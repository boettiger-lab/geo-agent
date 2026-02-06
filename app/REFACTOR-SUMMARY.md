# Map Tools Refactor - Quick Start

This directory contains a **complete refactoring** of the map tools system into a generic, modular architecture.

## What Changed

### Before
- Hardcoded layer definitions in `map.js` and `chat.js`
- Manual tool definitions for each layer
- Difficult to add new layers (required code changes)
- Layer properties not synced with database

### After
- **Generic, data-driven architecture**
- Layer metadata in `layers-config.json`
- Tools generated automatically from metadata
- Easy to add layers (just edit config file)
- Designed for PMTiles ↔ DuckDB consistency

## New Modules

1. **`layer-registry.js`** - Central registry for layer metadata
2. **`map-layer-controller.js`** - Generic map control operations
3. **`mcp-tool-factory.js`** - Dynamic MCP tool generation
4. **`layers-config.json`** - Declarative layer configuration
5. **`tests/`** - Comprehensive test suite

## Quick Start

### View Documentation
See [MAP-TOOLS-README.md](MAP-TOOLS-README.md) for complete documentation.

### Run Tests
```bash
# Serve the app directory
python -m http.server 8000

# Open tests in browser
open http://localhost:8000/tests/
```

### Add a New Layer

Edit `layers-config.json`:

```json
{
  "layers": {
    "my_new_layer": {
      "displayName": "My New Layer",
      "layerIds": ["my-layer-id"],
      "checkboxId": "my-layer-checkbox",
      "isVector": true,
      "sourceLayer": "my_layer_source",
      "sourceUrl": "pmtiles://https://...",
      "dataTablePath": "s3://bucket/path/**",
      "description": "Description",
      "filterableProperties": {
        "property1": {
          "type": "string",
          "description": "A property"
        }
      }
    }
  }
}
```

That's it! The layer will automatically:
- Appear in chatbot tools
- Be filterable/styleable
- Work with all map operations

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     layers-config.json                       │
│               (Declarative layer metadata)                   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      LayerRegistry                           │
│         (Central registry + validation)                      │
└────────┬────────────────────────────────────────────┬───────┘
         │                                            │
         ▼                                            ▼
┌──────────────────────┐                  ┌─────────────────────┐
│ MapLayerController   │                  │  MCPToolFactory     │
│ (Generic operations) │                  │ (Tool generation)   │
└──────────┬───────────┘                  └──────────┬──────────┘
           │                                         │
           ▼                                         ▼
    ┌──────────────┐                         ┌─────────────┐
    │   map.js     │                         │  chat.js    │
    │ (Map display)│                         │ (Chatbot)   │
    └──────────────┘                         └─────────────┘
```

## Key Features

### 1. Data-Driven
All layer information comes from configuration, not hardcoded in JavaScript.

### 2. Type-Safe
Property types and validation from metadata.

### 3. Database-Aware
Links PMTiles sources to DuckDB data tables for consistency.

### 4. Extensible
Add layers, properties, or tools without modifying core code.

### 5. Testable
Comprehensive test suite with mock objects.

## Usage Examples

### Register Layers
```javascript
import { layerRegistry } from './layer-registry.js';

await layerRegistry.loadFromJson('layers-config.json');
console.log(layerRegistry.getSummary());
// { total: 6, vector: 3, raster: 3, ... }
```

### Control Map
```javascript
import { MapLayerController } from './map-layer-controller.js';

const controller = new MapLayerController(map, layerRegistry);

// Show layer
controller.setLayerVisibility('wdpa', true);

// Filter
controller.setLayerFilter('wdpa', ['==', 'IUCN_CAT', 'II']);

// Style
controller.setLayerPaint('wdpa', 'fill-color', '#2E7D32');
```

### Generate Tools
```javascript
import { MCPToolFactory } from './mcp-tool-factory.js';

const factory = new MCPToolFactory(layerRegistry, controller);
const tools = factory.generateTools();
// Returns 7 tools: toggle, get, filter, clear, info, paint, reset
```

## Files Changed

### New Files
- `app/layer-registry.js` - Layer registry module
- `app/map-layer-controller.js` - Map controller module
- `app/mcp-tool-factory.js` - Tool factory module
- `app/layers-config.json` - Layer configuration
- `app/tests/index.html` - Test suite
- `app/MAP-TOOLS-README.md` - Full documentation
- `app/REFACTOR-SUMMARY.md` - This file

### Modified Files
- `app/chat.js` - Now uses MCPToolFactory for dynamic tools
- `app/map.js` - Now delegates to MapLayerController

## Migration Checklist

- [x] Create LayerRegistry module
- [x] Create MapLayerController module
- [x] Create MCPToolFactory module
- [x] Create layers-config.json
- [x] Refactor chat.js to use new modules
- [x] Refactor map.js to use new modules
- [x] Create comprehensive test suite
- [x] Write complete documentation
- [x] Maintain backward compatibility

## Benefits

1. **Easier Maintenance**: Layer info in one place
2. **Faster Development**: Add layers without code changes
3. **Better Testing**: Isolated, testable modules
4. **Consistency**: PMTiles and database always match
5. **Flexibility**: Easy to extend with new features

## Next Steps

1. **Review Documentation**: Read [MAP-TOOLS-README.md](MAP-TOOLS-README.md)
2. **Run Tests**: Verify everything works
3. **Test Integration**: Try the application end-to-end
4. **Add More Layers**: Practice adding a new layer via config

## Support

- Full docs: [MAP-TOOLS-README.md](MAP-TOOLS-README.md)
- Tests: [tests/index.html](tests/index.html)
- Issues: Check browser console for errors

## Backward Compatibility

The refactor maintains backward compatibility:
- `window.MapController` still exists and works
- Old method calls are delegated to new modules
- Existing map initialization code unchanged
- UI checkboxes and legends work as before

The system is designed for a smooth transition with zero breaking changes to existing functionality.
