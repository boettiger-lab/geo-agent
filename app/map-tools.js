/**
 * Map Tools - Local tool definitions for the LLM agent
 * 
 * Defines the tools the agent uses to control the map and query dataset metadata.
 * Each tool has: name, description, inputSchema, execute function.
 * 
 * Tools:
 *   Map control:
 *     - show_layer / hide_layer
 *     - set_filter / clear_filter
 *     - set_style / reset_style
 *     - get_map_state
 *   Dataset knowledge:
 *     - list_datasets
 *     - get_dataset_details
 */

/**
 * Generate all local tools given the app's MapManager and DatasetCatalog.
 * 
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./dataset-catalog.js').DatasetCatalog} catalog
 * @returns {Array<Object>} Tool definitions
 */
export function createMapTools(mapManager, catalog) {
    const allLayerIds = () => mapManager.getLayerIds();
    const vectorLayerIds = () => mapManager.getVectorLayerIds();

    // Build property docs for vector layers
    const getPropertyDocs = () => {
        return vectorLayerIds().map(id => {
            const cols = mapManager.getLayerColumns(id);
            if (!cols || cols.length === 0) return '';
            const lines = cols.map(c => `  - ${c.name} (${c.type}): ${c.description}`).join('\n');
            return `\nProperties for '${id}':\n${lines}`;
        }).filter(Boolean).join('\n');
    };

    return [
        // ---- Map Control Tools ----
        {
            name: 'show_layer',
            description: `Show/display a layer on the map. Use when the user asks to "show", "display", or "visualize" a layer.\n\nAvailable layers: ${allLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to show' }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapManager.showLayer(args.layer_id);
                if (result.success) mapManager.syncCheckbox(args.layer_id);
                return JSON.stringify(result);
            },
        },

        {
            name: 'hide_layer',
            description: `Hide/remove a layer from the map. Use when the user asks to "hide", "remove", or "turn off" a layer.\n\nAvailable layers: ${allLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to hide' }
                },
                required: ['layer_id']
            },
            execute: (args) => {
                const result = mapManager.hideLayer(args.layer_id);
                if (result.success) mapManager.syncCheckbox(args.layer_id);
                return JSON.stringify(result);
            },
        },

        {
            name: 'set_filter',
            description: `Apply a MapLibre filter expression to a vector layer. Use when the user asks to filter features by property values.

IMPORTANT: After filtering, check 'featuresInView' in the result. If 0, the filter may be wrong.

Filter syntax (use MapLibre expressions — NOT legacy filter arrays):
- Equality: ["==", ["get", "property"], "value"]
- Inequality: ["!=", ["get", "property"], "value"]
- Comparison: [">", ["get", "property"], 100]
- In list: ["match", ["get", "property"], ["val1", "val2", "val3"], true, false]
- AND: ["all", ["==", ["get", "p1"], "v1"], [">", ["get", "p2"], 100]]
- OR: ["any", ["==", ["get", "p"], "v1"], ["==", ["get", "p"], "v2"]]

IMPORTANT: Do NOT use the legacy ["in", "property", val1, val2] form — it is silently ignored in current MapLibre. Always use ["match", ["get", "property"], [...values], true, false] for list membership.

Vector layers: ${vectorLayerIds().join(', ')}
${getPropertyDocs()}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    filter: {
                        type: 'array',
                        description: 'MapLibre filter expression array'
                    }
                },
                required: ['layer_id', 'filter']
            },
            execute: (args) => JSON.stringify(mapManager.setFilter(args.layer_id, args.filter)),
        },

        {
            name: 'clear_filter',
            description: `Remove all filters from a layer, showing all features. Use when the user asks to "clear filters", "reset", or "show all".\n\nVector layers: ${vectorLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to clear filters from' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(mapManager.clearFilter(args.layer_id)),
        },

        {
            name: 'set_style',
            description: `Update a layer's paint/style properties. Provide MapLibre paint properties.

Examples:
  Simple: { "fill-color": "red", "fill-opacity": 0.5 }
  Data-driven categorical: { "fill-color": ["match", ["get", "PROP"], "val1", "#c1", "val2", "#c2", "#default"] }
  Data-driven gradient: { "fill-color": ["interpolate", ["linear"], ["get", "PROP"], 0, "#low", 100, "#high"] }
  Stepped: { "fill-color": ["step", ["get", "PROP"], "#c1", 10, "#c2", 50, "#c3"] }

Available layers: ${allLayerIds().join(', ')}
${getPropertyDocs()}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to style' },
                    style: { type: 'object', description: 'MapLibre paint properties object' }
                },
                required: ['layer_id', 'style']
            },
            execute: (args) => JSON.stringify(mapManager.setStyle(args.layer_id, args.style)),
        },

        {
            name: 'reset_style',
            description: `Reset a layer's style to its default appearance.\n\nAvailable layers: ${allLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to reset' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(mapManager.resetStyle(args.layer_id)),
        },

        {
            name: 'get_map_state',
            description: 'Get the current state of all map layers: which are visible, which have filters applied, etc. Use only when the user asks about current map state.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => JSON.stringify(mapManager.getMapState()),
        },

        // ---- Dataset Knowledge Tools ----
        {
            name: 'list_datasets',
            description: 'List all available datasets with their collection IDs, titles, and what data formats are available (SQL/parquet and map layers). Use when the user asks "what data is available?" or you need to discover datasets.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const datasets = catalog.getAll().map(ds => ({
                    id: ds.id,
                    title: ds.title,
                    description: ds.description.substring(0, 200),
                    provider: ds.provider,
                    parquetAssets: ds.parquetAssets.map(a => ({ title: a.title, s3Path: a.s3Path })),
                    mapLayers: ds.mapLayers.map(a => ({
                        layerId: `${ds.id}/${a.assetId}`,
                        title: a.title,
                        type: a.layerType
                    })),
                }));
                return JSON.stringify({ success: true, datasets });
            },
        },

        {
            name: 'get_dataset_details',
            description: 'Get detailed information about a specific dataset: full description, all columns with types and descriptions, available parquet paths for SQL, and map layer IDs. Use when you need column names or data paths before writing a query.',
            inputSchema: {
                type: 'object',
                properties: {
                    dataset_id: { type: 'string', description: 'Collection ID of the dataset' }
                },
                required: ['dataset_id']
            },
            execute: (args) => {
                const ds = catalog.get(args.dataset_id);
                if (!ds) {
                    return JSON.stringify({
                        success: false,
                        error: `Dataset not found: ${args.dataset_id}. Available: ${catalog.getIds().join(', ')}`
                    });
                }
                return JSON.stringify({
                    success: true,
                    id: ds.id,
                    title: ds.title,
                    description: ds.description,
                    provider: ds.provider,
                    license: ds.license,
                    columns: ds.columns,
                    parquetAssets: ds.parquetAssets.map(a => ({ title: a.title, s3Path: a.s3Path, description: a.description })),
                    mapLayers: ds.mapLayers.map(a => ({
                        layerId: `${ds.id}/${a.assetId}`,
                        title: a.title,
                        type: a.layerType,
                        description: a.description
                    })),
                    aboutUrl: ds.aboutUrl,
                    documentationUrl: ds.documentationUrl,
                    summaries: ds.summaries,
                });
            },
        },
    ];
}
