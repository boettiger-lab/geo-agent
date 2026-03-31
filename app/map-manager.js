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
        const defaultBasemap = (options.defaultBasemap && BASEMAPS[options.defaultBasemap])
            ? options.defaultBasemap
            : 'natgeo';

        // Allow custom_basemap to replace the natgeo slot's URL and label
        const customBasemap = options.customBasemap;
        const natgeoSource = (customBasemap?.url)
            ? { ...BASEMAPS.natgeo.source, tiles: [customBasemap.url], attribution: '' }
            : BASEMAPS.natgeo.source;

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
                    natgeo:    natgeoSource,
                    satellite: BASEMAPS.satellite.source,
                    plain:     BASEMAPS.plain.source,
                },
                layers: [
                    { id: 'natgeo-base',    type: 'raster', source: 'natgeo',    layout: { visibility: 'visible' } },
                    { id: 'satellite-base', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
                    { id: 'plain-base',     type: 'raster', source: 'plain',     layout: { visibility: 'none' } },
                ],
            },
            center: options.center || [-119.4, 36.8],
            zoom: options.zoom || 6,
            pitch: options.pitch ?? 20,
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
                if (customBasemap?.label) {
                    const btn = document.querySelector('.basemap-btn[data-basemap="natgeo"]');
                    if (btn) btn.textContent = customBasemap.label;
                }
                if (customBasemap?.url) {
                    // Custom basemap replaces natgeo slot; terrain not applicable
                    BASEMAPS.natgeo.terrain = false;
                }
                if (defaultBasemap !== 'natgeo') {
                    this.setBasemap(defaultBasemap);
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
        const { layerId, datasetId, group, displayName, type, source, sourceLayer, paint, outlinePaint, renderType, columns, tooltipFields, defaultVisible, defaultFilter, colormap, rescale, legendLabel, legendType, legendClasses } = config;
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
            layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'line-color': '#2E7D32', 'line-width': 1.5 };
        } else if (type === 'vector' && renderType === 'circle') {
            layerDef.type = 'circle';
            layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'circle-color': '#2E7D32', 'circle-radius': 6, 'circle-opacity': 0.8 };
        } else if (type === 'vector') {
            layerDef.type = 'fill';
            layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
        } else if (type === 'raster') {
            layerDef.type = 'raster';
            layerDef.paint = paint || { 'raster-opacity': 0.7 };
        }

        this.map.addLayer(layerDef);

        // Add outline layer for vector fills (not for line or circle layers)
        if (type === 'vector' && renderType !== 'line' && renderType !== 'circle') {
            outlineLayerId = `${mapLayerId}-outline`;
            this.map.addLayer({
                id: outlineLayerId,
                type: 'line',
                source: sourceId,
                'source-layer': sourceLayer,
                layout: { visibility: defaultVisible ? 'visible' : 'none' },
                paint: outlinePaint || {
                    'line-color': 'rgba(0,0,0,0.4)',
                    'line-width': 0.5,
                },
            });
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

        this.map.setLayoutProperty(state.mapLayerId, 'visibility', 'visible');
        if (state.outlineLayerId) this.map.setLayoutProperty(state.outlineLayerId, 'visibility', 'visible');
        state.visible = true;
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

        this.map.setLayoutProperty(state.mapLayerId, 'visibility', 'none');
        if (state.outlineLayerId) this.map.setLayoutProperty(state.outlineLayerId, 'visibility', 'none');
        state.visible = false;
        if (state.type === 'raster') this._hideRasterLegend(layerId);
        return { success: true, layer: layerId, displayName: state.displayName, visible: false };
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
        if (!BASEMAPS[name]) return;
        this._currentBasemap = name;
        Object.keys(BASEMAPS).forEach(key => {
            const vis = key === name ? 'visible' : 'none';
            if (this.map.getLayer(key + '-base')) {
                this.map.setLayoutProperty(key + '-base', 'visibility', vis);
            }
        });
        if (this._maptilerKey && this.map.getSource('terrain-dem')) {
            if (BASEMAPS[name].terrain) {
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
                details.open = true;
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
                const color = cls.color_hint ? `#${cls.color_hint}` : '#888888';
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
