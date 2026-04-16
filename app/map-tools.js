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
 *     - fly_to
 *   Dataset knowledge:
 *     - list_datasets
 */

/**
 * Parse a JSON array from DuckDB MCP query result text.
 * DuckDB may wrap the array in a markdown table or plain text — we extract
 * by finding the first '[' and last ']' in the response.
 *
 * @param {string} text
 * @returns {Array|null}
 */
function extractJsonArray(text) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Generate all local tools given the app's MapManager and DatasetCatalog.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./dataset-catalog.js').DatasetCatalog} catalog
 * @param {import('./mcp-client.js').MCPClient} [mcpClient]
 * @returns {Array<Object>} Tool definitions
 */
export function createMapTools(mapManager, catalog, mcpClient) {
    const allLayerIds = () => mapManager.getLayerIds();
    const vectorLayerIds = () => mapManager.getVectorLayerIds();

    // Build property docs for vector layers
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

IMPORTANT: Never guess categorical values used in filters. Check the dataset catalog in your system prompt for documented coded values, or call get_stac_details for full column details. Only use SELECT DISTINCT via SQL if the metadata doesn't cover it.

IMPORTANT: After filtering, check 'featuresInView' in the result. If 0, the filter may be wrong.

Filter syntax (use MapLibre expressions — NOT legacy filter arrays):
- Equality: ["==", ["get", "property"], "value"]
- Inequality: ["!=", ["get", "property"], "value"]
- Comparison: [">", ["get", "property"], 100]
- In list: ["match", ["get", "property"], ["val1", "val2", "val3"], true, false]
- AND: ["all", ["==", ["get", "p1"], "v1"], [">", ["get", "p2"], 100]]
- OR: ["any", ["==", ["get", "p"], "v1"], ["==", ["get", "p"], "v2"]]

IMPORTANT: Do NOT use the legacy ["in", "property", val1, val2] form — it is silently ignored in current MapLibre. Always use ["match", ["get", "property"], [...values], true, false] for list membership.

Vector layers: ${vectorLayerIds().join(', ')}`,
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
            description: `Remove ALL filters from a layer, showing every feature regardless of properties. Use when the user wants to see everything (e.g. "show all GAP codes", "remove filter", "show everything").\n\nNote: some layers have a config default filter applied at startup. This tool removes that too. Use reset_filter instead if you want to restore the default.\n\nVector layers: ${vectorLayerIds().join(', ')}`,
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
            name: 'reset_filter',
            description: `Reset a layer's filter to its config default (the filter it had when the app loaded). If the layer had no default filter, this clears all filters. Use when the user asks to "reset to default", "restore original view", or "go back to how it was".\n\nVector layers: ${vectorLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Layer ID to reset filter on' }
                },
                required: ['layer_id']
            },
            execute: (args) => JSON.stringify(mapManager.resetFilter(args.layer_id)),
        },

        {
            name: 'set_style',
            description: `Update a layer's paint/style properties. Provide MapLibre paint properties.

IMPORTANT: For categorical coloring (e.g., a "match" expression), never guess or assume valid values. Check the dataset catalog in your system prompt for documented coded values, or call get_stac_details for full column details. Only fall back to SELECT DISTINCT via SQL if the metadata doesn't cover it.

Examples:
  Simple: { "fill-color": "red", "fill-opacity": 0.5 }
  Data-driven categorical: { "fill-color": ["match", ["get", "PROP"], "val1", "#c1", "val2", "#c2", "#default"] }
  Data-driven gradient: { "fill-color": ["interpolate", ["linear"], ["get", "PROP"], 0, "#low", 100, "#high"] }
  Stepped: { "fill-color": ["step", ["get", "PROP"], "#c1", 10, "#c2", 50, "#c3"] }

Available layers: ${allLayerIds().join(', ')}`,
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

        {
            name: 'fly_to',
            description: 'Animate the map to a location. Use when the user asks to navigate to, zoom in on, or center the map on a place or set of coordinates.\n\nIMPORTANT: The center parameter is [longitude, latitude] (lon first, lat second — MapLibre order).\n\nTo obtain coordinates, query the H3 parquet data using the h3 extension (pre-loaded on the MCP server). H3 cell columns are typically named h8. Example:\n  LOAD h3; SELECT h3_cell_to_lng(h8) AS lon, h3_cell_to_lat(h8) AS lat FROM read_parquet(\'s3://...\') WHERE name = \'...\' LIMIT 1',
            inputSchema: {
                type: 'object',
                properties: {
                    center: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Target [longitude, latitude]'
                    },
                    zoom: {
                        type: 'number',
                        description: 'Target zoom level (0–22). Optional — omit to keep current zoom.'
                    }
                },
                required: ['center']
            },
            execute: (args) => JSON.stringify(mapManager.flyTo(args)),
        },

        // ---- Query-driven Filter Tool ----
        ...(mcpClient ? [{
            name: 'filter_by_query',
            description: `Filter a vector layer to features whose ID property matches the results of a SQL query — without passing thousands of IDs through the LLM.

Use this instead of set_filter when:
- The matching set comes from an MCP SQL query (e.g. "show parcels inside protected areas", "highlight counties above median income")
- The result set could be large (hundreds to tens of thousands of features)

How it works:
1. Executes your SQL via the MCP query tool
2. Extracts the ID column
3. Applies a MapLibre filter programmatically — IDs never pass through the LLM output

Parameters:
- layer_id: the vector layer to filter (must already be loaded)
- sql: a SELECT query returning ONE column — the feature ID values to keep. Alias that column to match id_property exactly. Example: SELECT GEOID FROM read_parquet('s3://...') WHERE ...
- id_property: the property name in the vector tile features to match against. Check get_stac_details for the correct column — CNG-processed datasets use "_cng_fid"; source datasets vary (e.g. "OBJECTID", "HOLDING_ID").

IMPORTANT: The sql must return only the id column — no extra columns. Write it as a plain SELECT, not wrapped in array_agg.

Vector layers: ${vectorLayerIds().join(', ')}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    sql: { type: 'string', description: 'SELECT query returning a single column of ID values to keep' },
                    id_property: { type: 'string', description: 'Feature property name in the vector tile to match against — check get_stac_details (CNG-processed datasets use "_cng_fid"; source datasets vary)' },
                },
                required: ['layer_id', 'sql', 'id_property'],
            },
            execute: async (args) => {
                if (!mcpClient) return JSON.stringify({ success: false, error: 'MCP client not available' });

                // Wrap user SQL to aggregate non-null IDs into a JSON array via DuckDB
                const col = args.id_property;
                const wrappedSql = `SELECT array_agg("${col}") FILTER (WHERE "${col}" IS NOT NULL) FROM (${args.sql}) _filter_subquery`;

                let rawResult;
                try {
                    rawResult = await mcpClient.callTool('query', { sql_query: wrappedSql });
                } catch (err) {
                    return JSON.stringify({ success: false, error: `SQL execution failed: ${err.message}` });
                }

                // DuckDB returns NULL (not []) when no rows match — treat as empty
                if (!rawResult || /\bnull\b/i.test(rawResult.trim().replace(/.*\n/, ''))) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const ids = extractJsonArray(rawResult);
                if (!ids) {
                    return JSON.stringify({
                        success: false,
                        error: `Could not parse ID list from query result. Check that id_property ("${col}") exactly matches the column name in the SQL output — verify via get_stac_details (CNG-processed datasets use "_cng_fid"). Raw: ${rawResult.substring(0, 300)}`
                    });
                }
                if (ids.length === 0) {
                    return JSON.stringify({ success: true, idCount: 0, featuresInView: 0, message: 'Query matched no features — filter not applied.' });
                }

                const filter = ['in', ['get', col], ['literal', ids]];
                const result = mapManager.setFilter(args.layer_id, filter);
                return JSON.stringify({ ...result, idCount: ids.length });
            },
        }] : []),

        // ---- Dataset Knowledge Tools ----
        {
            name: 'list_datasets',
            description: 'List all datasets pre-loaded for this app. Paths and schemas are in your system prompt. To discover datasets outside your app, use `browse_stac_catalog` instead.',
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
            name: 'set_projection',
            description: 'Switch the map between globe (spherical 3D) and mercator (flat 2D) projection. Use when the user asks to "show a globe", "switch to globe view", "go back to flat map", etc.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['globe', 'mercator'],
                        description: 'Projection type: "globe" for spherical Earth, "mercator" for flat map'
                    }
                },
                required: ['type']
            },
            execute: (args) => {
                mapManager.setProjection(args.type);
                return JSON.stringify({ success: true, projection: args.type });
            },
        },

    ];
}
