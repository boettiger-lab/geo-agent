/**
 * MapLayerController - Generic map layer control operations
 * 
 * Provides a unified API for controlling map layers without hardcoding
 * layer-specific logic. Works with any layer registered in LayerRegistry.
 * 
 * Features:
 * - Toggle layer visibility
 * - Filter vector layers with MapLibre expressions
 * - Apply data-driven styling (paint properties)
 * - Track active filters and paint states
 * - Human-readable filter descriptions
 * 
 * All operations work generically based on layer metadata from LayerRegistry.
 */

export class MapLayerController {
    constructor(map, layerRegistry) {
        this.map = map;
        this.layerRegistry = layerRegistry;
        this.activeFilters = new Map();
        this.activePaint = new Map();
        this.defaultPaint = new Map();
    }

    /**
     * Get all available layers with their current visibility status
     * @returns {Object} - Map of layer keys to their status
     */
    getAvailableLayers() {
        const result = {};
        for (const key of this.layerRegistry.getKeys()) {
            const layer = this.layerRegistry.get(key);
            const checkbox = document.getElementById(layer.checkboxId);
            result[key] = {
                displayName: layer.displayName,
                visible: checkbox ? checkbox.checked : false,
                isVector: layer.isVector
            };
        }
        return result;
    }

    /**
     * Set layer visibility
     * @param {string} key - Layer key
     * @param {boolean} visible - Whether to show the layer
     * @returns {Object} - Result object with success status
     */
    setLayerVisibility(key, visible) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return {
                success: false,
                error: `Unknown layer: ${key}. Available layers: ${this.layerRegistry.getKeys().join(', ')}`
            };
        }

        if (!this.map || !this.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            const visibility = visible ? 'visible' : 'none';

            // Set visibility on all associated layer IDs
            for (const layerId of layer.layerIds) {
                if (this.map.getLayer(layerId)) {
                    this.map.setLayoutProperty(layerId, 'visibility', visibility);
                }
            }

            // Update the checkbox to match
            const checkbox = document.getElementById(layer.checkboxId);
            if (checkbox) {
                checkbox.checked = visible;
            }

            // Handle legend visibility
            if (layer.hasLegend) {
                const legend = document.getElementById('legend');
                if (legend) {
                    legend.style.display = visible ? 'block' : 'none';
                }
            }

            console.log(`[MapLayerController] Layer '${key}' visibility set to ${visible}`);
            return {
                success: true,
                layer: key,
                displayName: layer.displayName,
                visible: visible
            };
        } catch (error) {
            console.error('[MapLayerController] Error setting layer visibility:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Toggle layer visibility
     * @param {string} key - Layer key
     * @returns {Object} - Result object with success status
     */
    toggleLayer(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }

        const checkbox = document.getElementById(layer.checkboxId);
        const currentlyVisible = checkbox ? checkbox.checked : false;
        return this.setLayerVisibility(key, !currentlyVisible);
    }

    /**
     * Show only specified layers (hide all others)
     * @param {string[]} keys - Array of layer keys to show
     * @returns {Object[]} - Array of result objects
     */
    showOnlyLayers(keys) {
        const results = [];
        for (const key of this.layerRegistry.getKeys()) {
            const shouldShow = keys.includes(key);
            results.push(this.setLayerVisibility(key, shouldShow));
        }
        return results;
    }

    /**
     * Hide all layers
     * @returns {Object[]} - Array of result objects
     */
    hideAllLayers() {
        const results = [];
        for (const key of this.layerRegistry.getKeys()) {
            results.push(this.setLayerVisibility(key, false));
        }
        return results;
    }

    /**
     * Show all layers
     * @returns {Object[]} - Array of result objects
     */
    showAllLayers() {
        const results = [];
        for (const key of this.layerRegistry.getKeys()) {
            results.push(this.setLayerVisibility(key, true));
        }
        return results;
    }

    /**
     * Get filterable properties for a vector layer
     * @param {string} key - Layer key
     * @returns {Object} - Properties info or error
     */
    getFilterableProperties(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not support filtering`
            };
        }
        return {
            success: true,
            layer: key,
            displayName: layer.displayName,
            properties: layer.filterableProperties || {}
        };
    }

    /**
     * Set a filter on a vector layer
     * @param {string} key - Layer key
     * @param {Array} filter - MapLibre filter expression
     * @returns {Object} - Result object with success status
     */
    setLayerFilter(key, filter) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return {
                success: false,
                error: `Unknown layer: ${key}. Available layers: ${this.layerRegistry.getKeys().join(', ')}`
            };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not support filtering. Only vector layers can be filtered.`
            };
        }

        if (!this.map || !this.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Apply filter to all layer IDs
            for (const layerId of layer.layerIds) {
                if (this.map.getLayer(layerId)) {
                    this.map.setFilter(layerId, filter);
                    console.log(`[MapLayerController] Filter applied to '${layerId}':`, filter);
                }
            }

            // Store the active filter
            this.activeFilters.set(key, filter);

            // Build human-readable description
            const filterDescription = this.describeFilter(filter);

            return {
                success: true,
                layer: key,
                displayName: layer.displayName,
                filter: filter,
                description: filterDescription
            };
        } catch (error) {
            console.error('[MapLayerController] Error setting filter:', error);
            return { success: false, error: `Failed to apply filter: ${error.message}` };
        }
    }

    /**
     * Clear filter from a layer
     * @param {string} key - Layer key
     * @returns {Object} - Result object with success status
     */
    clearLayerFilter(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not have filters`
            };
        }

        if (!this.map || !this.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Remove filter from all layer IDs
            for (const layerId of layer.layerIds) {
                if (this.map.getLayer(layerId)) {
                    this.map.setFilter(layerId, null);
                    console.log(`[MapLayerController] Filter cleared from '${layerId}'`);
                }
            }

            // Remove from active filters
            this.activeFilters.delete(key);

            return {
                success: true,
                layer: key,
                displayName: layer.displayName,
                message: 'Filter cleared, showing all features'
            };
        } catch (error) {
            console.error('[MapLayerController] Error clearing filter:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get the current filter for a layer
     * @param {string} key - Layer key
     * @returns {Object} - Filter info or error
     */
    getLayerFilter(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not have filters`
            };
        }

        const filter = this.activeFilters.get(key) || null;
        const description = filter ? this.describeFilter(filter) : 'No filter active';

        return {
            success: true,
            layer: key,
            displayName: layer.displayName,
            filter: filter,
            description: description
        };
    }

    /**
     * Set paint property on a vector layer
     * @param {string} key - Layer key
     * @param {string} property - Paint property name (e.g., 'fill-color')
     * @param {*} value - Paint value (string, number, or expression array)
     * @returns {Object} - Result object with success status
     */
    setLayerPaint(key, property, value) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer. Paint properties only work on vector layers.`
            };
        }

        if (!this.map || !this.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Store default paint if this is the first time setting paint
            if (!this.defaultPaint.has(key)) {
                const defaults = {};
                for (const layerId of layer.layerIds) {
                    if (this.map.getLayer(layerId)) {
                        defaults[layerId] = {};
                        // Store current paint properties
                        try {
                            defaults[layerId][property] = this.map.getPaintProperty(layerId, property);
                        } catch (e) {
                            // Property might not exist yet
                            defaults[layerId][property] = null;
                        }
                    }
                }
                this.defaultPaint.set(key, defaults);
            }

            // Apply paint to all layer IDs
            for (const layerId of layer.layerIds) {
                if (this.map.getLayer(layerId)) {
                    this.map.setPaintProperty(layerId, property, value);
                    console.log(`[MapLayerController] Paint '${property}' set on '${layerId}'`);
                }
            }

            // Track active paint
            if (!this.activePaint.has(key)) {
                this.activePaint.set(key, {});
            }
            this.activePaint.get(key)[property] = value;

            return {
                success: true,
                layer: key,
                displayName: layer.displayName,
                property: property,
                value: value
            };
        } catch (error) {
            console.error('[MapLayerController] Error setting paint:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Reset paint properties to defaults
     * @param {string} key - Layer key
     * @returns {Object} - Result object with success status
     */
    resetLayerPaint(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not have paint properties`
            };
        }

        if (!this.map || !this.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            const defaults = this.defaultPaint.get(key);
            if (defaults) {
                // Restore defaults
                for (const [layerId, props] of Object.entries(defaults)) {
                    if (this.map.getLayer(layerId)) {
                        for (const [property, value] of Object.entries(props)) {
                            this.map.setPaintProperty(layerId, property, value);
                        }
                    }
                }
            }

            // Clear active paint
            this.activePaint.delete(key);

            console.log(`[MapLayerController] Paint reset for '${key}'`);
            return {
                success: true,
                layer: key,
                displayName: layer.displayName,
                message: 'Paint properties reset to defaults'
            };
        } catch (error) {
            console.error('[MapLayerController] Error resetting paint:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get current paint properties for a layer
     * @param {string} key - Layer key
     * @returns {Object} - Paint info or error
     */
    getLayerPaint(key) {
        const layer = this.layerRegistry.get(key);
        if (!layer) {
            return { success: false, error: `Unknown layer: ${key}` };
        }
        if (!layer.isVector) {
            return {
                success: false,
                error: `Layer '${key}' is a raster layer and does not have paint properties`
            };
        }

        const paint = this.activePaint.get(key) || {};
        return {
            success: true,
            layer: key,
            displayName: layer.displayName,
            paint: paint
        };
    }

    /**
     * Generate a human-readable description of a filter expression
     * @param {Array} filter - MapLibre filter expression
     * @returns {string} - Human-readable description
     */
    describeFilter(filter) {
        if (!filter || !Array.isArray(filter) || filter.length === 0) {
            return 'No filter';
        }

        const operator = filter[0];

        switch (operator) {
            case '==':
                return `${filter[1]} equals ${JSON.stringify(filter[2])}`;
            case '!=':
                return `${filter[1]} not equals ${JSON.stringify(filter[2])}`;
            case '>':
                return `${filter[1]} > ${filter[2]}`;
            case '>=':
                return `${filter[1]} >= ${filter[2]}`;
            case '<':
                return `${filter[1]} < ${filter[2]}`;
            case '<=':
                return `${filter[1]} <= ${filter[2]}`;
            case 'in':
                return `${filter[1]} in [${filter.slice(2).join(', ')}]`;
            case '!in':
                return `${filter[1]} not in [${filter.slice(2).join(', ')}]`;
            case 'has':
                return `has property ${filter[1]}`;
            case '!has':
                return `does not have property ${filter[1]}`;
            case 'all':
                return filter.slice(1).map(f => this.describeFilter(f)).join(' AND ');
            case 'any':
                return filter.slice(1).map(f => this.describeFilter(f)).join(' OR ');
            case 'none':
                return 'NOT (' + filter.slice(1).map(f => this.describeFilter(f)).join(' OR ') + ')';
            default:
                return JSON.stringify(filter);
        }
    }

    /**
     * Get a summary of all active filters and paint overrides
     * @returns {Object} - Summary of active customizations
     */
    getCustomizationSummary() {
        const summary = {
            activeFilters: {},
            activePaint: {}
        };

        for (const [key, filter] of this.activeFilters) {
            const layer = this.layerRegistry.get(key);
            summary.activeFilters[key] = {
                displayName: layer?.displayName || key,
                filter: filter,
                description: this.describeFilter(filter)
            };
        }

        for (const [key, paint] of this.activePaint) {
            const layer = this.layerRegistry.get(key);
            summary.activePaint[key] = {
                displayName: layer?.displayName || key,
                paint: paint
            };
        }

        return summary;
    }

    /**
     * Reset all customizations (filters and paint)
     * @returns {Object[]} - Array of result objects
     */
    resetAllCustomizations() {
        const results = [];

        // Clear all filters
        for (const key of this.activeFilters.keys()) {
            results.push(this.clearLayerFilter(key));
        }

        // Reset all paint
        for (const key of this.activePaint.keys()) {
            results.push(this.resetLayerPaint(key));
        }

        return results;
    }
}
