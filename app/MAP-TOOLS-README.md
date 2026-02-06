# Generic Map Tools Architecture

## Overview

This document describes the generic, modular architecture for map layer control in the wetlands biodiversity chatbot application. The system is designed to be data-driven, extensible, and maintainable without hardcoding layer-specific logic.

## Architecture Goals

1. **Generic**: Work with any map layer without hardcoding specific layer names or properties
2. **Data-Driven**: Layer metadata comes from configuration files or database queries
3. **Modular**: Clean separation between layer registry, controller, and tool generation
4. **Extensible**: Easy to add new layers by updating configuration, not code
5. **Type-Safe**: Strong validation and type checking for layer operations
6. **MCP-Compatible**: Generate MCP tool definitions dynamically from metadata

## Core Components

### 1. LayerRegistry (`layer-registry.js`)

**Purpose**: Central registry for all map layer metadata

**Features**:
- Register layers with complete metadata (names, types, properties, sources)
- Load layer definitions from JSON configuration files
- Update layer properties from database schema introspection
- Query layers by type (vector vs raster)
- Validate layer metadata on registration

**Key Methods**:
```javascript
// Register a single layer
registry.register(key, metadata)

// Load from JSON config
await registry.loadFromJson('layers-config.json')

// Update from database schema
registry.updateFromSchema(key, schema)

// Query layers
registry.get(key)              // Get specific layer
registry.getKeys()             // All layer keys
registry.getVectorKeys()       // Only vector layers
registry.getRasterKeys()       // Only raster layers
```

**Example Usage**:
```javascript
import { layerRegistry } from './layer-registry.js';

// Load configuration
await layerRegistry.loadFromJson('layers-config.json');

// Get layer info
const wdpa = layerRegistry.get('wdpa');
console.log(wdpa.displayName);        // "Protected Areas (WDPA)"
console.log(wdpa.isVector);           // true
console.log(wdpa.filterableProperties); // { IUCN_CAT: {...}, ...  }
```

### 2. MapLayerController (`map-layer-controller.js`)

**Purpose**: Generic map control operations that work with any registered layer

**Features**:
- Toggle layer visibility
- Filter vector layers with MapLibre expressions
- Apply data-driven styling (paint properties)
- Track active filters and customizations
- Generate human-readable filter descriptions

**Key Methods**:
```javascript
// Visibility control
controller.setLayerVisibility(key, visible)
controller.toggleLayer(key)
controller.getAvailableLayers()

// Filtering (vector layers only)
controller.setLayerFilter(key, filterExpression)
controller.clearLayerFilter(key)
controller.getFilterableProperties(key)

// Styling (vector layers only)
controller.setLayerPaint(key, property, value)
controller.resetLayerPaint(key)

// Utilities
controller.describeFilter(filter)
controller.getCustomizationSummary()
```

**Example Usage**:
```javascript
import { MapLayerController } from './map-layer-controller.js';

const controller = new MapLayerController(map, layerRegistry);

// Show a layer
controller.setLayerVisibility('wdpa', true);

// Filter to IUCN category II
controller.setLayerFilter('wdpa', ['==', 'IUCN_CAT', 'II']);

// Color by ownership type
controller.setLayerPaint('wdpa', 'fill-color', [
  'match', ['get', 'OWN_TYPE'],
  'State', '#1f77b4',
  'Private', '#ff7f0e',
  'Community', '#2ca02c',
  '#999999' // default
]);
```

### 3. MCPToolFactory (`mcp-tool-factory.js`)

**Purpose**: Generate MCP tool definitions dynamically from layer metadata

**Features**:
- Generate all standard map control tools (toggle, filter, paint, etc.)
- Use layer metadata to create type-safe tool schemas
- Dynamic enum values from registered layers
- Property-aware descriptions and examples

**Generated Tools**:
- `toggle_map_layer` - Show/hide layers
- `get_map_layers` - List available layers
- `filter_map_layer` - Apply filters to vector layers
- `clear_map_filter` - Remove filters
- `get_layer_filter_info` - Query filterable properties
- `set_layer_paint` - Apply data-driven styling
- `reset_layer_paint` - Reset styling to defaults

**Example Usage**:
```javascript
import { MCPToolFactory } from './mcp-tool-factory.js';

const factory = new MCPToolFactory(layerRegistry, mapController);

// Generate all tools
const tools = factory.generateTools();

// Tools have this structure:
// {
//   name: 'toggle_map_layer',
//   description: '...',
//   inputSchema: { type: 'object', properties: {...}, required: [...] },
//   execute: (args) => { ... }
// }
```

### 4. Layer Configuration (`layers-config.json`)

**Purpose**: Declarative layer metadata in JSON format

**Structure**:
```json
{
  "version": "1.0",
  "description": "Map layer configuration",
  "layers": {
    "layer_key": {
      "displayName": "Human Readable Name",
      "layerIds": ["maplibre-layer-id"],
      "checkboxId": "ui-checkbox-id",
      "hasLegend": false,
      "isVector": true,
      "sourceLayer": "pmtiles-source-layer",
      "sourceUrl": "pmtiles://https://...",
      "dataTablePath": "s3://bucket/path/**",
      "description": "Layer description",
      "filterableProperties": {
        "property_name": {
          "type": "string|number|boolean",
          "description": "Property description",
          "values": ["enum", "values"]
        }
      }
    }
  }
}
```

**Key Fields**:
- `displayName`: Name shown to users
- `layerIds`: MapLibre layer IDs (can be multiple for complex layers like fill + outline)
- `checkboxId`: UI checkbox element ID
- `isVector`: true for vector tiles, false for raster
- `sourceLayer`: Vector tile source layer name (required for vector layers)
- `sourceUrl`: PMTiles or data source URL
- `dataTablePath`: Corresponding parquet/data path in DuckDB (ensures PMTiles matches parquet data)
- `filterableProperties`: Properties available for filtering (vector layers only)

## Integration with Application

### In `map.js`:

```javascript
import { layerRegistry } from './layer-registry.js';
import { MapLayerController } from './map-layer-controller.js';

// Load layer configuration when map is ready
map.on('load', async function() {
  await layerRegistry.loadFromJson('layers-config.json');
  const controller = new MapLayerController(map, layerRegistry);
  
  // Expose controller for chatbot
  window.MapController = controller;
});
```

### In `chat.js`:

```javascript
import { layerRegistry } from './layer-registry.js';
import { MCPToolFactory } from './mcp-tool-factory.js';

class Chatbot {
  async loadLayersAndInitTools() {
    await layerRegistry.loadFromJson('layers-config.json');
    const factory = new MCPToolFactory(layerRegistry, window.MapController);
    this.localTools = factory.generateTools();
  }
}
```

## Workflow: How It All Works Together

1. **Initialization**:
   - Application loads `layers-config.json`
   - LayerRegistry parses and validates layer metadata
   - MapLayerController is created with map instance and registry
   - MCPToolFactory generates tool definitions from registry

2. **User Query** (e.g., "Show me IUCN category II protected areas"):
   - LLM decides to use `filter_map_layer` tool
   - Tool definition (generated by MCPToolFactory) specifies valid layers and parameters
   - Tool execution calls `mapController.setLayerFilter('wdpa', ['==', 'IUCN_CAT', 'II'])`
   - MapLayerController looks up 'wdpa' in LayerRegistry
   - Controller validates it's a vector layer and applies MapLibre filter
   - Human-readable description is generated and returned

3. **Database Query Sync**:
   - User asks: "How many protected areas are in category II?"
   - MCP tool queries DuckDB using `dataTablePath` from layer config
   - Results match what's visible on map because PMTiles and parquet have same data
   - Chatbot can cross-reference map display with database queries

## Adding a New Layer

### Method 1: Configuration File (Recommended)

Edit `layers-config.json`:

```json
{
  "new_layer": {
    "displayName": "My New Layer",
    "layerIds": ["new-layer-fill", "new-layer-line"],
    "checkboxId": "new-layer-checkbox",
    "hasLegend": false,
    "isVector": true,
    "sourceLayer": "new_layer_source",
    "sourceUrl": "pmtiles://https://example.com/new-layer.pmtiles",
    "dataTablePath": "s3://bucket/new-layer/data/**",
    "description": "Description of the new layer",
    "filterableProperties": {
      "category": {
        "type": "string",
        "description": "Category field"
      },
      "value": {
        "type": "number",
        "description": "Numeric value"
      }
    }
  }
}
```

That's it! The layer will automatically:
- Appear in `toggle_map_layer` tool enum
- Be filterable if it's a vector layer
- Have correct property validation
- Work with all map control operations

### Method 2: Runtime Registration

```javascript
layerRegistry.register('dynamic_layer', {
  displayName: 'Dynamic Layer',
  layerIds: ['dynamic'],
  checkboxId: 'dynamic-check',
  isVector: false,
  hasLegend: false,
  sourceUrl: 'pmtiles://...',
  dataTablePath: 's3://...'
});

// Regenerate tools to include new layer
chatbot.localTools = toolFactory.regenerate();
```

### Method 3: Database Schema Introspection

```javascript
// Query database for schema
const schema = await queryDuckDB(`
  DESCRIBE SELECT * FROM read_parquet('s3://bucket/layer/**')
  LIMIT 1
`);

// Update layer with discovered properties
layerRegistry.updateFromSchema('layer_key', {
  columns: schema.map(row => ({
    name: row.column_name,
    type: row.column_type,
    description: `Column: ${row.column_name}`
  }))
});
```

## Advanced Features

### Data-Driven Styling

Color layers by data attributes:

```javascript
// Categorical coloring
controller.setLayerPaint('wdpa', 'fill-color', [
  'match',
  ['get', 'IUCN_CAT'],
  'Ia', '#1a237e',  // Strict nature reserve - dark blue
  'Ib', '#283593',  // Wilderness area - blue
  'II', '#3949ab',  // National park - lighter blue
  'III', '#5c6bc0', // Natural monument - light blue
  'IV', '#7e57c2', // Habitat management - purple
  'V', '#9575cd',  // Protected landscape - light purple
  'VI', '#b39ddb', // Sustainable use - lighter purple
  '#757575'        // default - gray
]);

// Numeric gradient
controller.setLayerPaint('hydrobasins', 'fill-color', [
  'interpolate',
  ['linear'],
  ['get', 'UP_AREA'],
  0, '#ffffcc',        // Small area - light yellow
  10000, '#41b6c4',    // Medium area - teal
  100000, '#0c2c84'    // Large area - dark blue
]);

// Stepped ranges
controller.setLayerPaint('ramsar', 'fill-color', [
  'step',
  ['get', 'area_off'],
  '#fee5d9',    // < 1000 ha - light orange
  1000, '#fcae91',  // 1000-10000 ha - orange
  10000, '#fb6a4a', // 10000-50000 ha - red
  50000, '#de2d26', // 50000+ ha - dark red
]);
```

### Complex Filtering

Combine multiple conditions:

```javascript
// AND: Protected areas that are both category II and state-owned
controller.setLayerFilter('wdpa', [
  'all',
  ['==', 'IUCN_CAT', 'II'],
  ['==', 'OWN_TYPE', 'State']
]);

// OR: Category Ia, Ib, or II
controller.setLayerFilter('wdpa', [
  'in', 'IUCN_CAT', 'Ia', 'Ib', 'II'
]);

// Ramsar sites meeting multiple criteria
controller.setLayerFilter('ramsar', [
  'all',
  ['==', 'Criterion1', true],
  ['==', 'Criterion2', true],
  ['>=', 'area_off', 10000]
]);
```

### Schema Synchronization

Ensure PMTiles and database have matching properties:

```javascript
// Option 1: Manual validation
const layerConfig = layerRegistry.get('wdpa');
const dbSchema = await queryDuckDB(`
  DESCRIBE SELECT * FROM read_parquet('${layerConfig.dataTablePath}')
  LIMIT 1
`);

// Compare properties
const configProps = Object.keys(layerConfig.filterableProperties);
const dbProps = dbSchema.map(r => r.column_name);
const missing = configProps.filter(p => !dbProps.includes(p));
if (missing.length > 0) {
  console.warn('Properties in config but not in data:', missing);
}

// Option 2: Automatic sync
layerRegistry.updateFromSchema('wdpa', {
  columns: dbSchema.map(row => ({
    name: row.column_name,
    type: row.column_type
  }))
});
```

## Testing

Run the test suite at `app/tests/index.html`:

```bash
# Serve the app directory
python -m http.server 8000

# Open in browser
open http://localhost:8000/tests/
```

Tests cover:
- LayerRegistry: registration, validation, queries
- MapLayerController: visibility, filtering, styling
- MCPToolFactory: tool generation, schema validation
- Integration: config loading, property matching

## Best Practices

### 1. Configuration Over Code
- Add new layers by editing `layers-config.json`, not by modifying JavaScript
- Keep layer metadata in one central place
- Use database introspection to keep properties in sync

### 2. Consistent Naming
- Use snake_case for layer keys (e.g., `wdpa`, `hydrobasins`)
- Use descriptive displayNames for UI
- Match PMTiles sourceLayer names to database table structure

### 3. Property Documentation
- Include clear descriptions for all filterable properties
- Specify property types accurately (string, number, boolean)
- Document known enum values for categorical properties

### 4. Error Handling
- All controller methods return result objects with `success` boolean
- Check for layer existence before operations
- Provide helpful error messages with available options

### 5. Performance
- Load layer config once at startup
- Cache LayerRegistry instance as singleton
- Regenerate tools only when layer configuration changes

## Migration Guide

### From Hardcoded to Generic

**Before** (hardcoded in chat.js):
```javascript
{
  name: 'toggle_map_layer',
  inputSchema: {
    properties: {
      layer: {
        enum: ['wetlands', 'carbon', 'ncp', 'ramsar', 'wdpa']
      }
    }
  }
}
```

**After** (generated from config):
```javascript
const factory = new MCPToolFactory(layerRegistry, controller);
const tools = factory.generateTools();
// Enum values automatically include all registered layers
```

**Benefits**:
- Add layers without touching code
- Tools stay in sync with available layers
- Type-safe property validation
- Automatic schema generation

## Future Enhancements

### 1. Dynamic Property Discovery
Query PMTiles metadata to discover properties at runtime:

```javascript
async function discoverLayerProperties(pmtilesUrl) {
  const pmtiles = new PMTiles(pmtilesUrl);
  const metadata = await pmtiles.getMetadata();
  // Extract vector_layers[].fields
  return metadata.vector_layers[0].fields;
}
```

### 2. User-Defined Layers
Allow users to upload custom GeoJSON or PMTiles and auto-register:

```javascript
async function addUserLayer(file, name) {
  const url = URL.createObjectURL(file);
  const properties = await discoverLayerProperties(url);
  
  layerRegistry.register(name, {
    displayName: name,
    layerIds: [name],
    checkboxId: `${name}-checkbox`,
    isVector: true,
    sourceLayer: name,
    sourceUrl: url,
    filterableProperties: properties
  });
}
```

### 3. Layer Presets
Save and load filter/style combinations:

```javascript
const preset = {
  name: 'Strict Protected Areas',
  filters: {
    wdpa: ['in', 'IUCN_CAT', 'Ia', 'Ib', 'II']
  },
  paint: {
    wdpa: {
      'fill-color': ['match', ['get', 'IUCN_CAT'], ...]
    }
  }
};

controller.applyPreset(preset);
```

### 4. Collaborative Filtering
Share map states via URL parameters:

```javascript
function encodeMapState() {
  const state = controller.getCustomizationSummary();
  return btoa(JSON.stringify(state));
}

function decodeMapState(encoded) {
  const state = JSON.parse(atob(encoded));
  controller.restoreState(state);
}
```

## Troubleshooting

### Layer Not Appearing in Tools
- Check `layers-config.json` syntax
- Verify layer key is valid (no spaces, lowercase recommended)
- Ensure required fields are present (displayName, layerIds, etc.)
- Check browser console for validation errors

### Filter Not Working
- Verify layer is a vector layer (`isVector: true`)
- Check property names match PMTiles data exactly (case-sensitive!)
- Use `get_layer_filter_info` tool to see available properties
- Test filter syntax with simple expressions first

### Paint Properties Not Applying
- Verify layer is a vector layer
- Check property names in expressions
- Use browser dev tools to inspect MapLibre layer state
- Try resetting paint first: `controller.resetLayerPaint(key)`

### Schema Mismatch
- Compare PMTiles properties with database columns
- Use `DESCRIBE SELECT` in DuckDB to list columns
- Update config if properties have changed
- Consider using `updateFromSchema()` for dynamic sync

## Resources

- [MapLibre Filter Expressions](https://maplibre.org/maplibre-style-spec/expressions/)
- [MapLibre Paint Properties](https://maplibre.org/maplibre-style-spec/layers/)
- [PMTiles Format](https://github.com/protomaps/PMTiles)
- [MCP Protocol](https://github.com/modelcontextprotocol/mcp)

## Support

For questions or issues:
1. Check this README
2. Review test suite for examples
3. Inspect browser console for errors
4. Check layer configuration syntax

## License

[Your license here]
