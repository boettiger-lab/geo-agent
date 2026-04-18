/**
 * MapManager - Map initialization and layer control API
 *
 * Owns the MapLibre map instance and provides a clean API for:
 * - Initializing layers from DatasetCatalog configs
 * - Show/hide layers
 * - Apply MapLibre filter expressions to vector layers
 * - Apply paint/style properties
 * - Query visible features
 * - Generate layer control UI
 *
 * No knowledge of LLMs, tools, or chat — pure map operations.
 */

import { extractHashFromUrl, buildFillColorExpression } from './hex-layer-helpers.js';

const BASEMAPS = {
    natgeo: {
        source: {
            type: 'raster',
            tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 16,
            attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA'
        },
        terrain: true
    },
    satellite: {
        source: {
            type: 'raster',
            tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        },
        terrain: true
    },
    plain: {
        source: {
            type: 'raster',
            tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
        },
        terrain: false
    }
};

export class MapManager {
    /**
     * @param {string} containerId - DOM element ID for the map
     * @param {Object} options - { center, zoom, maptilerKey, pitch, maxPitch }
     */
    constructor(containerId, options = {}) {
        /** @type {Map<string, LayerState>} */
        this.layers = new Map();

        // Raster legend state
        this._legendEl = null;
        this._legendContent = null;
        this._legendItems = new Map();   // layerId → DOM element
        this._colormapCache = new Map(); // colormap name → CSS gradient string
        this.titilerUrl = options.titilerUrl || 'https://titiler.nrp-nautilus.io';
        this._maptilerKey = options.maptilerKey || '';
        this._currentBasemap = 'natgeo';
        this._globeEnabled = options.globe ?? false;

        // Build instance-level copy so customization never mutates module-level BASEMAPS
        this._basemaps = structuredClone(BASEMAPS);
        const customBasemap = options.customBasemap;
        this._customBasemapLabel = customBasemap?.label || null;
        if (customBasemap?.url) {
            this._basemaps.natgeo.source.tiles = [customBasemap.url];
            this._basemaps.natgeo.source.attribution = '';
            this._basemaps.natgeo.terrain = false;
        }

        const defaultBasemap = (options.defaultBasemap && this._basemaps[options.defaultBasemap])
            ? options.defaultBasemap
            : 'natgeo';

        // Register PMTiles protocol
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);

        // Create map with all three basemap sources; natgeo visible by default
        this.map = new maplibregl.Map({
            container: containerId,
            style: {
                version: 8,
                glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
                sources: {
                    natgeo:    this._basemaps.natgeo.source,
                    satellite: this._basemaps.satellite.source,
                    plain:     this._basemaps.plain.source,
                },
                layers: [
                    { id: 'natgeo-base',    type: 'raster', source: 'natgeo',    layout: { visibility: 'visible' } },
                    { id: 'satellite-base', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
                    { id: 'plain-base',     type: 'raster', source: 'plain',     layout: { visibility: 'none' } },
                ],
            },
            center: options.center || [-119.4, 36.8],
            zoom: options.zoom || 6,
            pitch: options.pitch ?? 0,
            bearing: options.bearing ?? 0,
            maxPitch: options.maxPitch ?? 75,
            renderWorldCopies: false,
        });

        this.map.addControl(new maplibregl.NavigationControl(), 'top-left');

        // Promise that resolves when the map style is loaded (and terrain is set up)
        this.ready = new Promise(resolve => {
            this.map.on('load', async () => {
                if (this._maptilerKey) {
                    try {
                        this.map.addSource('terrain-dem', {
                            type: 'raster-dem',
                            url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${this._maptilerKey}`,
                            tileSize: 256
                        });
                        this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
                    } catch (e) {
                        console.warn('[MapManager] terrain setup failed:', e);
                    }
                }
                if (defaultBasemap !== 'natgeo') {
                    this.setBasemap(defaultBasemap);
                }
                if (this._globeEnabled) {
                    this.map.setProjection({ type: 'globe' });
                    const cb = document.getElementById('globe-checkbox');
                    if (cb) cb.checked = true;
                }
                resolve();
            });
        });

        // Shared hover tooltip element
        this._tooltip = document.createElement('div');
        this._tooltip.className = 'map-tooltip';
        document.body.appendChild(this._tooltip);
    }

    /**
     * Register and add layers to the map from catalog configs.
     * @param {Array} layerConfigs - From DatasetCatalog.getMapLayerConfigs()
     */
    addLayersFromCatalog(layerConfigs) {
        for (const config of layerConfigs) {
            this.registerLayer(config);
        }
        console.log(`[Map] Registered ${this.layers.size} layers`);
    }

    /**
     * Register a single layer on the map.
     */
    registerLayer(config) {
        const { layerId, datasetId, group, groupCollapsed, displayName, type, paint, outlinePaint, renderType, columns, tooltipFields, defaultVisible, defaultFilter, colormap, rescale, legendLabel, legendType, legendClasses } = config;

        // ── Animated layer: delegate to TrajectoryAnimation ──
        if (config.animation && config.animation.type === 'trajectory') {
            this._registerTrajectoryLayer(config);
            return;
        }

        // ── Versioned layer: register N underlying MapLibre layers, one logical entry ──
        if (config.versions && config.versions.length > 0) {
            const versionStates = config.versions.map((v, i) => {
                const isActive = (i === config.defaultVersionIndex);
                const vis = (defaultVisible && isActive) ? 'visible' : 'none';
                const vMapLayerId = `layer-${layerId.replace(/\//g, '-')}--v-${i}`;

                // Add source
                if (!this.map.getSource(v.sourceId)) {
                    this.map.addSource(v.sourceId, v.source);
                }

                // Build MapLibre layer
                const layerDef = {
                    id: vMapLayerId,
                    source: v.sourceId,
                    layout: { visibility: vis },
                };

                let vOutlineLayerId = null;
                if (v.type === 'vector' && renderType === 'line') {
                    layerDef.type = 'line';
                    if (v.sourceLayer) layerDef['source-layer'] = v.sourceLayer;
                    layerDef.paint = paint || { 'line-color': '#2E7D32', 'line-width': 1.5 };
                } else if (v.type === 'vector' && renderType === 'circle') {
                    layerDef.type = 'circle';
                    if (v.sourceLayer) layerDef['source-layer'] = v.sourceLayer;
                    layerDef.paint = paint || { 'circle-color': '#2E7D32', 'circle-radius': 6, 'circle-opacity': 0.8 };
                } else if (v.type === 'vector') {
                    layerDef.type = 'fill';
                    if (v.sourceLayer) layerDef['source-layer'] = v.sourceLayer;
                    layerDef.paint = paint || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
                } else if (v.type === 'raster') {
                    layerDef.type = 'raster';
                    layerDef.paint = paint || { 'raster-opacity': 0.7 };
                }

                this.map.addLayer(layerDef);

                // Outline for vector fills
                if (v.type === 'vector' && renderType !== 'line' && renderType !== 'circle') {
                    vOutlineLayerId = `${vMapLayerId}-outline`;
                    const outlineDef = {
                        id: vOutlineLayerId,
                        type: 'line',
                        source: v.sourceId,
                        layout: { visibility: vis },
                        paint: outlinePaint || { 'line-color': 'rgba(0,0,0,0.4)', 'line-width': 0.5 },
                    };
                    if (v.sourceLayer) outlineDef['source-layer'] = v.sourceLayer;
                    this.map.addLayer(outlineDef);
                }

                // Default filter
                if (defaultFilter) {
                    try {
                        this.map.setFilter(vMapLayerId, defaultFilter);
                        if (vOutlineLayerId) this.map.setFilter(vOutlineLayerId, defaultFilter);
                    } catch (err) {
                        console.error(`[Map] Failed to apply default filter to ${layerId} v${i}:`, err);
                    }
                }

                // Tooltip
                if (tooltipFields && tooltipFields.length > 0) {
                    this._wireTooltip(vMapLayerId, tooltipFields);
                }

                return {
                    label: v.label,
                    mapLayerId: vMapLayerId,
                    outlineLayerId: vOutlineLayerId,
                    sourceId: v.sourceId,
                    sourceLayer: v.sourceLayer || null,
                };
            });

            this.layers.set(layerId, {
                layerId,
                mapLayerId: versionStates[config.defaultVersionIndex].mapLayerId,
                outlineLayerId: versionStates[config.defaultVersionIndex].outlineLayerId,
                sourceId: versionStates[config.defaultVersionIndex].sourceId,
                datasetId,
                group: group || null,
                groupCollapsed: groupCollapsed || false,
                displayName,
                type,
                sourceLayer: versionStates[config.defaultVersionIndex].sourceLayer,
                visible: defaultVisible || false,
                filter: defaultFilter || null,
                defaultFilter: defaultFilter || null,
                columns: columns || [],
                defaultPaint: { ...(paint || {}) },
                tooltipFields: tooltipFields || null,
                colormap: colormap || null,
                rescale: rescale || null,
                legendLabel: legendLabel || null,
                legendType: legendType || null,
                legendClasses: legendClasses || null,
                // Version tracking
                versions: versionStates,
                activeVersionIndex: config.defaultVersionIndex,
            });
            return;
        }

        // ── Standard (non-versioned) layer ──
        const { source, sourceLayer } = config;
        // Use pre-computed sourceId (shared between alias layers) or derive from layerId
        const sourceId = config.sourceId || `src-${layerId.replace(/\//g, '-')}`;
        const mapLayerId = `layer-${layerId.replace(/\//g, '-')}`;

        // Add source if not exists
        if (!this.map.getSource(sourceId)) {
            this.map.addSource(sourceId, source);
        }

        // Build layer definition
        const layerDef = {
            id: mapLayerId,
            source: sourceId,
            layout: { visibility: defaultVisible ? 'visible' : 'none' },
        };

        let outlineLayerId = null;
        if (type === 'vector' && renderType === 'line') {
            layerDef.type = 'line';
            if (sourceLayer) layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'line-color': '#2E7D32', 'line-width': 1.5 };
        } else if (type === 'vector' && renderType === 'circle') {
            layerDef.type = 'circle';
            if (sourceLayer) layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'circle-color': '#2E7D32', 'circle-radius': 6, 'circle-opacity': 0.8 };
        } else if (type === 'vector') {
            layerDef.type = 'fill';
            if (sourceLayer) layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
        } else if (type === 'raster') {
            layerDef.type = 'raster';
            layerDef.paint = paint || { 'raster-opacity': 0.7 };
        }

        this.map.addLayer(layerDef);

        // Add outline layer for vector fills (not for line or circle layers)
        if (type === 'vector' && renderType !== 'line' && renderType !== 'circle') {
            outlineLayerId = `${mapLayerId}-outline`;
            const outlineDef = {
                id: outlineLayerId,
                type: 'line',
                source: sourceId,
                layout: { visibility: defaultVisible ? 'visible' : 'none' },
                paint: outlinePaint || {
                    'line-color': 'rgba(0,0,0,0.4)',
                    'line-width': 0.5,
                },
            };
            if (sourceLayer) outlineDef['source-layer'] = sourceLayer;
            this.map.addLayer(outlineDef);
        }

        // Apply default filter if declared
        if (defaultFilter) {
            try {
                this.map.setFilter(mapLayerId, defaultFilter);
                if (outlineLayerId) this.map.setFilter(outlineLayerId, defaultFilter);
            } catch (err) {
                console.error(`[Map] Failed to apply default filter to ${layerId}:`, err);
            }
        }

        // Store state
        this.layers.set(layerId, {
            layerId,
            mapLayerId,
            outlineLayerId,
            sourceId,
            datasetId,
            group: group || null,
            groupCollapsed: groupCollapsed || false,
            displayName,
            type,
            sourceLayer: sourceLayer || null,
            visible: defaultVisible || false,
            filter: defaultFilter || null,
            defaultFilter: defaultFilter || null,
            columns: columns || [],
            defaultPaint: { ...(paint || {}) },
            tooltipFields: tooltipFields || null,
            colormap: colormap || null,
            rescale: rescale || null,
            legendLabel: legendLabel || null,
            legendType: legendType || null,
            legendClasses: legendClasses || null,
        });

        // Wire hover tooltip if fields are declared
        if (tooltipFields && tooltipFields.length > 0) {
            this._wireTooltip(mapLayerId, tooltipFields);
        }
    }

    /**
     * Register an animated trajectory layer. Creates a TrajectoryAnimation
     * instance that owns its own sources, layers, and RAF loop; stores a
     * layer-state record so it shows up in the layer panel and works with
     * showLayer / hideLayer / setFilter.
     */
    async _registerTrajectoryLayer(config) {
        const { layerId, datasetId, group, groupCollapsed, displayName, animation, defaultVisible, defaultFilter, tracksUrl, paint } = config;

        // Store the state synchronously so generateControls can find it even
        // while the module + GeoJSON are still loading.
        const state = {
            layerId,
            mapLayerId: null,
            outlineLayerId: null,
            sourceId: null,
            datasetId,
            group: group || null,
            groupCollapsed: groupCollapsed || false,
            displayName,
            type: 'animation',
            sourceLayer: null,
            visible: defaultVisible || false,
            filter: defaultFilter || null,
            defaultFilter: defaultFilter || null,
            columns: [],
            defaultPaint: { ...(paint || {}) },
            tooltipFields: null,
            animation: null,   // filled in below
        };
        this.layers.set(layerId, state);

        try {
            const { TrajectoryAnimation } = await import('./animation-manager.js');
            const anim = new TrajectoryAnimation(this.map, {
                layerId,
                displayName,
                tracksUrl,
                staticUrl: animation.static_positions_url || null,
                config: animation,
                paint,
            });
            await anim.ready;
            state.animation = anim;
            // Apply deferred visibility/filter requested before init finished
            anim.setVisible(state.visible);
            if (state.filter) anim.setFilter(state.filter);
        } catch (err) {
            console.error(`[Map] Failed to init trajectory animation for ${layerId}:`, err);
        }
    }

    // ---- Layer Visibility ----

    /**
     * Show a layer.
     * @param {string} layerId 
     * @returns {Object} Result
     */
    showLayer(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}. Available: ${this.getLayerIds().join(', ')}` };

        state.visible = true;
        if (state.type === 'animation') {
            if (state.animation) state.animation.setVisible(true);
            return { success: true, layer: layerId, displayName: state.displayName, visible: true };
        }
        this.map.setLayoutProperty(state.mapLayerId, 'visibility', 'visible');
        if (state.outlineLayerId) this.map.setLayoutProperty(state.outlineLayerId, 'visibility', 'visible');
        if (state.type === 'raster') this._showRasterLegend(layerId);
        return { success: true, layer: layerId, displayName: state.displayName, visible: true };
    }

    /**
     * Hide a layer.
     * @param {string} layerId 
     * @returns {Object} Result
     */
    hideLayer(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}. Available: ${this.getLayerIds().join(', ')}` };

        state.visible = false;
        if (state.type === 'animation') {
            if (state.animation) state.animation.setVisible(false);
            return { success: true, layer: layerId, displayName: state.displayName, visible: false };
        }
        this.map.setLayoutProperty(state.mapLayerId, 'visibility', 'none');
        if (state.outlineLayerId) this.map.setLayoutProperty(state.outlineLayerId, 'visibility', 'none');
        if (state.type === 'raster') this._hideRasterLegend(layerId);
        return { success: true, layer: layerId, displayName: state.displayName, visible: false };
    }

    // ---- Hex Tile Layers (dynamic MVT from MCP register_hex_tiles) ----

    /**
     * Add a dynamic H3 hex MVT source + fill layer from an MCP tile URL template.
     *
     * See docs/superpowers/specs/2026-04-16-add-hex-tile-layer-design.md for the
     * full contract. Idempotent by hash: re-adding a URL whose hash is already
     * registered returns {already_exists: true} without mutating the map.
     *
     * @param {Object} opts
     * @param {string} opts.tileUrl - from register_hex_tiles.tile_url_template
     * @param {string} opts.valueColumn - which column to color by
     * @param {{by_res: Object<string,{min:number,max:number}>}} opts.valueStats -
     *   from register_hex_tiles.value_stats[valueColumn]
     * @param {[number, number, number, number]} opts.bounds - [w,s,e,n]
     * @param {string} opts.palette - one of PALETTES keys
     * @param {number} opts.opacity - 0..1
     * @param {string} opts.displayName
     * @param {boolean} opts.fitBounds - call map.fitBounds after adding
     * @param {string} [opts.layerName] - MVT source-layer name from register_hex_tiles.
     *   Defaults to 'layer' (current mcp-data-server default).
     * @returns {{success: boolean, layer_id?: string, error?: string}}
     */
    addHexTileLayer(opts) {
        const { tileUrl, valueColumn, valueStats, bounds, palette, opacity, displayName, fitBounds, layerName } = opts;
        const sourceLayer = layerName || 'layer';

        const hash = extractHashFromUrl(tileUrl);
        if (!hash) {
            return { success: false, error: `Invalid tile_url — expected template from register_hex_tiles ending in /tiles/hex/<hash>/{z}/{x}/{y}.pbf` };
        }
        const layerId = `hex-${hash}`;

        // Idempotency: same URL → same layer → no re-add
        if (this.layers.has(layerId)) {
            const state = this.layers.get(layerId);
            return {
                success: true,
                layer_id: layerId,
                display_name: state.displayName,
                value_column: valueColumn,
                bounds,
                already_exists: true,
                message: 'Layer already registered. Use remove_hex_tile_layer first to re-add with different styling.',
            };
        }

        let fillColor;
        try {
            fillColor = buildFillColorExpression(valueColumn, valueStats, palette);
        } catch (err) {
            return { success: false, error: err.message };
        }

        const paint = {
            'fill-color': fillColor,
            'fill-opacity': opacity,
            'fill-outline-color': 'rgba(0,0,0,0.15)',
        };

        this.map.addSource(layerId, { type: 'vector', tiles: [tileUrl], minzoom: 0, maxzoom: 14 });
        this.map.addLayer({
            id: layerId,
            type: 'fill',
            source: layerId,
            'source-layer': sourceLayer,
            layout: { visibility: 'visible' },
            paint,
        });

        this.layers.set(layerId, {
            layerId,
            mapLayerId: layerId,
            outlineLayerId: null,
            sourceId: layerId,
            datasetId: null,
            group: null,
            groupCollapsed: false,
            displayName,
            type: 'vector',
            sourceLayer,
            columns: [],
            visible: true,
            filter: null,
            defaultFilter: null,
            defaultPaint: { ...paint },
            tooltipFields: null,
            colormap: null,
            rescale: null,
            legendLabel: null,
            legendType: null,
            legendClasses: null,
        });

        if (fitBounds && Array.isArray(bounds) && bounds.length === 4) {
            const [w, s, e, n] = bounds;
            this.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800 });
        }

        return {
            success: true,
            layer_id: layerId,
            display_name: displayName,
            value_column: valueColumn,
            bounds,
            already_exists: false,
        };
    }

    /**
     * Remove a dynamic hex tile layer previously added via addHexTileLayer.
     *
     * Refuses any layer_id not starting with `hex-` so curated layers can't
     * be accidentally destroyed.
     *
     * @param {string} layerId - e.g. "hex-abc123"
     * @returns {{success: boolean, layer_id?: string, error?: string}}
     */
    removeHexTileLayer(layerId) {
        if (typeof layerId !== 'string' || !layerId.startsWith('hex-')) {
            return { success: false, error: `layer_id '${layerId}' is not a hex layer (must start with 'hex-')` };
        }
        if (!this.layers.has(layerId)) {
            const hexLayers = [...this.layers.keys()].filter(id => id.startsWith('hex-'));
            return { success: false, error: `Unknown hex layer '${layerId}'. Registered: [${hexLayers.join(', ')}]` };
        }
        this.map.removeLayer(layerId);
        this.map.removeSource(layerId);
        this.layers.delete(layerId);
        return { success: true, layer_id: layerId };
    }

    // ---- Filtering (vector layers only) ----

    /**
     * Apply a MapLibre filter expression to a vector layer.
     * @param {string} layerId 
     * @param {Array|null} filter - MapLibre filter expression, or null to clear
     * @returns {Object} Result with feature count
     */
    setFilter(layerId, filter) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}` };
        if (state.type === 'animation') {
            state.filter = filter;
            if (state.animation) state.animation.setFilter(filter);
            return {
                success: true,
                layer: layerId,
                displayName: state.displayName,
                filter,
                filterDescription: filter ? this.describeFilter(filter) : 'No filter (showing all)',
            };
        }
        if (state.type !== 'vector') return { success: false, error: `Layer '${layerId}' is raster — filtering only works on vector layers` };

        this.map.setFilter(state.mapLayerId, filter);
        if (state.outlineLayerId) this.map.setFilter(state.outlineLayerId, filter);
        state.filter = filter;

        // Count features in view
        const features = this.map.queryRenderedFeatures({ layers: [state.mapLayerId] });
        const result = {
            success: true,
            layer: layerId,
            displayName: state.displayName,
            filter,
            filterDescription: filter ? this.describeFilter(filter) : 'No filter (showing all)',
            featuresInView: features.length,
        };

        if (features.length === 0 && filter) {
            result.warning = 'No features match this filter in the current view. The filter may be too restrictive or property values may not match. Use the query tool to check actual data values.';
        }

        return result;
    }

    /**
     * Clear filter from a layer (show all features).
     */
    clearFilter(layerId) {
        return this.setFilter(layerId, null);
    }

    /**
     * Reset filter to the layer's config default (or clear if no default).
     */
    resetFilter(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}` };
        return this.setFilter(layerId, state.defaultFilter);
    }

    // ---- Styling ----

    /**
     * Apply paint properties to a layer.
     * @param {string} layerId 
     * @param {Object} paintProps - e.g. { 'fill-color': 'red', 'fill-opacity': 0.5 }
     * @returns {Object} Result
     */
    setStyle(layerId, paintProps) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}` };

        const results = [];
        for (const [prop, value] of Object.entries(paintProps)) {
            try {
                this.map.setPaintProperty(state.mapLayerId, prop, value);
                results.push({ property: prop, success: true });
            } catch (error) {
                results.push({ property: prop, success: false, error: error.message });
            }
        }

        return { success: true, layer: layerId, displayName: state.displayName, updates: results };
    }

    /**
     * Reset a layer's paint to defaults.
     */
    resetStyle(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}` };
        return this.setStyle(layerId, state.defaultPaint);
    }

    // ---- Query ----

    /**
     * Get summary of all layers and their current state.
     */
    flyTo({ center, zoom }) {
        const options = { center };
        if (zoom !== undefined) options.zoom = zoom;
        this.map.flyTo(options);
        return { success: true, center, zoom: zoom ?? this.map.getZoom() };
    }

    getMapState() {
        const layers = {};
        for (const [id, state] of this.layers) {
            layers[id] = {
                displayName: state.displayName,
                type: state.type,
                visible: state.visible,
                hasFilter: state.filter !== null,
                filterDescription: state.filter ? this.describeFilter(state.filter) : null,
                hasDefaultFilter: state.defaultFilter !== null,
                defaultFilterDescription: state.defaultFilter ? this.describeFilter(state.defaultFilter) : null,
            };
        }
        return { success: true, layers };
    }

    /**
     * Get all registered layer IDs.
     */
    getLayerIds() {
        return [...this.layers.keys()];
    }

    /**
     * Get vector layer IDs only.
     */
    getVectorLayerIds() {
        return [...this.layers.entries()]
            .filter(([, s]) => s.type === 'vector')
            .map(([id]) => id);
    }

    /**
     * Get a layer's filterable columns.
     */
    getLayerColumns(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return null;
        return state.columns.filter(c => !['h0', 'h8', 'h9', 'h10', 'geometry'].includes(c.name));
    }

    // ---- UI Generation ----

    /**
     * Switch the active basemap by name ('natgeo' | 'satellite' | 'plain').
     * Also toggles 3D terrain on/off based on the basemap's terrain flag.
     * @param {string} name
     */
    setBasemap(name) {
        if (!this._basemaps[name]) return;
        this._currentBasemap = name;
        Object.keys(this._basemaps).forEach(key => {
            const vis = key === name ? 'visible' : 'none';
            if (this.map.getLayer(key + '-base')) {
                this.map.setLayoutProperty(key + '-base', 'visibility', vis);
            }
        });
        if (this._maptilerKey && this.map.getSource('terrain-dem')) {
            if (this._basemaps[name].terrain) {
                this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
            } else {
                this.map.setTerrain(null);
            }
        }
        document.querySelectorAll('.basemap-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.basemap === name);
        });
    }

    /**
     * Switch between 'globe' and 'mercator' projection.
     * @param {'globe'|'mercator'} type
     */
    setProjection(type) {
        this._globeEnabled = type === 'globe';
        this.map.setProjection({ type });
        const btn = document.getElementById('globe-btn');
        if (btn) btn.classList.toggle('active', this._globeEnabled);
    }

    /**
     * Generate the full menu: collapse header, basemap buttons, globe toggle,
     * overlays section, and layer-controls-container. Call once after map is ready.
     * @param {HTMLElement|string} container - DOM element or element ID for #menu
     */
    generateMenu(container) {
        if (typeof container === 'string') container = document.getElementById(container);
        if (!container) return;

        // ── Collapse header (always visible) ────────────────────────────
        const menuHeader = document.createElement('div');
        menuHeader.className = 'menu-header';
        const layersTitle = document.createElement('label');
        layersTitle.className = 'section-title';
        layersTitle.textContent = 'Layers';
        const menuToggle = document.createElement('button');
        menuToggle.id = 'menu-toggle';
        menuToggle.title = 'Toggle layers';
        menuToggle.textContent = '−';
        menuToggle.addEventListener('click', () => {
            container.classList.toggle('collapsed');
            menuToggle.textContent = container.classList.contains('collapsed') ? '+' : '−';
        });
        menuHeader.appendChild(layersTitle);
        menuHeader.appendChild(menuToggle);
        container.appendChild(menuHeader);

        // ── Collapsible body ─────────────────────────────────────────────
        const menuBody = document.createElement('div');
        menuBody.id = 'menu-body';

        // Basemap section
        const basemapSection = document.createElement('div');
        basemapSection.className = 'menu-section';

        // Basemap header: "BASEMAP" label + globe icon button inline
        const basemapHeader = document.createElement('div');
        basemapHeader.className = 'basemap-section-header';
        const basemapTitle = document.createElement('label');
        basemapTitle.className = 'section-title';
        basemapTitle.textContent = 'Basemap';
        const globeBtn = document.createElement('button');
        globeBtn.id = 'globe-btn';
        globeBtn.className = 'globe-btn' + (this._globeEnabled ? ' active' : '');
        globeBtn.title = 'Toggle globe view';
        globeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
        globeBtn.addEventListener('click', () => this.setProjection(this._globeEnabled ? 'mercator' : 'globe'));
        basemapHeader.appendChild(basemapTitle);
        basemapHeader.appendChild(globeBtn);
        basemapSection.appendChild(basemapHeader);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'basemap-toggle-group';
        const basemapDefs = [
            { key: 'natgeo',    label: this._customBasemapLabel || 'NatGeo' },
            { key: 'satellite', label: 'Satellite' },
            { key: 'plain',     label: 'Plain' },
        ];
        for (const { key, label } of basemapDefs) {
            const btn = document.createElement('button');
            btn.className = 'basemap-btn' + (key === this._currentBasemap ? ' active' : '');
            btn.dataset.basemap = key;
            btn.textContent = label;
            btn.addEventListener('click', () => this.setBasemap(key));
            btnGroup.appendChild(btn);
        }
        basemapSection.appendChild(btnGroup);
        menuBody.appendChild(basemapSection);

        // Overlays section
        const overlaysSection = document.createElement('div');
        overlaysSection.className = 'menu-section';
        const overlaysTitle = document.createElement('label');
        overlaysTitle.className = 'section-title';
        overlaysTitle.textContent = 'Overlays';
        overlaysSection.appendChild(overlaysTitle);
        const layerControls = document.createElement('div');
        layerControls.id = 'layer-controls-container';
        layerControls.className = 'checkbox-group';
        overlaysSection.appendChild(layerControls);
        menuBody.appendChild(overlaysSection);

        container.appendChild(menuBody);
    }

    /**
     * Generate checkbox controls in a container element.
     * @param {HTMLElement|string} container - DOM element or element ID
     */
    generateControls(container) {
        if (typeof container === 'string') {
            container = document.getElementById(container);
        }
        if (!container) return;
        container.innerHTML = '';

        // Group layers by their group name (null → ungrouped)
        const groups = new Map();
        for (const [layerId, state] of this.layers) {
            const key = state.group || '';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push([layerId, state]);
        }

        for (const [groupName, entries] of groups) {
            let itemContainer;

            if (groupName) {
                const details = document.createElement('details');
                details.open = !entries[0][1].groupCollapsed;
                details.className = 'layer-group';

                const summary = document.createElement('summary');
                summary.className = 'layer-group-title';
                summary.textContent = groupName;
                details.appendChild(summary);

                container.appendChild(details);
                itemContainer = details;
            } else {
                itemContainer = container;
            }

            for (const [layerId, state] of entries) {
                const wrapper = document.createElement('div');
                wrapper.className = 'layer-item';

                const label = document.createElement('label');
                label.className = 'layer-toggle';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `toggle-${layerId.replace(/\//g, '-')}`;
                checkbox.checked = state.visible;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) this.showLayer(layerId);
                    else this.hideLayer(layerId);
                });

                const span = document.createElement('span');
                span.textContent = state.displayName;

                label.appendChild(checkbox);
                label.appendChild(span);
                wrapper.appendChild(label);

                // Version selector dropdown for versioned layers
                if (state.versions && state.versions.length > 1) {
                    const select = document.createElement('select');
                    select.className = 'version-select';
                    select.id = `version-${layerId.replace(/\//g, '-')}`;
                    for (let i = 0; i < state.versions.length; i++) {
                        const opt = document.createElement('option');
                        opt.value = i;
                        opt.textContent = state.versions[i].label;
                        if (i === state.activeVersionIndex) opt.selected = true;
                        select.appendChild(opt);
                    }
                    select.addEventListener('change', () => {
                        this.switchVersion(layerId, parseInt(select.value, 10));
                    });
                    wrapper.appendChild(select);
                }

                itemContainer.appendChild(wrapper);
            }
        }
    }

    /**
     * Sync a checkbox to match current layer visibility
     * (called when agent changes visibility programmatically).
     */
    syncCheckbox(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return;
        const checkbox = document.getElementById(`toggle-${layerId.replace(/\//g, '-')}`);
        if (checkbox) checkbox.checked = state.visible;
    }

    /**
     * Switch the active version of a versioned layer.
     * Hides the old version, shows the new one (if the layer is visible),
     * and carries over the current filter to the new version.
     *
     * @param {string} layerId - Logical layer ID
     * @param {number} newIndex - Version index to activate
     * @returns {Object} Result
     */
    switchVersion(layerId, newIndex) {
        const state = this.layers.get(layerId);
        if (!state) return { success: false, error: `Unknown layer: ${layerId}` };
        if (!state.versions) return { success: false, error: `Layer '${layerId}' is not versioned` };
        if (newIndex < 0 || newIndex >= state.versions.length) {
            return { success: false, error: `Version index ${newIndex} out of range (0–${state.versions.length - 1})` };
        }
        if (newIndex === state.activeVersionIndex) return { success: true, layer: layerId, version: state.versions[newIndex].label, noChange: true };

        const oldV = state.versions[state.activeVersionIndex];
        const newV = state.versions[newIndex];

        // Hide old version's MapLibre layers
        this.map.setLayoutProperty(oldV.mapLayerId, 'visibility', 'none');
        if (oldV.outlineLayerId) this.map.setLayoutProperty(oldV.outlineLayerId, 'visibility', 'none');

        // Carry over filter to new version
        if (state.filter) {
            try {
                this.map.setFilter(newV.mapLayerId, state.filter);
                if (newV.outlineLayerId) this.map.setFilter(newV.outlineLayerId, state.filter);
            } catch (e) {
                console.warn(`[Map] Could not apply filter to new version:`, e);
            }
        }

        // Show new version if the logical layer is visible
        if (state.visible) {
            this.map.setLayoutProperty(newV.mapLayerId, 'visibility', 'visible');
            if (newV.outlineLayerId) this.map.setLayoutProperty(newV.outlineLayerId, 'visibility', 'visible');
        }

        // Update state pointers
        state.activeVersionIndex = newIndex;
        state.mapLayerId = newV.mapLayerId;
        state.outlineLayerId = newV.outlineLayerId;
        state.sourceId = newV.sourceId;
        state.sourceLayer = newV.sourceLayer;

        // Refresh raster legend if visible (tile URL changed)
        if (state.type === 'raster' && state.visible) {
            this._hideRasterLegend(layerId);
            this._legendItems.delete(layerId);   // force re-creation with new source
            this._showRasterLegend(layerId);
        }

        return { success: true, layer: layerId, version: newV.label };
    }

    // ---- Raster Legend ----

    _ensureLegend() {
        if (this._legendEl) return;

        const legend = document.createElement('div');
        legend.id = 'legend';
        legend.innerHTML = `
            <div id="legend-header">
                <h3>Legend</h3>
                <button id="legend-toggle" title="Toggle legend">−</button>
            </div>
            <div id="legend-content"></div>
        `;
        document.body.appendChild(legend);
        this._legendEl = legend;
        this._legendContent = legend.querySelector('#legend-content');

        legend.querySelector('#legend-toggle').addEventListener('click', () => {
            const collapsed = this._legendContent.classList.toggle('collapsed');
            legend.querySelector('#legend-toggle').textContent = collapsed ? '+' : '−';
        });
    }

    async _getColormapGradient(colormap) {
        if (this._colormapCache.has(colormap)) return this._colormapCache.get(colormap);
        try {
            const resp = await fetch(`${this.titilerUrl}/colorMaps/${colormap}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const stops = [0, 28, 57, 85, 113, 141, 170, 198, 226, 255].map(i => {
                const [r, g, b, a] = data[String(i)] || [128, 128, 128, 255];
                return `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
            });
            const gradient = `linear-gradient(to right, ${stops.join(', ')})`;
            this._colormapCache.set(colormap, gradient);
            return gradient;
        } catch {
            return 'linear-gradient(to right, #eee, #333)';
        }
    }

    async _showRasterLegend(layerId) {
        const state = this.layers.get(layerId);
        if (!state) return;

        this._ensureLegend();
        this._legendEl.style.display = '';

        if (this._legendItems.has(layerId)) {
            this._legendItems.get(layerId).style.display = '';
            return;
        }

        const item = document.createElement('div');
        item.className = 'legend-section';

        if (state.legendType === 'categorical' && state.legendClasses?.length) {
            const rows = state.legendClasses.map(cls => {
                const color = cls['color-hint'] || cls.color_hint ? `#${cls['color-hint'] || cls.color_hint}` : '#888888';
                const label = cls.name || `Class ${cls.value}`;
                return `<div class="legend-item"><span style="background:${color};"></span>${label}</div>`;
            }).join('');
            item.innerHTML = `<h4>${state.displayName}</h4>${rows}`;
        } else {
            const gradient = await this._getColormapGradient(state.colormap || 'reds');
            const [minVal, maxVal] = (state.rescale || '0,1').split(',');
            const unit = state.legendLabel ? ` ${state.legendLabel}` : '';
            item.innerHTML = `
                <h4>${state.displayName}</h4>
                <div class="legend-colorbar" style="background: ${gradient};"></div>
                <div class="legend-labels">
                    <span>${minVal}${unit}</span>
                    <span>${maxVal}${unit}</span>
                </div>
            `;
        }

        this._legendContent.appendChild(item);
        this._legendItems.set(layerId, item);
    }

    _hideRasterLegend(layerId) {
        const item = this._legendItems.get(layerId);
        if (item) item.style.display = 'none';
        // Hide the whole panel when nothing is visible
        if (this._legendEl) {
            const anyVisible = [...this._legendItems.values()].some(el => el.style.display !== 'none');
            this._legendEl.style.display = anyVisible ? '' : 'none';
        }
    }

    // ---- Utilities ----

    _wireTooltip(mapLayerId, tooltipFields) {
        this.map.on('mousemove', mapLayerId, (e) => {
            if (!e.features || e.features.length === 0) return;
            const props = e.features[0].properties;
            const rows = tooltipFields
                .filter(f => props[f] !== undefined && props[f] !== null && props[f] !== '')
                .map(f => `<tr><th>${f}</th><td>${this._formatTooltipValue(f, props[f])}</td></tr>`)
                .join('');
            if (!rows) return;
            this._tooltip.innerHTML = `<table>${rows}</table>`;
            this._tooltip.style.display = 'block';
            this._tooltip.style.left = (e.originalEvent.clientX + 12) + 'px';
            this._tooltip.style.top = (e.originalEvent.clientY - 12) + 'px';
            this.map.getCanvas().style.cursor = 'pointer';
        });

        this.map.on('mouseleave', mapLayerId, () => {
            this._tooltip.style.display = 'none';
            this.map.getCanvas().style.cursor = '';
        });
    }

    _formatTooltipValue(field, value) {
        const lf = field.toLowerCase();
        if (typeof value === 'number' && (lf.includes('value') || lf.includes('price') || lf.includes('cost'))) {
            return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
        }
        if (typeof value === 'number' && (lf.includes('acres') || lf.includes('area'))) {
            return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
        }
        return value;
    }

    describeFilter(filter) {
        if (!filter || !Array.isArray(filter)) return 'No filter';

        const op = filter[0];
        if (['==', '!=', '>', '<', '>=', '<='].includes(op)) {
            const opText = { '==': 'equals', '!=': 'not equals', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };
            return `${filter[1]} ${opText[op]} ${filter[2]}`;
        }
        if (op === 'in') return `${filter[1]} in [${filter.slice(2).join(', ')}]`;
        if (op === 'all') return filter.slice(1).map(f => this.describeFilter(f)).join(' AND ');
        if (op === 'any') return '(' + filter.slice(1).map(f => this.describeFilter(f)).join(' OR ') + ')';
        if (op === 'has') return `has '${filter[1]}'`;
        return JSON.stringify(filter);
    }
}
