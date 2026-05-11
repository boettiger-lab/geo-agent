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
 *     - get_schema
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
export function extractJsonArray(text) {
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
    const allLayers = () => mapManager.getLayerSummaries();
    const vectorLayers = () => mapManager.getLayerSummaries().filter(l => l.type === 'vector');

    const formatLayerList = (layers) => layers.map(l => `- \`${l.id}\` — ${l.displayName}`).join('\n');

    const pickLayerNudge = 'Pick the layer by displayName semantic match, not by ID suffix. When several layers could plausibly match the user\'s intent (e.g. "districts" could mean congressional, state senate, or state house), choose on displayName — the ID suffix is not a reliable disambiguator.';

    return [
        // ---- Map Control Tools ----
        {
            name: 'show_layer',
            description: `Show/display a layer on the map. Use when the user asks to "show", "display", or "visualize" a layer.

${pickLayerNudge}

Available layers:
${formatLayerList(allLayers())}`,
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
            description: `Hide/remove a layer from the map. Use when the user asks to "hide", "remove", or "turn off" a layer.

Available layers:
${formatLayerList(allLayers())}`,
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

${pickLayerNudge}

Vector layers:
${formatLayerList(vectorLayers())}`,
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
            description: `Remove ALL filters from a layer, showing every feature regardless of properties. Use when the user wants to see everything (e.g. "show all GAP codes", "remove filter", "show everything").

Note: some layers have a config default filter applied at startup. This tool removes that too. Use reset_filter instead if you want to restore the default.

Vector layers:
${formatLayerList(vectorLayers())}`,
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
            description: `Reset a layer's filter to its config default (the filter it had when the app loaded). If the layer had no default filter, this clears all filters. Use when the user asks to "reset to default", "restore original view", or "go back to how it was".

Vector layers:
${formatLayerList(vectorLayers())}`,
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

${pickLayerNudge}

Available layers:
${formatLayerList(allLayers())}`,
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
            description: `Reset a layer's style to its default appearance.

Available layers:
${formatLayerList(allLayers())}`,
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

        // ---- Dynamic Hex Tile Layers ----
        {
            name: 'add_hex_tile_layer',
            description: `Add a dynamic H3 hex tile layer to the map as an ADDITIVE overlay. Hex layers do not replace existing layers — they sit on top, and existing polygon/raster layers stay visible beneath. Use after calling the MCP \`register_hex_tiles\` tool, which returns a tile URL template + bounds + value columns + per-resolution value stats.

Common use cases:
  - Dense point data aggregated per hex (e.g. GBIF occurrence counts per h8 cell).
  - Polygon datasets summarized per hex (e.g. feature count or average attribute).
  - Pre-computed per-cell values (density rasters, model outputs).

Flow:
  1. Call \`register_hex_tiles\` (MCP) with SQL that returns (h3_index [, value1, ...]).
  2. Pass its return fields directly into this tool — no extra min/max query needed; the server already computed \`value_stats\` per H3 resolution.

Pass the following fields straight through from the register_hex_tiles return value:
  - tile_url              ← tile_url_template
  - value_column          ← one of value_columns (for agg="COUNT" this is "count")
  - value_stats           ← value_stats[value_column]  (has { by_res: { "<res>": { min, max } } })
  - bounds                ← bounds
  - layer_name            ← layer_name (when present; defaults to "layer" otherwise)

**Resolution (important):** the tile pyramid holds hexes at multiple H3 resolutions, but the map renders ONE at a time — hexes do not change size as the user zooms. If the user names a target H3 resolution (e.g. "show at h6", "resolution 7"), pass it as \`resolution\`. Otherwise it defaults to the finest (highest) resolution present in \`value_stats.by_res\`. To show a coarser view, either specify \`resolution\` or call \`register_hex_tiles\` with \`min_res == finest_res\`.

IMPORTANT: The tile_url must be the exact tile_url_template returned by register_hex_tiles — the tool rejects other URLs.

The returned layer_id can be used with show_layer / hide_layer / set_style / set_filter / get_map_state like any other vector layer, and with remove_hex_tile_layer to free the source.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tile_url: { type: 'string', description: 'tile_url_template from register_hex_tiles' },
                    value_column: { type: 'string', description: 'Which column from register_hex_tiles.value_columns to style by (e.g. "count" for agg=COUNT)' },
                    value_stats: {
                        type: 'object',
                        description: 'Per-resolution stats for value_column — pass register_hex_tiles.value_stats[value_column] directly. Shape: { by_res: { "<res>": { min, max } } }.'
                    },
                    bounds: {
                        type: 'array',
                        items: { type: 'number' },
                        description: '[w, s, e, n] from register_hex_tiles.bounds'
                    },
                    resolution: {
                        type: 'integer',
                        description: 'H3 resolution to render (must be a key in value_stats.by_res). Defaults to the finest available. The layer is filtered to this single resolution so hexes do not change size as the user zooms.'
                    },
                    layer_name: { type: 'string', description: 'MVT source-layer name from register_hex_tiles.layer_name (defaults to "layer" when omitted)' },
                    display_name: { type: 'string', description: 'Optional human-readable layer name (default: "Hex: <value_column>")' },
                    palette: {
                        type: 'string',
                        enum: ['viridis', 'ylorrd', 'bluered'],
                        description: 'Color ramp: viridis (sequential default), ylorrd (warm sequential), bluered (diverging)'
                    },
                    opacity: { type: 'number', description: 'Fill opacity 0..1 (default 0.7)' },
                    fit_bounds: { type: 'boolean', description: 'Fly the camera to fit bounds (default true)' },
                },
                required: ['tile_url', 'value_column', 'value_stats', 'bounds'],
            },
            execute: (args) => {
                const displayName = args.display_name || `Hex: ${args.value_column}`;
                const result = mapManager.addHexTileLayer({
                    tileUrl: args.tile_url,
                    valueColumn: args.value_column,
                    valueStats: args.value_stats,
                    bounds: args.bounds,
                    palette: args.palette || 'viridis',
                    opacity: args.opacity ?? 0.7,
                    displayName,
                    fitBounds: args.fit_bounds !== false,
                    layerName: args.layer_name,
                    resolution: args.resolution,
                });
                return JSON.stringify(result);
            },
        },

        {
            name: 'remove_hex_tile_layer',
            description: `Remove a dynamic hex tile layer previously added via add_hex_tile_layer. Takes a layer_id like "hex-<hash>". Refuses to touch non-hex layers (any id not starting with "hex-"), so curated layers are safe.

Use when the agent is iterating — e.g. user asks to replace one hex analysis with another.`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Hex layer ID, starting with "hex-"' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.removeHexTileLayer(args.layer_id)),
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

${pickLayerNudge}

Vector layers:
${formatLayerList(vectorLayers())}`,
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

                // Wrap user SQL to aggregate non-null IDs into a JSON array via DuckDB.
                // to_json() is required because DuckDB's native array display format
                // (space-separated, no commas — e.g. "[ 1  2  3]") is not valid JSON,
                // so without it the extractJsonArray() call below fails to parse.
                const col = args.id_property;
                const wrappedSql = `SELECT to_json(array_agg("${col}") FILTER (WHERE "${col}" IS NOT NULL)) AS ids FROM (${args.sql}) _filter_subquery`;

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
            name: 'get_schema',
            description: 'Get column names, types, sample values, and coded value lists for a dataset — formatted like SELECT * LIMIT 1 output. Also includes the read_parquet() path. **Call this before your first SQL query against a dataset.** For datasets outside your app, use `get_stac_details` instead.',
            inputSchema: {
                type: 'object',
                properties: {
                    dataset_id: { type: 'string', description: 'Collection ID of the dataset' }
                },
                required: ['dataset_id']
            },
            execute: async (args) => {
                if (!catalog.get(args.dataset_id)) {
                    return JSON.stringify({
                        success: false,
                        error: `Dataset not found: ${args.dataset_id}. Available: ${catalog.getIds().join(', ')}. For datasets outside this app, use get_stac_details.`
                    });
                }
                if (!mcpClient) {
                    return JSON.stringify({
                        success: false,
                        error: 'Schema service unavailable: MCP client not configured.'
                    });
                }
                try {
                    // Forward the cached STAC content inline so MCP doesn't re-fetch
                    // the catalog (matters for OAuth-walled deployments and saves a
                    // round-trip in the common case). Requires mcp-data-server >= PR #107.
                    const collection = catalog.toStacDict(args.dataset_id);
                    const mcpArgs = { dataset_id: args.dataset_id, collection };
                    const raw = await mcpClient.callTool('get_stac_details', mcpArgs);
                    return typeof raw === 'string' ? raw : JSON.stringify(raw);
                } catch (err) {
                    return JSON.stringify({
                        success: false,
                        error: `Schema service unavailable: ${err.message || err}. Try again, or call get_stac_details directly.`
                    });
                }
            },
        },

        {
            name: 'list_datasets',
            description: 'List all dataset IDs and titles pre-loaded for this app. Paths are in your system prompt; call `get_schema` for column details. To discover datasets outside your app, use `browse_stac_catalog` instead.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: () => {
                const datasets = catalog.getAll().map(ds => ({
                    id: ds.id,
                    title: ds.title,
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
