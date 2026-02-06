/**
 * Example: Adding a New Layer to the System
 * 
 * This file demonstrates how to add a new map layer to the generic
 * map tools system. There are three approaches, ranked by preference.
 */

// ============================================================================
// METHOD 1: Configuration File (RECOMMENDED)
// ============================================================================

/**
 * The easiest and most maintainable way to add a layer is by editing
 * the layers-config.json file. No JavaScript code changes needed!
 * 
 * Steps:
 * 1. Open layers-config.json
 * 2. Add your layer definition under "layers"
 * 3. Save and reload the application
 * 
 * Example layer entry:
 */

const exampleLayerConfig = {
    "unesco_sites": {
        "displayName": "UNESCO World Heritage Sites",
        "layerIds": ["unesco-fill", "unesco-outline"],
        "checkboxId": "unesco-layer",
        "hasLegend": false,
        "isVector": true,
        "sourceLayer": "unesco_sites",
        "sourceUrl": "pmtiles://https://example.com/unesco-sites.pmtiles",
        "dataTablePath": "s3://public-unesco/sites/hex/**",
        "description": "UNESCO World Heritage Sites with cultural and natural significance",
        "filterableProperties": {
            "site_name": {
                "type": "string",
                "description": "Official name of the UNESCO site"
            },
            "category": {
                "type": "string",
                "description": "Site category",
                "values": ["Cultural", "Natural", "Mixed"]
            },
            "year_inscribed": {
                "type": "number",
                "description": "Year the site was inscribed"
            },
            "endangered": {
                "type": "boolean",
                "description": "Whether site is on the Danger List"
            },
            "area_hectares": {
                "type": "number",
                "description": "Site area in hectares"
            },
            "country": {
                "type": "string",
                "description": "Country where site is located"
            }
        }
    }
};

/**
 * Once added to layers-config.json, the layer will automatically:
 * - Appear in the chatbot's toggle_map_layer tool
 * - Be filterable via filter_map_layer tool
 * - Support data-driven styling via set_layer_paint
 * - Be included in get_map_layers listing
 * - Have property validation for filters
 * 
 * Users can immediately ask:
 * - "Show UNESCO sites"
 * - "Filter to endangered UNESCO sites"
 * - "Show only cultural sites inscribed after 2000"
 * - "Color UNESCO sites by category"
 */

// ============================================================================
// METHOD 2: Runtime Registration (ADVANCED)
// ============================================================================

/**
 * For dynamic layers that are discovered at runtime or loaded
 * from external sources, use the LayerRegistry API.
 */

import { layerRegistry } from './layer-registry.js';
import { MCPToolFactory } from './mcp-tool-factory.js';

async function addDynamicLayer() {
    // Register the layer
    layerRegistry.register('dynamic_unesco', {
        displayName: 'UNESCO World Heritage Sites (Dynamic)',
        layerIds: ['unesco-fill', 'unesco-outline'],
        checkboxId: 'unesco-layer',
        hasLegend: false,
        isVector: true,
        sourceLayer: 'unesco_sites',
        sourceUrl: 'pmtiles://https://example.com/unesco-sites.pmtiles',
        dataTablePath: 's3://public-unesco/sites/hex/**',
        description: 'UNESCO World Heritage Sites',
        filterableProperties: {
            site_name: { type: 'string', description: 'Site name' },
            category: { type: 'string', description: 'Category', values: ['Cultural', 'Natural', 'Mixed'] },
            year_inscribed: { type: 'number', description: 'Year inscribed' },
            endangered: { type: 'boolean', description: 'On Danger List' }
        }
    });

    // Regenerate tools to include the new layer
    // (Assuming you have access to the chatbot instance)
    if (window.chatbot && window.chatbot.toolFactory) {
        window.chatbot.localTools = window.chatbot.toolFactory.regenerate();
        console.log('Tools regenerated with new layer');
    }
}

// ============================================================================
// METHOD 3: Database Schema Discovery (EXPERT)
// ============================================================================

/**
 * For layers where you want to automatically discover properties
 * from the database schema, use updateFromSchema().
 */

async function addLayerFromDatabase() {
    // First, register the layer with basic info
    layerRegistry.register('unesco', {
        displayName: 'UNESCO World Heritage Sites',
        layerIds: ['unesco-fill', 'unesco-outline'],
        checkboxId: 'unesco-layer',
        hasLegend: false,
        isVector: true,
        sourceLayer: 'unesco_sites',
        sourceUrl: 'pmtiles://https://example.com/unesco-sites.pmtiles',
        dataTablePath: 's3://public-unesco/sites/hex/**'
    });

    // Query database schema (pseudo-code - adapt to your MCP setup)
    const schema = await queryDuckDB(`
    SELECT 
      column_name as name,
      data_type as type
    FROM (
      DESCRIBE SELECT * 
      FROM read_parquet('s3://public-unesco/sites/hex/**')
      LIMIT 1
    )
  `);

    // Update layer with discovered properties
    layerRegistry.updateFromSchema('unesco', {
        columns: schema.map(row => ({
            name: row.name,
            type: row.type,
            description: `Database column: ${row.name}`
        }))
    });

    console.log('Layer updated with schema from database');
}

// ============================================================================
// COMPLETE EXAMPLE: Adding UNESCO Sites Layer
// ============================================================================

/**
 * This example shows the complete workflow for adding a new layer,
 * including map initialization and usage examples.
 */

class UNESCOLayerExample {
    constructor(map, layerRegistry, mapController) {
        this.map = map;
        this.layerRegistry = layerRegistry;
        this.mapController = mapController;
    }

    /**
     * Step 1: Add the PMTiles source to the map
     */
    addMapSource() {
        this.map.addSource('unesco-source', {
            type: 'vector',
            url: 'pmtiles://https://example.com/unesco-sites.pmtiles',
            attribution: '<a href="https://whc.unesco.org/" target="_blank">UNESCO</a>'
        });
    }

    /**
     * Step 2: Add map layers (fill and outline)
     */
    addMapLayers() {
        // Fill layer
        this.map.addLayer({
            id: 'unesco-fill',
            type: 'fill',
            source: 'unesco-source',
            'source-layer': 'unesco_sites',
            paint: {
                'fill-color': '#1976D2',
                'fill-opacity': 0.6
            }
        });

        // Outline layer
        this.map.addLayer({
            id: 'unesco-outline',
            type: 'line',
            source: 'unesco-source',
            'source-layer': 'unesco_sites',
            paint: {
                'line-color': '#0D47A1',
                'line-width': 2
            }
        });

        // Initially hidden
        this.map.setLayoutProperty('unesco-fill', 'visibility', 'none');
        this.map.setLayoutProperty('unesco-outline', 'visibility', 'none');
    }

    /**
     * Step 3: Register in LayerRegistry (or add to config file)
     */
    registerLayer() {
        this.layerRegistry.register('unesco', {
            displayName: 'UNESCO World Heritage Sites',
            layerIds: ['unesco-fill', 'unesco-outline'],
            checkboxId: 'unesco-layer',
            hasLegend: false,
            isVector: true,
            sourceLayer: 'unesco_sites',
            sourceUrl: 'pmtiles://https://example.com/unesco-sites.pmtiles',
            dataTablePath: 's3://public-unesco/sites/hex/**',
            filterableProperties: {
                site_name: { type: 'string', description: 'Site name' },
                category: {
                    type: 'string',
                    description: 'Heritage category',
                    values: ['Cultural', 'Natural', 'Mixed']
                },
                year_inscribed: { type: 'number', description: 'Year inscribed' },
                endangered: { type: 'boolean', description: 'Endangered status' },
                area_hectares: { type: 'number', description: 'Area in hectares' },
                country: { type: 'string', description: 'Country' }
            }
        });
    }

    /**
     * Step 4: Add UI checkbox
     */
    addUICheckbox() {
        const menu = document.getElementById('menu');
        const checkboxGroup = menu.querySelector('.checkbox-group');

        const label = document.createElement('label');
        label.innerHTML = `
      <input id="unesco-layer" type="checkbox" name="rtoggle" value="unesco">
      <span>UNESCO Sites</span>
    `;

        checkboxGroup.appendChild(label);

        // Add event listener
        document.getElementById('unesco-layer').addEventListener('change', (e) => {
            this.mapController.setLayerVisibility('unesco', e.target.checked);
        });
    }

    /**
     * Complete setup
     */
    setup() {
        this.addMapSource();
        this.addMapLayers();
        this.registerLayer();
        this.addUICheckbox();
        console.log('UNESCO layer added successfully!');
    }

    /**
     * Usage examples after setup
     */
    demonstrateUsage() {
        // Show the layer
        this.mapController.setLayerVisibility('unesco', true);

        // Filter to endangered sites
        this.mapController.setLayerFilter('unesco', ['==', 'endangered', true]);

        // Filter to cultural sites inscribed after 2000
        this.mapController.setLayerFilter('unesco', [
            'all',
            ['==', 'category', 'Cultural'],
            ['>=', 'year_inscribed', 2000]
        ]);

        // Color by category
        this.mapController.setLayerPaint('unesco', 'fill-color', [
            'match',
            ['get', 'category'],
            'Cultural', '#E91E63',  // Pink for cultural
            'Natural', '#4CAF50',    // Green for natural
            'Mixed', '#FF9800',      // Orange for mixed
            '#9E9E9E'                // Gray default
        ]);

        // Size by area
        this.mapController.setLayerPaint('unesco', 'fill-opacity', [
            'interpolate',
            ['linear'],
            ['get', 'area_hectares'],
            0, 0.3,           // Small sites - more transparent
            10000, 0.8        // Large sites - more opaque
        ]);

        // Reset to defaults
        this.mapController.resetLayerPaint('unesco');
        this.mapController.clearLayerFilter('unesco');
    }
}

// ============================================================================
// USAGE IN APPLICATION
// ============================================================================

/**
 * In your application's initialization code:
 */
async function initializeApplication() {
    // Wait for map to load
    map.on('load', async () => {
        // Load existing layers
        await layerRegistry.loadFromJson('layers-config.json');

        // Create controllers
        const mapController = new MapLayerController(map, layerRegistry);

        // Add UNESCO layer (if not in config)
        const unesco = new UNESCOLayerExample(map, layerRegistry, mapController);
        unesco.setup();

        // Regenerate chatbot tools
        const toolFactory = new MCPToolFactory(layerRegistry, mapController);
        const tools = toolFactory.generateTools();

        console.log(`Generated ${tools.length} tools for ${layerRegistry.getKeys().length} layers`);
    });
}

// ============================================================================
// TESTING YOUR NEW LAYER
// ============================================================================

/**
 * Test checklist for new layers:
 */
function testNewLayer(layerKey, mapController) {
    console.group(`Testing layer: ${layerKey}`);

    // 1. Check registration
    const layer = layerRegistry.get(layerKey);
    console.assert(layer !== null, 'Layer should be registered');
    console.log('✓ Layer registered');

    // 2. Test visibility toggle
    const showResult = mapController.setLayerVisibility(layerKey, true);
    console.assert(showResult.success, 'Should show layer');
    console.log('✓ Visibility toggle works');

    // 3. Test filtering (vector only)
    if (layer.isVector) {
        const props = mapController.getFilterableProperties(layerKey);
        console.assert(props.success, 'Should get filterable properties');
        console.log('✓ Properties accessible');

        // Try a simple filter
        const firstProp = Object.keys(props.properties)[0];
        const filterResult = mapController.setLayerFilter(layerKey, ['has', firstProp]);
        console.assert(filterResult.success, 'Should apply filter');
        console.log('✓ Filtering works');

        // Clear filter
        const clearResult = mapController.clearLayerFilter(layerKey);
        console.assert(clearResult.success, 'Should clear filter');
        console.log('✓ Filter clearing works');
    }

    // 4. Test paint (vector only)
    if (layer.isVector) {
        const paintResult = mapController.setLayerPaint(layerKey, 'fill-opacity', 0.5);
        console.assert(paintResult.success, 'Should set paint property');
        console.log('✓ Paint properties work');

        const resetResult = mapController.resetLayerPaint(layerKey);
        console.assert(resetResult.success, 'Should reset paint');
        console.log('✓ Paint reset works');
    }

    console.groupEnd();
    return true;
}

// ============================================================================
// TROUBLESHOOTING
// ============================================================================

/**
 * Common issues and solutions:
 */
const troubleshooting = {
    'Layer not appearing in tools': `
    1. Check layers-config.json syntax (valid JSON)
    2. Verify layer key has no spaces or special characters
    3. Ensure all required fields are present
    4. Check browser console for validation errors
    5. Try regenerating tools: toolFactory.regenerate()
  `,

    'Filter not working': `
    1. Verify layer is vector (isVector: true)
    2. Check property names match PMTiles data exactly
    3. Property names are case-sensitive!
    4. Use get_layer_filter_info to see available properties
    5. Test with simple filter first: ['has', 'property_name']
  `,

    'Paint not applying': `
    1. Verify layer is vector
    2. Check MapLibre layer type (fill vs line)
    3. Use fill-* properties for fill layers
    4. Use line-* properties for line layers
    5. Check property names in expressions match data
  `,

    'PMTiles vs DuckDB mismatch': `
    1. Compare property names in both sources
    2. Use DESCRIBE to see DuckDB schema
    3. Update filterableProperties in config
    4. Consider using updateFromSchema() for sync
  `
};

// Export for use in other modules
export {
    UNESCOLayerExample,
    testNewLayer,
    troubleshooting
};
