# `add_hex_tile_layer` — design spec

**Issue:** [#51](https://github.com/boettiger-lab/geo-agent/issues/51)
**Date:** 2026-04-16
**Status:** approved, ready for implementation plan
**Follow-up tracked:** [#169](https://github.com/boettiger-lab/geo-agent/issues/169) (MapManager decomposition)

## Goal

Let the geo-agent render dynamic H3 hex MVT tiles produced by `mcp-data-server`'s `register_hex_tiles` tool (shipped in v0.3.0). Today the agent can return a tile URL as chat text but cannot put the tiles on the map.

User-facing example: *"Show me a hex map of protected-area density across the Western US."*

## Non-goals

- A generic `add_source` tool for arbitrary tile URLs (hex-only here).
- Any server-side change — `register_hex_tiles` + the `/tiles/hex/{hash}/{z}/{x}/{y}.pbf` endpoint are a fixed contract.
- Sidebar UI controls, legends, or persistence across page reloads.
- Log / quantile / custom value scaling — linear interpolation only; agent pre-transforms in SQL if needed.
- Custom palettes beyond three built-ins.
- Decomposing `map-manager.js` — tracked in #169.

## Scope summary

Two new LLM-callable tools in `app/map-tools.js`:

- `add_hex_tile_layer(tile_url, value_column, value_range, bounds, ...)` — registers a dynamic MVT vector source + fill layer.
- `remove_hex_tile_layer(layer_id)` — removes one by id.

Two new methods on `MapManager` in `app/map-manager.js`:

- `addHexTileLayer(opts)` — owns `map.addSource` / `map.addLayer` / `this.layers` writes.
- `removeHexTileLayer(layerId)` — mirror.

No config changes, no new deps, no downstream HTML changes.

## Key design decisions (with rationale)

### D1. Layer registry: first-class for agent, invisible to sidebar

Hex layers register into `mapManager.layers` with the same state shape as existing vector layers. That makes `show_layer` / `hide_layer` / `set_filter` / `set_style` / `get_map_state` work on hex layers for free.

The sidebar is built from **static catalog config** in `main.js` (not by iterating `mapManager.layers`), so hex layers are invisible to the sidebar without any filter logic. No `ephemeral` flag needed — the separation falls out naturally.

**Rejected alternatives:** full sidebar integration (premature — session-ephemeral), orphan layers outside `mapManager.layers` (breaks reuse of existing tools).

### D2. Color ramp: LLM passes `value_range` explicitly

The tool requires `value_range: [min, max]`. The agent computes this via one extra MCP `query` round-trip (`SELECT MIN(col), MAX(col) FROM (<same sql>)`) before calling `add_hex_tile_layer`.

**Rejected alternatives:** client-side MVT tile sampling (adds a decoder dep, brittle at coarse zooms); viewport quantile bins (colors shift on pan/zoom, surprising UX).

### D3. Lifecycle: idempotent add + explicit remove

- `add_hex_tile_layer` with a URL whose hash is already registered returns `{success: true, already_exists: true}` without mutating anything.
- `remove_hex_tile_layer(layer_id)` is the only way to free a source.

**Rejected alternatives:** single-slot auto-replace (forecloses multi-layer comparison); add-without-remove (leaks sources until page reload).

### D4. Auto-fit to bounds by default

Tool calls `map.fitBounds(bounds)` automatically (opt-out via `fit_bounds: false`). Matches user intent ~95% of the time for analysis-driven hex maps and saves one agent round-trip vs. calling `fly_to` separately.

Differs from `show_layer` (which never moves camera) because curated layers are often global/CONUS while hex analyses target a specific region and the agent already has bounds in hand.

### D5. Code location: new methods on `MapManager`

`MapManager` retains single write authority over `this.layers`. Tools in `map-tools.js` stay thin: marshal args, call the manager method, format results. Consistent with every other mutator today.

Tradeoff: grows `map-manager.js` (~1030 → ~1130 lines). Tracked as a general concern in #169 but not blocking.

## Tool specifications

### `add_hex_tile_layer`

| Param | Type | Required | Default | Source |
|---|---|---|---|---|
| `tile_url` | string | ✓ | — | `register_hex_tiles.tile_url_template` |
| `value_column` | string | ✓ | — | chosen from `register_hex_tiles.value_columns` |
| `value_range` | `[min, max]` | ✓ | — | computed via MCP `query` |
| `bounds` | `[w, s, e, n]` | ✓ | — | `register_hex_tiles.bounds` |
| `display_name` | string | ✗ | `"Hex: <value_column>"` | LLM-supplied |
| `palette` | enum `"viridis" \| "ylorrd" \| "bluered"` | ✗ | `"viridis"` | — |
| `opacity` | number (0–1) | ✗ | `0.7` | — |
| `fit_bounds` | boolean | ✗ | `true` | — |

**Returns (success):**
```json
{"success": true, "layer_id": "hex-<hash>", "display_name": "...",
 "value_column": "...", "valueRange": [min, max], "bounds": [w,s,e,n],
 "already_exists": false}
```

### `remove_hex_tile_layer`

| Param | Type | Required |
|---|---|---|
| `layer_id` | string | ✓ |

**Returns:** `{success: true, layer_id}` or `{success: false, error}`.

Refuses any `layer_id` not starting with `hex-` so curated layers can't be accidentally destroyed.

## Architecture

### Identifiers

- Hash extracted from URL via `/tiles/hex/([^/]+)/`. Refuses non-matching URLs.
- `layer_id` = map-source id = map-layer id = `hex-<hash>`. Deterministic, makes `add_hex_tile_layer` idempotent.

### Source-layer name

Hardcoded to `'hex'` per the `mcp-data-server` v0.3.0 server docstring contract:

```js
map.addLayer({..., 'source-layer': 'hex', paint: {...}});
```

If the server changes this, coordinated update required here. Not treated as a parameter — keeps the tool closed over a stable contract.

### Paint expression

```js
const PALETTES = {
  viridis: ['#440154', '#21918c', '#fde725'],
  ylorrd:  ['#ffffb2', '#fd8d3c', '#bd0026'],
  bluered: ['#2166ac', '#f7f7f7', '#b2182b'],
};

const [min, max] = valueRange;
const mid = (min + max) / 2;
const [c0, c1, c2] = PALETTES[palette];

const fillColor = [
  'case',
  ['==', ['get', valueColumn], null],
  'rgba(0,0,0,0)',
  ['interpolate', ['linear'], ['get', valueColumn],
    min, c0,
    mid, c1,
    max, c2,
  ],
];
```

Additional paint: `fill-opacity: <opacity>`, `fill-outline-color: 'rgba(0,0,0,0.15)'`. No separate outline layer (would double draw cost for small hex cells).

### Layer-state shape in `mapManager.layers`

Matches existing vector-layer shape so `show_layer` / `set_filter` / `get_map_state` etc. work transparently:

```js
{
  layerId: 'hex-<hash>',
  mapLayerId: 'hex-<hash>',
  outlineLayerId: null,
  sourceId: 'hex-<hash>',
  datasetId: null,
  group: null,
  displayName,
  type: 'vector',
  sourceLayer: 'hex',
  columns: [],
  visible: true,
  filter: null,
  defaultFilter: null,
  defaultPaint: {...},
  tooltipFields: null,
}
```

## Data flow (end-to-end)

1. **Agent → MCP `register_hex_tiles`**: returns `{tile_url_template, hash, bounds, value_columns, feature_count_finest, ...}`.
2. **Agent → MCP `query`**: `SELECT MIN(col), MAX(col) FROM (<same sql>)` → `[min, max]`.
3. **Agent → `add_hex_tile_layer`** (local): passes URL, column, range, bounds, optional style.
4. **Tool:** extract hash → idempotency check → call `MapManager.addHexTileLayer`.
5. **MapManager:**
   1. `map.addSource(id, {type: 'vector', tiles: [url], minzoom: 0, maxzoom: 14})`
   2. Build `fill-color` expression
   3. `map.addLayer({id, type: 'fill', source: id, 'source-layer': 'hex', paint, layout: {visibility: 'visible'}})`
   4. Register in `this.layers`
6. **Tool:** optional `fitBounds`, return success payload.

**Remove flow:** prefix-guard `hex-` → `map.removeLayer` → `map.removeSource` → `this.layers.delete`.

**Round-trip budget:** 1 MCP register + 1 MCP min/max + 1 local tool = **3 tool calls per hex map**. If `register_hex_tiles` ever returns min/max directly, drops to 2 (candidate server enhancement; not blocking).

## Error handling

| Failure | Response |
|---|---|
| `tile_url` doesn't match `/tiles/hex/<hash>/` | `{success: false, error: "Invalid tile_url — expected template from register_hex_tiles"}` |
| `value_range` `min >= max` | `{success: false, error: "value_range collapsed: min >= max"}` |
| `palette` unknown | `{success: false, error: "Unknown palette 'X'. Valid: viridis, ylorrd, bluered"}` |
| Layer with same hash already registered | `{success: true, layer_id, already_exists: true}` — advisory, not an error |
| `remove_hex_tile_layer` on unknown id | `{success: false, error: "Unknown hex layer '<id>'. Registered: [...]"}` |
| `remove_hex_tile_layer` on non-hex id | `{success: false, error: "layer_id '<id>' is not a hex layer (must start with 'hex-')"}` |
| `map.addSource` throws | Propagated via `ToolRegistry`'s existing try/catch |

## Testing plan

**Unit (CI, no browser):**
- `extractHashFromUrl()` — valid and invalid inputs
- Paint-expression builder: one snapshot per palette × sample range
- Idempotent add: second call with same URL → `already_exists: true`, no duplicate source

**Integration (headless browser or manual against dev MCP server):**
- Full flow: register → add → assert source + layer present in `map.getStyle()`
- `fitBounds` moved camera within tolerance
- `remove_hex_tile_layer` cleans source + layer + registry
- `show_layer` / `hide_layer` / `set_style` on a hex layer work via existing tools

**Manual smoke (browser, real proxy):**
- User prompt → tiles render, correctly colored
- Second hex layer added without disturbing first
- Remove frees the source (verify via DevTools)

**Explicitly not tested here:** MCP server (covered by its own 105-test suite), MVT decoding correctness (MapLibre's concern).

## Out of scope — confirmed

- Generic `add_source` tool
- Any server-side change
- Sidebar UI / legend / persistence
- Palettes beyond the three built-ins
- Log / quantile scaling
- MapManager decomposition (tracked in #169)

## Open questions

None blocking. Future enhancements to consider once the tool is in use:

- `register_hex_tiles` returning min/max to eliminate the extra query.
- A dynamic-layers section in the sidebar so users can toggle hex layers manually.
- A hex-layer legend mode in the chat UI.
