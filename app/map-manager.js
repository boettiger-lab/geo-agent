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

export class MapManager {
    /**
     * @param {string} containerId - DOM element ID for the map
     * @param {Object} options - { center, zoom }
     */
    constructor(containerId, options = {}) {
        /** @type {Map<string, LayerState>} */
        this.layers = new Map();

        // Register PMTiles protocol
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);

        // Create map
        this.map = new maplibregl.Map({
            container: containerId,
            style: {
                version: 8,
                glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
                sources: {
                    'carto-light': {
                        type: 'raster',
                        tiles: [
                            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                            'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                        ],
                        tileSize: 256,
                        attribution: '© <a href="https://carto.com/">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
                    }
                },
                layers: [{ id: 'carto-light', type: 'raster', source: 'carto-light' }],
            },
            center: options.center || [-119.4, 36.8],
            zoom: options.zoom || 6,
            renderWorldCopies: false,
        });

        this.map.addControl(new maplibregl.NavigationControl(), 'top-left');

        // Promise that resolves when the map style is loaded
        this.ready = new Promise(resolve => {
            this.map.on('load', resolve);
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
        const { layerId, datasetId, displayName, type, source, sourceLayer, paint, columns, tooltipFields, defaultVisible, defaultFilter } = config;
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

        if (type === 'vector') {
            layerDef.type = 'fill';
            layerDef['source-layer'] = sourceLayer;
            layerDef.paint = paint || { 'fill-color': '#2E7D32', 'fill-opacity': 0.5 };
        } else if (type === 'raster') {
            layerDef.type = 'raster';
            layerDef.paint = paint || { 'raster-opacity': 0.7 };
        }

        this.map.addLayer(layerDef);

        // Apply default filter if declared
        if (defaultFilter) {
            try {
                this.map.setFilter(mapLayerId, defaultFilter);
            } catch (err) {
                console.error(`[Map] Failed to apply default filter to ${layerId}:`, err);
            }
        }

        // Store state
        this.layers.set(layerId, {
            layerId,
            mapLayerId,
            sourceId,
            datasetId,
            displayName,
            type,
            sourceLayer: sourceLayer || null,
            visible: defaultVisible || false,
            filter: defaultFilter || null,
            columns: columns || [],
            defaultPaint: { ...(paint || {}) },
            tooltipFields: tooltipFields || null,
        });

        // Wire hover tooltip if fields are declared
        if (tooltipFields && tooltipFields.length > 0) {
            this.map.on('mousemove', mapLayerId, (e) => {
                if (!e.features || e.features.length === 0) return;
                const props = e.features[0].properties;
                const rows = tooltipFields
                    .filter(f => props[f] !== undefined && props[f] !== null && props[f] !== '')
                    .map(f => `<tr><th>${f}</th><td>${props[f]}</td></tr>`)
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
        state.visible = true;
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
        state.visible = false;
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
     * Clear filter from a layer.
     */
    clearFilter(layerId) {
        return this.setFilter(layerId, null);
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
    getMapState() {
        const layers = {};
        for (const [id, state] of this.layers) {
            layers[id] = {
                displayName: state.displayName,
                type: state.type,
                visible: state.visible,
                hasFilter: state.filter !== null,
                filterDescription: state.filter ? this.describeFilter(state.filter) : null,
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
     * Generate checkbox controls in a container element.
     * @param {HTMLElement|string} container - DOM element or element ID
     */
    generateControls(container) {
        if (typeof container === 'string') {
            container = document.getElementById(container);
        }
        if (!container) return;
        container.innerHTML = '';
        for (const [layerId, state] of this.layers) {
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
            container.appendChild(wrapper);
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

    // ---- Utilities ----

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
