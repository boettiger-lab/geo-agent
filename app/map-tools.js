import { validateChartSpec } from './chart-renderer.js';
import { metadataUrlFromTileUrl } from './hex-layer-helpers.js';

/**
 * Whether a value_stats object is usable for building a hex color ramp (#276):
 * an object with a non-empty `by_res` map.
 */
function isUsableStats(vs) {
    return !!(vs && typeof vs === 'object' && vs.by_res && Object.keys(vs.by_res).length > 0);
}

/**
 * Resolve a hex layer's color-scale metadata (value_column, value_stats, bounds,
 * layer_name) for add_hex_tile_layer (#276).
 *
 * The server already computed these and serves them by content hash, so the LLM
 * should not have to transcribe the large value_stats blob into tool args (where
 * weak models corrupt it — the failure that reopened #276). This prefers usable
 * values the caller supplied, otherwise fetches the sidecar
 * (metadataUrlFromTileUrl) and fills the gaps. If the fetch fails it uses
 * whatever the caller did supply, and returns `{ error }` only when neither
 * source yields the fields the renderer needs — never a silent blank layer.
 */
async function resolveHexMetadata(args) {
    let valueColumn = args.value_column;
    let valueStats = args.value_stats;
    let bounds = (Array.isArray(args.bounds) && args.bounds.length === 4) ? args.bounds : undefined;
    let layerName = args.layer_name;

    // Fast path: the caller already supplied everything the renderer needs — no
    // network round-trip, and back-compat for manual/programmatic callers.
    if (isUsableStats(valueStats) && bounds && valueColumn) {
        return { valueColumn, valueStats, bounds, layerName };
    }

    const metaUrl = metadataUrlFromTileUrl(args.tile_url);
    if (metaUrl && typeof fetch === 'function') {
        try {
            const resp = await fetch(metaUrl);
            if (resp.ok) {
                const meta = await resp.json();
                valueColumn = valueColumn || meta.value_columns?.[0];
                if (!isUsableStats(valueStats)) valueStats = meta.value_stats?.[valueColumn];
                if (!bounds) {
                    bounds = (Array.isArray(meta.bounds) && meta.bounds.length === 4) ? meta.bounds : undefined;
                }
                layerName = layerName || meta.layer_name;
            }
        } catch { /* fall through to whatever the caller supplied */ }
    }

    // One clear error covering any remaining gap — never a silent blank layer.
    // All three gaps share a root cause: the by-hash fetch didn't deliver and
    // nothing usable was passed explicitly.
    if (!valueColumn || !isUsableStats(valueStats) || !bounds) {
        const missing = [
            !valueColumn && 'value_column',
            !isUsableStats(valueStats) && 'value_stats',
            !bounds && 'bounds',
        ].filter(Boolean).join(', ');
        return { error: `add_hex_tile_layer: could not resolve color-scale metadata (${missing}). `
            + `These are normally fetched from ${metaUrl || 'the tile host'} by content hash; that fetch `
            + `returned nothing usable (ensure the tile host serves metadata.json — mcp-data-server >= v0.8.6), `
            + `and no usable values were passed explicitly.` };
    }
    return { valueColumn, valueStats, bounds, layerName };
}

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
 * Promisified `navigator.geolocation.getCurrentPosition`. Rejects (rather than
 * hanging) when geolocation isn't available in the environment.
 * @returns {Promise<GeolocationPosition>}
 */
export function getCurrentPositionAsync(options = { enableHighAccuracy: true, timeout: 10000 }) {
    return new Promise((resolve, reject) => {
        const geo = typeof navigator !== 'undefined' && navigator.geolocation;
        if (!geo) {
            reject(new Error('Geolocation is not available in this browser.'));
            return;
        }
        geo.getCurrentPosition(resolve, reject, options);
    });
}

/**
 * Generate all local tools given the app's MapManager and DatasetCatalog.
 *
 * @param {import('./map-manager.js').MapManager} mapManager
 * @param {import('./dataset-catalog.js').DatasetCatalog} catalog
 * @param {import('./mcp-client.js').MCPClient} [mcpClient]
 * @param {{ forwardGeocode: Function }} [geocoder] - optional geocoder backend (see geocoder.js)
 * @param {{ geolocateTool?: boolean }} [options] - opt-in flags for privacy-sensitive tools
 * @returns {Array<Object>} Tool definitions
 */
export function createMapTools(mapManager, catalog, mcpClient, geocoder, options = {}) {
    // The live layer roster is injected once into the system prompt via
    // DatasetCatalog.generatePromptCatalog() (richer: id + title + type +
    // versions + default filters). Tool descriptions deliberately do NOT
    // re-embed it — that was N copies of a strict subset of the same list,
    // frozen at boot and redundant with the catalog (#225). pickLayerNudge
    // stays per-tool: it's the disambiguation rule, not the list.
    const pickLayerNudge = 'Pick the layer by displayName semantic match, not by ID suffix. When several layers could plausibly match the user\'s intent (e.g. "districts" could mean congressional, state senate, or state house), choose on displayName — the ID suffix is not a reliable disambiguator.';

    return [
        // ---- Map Control Tools ----
        {
            name: 'show_layer',
            description: `Show/display a layer on the map. Use when the user asks to "show", "display", or "visualize" a layer.

${pickLayerNudge}`,
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
            description: `Hide/remove a layer from the map. Use when the user asks to "hide", "remove", or "turn off" a layer.`,
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

Filter syntax (use MapLibre expressions — NOT legacy filter arrays):
- Equality: ["==", ["get", "property"], "value"]
- Inequality: ["!=", ["get", "property"], "value"]
- Comparison: [">", ["get", "property"], 100]
- In list: ["match", ["get", "property"], ["val1", "val2", "val3"], true, false]
- AND: ["all", ["==", ["get", "p1"], "v1"], [">", ["get", "p2"], 100]]
- OR: ["any", ["==", ["get", "p"], "v1"], ["==", ["get", "p"], "v2"]]

IMPORTANT: Do NOT use the legacy ["in", "property", val1, val2] form — it is silently ignored in current MapLibre. Always use ["match", ["get", "property"], [...values], true, false] for list membership.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to filter' },
                    filter: {
                        type: 'array',
                        // `items: {}` (any JSON value, including nested arrays) is
                        // REQUIRED: under grammar-constrained tool decoding, an array
                        // schema with no `items` compiles to a grammar that can only
                        // emit `[]`, silently collapsing every filter to empty (#243).
                        items: {},
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

Note: some layers have a config default filter applied at startup. This tool removes that too. Use reset_filter instead if you want to restore the default.`,
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
            description: `Reset a layer's filter to its config default (the filter it had when the app loaded). If the layer had no default filter, this clears all filters. Use when the user asks to "reset to default", "restore original view", or "go back to how it was".`,
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
            name: 'create_slider',
            description: `Create an interactive slider that filters a vector layer by a numeric or temporal field — entirely client-side, with no round-trip per step. Use when the user wants to scrub, step, or animate through values of one field (e.g. "let me step through fire years", "add a year slider", "play the burn history over time").

The slider binds as a MapLibre filter on \`field\`:
- mode "cumulative" (default): shows every feature with field <= the slider value (e.g. fires accumulate as the year advances).
- mode "step": shows only features whose field == the slider value (one year at a time).

Set animate: true to add a play/pause button that sweeps min→max automatically. Only one slider can be attached to a layer at a time (creating a new one replaces it). The slider panel is shown while the layer is visible — call show_layer first if it isn't already on.

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID to attach the slider to' },
                    field: { type: 'string', description: 'Feature property to filter on (e.g. "YEAR_"). Must be numeric or a value that compares numerically.' },
                    min: { type: 'number', description: 'Slider minimum (low end of the field range)' },
                    max: { type: 'number', description: 'Slider maximum (high end of the field range)' },
                    step: { type: 'number', description: 'Slider step size (default 1)' },
                    mode: { type: 'string', enum: ['cumulative', 'step'], description: 'cumulative (<=) or step (==). Default cumulative.' },
                    label: { type: 'string', description: 'Label shown on the slider panel (defaults to the field name)' },
                    animate: { type: 'boolean', description: 'Add a play button that sweeps the range (default false)' },
                },
                required: ['layer_id', 'field', 'min', 'max'],
            },
            execute: async (args) => JSON.stringify(await mapManager.createSlider(args)),
        },

        {
            name: 'set_tooltip',
            description: `Set which feature properties appear in the hover tooltip for a vector layer. Pass an array of property names; the tooltip displays them in order. Pass an empty array to disable the tooltip for that layer.

Use when the user asks to "show X on hover", "include Y in the tooltip", or "stop showing the tooltip".

Property names must exactly match the feature properties in the vector tiles. Call get_schema first if you need to see available property names — the agent's catalog may list them, but get_schema returns the live set. Unknown names render nothing (no error).

${pickLayerNudge}`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID' },
                    fields: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Property names to display, in order. Pass [] to disable the tooltip.'
                    },
                },
                required: ['layer_id', 'fields'],
            },
            execute: (args) => JSON.stringify(mapManager.setTooltip(args.layer_id, args.fields)),
        },

        {
            name: 'reset_tooltip',
            description: `Reset a layer's tooltip fields to its config default (the fields it had when the app loaded). If the layer had no default tooltip, this disables the tooltip. Use when the user asks to "reset the tooltip", "restore the default hover", or "go back to how it was".`,
            inputSchema: {
                type: 'object',
                properties: {
                    layer_id: { type: 'string', description: 'Vector layer ID' },
                },
                required: ['layer_id'],
            },
            execute: (args) => JSON.stringify(mapManager.resetTooltip(args.layer_id)),
        },

        {
            name: 'set_style',
            description: `Update a layer's paint/style properties. Provide MapLibre paint properties — every property name carries a layer-type prefix (\`fill-\`, \`line-\`, \`circle-\`, \`raster-\`).

IMPORTANT: For categorical coloring (e.g., a "match" expression), never guess or assume valid values. Check the dataset catalog in your system prompt for documented coded values, or call get_stac_details for full column details. Only fall back to SELECT DISTINCT via SQL if the metadata doesn't cover it.

Supported paint properties by MapLibre layer type:
  fill (polygons):   fill-color, fill-opacity, fill-outline-color, fill-pattern
  line (lines, polygon outlines): line-color, line-width, line-opacity, line-blur, line-dasharray
  circle (points):   circle-color, circle-radius, circle-opacity, circle-stroke-color, circle-stroke-width
  raster:            raster-opacity, raster-brightness-min, raster-brightness-max, raster-contrast, raster-saturation, raster-hue-rotate

Examples:
  Simple: { "fill-color": "red", "fill-opacity": 0.5 }
  Data-driven categorical: { "fill-color": ["match", ["get", "PROP"], "val1", "#c1", "val2", "#c2", "#default"] }
  Data-driven gradient: { "fill-color": ["interpolate", ["linear"], ["get", "PROP"], 0, "#low", 100, "#high"] }
  Stepped: { "fill-color": ["step", ["get", "PROP"], "#c1", 10, "#c2", 50, "#c3"] }

For dynamic hex layers (\`hex-…\` ids from add_hex_tile_layer), \`PROP\` is the layer's value column (the \`value_column\` you passed to add_hex_tile_layer, e.g. "species_richness") — NOT "count" unless that is literally the column. If unsure, call get_map_state to read the layer's \`valueColumn\`.

${pickLayerNudge}`,
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
            description: `Reset a layer's style to its default appearance.`,
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

        // ---- Geocoding ----
        ...(geocoder ? [{
            name: 'geocode',
            description: `Resolve a free-text place reference — street address, city, landmark, or named region — to real coordinates. Use this WHENEVER the user names a place rather than giving coordinates: "what watershed is 3109 6th Ave, LA in?", "show me Yosemite", "fly to Chicago", "which district contains downtown Fresno".

NEVER invent, recall, or estimate coordinates from your own memory — always call this tool so the coordinate is traceable to a geocoder.

Returns up to \`limit\` ranked candidates. Each candidate has:
  - lat, lon          — pass to fly_to as center [lon, lat] (lon first!), or into point-in-hex SQL lookups
  - bbox [w,s,e,n]    — for framing/fit-bounds; null for precise point addresses
  - display_name      — the normalized, matched location
  - match_quality     — "high" | "medium" | "low"

How to use the result:
  - Echo the resolved \`display_name\` back to the user so they can confirm the location is the one they meant.
  - If more than one candidate is returned, or the top match_quality is "low" (e.g. "Springfield"), ASK the user which one they mean — do NOT silently pick the first.
  - Then act: fly_to the coordinate, or use it in a containing-polygon / nearest-feature query.`,
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Free-text place reference: address, city, landmark, or region name.' },
                    limit: { type: 'number', description: 'Max candidates to return (1–10, default 5). Use a small limit unless disambiguating.' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                try {
                    const results = await geocoder.forwardGeocode(args.query, { limit: args.limit ?? 5 });
                    if (!results.length) {
                        return JSON.stringify({
                            success: true,
                            count: 0,
                            results: [],
                            message: `No location found for "${args.query}". Ask the user to add detail (city, state, or a more specific address).`,
                        });
                    }
                    return JSON.stringify({ success: true, count: results.length, source: results[0].source, results });
                } catch (err) {
                    return JSON.stringify({ success: false, error: `Geocoding failed: ${err.message}` });
                }
            },
        }] : []),

        // ---- Geolocation (device location; opt-in) ----
        ...(options.geolocateTool ? [{
            name: 'get_user_location',
            description: `Get the user's CURRENT PHYSICAL location from their device (GPS/network), returning { latitude, longitude, accuracy_m }. Use this when the relevant place is *where the user is* — "near me", "my area", "what county/district am I in", "carbon here". For a place the user NAMES (a city, address, landmark), use \`geocode\` instead.

The browser asks the user for permission. If they deny it (success:false), tell them you couldn't access their location and offer to let them name a place instead (\`geocode\`).

Returns a single point. This tool does NOT move the map — call \`fly_to\` yourself if you want to recenter. To answer "what's here", feed the coordinate into a containing-polygon / point-in-hex query.`,
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const pos = await getCurrentPositionAsync();
                    return JSON.stringify({
                        success: true,
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude,
                        accuracy_m: pos.coords.accuracy,
                    });
                } catch (err) {
                    const reason = err?.code === 1 ? 'The user denied location permission.'
                        : err?.code === 2 ? 'The location is currently unavailable.'
                        : err?.code === 3 ? 'The location request timed out.'
                        : (err?.message || 'Unknown error.');
                    return JSON.stringify({ success: false, error: `Could not get the user's location: ${reason}` });
                }
            },
        }] : []),

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
  2. Pass the returned \`tile_url\` to this tool. That is the ONLY required field.
     The color-scale metadata (value_stats, bounds, value_column, layer_name) is
     fetched automatically from the tile host by content hash — do NOT copy the
     \`value_stats\` blob or \`bounds\` array into this call. Transcribing that large
     nested object is error-prone and unnecessary; the server already has it.

Optional inputs:
  - value_column          which value_columns entry to color by (default: first; "count" for agg=COUNT)
  - palette / opacity / display_name / fit_bounds    styling (see below)
  - value_stats / bounds / layer_name    accepted as explicit overrides, but normally OMIT — they are fetched
  - format                ← format ("geojson" or "vector"; defaults to "vector")
  - geojson_url           ← geojson_url (REQUIRED when format="geojson"; ignored otherwise)

For GeoJSON tilesets you MUST still pass format="geojson" + geojson_url from the register_hex_tiles return — those two are NOT in the fetched sidecar. The server auto-selects GeoJSON for small/single-resolution tilesets and vector tiles otherwise; for GeoJSON the \`.pbf\` tile_url 404s, so the layer renders blank unless you also pass format="geojson" + geojson_url.

Hexes get finer as the user zooms in: the tile server's pyramid serves the appropriate H3 resolution for each zoom level automatically (vector format only). If the user wants a coarser overall view, re-run \`register_hex_tiles\` with the SQL projected to a coarser resolution by wrapping the first column in \`h3_cell_to_parent(<h3_col>, <target_res>)\` — the server auto-detects the H3 resolution from that column.

IMPORTANT: tile_url must be the exact tile_url_template returned by register_hex_tiles — the tool rejects other URLs. It supplies the layer's content hash for both formats (the GeoJSON layer still keys off it).

The returned layer_id can be used with show_layer / hide_layer / set_style / set_filter / get_map_state like any other vector layer, and with remove_hex_tile_layer to free the source.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tile_url: { type: 'string', description: 'tile_url_template from register_hex_tiles — the ONLY required field' },
                    value_column: { type: 'string', description: 'Optional: which column from value_columns to style by (default: first; "count" for agg=COUNT)' },
                    value_stats: {
                        type: 'object',
                        description: 'Optional override — normally OMIT. Fetched automatically by content hash. Shape if passed: { by_res: { "<res>": { min, max } } }.'
                    },
                    bounds: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Optional override — normally OMIT. Fetched automatically. [w, s, e, n].'
                    },
                    layer_name: { type: 'string', description: 'Optional override — normally OMIT. Fetched automatically (defaults to "layer"; ignored for format="geojson").' },
                    format: {
                        type: 'string',
                        enum: ['vector', 'geojson'],
                        description: 'Tileset format from register_hex_tiles.format. "vector" (default) reads MVT tiles from tile_url; "geojson" reads the whole FeatureCollection from geojson_url.'
                    },
                    geojson_url: { type: 'string', description: 'register_hex_tiles.geojson_url — REQUIRED when format="geojson"' },
                    display_name: { type: 'string', description: 'Optional human-readable layer name (default: "Hex: <value_column>")' },
                    palette: {
                        type: 'string',
                        enum: ['viridis', 'ylorrd', 'bluered'],
                        description: 'Color ramp: viridis (sequential default), ylorrd (warm sequential), bluered (diverging)'
                    },
                    opacity: { type: 'number', description: 'Fill opacity 0..1 (default 0.7)' },
                    fit_bounds: { type: 'boolean', description: 'Fly the camera to fit bounds (default true)' },
                },
                required: ['tile_url'],
            },
            execute: async (args) => {
                const meta = await resolveHexMetadata(args);
                if (meta.error) return JSON.stringify({ success: false, error: meta.error });
                const displayName = args.display_name || `Hex: ${meta.valueColumn}`;
                const result = mapManager.addHexTileLayer({
                    tileUrl: args.tile_url,
                    valueColumn: meta.valueColumn,
                    valueStats: meta.valueStats,
                    bounds: meta.bounds,
                    palette: args.palette || 'viridis',
                    opacity: args.opacity ?? 0.7,
                    displayName,
                    fitBounds: args.fit_bounds !== false,
                    layerName: meta.layerName,
                    format: args.format,
                    geojsonUrl: args.geojson_url,
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

${pickLayerNudge}`,
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
                // col is quoted into wrappedSql — restrict to plain identifier chars.
                if (!/^[A-Za-z0-9_]+$/.test(col || '')) {
                    return JSON.stringify({
                        success: false,
                        error: `Invalid id_property "${col}" — must contain only letters, digits, or underscores. Check get_stac_details for the feature ID column name.`,
                    });
                }
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

/**
 * Build the opt-in `render_chart` tool (#277). Registered only when an app
 * sets `charts.enabled` — so apps that don't want charts pay no footprint and
 * the LLM never sees the tool.
 *
 * @param {{ render: Function }} chartRenderer — a ChartRenderer instance
 * @param {import('./mcp-client.js').MCPClient} [mcpClient] — for the `sql` path
 * @returns {Object} a tool definition (name/description/inputSchema/execute)
 */
/**
 * Run a SELECT (already wrapped to emit `to_json(array_agg(...))`) through MCP
 * and return its rows as a parsed array. Shared marshalling for the chart
 * tool: DuckDB's array_agg over zero rows yields SQL NULL (no brackets), so an
 * empty result is reported as `{ ok: true, rows: [] }`, not a parse failure.
 *
 * @returns {Promise<{ok:true, rows:Array}|{ok:false, error:string}>}
 */
async function runJsonArrayQuery(mcpClient, wrappedSql) {
    let raw;
    try {
        raw = await mcpClient.callTool('query', { sql_query: wrappedSql });
    } catch (err) {
        return { ok: false, error: `SQL execution failed: ${err.message}` };
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || /\bnull\b/i.test(text.trim().replace(/.*\n/, ''))) {
        return { ok: true, rows: [] };
    }
    const rows = extractJsonArray(text);
    if (!rows) {
        return { ok: false, error: `Could not parse rows from query result. Raw: ${text.substring(0, 300)}` };
    }
    return { ok: true, rows };
}

export function createRenderChartTool(chartRenderer, mcpClient) {
    return {
        name: 'render_chart',
        description: `Render query results as a chart in a floating panel. Use when a table or map can't show the shape of the data — e.g. "plot the top 10 countries", "show the distribution", "chart the trend over years".

Chart types:
- bar: ranking / category comparison (x = category, y = value)
- line: time series / trend (x = ordered field e.g. year, y = value)
- scatter: relationship / trade-off (x, y = two numerics)
- histogram: distribution of one numeric (x = the value; bars are counts — omit y)

Provide the data ONE of two ways (if you pass both, sql wins):
- data: an array of row objects you already have, e.g. [{"country":"Brazil","pct":31}, ...]. Best for small, already-aggregated results.
- sql: a SELECT the panel runs itself (rows never pass through the LLM). Best for larger results. Write a plain SELECT — do NOT wrap it in array_agg/to_json.

x / y name the columns to plot; series (optional) splits/colors by a column. Keep result sets small (≈ a few hundred rows max).`,
        inputSchema: {
            type: 'object',
            properties: {
                chart_type: { type: 'string', enum: ['bar', 'line', 'scatter', 'histogram'], description: 'Chart type' },
                title: { type: 'string', description: 'Chart title shown on the panel' },
                data: { type: 'array', items: {}, description: 'Array of row objects to plot. Provide this OR sql.' },
                sql: { type: 'string', description: 'A plain SELECT the panel runs to get rows. Provide this OR data.' },
                x: { type: 'string', description: 'Column for the x axis (category for bar, the value for histogram)' },
                y: { type: 'string', description: 'Column for the y axis (numeric). Omit for histogram.' },
                series: { type: 'string', description: 'Optional column to split/color multiple series' },
                x_label: { type: 'string', description: 'Optional x-axis label (defaults to the x column name)' },
                y_label: { type: 'string', description: 'Optional y-axis label' },
            },
            required: ['chart_type', 'x'],
        },
        execute: async (args) => {
            // Reject a bad spec cheaply, before paying for any SQL round-trip.
            try {
                validateChartSpec(args);
            } catch (err) {
                return JSON.stringify({ success: false, error: err.message });
            }

            let rows;
            if (args.sql) {
                // sql is authoritative when both are supplied — never silently
                // chart a partial inline sample while ignoring the full query.
                if (!mcpClient) return JSON.stringify({ success: false, error: 'MCP client not available for the sql path — pass data instead.' });
                // Aggregate full rows to a JSON array via DuckDB. to_json() is
                // required: DuckDB's native list display is not valid JSON.
                const wrappedSql = `SELECT to_json(array_agg(_chart_rows)) AS rows FROM (${args.sql}) _chart_rows`;
                const res = await runJsonArrayQuery(mcpClient, wrappedSql);
                if (!res.ok) return JSON.stringify({ success: false, error: res.error });
                rows = res.rows;
            } else if (Array.isArray(args.data)) {
                rows = args.data;
            }

            if (!rows || rows.length === 0) {
                return JSON.stringify({
                    success: false,
                    error: args.sql
                        ? 'Query returned no rows — nothing to chart.'
                        : 'No data to chart — provide a non-empty `data` array or a `sql` query that returns rows.',
                });
            }

            try {
                const { id } = await chartRenderer.render(args, rows);
                return JSON.stringify({ success: true, chart_id: id, chart_type: args.chart_type, title: args.title || null, points: rows.length });
            } catch (err) {
                return JSON.stringify({ success: false, error: `Could not render chart: ${err.message}` });
            }
        },
    };
}
