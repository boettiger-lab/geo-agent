# Configuration Reference

Client apps configure geo-agent via `layers-input.json`. All fields except `catalog` and `collections` are optional.

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `catalog` | Yes | STAC catalog root URL. The app traverses child links to find collection metadata. |
| `collections` | Yes | Array of collection specs — see below. |
| `titiler_url` | No | TiTiler server for COG/raster tile rendering. Defaults to `https://titiler.nrp-nautilus.io`. |
| `mcp_url` | No | MCP server URL for DuckDB SQL queries. Omit to disable analytics. |
| `view` | No | Initial map view — see below. |
| `llm` | No | LLM configuration — see below. Omit for server-provided mode. |
| `welcome` | No | Welcome message: `{ "message": "...", "examples": ["...", "..."] }` |
| `default_basemap` | No | Which basemap is active on load: `"natgeo"` (default), `"satellite"`, or `"plain"`. |
| `custom_basemap` | No | Replace the NatGeo slot with a custom tile URL — see below. |
| `auto_approve` | No | Start with remote tool calls auto-approved (no confirmation prompt). Default: `false`. |
| `links` | No | Optional links shown in the chat UI — see below. |

## View

Controls the initial camera position. All fields are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `center` | `[lon, lat]` | `[-119.4, 36.8]` | Initial map center (longitude first). |
| `zoom` | number | `6` | Initial zoom level (0–22). |
| `pitch` | number | `0` | Camera tilt in degrees (0 = flat, 60 = steep). |
| `bearing` | number | `0` | Map rotation in degrees clockwise from north (0 = north-up). |
| `globe` | boolean | `false` | Start in globe (spherical Earth) projection. Users can also toggle this at runtime via the "Globe view" checkbox in the basemap panel. Globe view automatically transitions back to flat Mercator at zoom ~12, where the projections converge — this is handled by MapLibre internally. |

```json
"view": { "center": [-119.4, 36.8], "zoom": 6, "pitch": 0, "bearing": 0 }
```

For apps with 3D terrain, a modest pitch reveals elevation more effectively:

```json
"view": { "center": [-110, 43], "zoom": 6, "pitch": 45, "bearing": -15 }
```

To start in globe projection:

```json
"view": { "center": [0, 20], "zoom": 2, "globe": true }
```

## Collections

Each entry in `collections` is either a **bare string** (loads all visual assets from that collection) or an **object**:

| Field | Type | Description |
|---|---|---|
| `collection_id` | string | STAC collection ID to load. |
| `collection_url` | string | Direct URL to the STAC collection JSON. Bypasses root catalog traversal — useful for private or external catalogs. |
| `group` | string or object | Group label shown in the layer toggle panel. Use an object `{ "name": "...", "collapsed": true }` to start the group folded — see [Collapsed groups](#collapsed-groups). |
| `assets` | array | Asset selector — see below. Omit to load all visual assets. |
| `display_name` | string | Override the collection title shown in the UI. |
| `preload` | boolean | Inject the full column schema into the LLM system prompt — see [Preloaded schemas](#preloaded-schemas). Default: `false`. |

## Asset config — vector (PMTiles)

Each entry in `assets` may be a **bare string** (the STAC asset key, loaded with defaults) or a config object:

| Field | Type | Description |
|---|---|---|
| `id` | string | **Required.** STAC asset key (e.g., `"pmtiles"`). |
| `alias` | string | Alternative layer ID when you need two logical layers from one STAC asset (e.g., two `default_filter` views of the same file). |
| `display_name` | string | Label in the layer toggle UI. Falls back to the STAC asset title. |
| `visible` | boolean | Default visibility on load. Default: `false`. |
| `default_style` | object | MapLibre **fill** paint properties for polygon layers (e.g., `fill-color`, `fill-opacity`). |
| `outline_style` | object | MapLibre **line** paint for an auto-added outline on top of the fill. Use this — not `layer_type` — to draw polygon borders. |
| `layer_type` | `"line"` or `"circle"` | `"line"` for LineString/MultiLineString features; `"circle"` for Point/MultiPoint features. |
| `default_filter` | array | MapLibre filter expression applied at load time. |
| `tooltip_fields` | array | Feature property names shown in the hover tooltip. |
| `group` | string | Overrides the collection-level `group` for this specific layer. |

## Asset config — raster (COG)

| Field | Type | Description |
|---|---|---|
| `id` | string | **Required.** STAC asset key. |
| `display_name` | string | Label in the layer toggle UI. |
| `visible` | boolean | Default visibility. Default: `false`. |
| `colormap` | string | TiTiler colormap name (e.g., `"reds"`, `"blues"`, `"viridis"`). Default: `"reds"`. |
| `rescale` | string | TiTiler min,max range for color scaling (e.g., `"0,150"`). |
| `nodata` | number\|string | Pixel value to render transparent (e.g., `0` to mask ocean/no-data). If unset, falls back to the STAC `raster:bands[0].nodata` value; omit both to leave all pixels opaque. |
| `legend_label` | string | Label shown next to the color legend. |
| `legend_type` | string | `"categorical"` to use STAC `classification:classes` color codes for a discrete legend. |

## Asset config — GeoJSON

STAC assets with MIME type `application/geo+json` (or an `.geojson` href) are loaded as MapLibre GeoJSON sources. This is the simplest path for small vector datasets — no PMTiles build step required, just host a `.geojson` file alongside the STAC collection.

GeoJSON assets accept the same config fields as PMTiles vectors (`display_name`, `visible`, `default_style`, `outline_style`, `layer_type`, `default_filter`, `tooltip_fields`, `group`). They also work with [versioned assets](#versioned-assets) and [animated trajectories](#animated-trajectory-layers).

```json
{
  "collection_id": "ca-wolves",
  "assets": [
    {
      "id": "pack-territories",
      "display_name": "Pack Territories",
      "visible": true,
      "default_style": { "fill-color": "#1565C0", "fill-opacity": 0.3 },
      "outline_style": { "line-color": "#1565C0", "line-width": 2 }
    }
  ]
}
```

::: tip When to use GeoJSON vs PMTiles
GeoJSON loads the entire file into the browser at once, so it works best for small datasets (a few thousand features or a few MB). For larger datasets, PMTiles streams only the tiles visible at the current zoom level and will perform significantly better.
:::

## Animated trajectory layers

For GeoJSON assets containing `LineString` features with a parallel timestamp array, set `animation` on the asset config to turn it into an animated point-along-line layer. The framework adds a play/pause controller, renders a faint static track line, and emits colored dots that interpolate linearly between waypoints. The layer appears in the layer menu like any other layer; the LLM agent's `show_layer` / `hide_layer` / `set_filter` tools work on it directly.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | string | — | **Required.** Currently only `"trajectory"` is supported. |
| `timestamp_field` | string | `"timestamps"` | Feature property holding an array of ISO timestamps — one per coordinate in the LineString. |
| `id_field` | string | `"id"` | Feature property used to group features (one animated dot per unique value). Also used by `set_filter`. |
| `loop` | boolean | `true` | Restart at `globalStart` when reaching `globalEnd`. |
| `duration_seconds` | number | `30` | Real-time seconds for one pass through the time range. |
| `dot_radius` | number | `7` | Animated dot radius (px). |
| `show_track_line` | boolean | `true` | Draw a faint static line of the full trajectory underneath. |
| `track_line_opacity` | number | `0.35` | Opacity of the static track line. |
| `show_labels` | boolean | `true` | Render each dot's `id_field` value as a text label. |
| `static_positions_asset` | string | — | STAC asset key (in the same collection) for a GeoJSON of static positions. Entities present only in this dataset render as non-moving dots. |

`default_style` on the asset supplies paint overrides — `line-color` and `circle-color` are the common cases, and MapLibre `match` expressions against `id_field` let you color-code per entity.

```json
{
  "collection_id": "ca-wolves",
  "group": { "name": "Wolf Activity" },
  "assets": [
    {
      "id": "tracks",
      "display_name": "Wolf Movement",
      "visible": true,
      "animation": {
        "type": "trajectory",
        "timestamp_field": "timestamps",
        "id_field": "pack",
        "duration_seconds": 30,
        "static_positions_asset": "bins-latest"
      },
      "default_style": {
        "line-color":   ["match", ["get", "pack"], "Whaleback 1", "#E65100", "Harvey 1", "#1565C0", "#888"],
        "circle-color": ["match", ["get", "pack"], "Whaleback 1", "#E65100", "Harvey 1", "#1565C0", "#888"]
      }
    }
  ]
}
```

Only point-trajectory animation is supported today. Raster time-series playback and temporal filtering of static features are tracked as future work in [#144](https://github.com/boettiger-lab/geo-agent/issues/144).

## Collapsed groups

By default, layer groups in the panel start expanded. To start a group folded (useful when a collection has many layers), use the object form for `group`:

```json
{
  "collection_id": "fishing-effort",
  "group": { "name": "Fishing Effort", "collapsed": true },
  "assets": [
    { "id": "fishing-effort-cog-2012", "display_name": "2012" },
    { "id": "fishing-effort-cog-2024", "display_name": "2024", "visible": true }
  ]
}
```

The string form (`"group": "Fishing Effort"`) still works and defaults to expanded. The per-asset `group` field (used to reassign a layer to a different group) is always a plain string.

## Preloaded schemas

By default, the system prompt includes only a compact hint for each collection — enough for the LLM to know the dataset exists, but it must call `get_dataset_details` before writing SQL. This keeps token usage low when many collections are configured.

Set `"preload": true` on a collection to inject its full column schema (names, types, descriptions, and H3 index columns) directly into the system prompt. This lets the LLM write correct SQL on the first turn without an extra tool call, at the cost of more prompt tokens.

Use `preload` for the datasets users query most often:

```json
{
  "collection_id": "cpad-2025b",
  "preload": true,
  "group": "Protected Areas",
  "assets": [{ "id": "cpad-holdings-pmtiles", "visible": true }]
}
```

Collections without `preload` (or with `preload: false`) show a compact summary with coded-value hints and a prompt to call `get_dataset_details`. The `get_dataset_details` tool always returns the full schema regardless of the `preload` setting.

## Versioned assets

When a dataset has multiple related assets that differ along one axis (resolution level, year, scenario), declare them as **versions** of a single logical layer. The layer panel shows one checkbox plus a dropdown selector instead of separate entries for each asset.

```json
{
  "id": "watersheds",
  "display_name": "Watersheds",
  "versions": [
    { "label": "L3 – Major Basins",   "asset_id": "hydrobasins_level_03" },
    { "label": "L4",                   "asset_id": "hydrobasins_level_04" },
    { "label": "L5",                   "asset_id": "hydrobasins_level_05" },
    { "label": "L6 – Sub-catchments",  "asset_id": "hydrobasins_level_06" }
  ],
  "default_version": "L6 – Sub-catchments"
}
```

| Field | Type | Description |
|---|---|---|
| `versions` | array | List of `{ "label": "...", "asset_id": "..." }` entries. Each `asset_id` must be a key in the STAC collection's assets. |
| `default_version` | string | Label of the version to show by default. Falls back to the first entry if not found. |

Switching versions swaps the visible map layer without adding or removing panel entries. All per-asset config options (`default_style`, `default_filter`, `colormap`, etc.) apply uniformly to every version. Works for both PMTiles (vector) and COG (raster) assets; all versions must share the same layer type.

## Basemap configuration

Three basemap presets are always available via the toggle buttons: **NatGeo** (default), **Satellite**, and **Plain**.

**`default_basemap`** — controls which preset is active when the map loads:

```json
{ "default_basemap": "plain" }
```

Valid values: `"natgeo"` (default), `"satellite"`, `"plain"`.

**`custom_basemap`** — replaces the NatGeo slot with a custom raster tile URL:

```json
{
  "custom_basemap": {
    "url": "https://example.com/tiles/{z}/{x}/{y}.png",
    "label": "My Basemap"
  }
}
```

| Field | Description |
|---|---|
| `url` | XYZ raster tile URL with `{z}/{x}/{y}` placeholders. |
| `label` | Button label to show in the basemap toggle group (replaces "NatGeo"). |

Both fields are optional independently — you can swap the URL without changing the label, or vice versa. Terrain is disabled when a custom URL is set. The two options compose independently:

```json
{
  "custom_basemap": { "url": "...", "label": "My Style" },
  "default_basemap": "plain"
}
```

## Links

Optional links surfaced in the chat UI. All fields are optional — omit any you don't need.

```json
{
  "links": {
    "github": "https://github.com/org/my-app",
    "docs": "https://my-app-website.org",
    "carbon": true
  }
}
```

| Field | Description |
|---|---|
| `github` | URL to the app's source repository. Renders as a GitHub octocat icon in the chat header. |
| `docs` | URL to a documentation or about page for the app. Renders as an "About" text link in the chat header. |
| `carbon` | Set to `true` to show a carbon dashboard link (leaf icon) in the chat footer. Only meaningful for apps using NRP-hosted LLMs — links to the NRP carbon API dashboard. |

## LLM configuration

The `llm` section controls how the chat agent connects to a language model. Two modes:

**Server-provided** (default — omit `llm`): a `config.json` on the same server provides model endpoints and API keys (e.g., injected by Kubernetes at deploy time). See [Deployment](./deployment).

**User-provided** (`"user_provided": true`): no `config.json` needed. A ⚙ button appears in the chat footer; visitors enter their own API key, stored in `localStorage` (never sent to the server). Ideal for static-site deployments.

| Field | Description |
|---|---|
| `user_provided` | `true` to enable browser-side API key entry. |
| `default_endpoint` | Pre-filled endpoint URL shown in the settings panel. [OpenRouter](https://openrouter.ai) gives access to many models via one key. |
| `models` | Array of `{ "value": "<model-id>", "label": "<display name>" }` entries in the model selector. |

## Voice input (optional)

Voice input is opt-in via a `transcription_model` entry in `config.json`. When present, a 🎤 button appears in the chat footer; when absent, the button stays hidden and the voice/transcription JS modules are never loaded (zero footprint).

The voice pipeline runs in two phases:

1. **Transcription** — the recorded audio is sent to `transcription_model` with a "transcribe exactly" prompt. The returned text lands in the chat input field so you can review and edit it before sending.
2. **Agent** — pressing send dispatches the (possibly edited) text through the normal agent loop, using whichever model is selected in the model dropdown. Voice input therefore works with *any* agent model, not just audio-capable ones.

**Server-provided mode** — add at the top level of `config.json`:

```json
{
  "transcription_model": {
    "value": "google/gemma-3n-e4b-it",
    "endpoint": "https://llm-proxy.nrp-nautilus.io/v1",
    "api_key": "EMPTY"
  }
}
```

**User-provided mode** — add inside the `llm` block in `layers-input.json`. The user's API key and endpoint are injected at runtime, so you usually only need to specify `value`:

```json
{
  "llm": {
    "user_provided": true,
    "default_endpoint": "https://open-llm-proxy.nrp-nautilus.io/v1",
    "models": [ /* ... */ ],
    "transcription_model": { "value": "gemma" }
  }
}
```

The `endpoint` must be an OpenAI-compatible chat-completions URL whose model accepts the `input_audio` content part. Any backend that meets that contract works — gemma4 on the NRP llm-proxy is the current reference implementation; a dedicated Whisper deployment can be substituted by swapping this config block.

## Draw tool (optional)

The polygon draw tool lets users draw a region of interest on the map and query it through the chat agent. It is opt-in: when absent, no draw UI appears and the draw module is never loaded (zero footprint).

| Field | Type | Default | Description |
|---|---|---|---|
| `draw_enabled` | boolean | `false` | Show the draw button and register the `get_drawn_region` tool. |

```json
{ "draw_enabled": true }
```

When enabled, a pentagon icon button appears in the top-left map controls (below the zoom buttons). Click it to enter polygon draw mode, click on the map to place vertices, and double-click to finish. Only one polygon can exist at a time — drawing a new one replaces the previous.

The agent receives a `get_drawn_region` tool that returns the polygon as WKT along with a suggested H3 resolution scaled to the region size. This prevents expensive high-resolution hexing of large areas.

## Tool call auto-approve

By default, the agent pauses before executing remote tool calls (SQL queries via the MCP server) and shows a confirmation prompt with **Run** / **Cancel** buttons. Local tools — map controls like `show_layer`, `fly_to`, `set_filter` — always run immediately without confirmation.

Set `auto_approve` to skip the confirmation step for remote calls:

```json
{ "auto_approve": true }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_approve` | boolean | `false` | When `true`, remote tool calls execute immediately without user confirmation. |

A ⚡ toggle button in the chat footer lets users switch auto-approve on or off at runtime. The runtime state is saved in `localStorage` (`geo-agent-auto-approve`) and takes precedence over the config value on subsequent visits. Setting `auto_approve: true` in config controls only the *initial* default for first-time visitors.

## Finding STAC asset IDs

Browse the catalog in STAC Browser:

```
https://radiantearth.github.io/stac-browser/#/external/s3-west.nrp-nautilus.io/public-data/stac/catalog.json
```

Open a collection → click the **Assets** tab. The keys listed there (e.g., `"pmtiles"`, `"v2-total-2024-cog"`) are the `id` values to use. For PMTiles vector layers, the asset's `vector:layers` field gives the internal layer name used by MapLibre (the app reads this automatically).

## Worked examples

### Point features as circles

```json
{
  "id": "pmtiles",
  "display_name": "Observation Points",
  "visible": true,
  "layer_type": "circle",
  "default_style": {
    "circle-color": "#E53935",
    "circle-radius": 5,
    "circle-opacity": 0.7
  },
  "tooltip_fields": ["species", "date", "count"]
}
```

### Polygon fill with categorical coloring

```json
{
  "id": "pmtiles",
  "display_name": "Fee Lands",
  "visible": true,
  "default_style": {
    "fill-color": ["match", ["get", "GAP_Sts"],
      "1", "#26633A",
      "2", "#3E9C47",
      "3", "#7EB3D3",
      "4", "#BDBDBD",
      "#888888"
    ],
    "fill-opacity": 0.7
  },
  "default_filter": ["match", ["get", "GAP_Sts"], ["1", "2"], true, false],
  "tooltip_fields": ["Unit_Nm", "GAP_Sts", "Mang_Type"]
}
```

### Boundary-only (outline) layer

To render polygon features as outlines only (census tracts, admin boundaries), keep the fill type but make the fill transparent and set `outline_style`:

```json
{
  "id": "pmtiles",
  "display_name": "Congressional Districts",
  "visible": true,
  "default_style": {
    "fill-color": "#000000",
    "fill-opacity": 0
  },
  "outline_style": {
    "line-color": "#1565C0",
    "line-width": 1.5
  },
  "tooltip_fields": ["DISTRICTID", "STATE"]
}
```

::: warning Common mistake
`layer_type` is for the geometry type of the tile features, not a styling choice. Only set it when the features really are lines or points:
- `"line"` — LineString/MultiLineString features (roads, rivers, transects)
- `"circle"` — Point/MultiPoint features (observations, stations, events)

For polygon outline styling, use `outline_style` instead — see the example below.
:::

### Filter syntax

Use `["match", ["get", "col"], ["val1", "val2"], true, false]` for list membership. Do **not** use the legacy `["in", "col", val1, val2]` form — it is silently ignored in current MapLibre.

### Full example

```json
{
  "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
  "titiler_url": "https://titiler.nrp-nautilus.io",
  "mcp_url": "https://duckdb-mcp.nrp-nautilus.io/mcp",
  "view": { "center": [-119.4, 36.8], "zoom": 6, "pitch": 0, "bearing": 0 },

  "llm": {
    "user_provided": true,
    "default_endpoint": "https://openrouter.ai/api/v1",
    "models": [
      { "value": "anthropic/claude-sonnet-4", "label": "Claude Sonnet" },
      { "value": "google/gemini-2.5-flash", "label": "Gemini Flash" }
    ]
  },

  "welcome": {
    "message": "Explore California's protected lands. Ask me about ownership, gap status, or acreage.",
    "examples": [
      "How much land is gap status 1 or 2?",
      "Show only federal lands",
      "Which agency manages the most acreage?"
    ]
  },

  "collections": [
    {
      "collection_id": "cpad-2025b",
      "group": "Protected Areas",
      "assets": [
        {
          "id": "cpad-holdings-pmtiles",
          "display_name": "Holdings",
          "visible": true,
          "default_style": { "fill-color": "#3E9C47", "fill-opacity": 0.5 },
          "tooltip_fields": ["UNIT_NAME", "AGNCY_NAME"]
        }
      ]
    },
    {
      "collection_id": "irrecoverable-carbon",
      "group": "Carbon",
      "assets": [
        { "id": "irrecoverable-total-2018-cog", "display_name": "Irrecoverable Carbon (2018)" }
      ]
    }
  ]
}
```
