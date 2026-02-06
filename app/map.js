// Import generic map control modules
import { layerRegistry } from './layer-registry.js';
import { MapLayerController } from './map-layer-controller.js';

// Register PMTiles protocol
let protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Initialize generic map controller after layers are loaded
let genericMapController = null;

// MapController: API for chatbot to control the map (legacy compatibility wrapper)
// This wraps the new generic MapLayerController for backward compatibility
window.MapController = {
    // Legacy layers object (will be populated from LayerRegistry)
    layers: {
        'carbon': {
            displayName: 'Vulnerable Carbon',
            layerIds: ['carbon-layer'],
            checkboxId: 'carbon-layer',
            hasLegend: false,
            isVector: false
        },
        'species_richness': {
            displayName: 'Species Richness',
            layerIds: ['species-richness-layer'],
            checkboxId: 'species-richness-layer',
            hasLegend: false,
            isVector: false,
            currentTaxon: 'combined',
            currentSpeciesType: 'sr'
        },
        'wdpa': {
            displayName: 'Protected Areas (WDPA)',
            layerIds: ['wdpa-layer'],
            checkboxId: 'wdpa-layer',
            hasLegend: false,
            isVector: true,
            sourceLayer: 'wdpa',
            filterableProperties: {
                'NAME_ENG': { type: 'string', description: 'Site name in English' },
                'NAME': { type: 'string', description: 'Site name (original)' },
                'DESIG_ENG': { type: 'string', description: 'Designation type in English' },
                'DESIG_TYPE': { type: 'string', description: 'Designation type category' },
                'IUCN_CAT': {
                    type: 'string',
                    description: 'IUCN management category',
                    values: ['Ia', 'Ib', 'II', 'III', 'IV', 'V', 'VI', 'Not Reported', 'Not Applicable', 'Not Assigned']
                },
                'ISO3': { type: 'string', description: 'ISO 3-letter country code' },
                'STATUS': { type: 'string', description: 'Current status (e.g., Designated, Proposed)' },
                'STATUS_YR': { type: 'number', description: 'Year of status' },
                'GOV_TYPE': { type: 'string', description: 'Governance type' },
                'OWN_TYPE': { type: 'string', description: 'Ownership type' },
                'GIS_AREA': { type: 'number', description: 'GIS-calculated area in km²' },
                'REP_AREA': { type: 'number', description: 'Reported area in km²' },
                'MARINE': { type: 'string', description: 'Marine designation (0, 1, 2)' },
                'NO_TAKE': { type: 'string', description: 'No-take zone status' }
            }
        }
    },

    // Store active filters for each layer
    activeFilters: {},

    // Get list of available layers and their current visibility
    getAvailableLayers: function () {
        const result = {};
        for (const [key, config] of Object.entries(this.layers)) {
            const checkbox = document.getElementById(config.checkboxId);
            result[key] = {
                displayName: config.displayName,
                visible: checkbox ? checkbox.checked : false
            };
        }
        return result;
    },

    // Set layer visibility
    setLayerVisibility: function (layerKey, visible) {
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${Object.keys(this.layers).join(', ')}` };
        }

        // Check if map and layers are ready
        if (!window.map || !window.map.getLayer) {
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

            // Update the checkbox to match
            const checkbox = document.getElementById(config.checkboxId);
            if (checkbox) {
                checkbox.checked = visible;
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
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }

        const checkbox = document.getElementById(config.checkboxId);
        const currentlyVisible = checkbox ? checkbox.checked : false;
        return this.setLayerVisibility(layerKey, !currentlyVisible);
    },

    // Show only specified layers (hide all others)
    showOnlyLayers: function (layerKeys) {
        const results = [];
        for (const key of Object.keys(this.layers)) {
            const shouldShow = layerKeys.includes(key);
            results.push(this.setLayerVisibility(key, shouldShow));
        }
        return results;
    },

    // Hide all overlay layers
    hideAllLayers: function () {
        const results = [];
        for (const key of Object.keys(this.layers)) {
            results.push(this.setLayerVisibility(key, false));
        }
        return results;
    },

    // Show all overlay layers  
    showAllLayers: function () {
        const results = [];
        for (const key of Object.keys(this.layers)) {
            results.push(this.setLayerVisibility(key, true));
        }
        return results;
    },

    // Get filterable properties for a vector layer
    getFilterableProperties: function (layerKey) {
        const config = this.layers[layerKey];
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
    // filter should be a valid MapLibre filter expression array, e.g.:
    //   ["==", "IUCN_CAT", "II"]
    //   ["in", "IUCN_CAT", "Ia", "Ib", "II"]
    //   ["all", ["==", "Criterion1", true], ["==", "Criterion2", true]]
    //   [">=", "area_off", 10000]
    setLayerFilter: function (layerKey, filter) {
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${Object.keys(this.layers).join(', ')}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support filtering. Only vector layers (wdpa) can be filtered.` };
        }

        if (!window.map || !window.map.getLayer) {
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

            return {
                success: true,
                layer: layerKey,
                displayName: config.displayName,
                filter: filter,
                description: filterDescription
            };
        } catch (error) {
            console.error('[MapController] Error setting filter:', error);
            return { success: false, error: `Failed to apply filter: ${error.message}` };
        }
    },

    // Clear filter from a layer (show all features)
    clearLayerFilter: function (layerKey) {
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not have filters` };
        }

        if (!window.map || !window.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Remove filter from all layer IDs (set to null or undefined)
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
        const config = this.layers[layerKey];
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

    // Default paint properties for each vector layer (for reset functionality)
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
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}. Available layers: ${Object.keys(this.layers).join(', ')}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support paint styling. Only vector layers (wdpa) can be styled.` };
        }

        if (!window.map || !window.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        try {
            // Determine which layer ID(s) to apply the property to
            // fill-* properties go to fill layers, line-* properties go to line/outline layers
            const isFillProperty = property.startsWith('fill-');
            const isLineProperty = property.startsWith('line-');

            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    const layerType = window.map.getLayer(layerId).type;

                    // Apply fill properties to fill layers, line properties to line layers
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
                const prop = value[1][1]; // ["get", "property_name"] -> property_name
                description = `Coloring by ${prop}`;
            } else if (Array.isArray(value) && value[0] === 'interpolate') {
                const prop = value[2][1]; // ["get", "property_name"]
                description = `Gradient coloring by ${prop}`;
            } else if (Array.isArray(value) && value[0] === 'step') {
                const prop = value[1][1]; // ["get", "property_name"]
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
        const config = this.layers[layerKey];
        if (!config) {
            return { success: false, error: `Unknown layer: ${layerKey}` };
        }
        if (!config.isVector) {
            return { success: false, error: `Layer '${layerKey}' is a raster layer and does not support paint styling` };
        }

        if (!window.map || !window.map.getLayer) {
            return { success: false, error: 'Map not yet initialized' };
        }

        const defaults = this.defaultPaint[layerKey];
        if (!defaults) {
            return { success: false, error: `No default paint properties defined for layer: ${layerKey}` };
        }

        try {
            for (const layerId of config.layerIds) {
                if (window.map.getLayer(layerId)) {
                    const layerType = window.map.getLayer(layerId).type;

                    if (layerType === 'fill') {
                        if (defaults['fill-color']) {
                            window.map.setPaintProperty(layerId, 'fill-color', defaults['fill-color']);
                        }
                        if (defaults['fill-opacity']) {
                            window.map.setPaintProperty(layerId, 'fill-opacity', defaults['fill-opacity']);
                        }
                    } else if (layerType === 'line') {
                        if (defaults['line-color']) {
                            window.map.setPaintProperty(layerId, 'line-color', defaults['line-color']);
                        }
                        if (defaults['line-width']) {
                            window.map.setPaintProperty(layerId, 'line-width', defaults['line-width']);
                        }
                    }
                    console.log(`[MapController] Paint reset to defaults on layer '${layerId}'`);
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
        // speciesType: 'all' or 'threatened'
        // taxon: 'combined', 'amphibians', 'birds', 'mammals', 'reptiles', 'fw_fish'

        // Map taxon to capitalized filename format
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

        // Use much lower rescale range for threatened species to get better contrast
        const rescale = speciesType === 'threatened' ? '0,50' : '0,800';

        return `https://titiler.xyz/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=https://s3-west.nrp-nautilus.io/public-iucn/cog/richness/${filename}&rescale=${rescale}&colormap_name=turbo`;
    },

    // Set species richness filter (taxon and species type)
    setSpeciesRichnessFilter: function (speciesType, taxon) {
        // speciesType: 'all' or 'threatened'
        // taxon: 'combined', 'amphibians', 'birds', 'mammals', 'reptiles', 'fw_fish'

        const config = this.layers['species_richness'];
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
                // Remove and re-add the source with new URL
                window.map.removeLayer('species-richness-layer');
                window.map.removeSource('species-richness-cog');

                window.map.addSource('species-richness-cog', {
                    type: 'raster',
                    tiles: [newUrl],
                    tileSize: 256
                });

                // Determine layer ordering: add before wdpa-layer if it exists, otherwise add at end
                const beforeLayer = window.map.getLayer('wdpa-layer') ? 'wdpa-layer' : undefined;

                // Check checkbox state to determine initial visibility
                const checkbox = document.getElementById('species-richness-layer');
                const shouldBeVisible = checkbox && checkbox.checked;

                window.map.addLayer({
                    id: 'species-richness-layer',
                    type: 'raster',
                    source: 'species-richness-cog',
                    paint: {
                        'raster-opacity': 0.7
                    },
                    layout: {
                        visibility: shouldBeVisible ? 'visible' : 'none'
                    }
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
    }
};

const map = new maplibregl.Map({
    container: 'map',
    // projection: 'globe',
    style: 'https://api.maptiler.com/maps/dataviz-v4/style.json?key=0Vzl9yHwu0Xyx4TwT2Iw',
    center: [0, 20],
    zoom: 2
});

// Expose map globally for MapController access
window.map = map;

// Add error handlers for debugging
map.on('error', function (e) {
    console.error('Map error:', e);
});

map.on('styleimagemissing', function (e) {
    console.warn('Style image missing:', e.id);
});

// Store style URLs
const darkStyleUrl = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const datavizStyleUrl = 'https://api.maptiler.com/maps/dataviz-v4/style.json?key=0Vzl9yHwu0Xyx4TwT2Iw';

// Wait for map to load before adding layers
map.on('load', function () {
    console.log('Map loaded, adding layers...');

    // Add vulnerable carbon layer
    map.addSource('carbon-cog', {
        'type': 'raster',
        'tiles': [
            'https://titiler.nrp-nautilus.io/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=https://s3-west.nrp-nautilus.io/public-carbon/cogs/vulnerable_c_total_2018.tif&colormap_name=reds'
        ],
        'tileSize': 256,
        'minzoom': 0,
        'maxzoom': 12,
        'attribution': '<a href="https://www.conservation.org/irrecoverable-carbon" target="_blank">Irrecoverable Carbon (CI 2018)</a>'
    });

    map.addLayer({
        'id': 'carbon-layer',
        'type': 'raster',
        'source': 'carbon-cog',
        'paint': {
            'raster-opacity': 0.7
        },
        'layout': {
            'visibility': 'none'
        }
    });

    console.log('Carbon layer added successfully');

    // Add species richness layer (default: combined, all species)
    const defaultSpeciesUrl = window.MapController.getSpeciesRichnessUrl('combined', 'all');
    map.addSource('species-richness-cog', {
        'type': 'raster',
        'tiles': [defaultSpeciesUrl],
        'tileSize': 256,
        'minzoom': 0,
        'maxzoom': 12,
        'attribution': '<a href="https://www.iucnredlist.org/" target="_blank">IUCN Red List 2025</a>'
    });

    map.addLayer({
        'id': 'species-richness-layer',
        'type': 'raster',
        'source': 'species-richness-cog',
        'paint': {
            'raster-opacity': 0.7
        },
        'layout': {
            'visibility': 'none'
        }
    });

    console.log('Species richness layer added successfully');

    // Add WDPA protected areas PMTiles layer
    map.addSource('wdpa-source', {
        'type': 'vector',
        'url': 'pmtiles://https://s3-west.nrp-nautilus.io/public-wdpa/WDPA_Dec2025.pmtiles',
        'attribution': '<a href="https://www.protectedplanet.net/" target="_blank">World Database on Protected Areas</a>'
    });

    map.addLayer({
        'id': 'wdpa-layer',
        'type': 'fill',
        'source': 'wdpa-source',
        'source-layer': 'wdpa',
        'minzoom': 0,
        'maxzoom': 22,
        'paint': {
            'fill-color': '#2E7D32',
            'fill-opacity': 0.5
        },
        'layout': {
            'visibility': 'none'
        }
    });

    // Add click popup for WDPA sites
    map.on('click', 'wdpa-layer', (e) => {
        const coordinates = e.lngLat;
        const properties = e.features[0].properties;

        new maplibregl.Popup()
            .setLngLat(coordinates)
            .setHTML(`
                    <strong>${properties.NAME_ENG || properties.NAME || 'Protected Area'}</strong><br>
                    ${properties.DESIG_ENG ? 'Type: ' + properties.DESIG_ENG + '<br>' : ''}
                    ${properties.IUCN_CAT ? 'IUCN Category: ' + properties.IUCN_CAT + '<br>' : ''}
                    ${properties.OWN_TYPE ? 'Ownership: ' + properties.OWN_TYPE + '<br>' : ''}
                    ${properties.GIS_AREA ? 'Area: ' + properties.GIS_AREA + ' km²<br>' : ''}
                    ${properties.STATUS_YR ? 'Year: ' + properties.STATUS_YR + '<br>' : ''}
                `)
            .addTo(map);
    });

    // Change cursor on hover
    map.on('mouseenter', 'wdpa-layer', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'wdpa-layer', () => {
        map.getCanvas().style.cursor = '';
    });

    console.log('WDPA layer added successfully');

    // Set up carbon layer toggle
    const carbonCheckbox = document.getElementById('carbon-layer');
    if (carbonCheckbox) {
        carbonCheckbox.addEventListener('change', function () {
            if (this.checked) {
                map.setLayoutProperty('carbon-layer', 'visibility', 'visible');
            } else {
                map.setLayoutProperty('carbon-layer', 'visibility', 'none');
            }
        });
    }

    // Set up species richness layer toggle
    const speciesRichnessCheckbox = document.getElementById('species-richness-layer');
    const speciesRichnessControls = document.getElementById('species-richness-controls');
    if (speciesRichnessCheckbox) {
        speciesRichnessCheckbox.addEventListener('change', function () {
            const visibility = this.checked ? 'visible' : 'none';
            map.setLayoutProperty('species-richness-layer', 'visibility', visibility);

            // Toggle controls visibility
            if (speciesRichnessControls) {
                speciesRichnessControls.style.display = this.checked ? 'block' : 'none';
            }
        });
    }

    // Set up species richness filter controls
    const speciesTypeRadios = document.querySelectorAll('input[name="species-type"]');
    const speciesTaxonSelect = document.getElementById('species-taxon');

    function updateSpeciesRichnessLayer() {
        const speciesType = document.querySelector('input[name="species-type"]:checked')?.value || 'all';
        const taxon = speciesTaxonSelect?.value || 'combined';
        window.MapController.setSpeciesRichnessFilter(speciesType, taxon);
    }

    speciesTypeRadios.forEach(radio => {
        radio.addEventListener('change', updateSpeciesRichnessLayer);
    });

    if (speciesTaxonSelect) {
        speciesTaxonSelect.addEventListener('change', updateSpeciesRichnessLayer);
    }

    // Set up WDPA layer toggle
    const wdpaCheckbox = document.getElementById('wdpa-layer');
    if (wdpaCheckbox) {
        wdpaCheckbox.addEventListener('change', function () {
            const visibility = this.checked ? 'visible' : 'none';
            map.setLayoutProperty('wdpa-layer', 'visibility', visibility);
        });
    }
});

// Base layer switcher functionality
function switchBaseLayer(styleName) {
    const styleUrl = styleName === 'dark' ? darkStyleUrl : datavizStyleUrl;

    // Store current layer states
    const carbonVisible = map.getLayer('carbon-layer') ?
        map.getLayoutProperty('carbon-layer', 'visibility') !== 'none' : false;
    const speciesRichnessVisible = map.getLayer('species-richness-layer') ?
        map.getLayoutProperty('species-richness-layer', 'visibility') !== 'none' : false;
    const wdpaVisible = map.getLayer('wdpa-layer') ?
        map.getLayoutProperty('wdpa-layer', 'visibility') !== 'none' : false;

    // Store current species richness filter state
    const currentTaxon = window.MapController.layers.species_richness?.currentTaxon || 'combined';
    const currentSpeciesType = window.MapController.layers.species_richness?.currentSpeciesType || 'sr';

    map.setStyle(styleUrl);

    // Re-add layers after style loads
    map.once('styledata', function () {
        // Re-add carbon layer
        map.addSource('carbon-cog', {
            'type': 'raster',
            'tiles': [
                'https://titiler.nrp-nautilus.io/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=https://s3-west.nrp-nautilus.io/public-carbon/cogs/vulnerable_c_total_2018.tif&colormap_name=reds'
            ],
            'tileSize': 256,
            'minzoom': 0,
            'maxzoom': 12,
            'attribution': '<a href="https://www.conservation.org/irrecoverable-carbon" target="_blank">Irrecoverable Carbon (CI 2018)</a>'
        });

        map.addLayer({
            'id': 'carbon-layer',
            'type': 'raster',
            'source': 'carbon-cog',
            'paint': {
                'raster-opacity': 0.7
            }
        });

        if (!carbonVisible) {
            map.setLayoutProperty('carbon-layer', 'visibility', 'none');
            document.getElementById('carbon-layer').checked = false;
        }

        // Re-add species richness layer with current filter
        const speciesUrl = currentSpeciesType === 'thr_sr' ?
            window.MapController.getSpeciesRichnessUrl(currentTaxon, 'threatened') :
            window.MapController.getSpeciesRichnessUrl(currentTaxon, 'all');

        map.addSource('species-richness-cog', {
            'type': 'raster',
            'tiles': [speciesUrl],
            'tileSize': 256,
            'minzoom': 0,
            'maxzoom': 12,
            'attribution': '<a href="https://www.iucnredlist.org/" target="_blank">IUCN Red List 2025</a>'
        });

        map.addLayer({
            'id': 'species-richness-layer',
            'type': 'raster',
            'source': 'species-richness-cog',
            'paint': {
                'raster-opacity': 0.7
            }
        }, 'wdpa-layer');

        if (!speciesRichnessVisible) {
            map.setLayoutProperty('species-richness-layer', 'visibility', 'none');
            document.getElementById('species-richness-layer').checked = false;
        }

        // Re-add WDPA layer
        map.addSource('wdpa-source', {
            'type': 'vector',
            'url': 'pmtiles://https://s3-west.nrp-nautilus.io/public-wdpa/WDPA_Dec2025.pmtiles',
            'attribution': '<a href="https://www.protectedplanet.net/" target="_blank">World Database on Protected Areas</a>'
        });

        map.addLayer({
            'id': 'wdpa-layer',
            'type': 'fill',
            'source': 'wdpa-source',
            'source-layer': 'wdpa',
            'minzoom': 0,
            'maxzoom': 22,
            'paint': {
                'fill-color': '#2E7D32',
                'fill-opacity': 0.5
            }
        });

        if (!wdpaVisible) {
            map.setLayoutProperty('wdpa-layer', 'visibility', 'none');
            document.getElementById('wdpa-layer').checked = false;
        }
    });
}

document.querySelectorAll('input[name="basemap"]').forEach(radio => {
    radio.addEventListener('change', function () {
        if (this.checked) {
            switchBaseLayer(this.value);
        }
    });
});

// Initialize generic map controller after map is fully loaded
map.on('load', async function () {
    try {
        // Load layer configuration if not already loaded
        if (layerRegistry.getKeys().length === 0) {
            await layerRegistry.loadFromJson('layers-config.json');
            console.log('✓ Layer registry loaded in map.js:', layerRegistry.getSummary());
        }

        // Create generic map controller
        genericMapController = new MapLayerController(window.map, layerRegistry);

        // Update legacy MapController to delegate to generic controller
        // This provides backward compatibility
        window.MapController.getAvailableLayers = () => genericMapController.getAvailableLayers();
        window.MapController.setLayerVisibility = (k, v) => genericMapController.setLayerVisibility(k, v);
        window.MapController.toggleLayer = (k) => genericMapController.toggleLayer(k);
        window.MapController.showOnlyLayers = (ks) => genericMapController.showOnlyLayers(ks);
        window.MapController.hideAllLayers = () => genericMapController.hideAllLayers();
        window.MapController.showAllLayers = () => genericMapController.showAllLayers();
        window.MapController.getFilterableProperties = (k) => genericMapController.getFilterableProperties(k);
        window.MapController.setLayerFilter = (k, f) => genericMapController.setLayerFilter(k, f);
        window.MapController.clearLayerFilter = (k) => genericMapController.clearLayerFilter(k);
        window.MapController.getLayerFilter = (k) => genericMapController.getLayerFilter(k);
        window.MapController.setLayerPaint = (k, p, v) => genericMapController.setLayerPaint(k, p, v);
        window.MapController.resetLayerPaint = (k) => genericMapController.resetLayerPaint(k);
        window.MapController.describeFilter = (f) => genericMapController.describeFilter(f);

        console.log('✓ Generic map controller initialized and integrated');
    } catch (error) {
        console.error('Failed to initialize generic map controller:', error);
    }
});
