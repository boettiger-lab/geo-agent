// Import generic map control modules
import { layerRegistry } from './layer-registry.js';
import { configLoader } from './config-loader.js';
import { MapLayerController } from './map-layer-controller.js';
import { UILayerGenerator } from './ui-layer-generator.js';

// Register PMTiles protocol
let protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Initialize generic map controller after layers are loaded
let genericMapController = null;
let uiGenerator = null;

// MapController: API for chatbot to control the map
// Updated to use LayerRegistry for dynamic configuration
window.MapController = {
    // Store active filters for each layer
    activeFilters: {},

    // Get list of available layers and their current visibility
    getAvailableLayers: function () {
        const result = {};
        for (const [key, config] of layerRegistry.layers) {
            // Checkbox ID is either in config or generated
            const checkboxId = config.checkboxId || `${key}-toggle`;
            const checkbox = document.getElementById(checkboxId);
            result[key] = {
                displayName: config.displayName,
                visible: checkbox ? checkbox.checked : false
            };
        }
        return result;
    },

    // Set layer visibility
    setLayerVisibility: function (layerKey, visible) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            // Try to reload registry if empty? No, just error.
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${layerRegistry.getKeys().join(', ')}` };
        }

        // Check if map and layers are ready
        if (!window.map) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            const visibility = visible ? 'visible' : 'none';

            // Set visibility on all associated layer IDs
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    window.map.setLayoutProperty(layerId, 'visibility', visibility);
                }
            }

            // Update the checkbox to match (if action came from chat)
            const checkboxId = config.checkboxId || `${layerKey}-toggle`;
            const checkbox = document.getElementById(checkboxId);
            if (checkbox && checkbox.checked !== visible) {
                checkbox.checked = visible;
                // Dispatch event to update UI params visibility if needed
                checkbox.dispatchEvent(new Event('change'));
            }

            // Handle legend visibility
            if (config.hasLegend) {
                const legend = document.getElementById('legend');
                if (legend) {
                    legend.style.display = visible ? 'block' : 'none';
                }
            }

            console.log(`[MapController] Layer '${layerKey}' visibility set to ${visible}`);
            return {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                visible: visible
            };
        } catch (error) {
            console.error('[MapController] Error setting layer visibility:', error);
            return { success: false, error: error.message };
        }
    },

    // Toggle layer visibility
    toggleLayer: function (layerKey) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }

        const checkboxId = config.checkboxId || `${layerKey}-toggle`;
        const checkbox = document.getElementById(checkboxId);
        const currentlyVisible = checkbox ? checkbox.checked : false;
        return this.setLayerVisibility(layerKey, !currentlyVisible);
    },

    // Show only specified layers (hide all others)
    showOnlyLayers: function (layerKeys) {
        const results = [];
        for (const key of layerRegistry.getKeys()) {
            const shouldShow = layerKeys.includes(key);
            results.push(this.setLayerVisibility(key, shouldShow));
        }
        return results;
    },

    // Hide all overlay layers
    hideAllLayers: function () {
        const results = [];
        for (const key of layerRegistry.getKeys()) {
            results.push(this.setLayerVisibility(key, false));
        }
        return results;
    },

    // Show all overlay layers  
    showAllLayers: function () {
        const results = [];
        for (const key of layerRegistry.getKeys()) {
            results.push(this.setLayerVisibility(key, true));
        }
        return results;
    },

    // Get filterable properties for a vector layer
    getFilterableProperties: function (layerKey) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support filtering` };
        }
        return {
            success: true,
            layer: layerKey,
            displayName: config.displayName,
            properties: config.filterableProperties
        };
    },

    // Set a filter on a vector layer using MapLibre filter expressions
    setLayerFilter: function (layerKey, filter) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${layerRegistry.getKeys().join(', ')}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support filtering. Only vector layers (wdpa) can be filtered.` };
        }

        if (!window.map) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Apply filter to all layer IDs for this layer
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    window.map.setFilter(layerId, filter);
                    console.log(`[MapController] Filter applied to layer '${layerId}':`, filter);
                }
            }

            // Store the active filter
            this.activeFilters[layerKey] = filter;

            // Build a human-readable description of the filter
            const filterDescription = this.describeFilter(filter);

            // Query rendered features to count what's visible after filtering
            let featuresInView = 0;
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    const features = window.map.queryRenderedFeatures({ layers: [layerId] });
                    featuresInView += features.length;
                }
            }

            console.log(`[MapController] Filter result: ${featuresInView} features visible in current view`);

            // Build result with feature count
            const result = {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                filter: filter,
                description: filterDescription,
                featuresInView: featuresInView
            };

            // Add warning if no features match
            if (featuresInView === 0 && filter !== null) {
                result.warning = "No features match this filter in the current map view. The filter may be too restrictive, or the property values may not match the data. Consider checking available property values first.";
            }

            return result;
        } catch (error) {
            console.error('[MapController] Error setting filter:', error);
            return { success: false, error: `Failed to apply filter: ${error.message}` };
        }
    },

    // Clear filter from a layer (show all features)
    clearLayerFilter: function (layerKey) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not have filters` };
        }

        if (!window.map) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Remove filter from all layer IDs
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    window.map.setFilter(layerId, null);
                    console.log(`[MapController] Filter cleared from layer '${layerId}'`);
                }
            }

            // Remove from active filters
            delete this.activeFilters[layerKey];

            return {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                message: 'Filter cleared - showing all features'
            };
        } catch (error) {
            console.error('[MapController] Error clearing filter:', error);
            return { success: false, error: error.message };
        }
    },

    // Get current filter for a layer
    getLayerFilter: function (layerKey) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support filtering` };
        }

        const filter = this.activeFilters[layerKey] || null;
        return {
            success: true,
            layer: layerKey,
            displayName: config.displayName,
            filter: filter,
            hasFilter: filter !== null,
            description: filter ? this.describeFilter(filter) : 'No filter applied'
        };
    },

    // Helper: Generate human-readable description of a filter
    describeFilter: function (filter) {
        if (!filter || !Array.isArray(filter)) return 'No filter';

        const op = filter[0];

        // Handle comparison operators
        if (['==', '!=', '>', '<', '>=', '<='].includes(op)) {
            const prop = filter[1];
            const val = filter[2];
            const opText = {
                '==': 'equals',
                '!=': 'not equals',
                '>': 'greater than',
                '<': 'less than',
                '>=': 'at least',
                '<=': 'at most'
            }[op];
            return `${prop} ${opText} ${val}`;
        }

        // Handle 'in' operator
        if (op === 'in') {
            const prop = filter[1];
            const vals = filter.slice(2);
            return `${prop} is one of: ${vals.join(', ')}`;
        }

        // Handle 'all' (AND)
        if (op === 'all') {
            const conditions = filter.slice(1).map(f => this.describeFilter(f));
            return conditions.join(' AND ');
        }

        // Handle 'any' (OR)
        if (op === 'any') {
            const conditions = filter.slice(1).map(f => this.describeFilter(f));
            return `(${conditions.join(' OR ')})`;
        }

        // Handle 'has' / '!has'
        if (op === 'has') {
            return `has property '${filter[1]}'`;
        }
        if (op === '!has') {
            return `missing property '${filter[1]}'`;
        }

        // Fallback
        return JSON.stringify(filter);
    },

    // Default paint properties (legacy support)
    defaultPaint: {
        'wdpa': {
            'fill-color': '#2E7D32',
            'fill-opacity': 0.5,
            'line-color': '#1B5E20',
            'line-width': 1.5
        }
    },

    // Set a paint property on a vector layer (for data-driven styling)
    setLayerPaint: function (layerKey, property, value) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${layerRegistry.getKeys().join(', ')}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support paint styling. Only vector layers (wdpa) can be styled.` };
        }

        if (!window.map) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            const isFillProperty = property.startsWith('fill-');
            const isLineProperty = property.startsWith('line-');

            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    const layerType = window.map.getLayer(layerId).type;

                    if ((isFillProperty && layerType === 'fill') ||
                        (isLineProperty && layerType === 'line')) {
                        window.map.setPaintProperty(layerId, property, value);
                        console.log(`[MapController] Paint property '${property}' set on layer '${layerId}':`, value);
                    }
                }
            }

            // Build a human-readable description
            let description;
            if (Array.isArray(value) && value[0] === 'match') {
                const prop = value[1][1];
                description = `Coloring by ${prop}`;
            } else if (Array.isArray(value) && value[0] === 'interpolate') {
                const prop = value[2][1];
                description = `Gradient coloring by ${prop}`;
            } else if (Array.isArray(value) && value[0] === 'step') {
                const prop = value[1][1];
                description = `Stepped coloring by ${prop}`;
            } else {
                description = `Set ${property} to ${typeof value === 'string' ? value : JSON.stringify(value)}`;
            }

            return {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                property: property,
                value: value,
                description: description
            };
        } catch (error) {
            console.error('[MapController] Error setting paint property:', error);
            return { success: false, error: `Failed to apply paint property: ${error.message}` };
        }
    },

    // Reset paint properties to defaults for a vector layer
    resetLayerPaint: function (layerKey) {
        const config = layerRegistry.get(layerKey);
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support paint styling` };
        }

        if (!window.map) {
            return { success: false, error: 'Map not yet initialized' };
        }

        // TODO: Move defaultPaint to config.json
        const defaults = this.defaultPaint[layerKey] || config.defaultPaint;
        if (!defaults) {
            return { success: false, error: `No default paint properties defined for layer: ${layerKey}` };
        }

        try {
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    const layerType = window.map.getLayer(layerId).type;

                    if (layerType === 'fill') {
                        if (defaults['fill-color']) window.map.setPaintProperty(layerId, 'fill-color', defaults['fill-color']);
                        if (defaults['fill-opacity']) window.map.setPaintProperty(layerId, 'fill-opacity', defaults['fill-opacity']);
                    } else if (layerType === 'line') {
                        if (defaults['line-color']) window.map.setPaintProperty(layerId, 'line-color', defaults['line-color']);
                        if (defaults['line-width']) window.map.setPaintProperty(layerId, 'line-width', defaults['line-width']);
                    }
                }
            }

            return {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                message: 'Paint properties reset to defaults'
            };
        } catch (error) {
            console.error('[MapController] Error resetting paint:', error);
            return { success: false, error: error.message };
        }
    },

    // Helper function to generate species richness COG URL
    getSpeciesRichnessUrl: function (taxon, speciesType) {
        const taxonMap = {
            'combined': 'Combined',
            'amphibians': 'Amphibians',
            'birds': 'Birds',
            'mammals': 'Mammals',
            'reptiles': 'Reptiles',
            'fw_fish': 'FW_Fish'
        };

        const taxonName = taxonMap[taxon] || 'Combined';
        const typeCode = speciesType === 'threatened' ? 'THR_SR' : 'SR';
        const filename = `${taxonName}_${typeCode}_2025.tif`;
        const rescale = speciesType === 'threatened' ? '0,50' : '0,800';

        return `https://titiler.xyz/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=https://s3-west.nrp-nautilus.io/public-iucn/cog/richness/${filename}&rescale=${rescale}&colormap_name=turbo`;
    },

    // Set species richness filter (taxon and species type)
    setSpeciesRichnessFilter: function (speciesType, taxon) {
        const config = layerRegistry.get('species_richness');
        if (!config) {
            return { success: false, error: 'Species richness layer not configured' };
        }

        if (!window.map || !window.map.getSource) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            const typeCode = speciesType === 'threatened' ? 'thr_sr' : 'sr';
            config.currentTaxon = taxon;
            config.currentSpeciesType = typeCode;

            const newUrl = this.getSpeciesRichnessUrl(taxon, speciesType);

            // Update the source URL
            const source = window.map.getSource('species-richness-cog');
            if (source) {
                // Full remove/add strategy (robust)
                const isVisible = window.map.getLayoutProperty('species-richness-layer', 'visibility') === 'visible';

                if (window.map.getLayer('species-richness-layer')) window.map.removeLayer('species-richness-layer');
                if (window.map.getSource('species-richness-cog')) window.map.removeSource('species-richness-cog');

                window.map.addSource('species-richness-cog', {
                    type: 'raster',
                    tiles: [newUrl],
                    tileSize: 256
                });

                // Determine layer ordering
                const beforeLayer = window.map.getLayer('wdpa-layer') ? 'wdpa-layer' : undefined;

                window.map.addLayer({
                    id: 'species-richness-layer',
                    type: 'raster',
                    source: 'species-richness-cog',
                    paint: { 'raster-opacity': 0.7 },
                    layout: { visibility: isVisible ? 'visible' : 'none' }
                }, beforeLayer);

                console.log(`[MapController] Species richness filter updated: ${taxon}, ${speciesType}`);
            }

            const taxonNames = {
                'combined': 'All Groups',
                'amphibians': 'Amphibians',
                'birds': 'Birds',
                'mammals': 'Mammals',
                'reptiles': 'Reptiles',
                'fw_fish': 'Freshwater Fish'
            };

            return {
                success: true,
                layer: 'species_richness',
                speciesType: speciesType,
                taxon: taxon,
                displayName: config.displayName,
                description: `Showing ${speciesType === 'threatened' ? 'threatened' : 'all'} species for ${taxonNames[taxon] || taxon}`
            };
        } catch (error) {
            console.error('[MapController] Error setting species richness filter:', error);
            return { success: false, error: error.message };
        }
    },

    // Generic filter method for any layer
    filterLayer: function (layerId, filterParams) {
        if (layerId === 'species_richness') {
            // For species richness, filterParams can be passed as arguments object { taxon, species_type }
            // Ensure defaults
            const config = layerRegistry.get('species_richness');
            const currentTaxon = config.currentTaxon || 'combined';
            const currentType = (config.currentSpeciesType === 'thr_sr') || (config.currentSpeciesType === 'threatened') ? 'threatened' : 'all';

            // Check if params are passed 
            const taxon = filterParams.taxon || currentTaxon;
            const speciesType = filterParams.species_type || currentType;

            return this.setSpeciesRichnessFilter(speciesType, taxon);
        }

        const config = layerRegistry.get(layerId);
        if (!config) return { success: false, error: `Unknown layer: ${layerId}` };

        if (config.isVector) {
            if (!Array.isArray(filterParams)) {
                return { success: false, error: `Layer ${layerId} expects a MapLibre filter array.` };
            }
            return this.setLayerFilter(layerId, filterParams);
        }

        return { success: false, error: `Layer ${layerId} does not support filtering.` };
    },

    // Generic style/paint method
    styleLayer: function (layerId, styleParams) {
        const config = layerRegistry.get(layerId);
        if (!config) return { success: false, error: `Unknown layer: ${layerId}` };

        if (config.isVector) {
            const results = [];
            for (const [prop, val] of Object.entries(styleParams)) {
                results.push(this.setLayerPaint(layerId, prop, val));
            }
            return { success: true, updates: results };
        }

        return { success: false, error: `Layer ${layerId} does not support dynamic paint styling.` };
    }
};

const map = new maplibregl.Map({
    container: 'map',
    style: 'https://api.maptiler.com/maps/dataviz-v4/style.json?key=0Vzl9yHwu0Xyx4TwT2Iw',
    center: [0, 20],
    zoom: 2
});

window.map = map;

// Map Load Event - Initialize Dynamic Layers
map.on('load', async function () {
    console.log('Map loaded, initializing layers...');

    try {
        // 1. Load configuration
        // Using ConfigLoader to fetch STAC metadata dynamically
        await configLoader.loadAndRegister('layers-input.json');

        // Apply initial view if configured
        const initialView = layerRegistry.getView();
        if (initialView) {
            console.log('Setting initial map view:', initialView);
            map.jumpTo({
                center: initialView.center,
                zoom: initialView.zoom
            });
        }

        // 2. Initialize layers on the map
        for (const [key, config] of layerRegistry.layers) {

            // Add Source
            if (config.source) {
                const sourceOptions = { ...config.source };

                // Determine source ID
                // Historic naming convention: 
                let sourceId = `${key}-source`;
                if (key === 'species_richness') sourceId = 'species-richness-cog';
                if (key === 'carbon') sourceId = 'carbon-cog';

                if (!map.getSource(sourceId)) {
                    map.addSource(sourceId, sourceOptions);
                }

                // Add Layer(s)
                if (config.layer) {
                    const layerDef = {
                        id: config.layerIds[0], // Primary layer ID
                        source: sourceId,
                        ...config.layer
                    };

                    if (config.isVector && config.sourceLayer) {
                        layerDef['source-layer'] = config.sourceLayer;
                    }

                    map.addLayer(layerDef);
                } else if (config.layerIds.length > 0 && config.sourceUrl) {
                    // Legacy/CPAD handling for layers without 'layer' block but with URL
                    // This is a fallback or for layers like CPAD that might be complex
                    // Assuming CPAD manually handled or needs config update. 
                    // For now, if no layer block, we might skip adding layer automatically 
                    // unless we handle CPAD specifically.
                    // The original map.js didn't have CPAD hardcoded in 'load', it was likely handled elsewhere or via tools?
                    // Wait, the original `map.js` I read did NOT have CPAD in `map.on('load')`.
                    // It only had carbon, species, wdpa.
                    // So CPAD must be handled by `initLayers` or similar? 
                    // Ah, `MCPTool` usually added it? 
                    // No, `layers-config.json` listed it.
                    // If `map.js` didn't add it, safe to ignore for auto-init unless we want it auto-loaded.
                    // The requirement is "streamline ... index.html is hardwiring ... carbon, species, protected areas".
                    // So I've handled those.
                }

                // Handle Popup for WDPA
                if (config.popup && config.isVector) {
                    const layerId = config.layerIds[0];
                    map.on('click', layerId, (e) => {
                        const props = e.features[0].properties;
                        let title = config.popup.title;
                        // Simple template replacement
                        title = title.replace(/{(\w+)}/g, (_, k) => props[k] || '');
                        // fallback if empty
                        if (title.trim() === '||') title = 'Feature';

                        let content = `<strong>${title}</strong>`;
                        if (config.popup.fields) {
                            content += '<br>';
                            content += config.popup.fields.map(f => {
                                const val = props[f.property];
                                return val ? `${f.label}: ${val}${f.suffix || ''}` : '';
                            }).filter(Boolean).join('<br>');
                        }
                        new maplibregl.Popup()
                            .setLngLat(e.lngLat)
                            .setHTML(content)
                            .addTo(map);
                    });

                    map.on('mouseenter', layerId, () => map.getCanvas().style.cursor = 'pointer');
                    map.on('mouseleave', layerId, () => map.getCanvas().style.cursor = '');
                }
            }
        }

        // 3. Initialize UI
        uiGenerator = new UILayerGenerator('layer-controls-container', window.MapController);
        uiGenerator.generateControls();

        console.log('Dynamic layers initialized.');

    } catch (e) {
        console.error('Failed to initialize layers:', e);
    }
});
