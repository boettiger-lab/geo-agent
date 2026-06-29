# Configuration Reference

Client apps configure GLEN via `layers-input.json`. All fields except `catalog` and `collections` are optional.

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
| `auto_approve` | No | Start with remote tool calls auto-approved (no confirmation prompt). Default: `true`. |
| `max_tool_calls` | No | Remote queries in auto-approve mode before the agent pauses at a checkpoint. Default: `15`. |
| `max_tool_calls_manual` | No | Remote queries in manual mode before a checkpoint. Default: `100`. |
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
| `collection_url` | string | Direct URL to the STAC collection JSON. **Required** for any collection that is not a direct child of the root catalog — see [Nested collections](#nested-collections). Also needed for private or external catalogs, and recommended even for top-level collections since it skips the (slow) catalog walk. |
| `group` | string or object | Group label shown in the layer toggle panel. Use an object `{ "name": "...", "collapsed": true }` to start the group folded — see [Collapsed groups](#collapsed-groups). |
| `assets` | array | Asset selector — see below. Omit to load all visual assets. |
| `display_name` | string | Override the collection title shown in the UI. |
| `preload` | boolean | Inject the full column schema into the LLM system prompt — see [Preloaded schemas](#preloaded-schemas). Default: `false`. |

### Nested collections

The framework resolves bare `collection_id`s by scanning **only the direct `child` links of the root catalog** (`appConfig.catalog`). It does **not** recurse into parent/container collections. So any collection nested under a parent — *even within the same public catalog* — must specify an explicit `collection_url`, or its layer **silently never appears** (the miss is only a `console.warn`, not a user-visible error).

This bites when a collection shows up in the flat `list_datasets` output (so it looks loadable by ID) but actually lives under a container collection rather than directly under the root.

**How to tell whether a collection is nested:** fetch the root catalog JSON and inspect its `links[rel=child]`. If your `collection_id` isn't among those direct children, it's nested under one of them and needs a `collection_url`.

**How to find the URL:** open the collection's own JSON and copy its `self` href (typically the `stac-collection.json` path in object storage, e.g. `https://.../<collection_id>/stac-collection.json`).

```json
{
  "collection_id": "ace-amphibian-richness",
  "collection_url": "https://data.source.coop/cboettig/ca30x30/ace-amphibian-richness/stac-collection.json"
}
```

**Trade-off:** a hardcoded `collection_url` breaks if the bucket/path is renamed or moved, so prefer it only where the catalog walk can't reach the collection (or where skipping the walk is a deliberate perf choice).

> **Troubleshooting:** *a layer never appears and its `collection_id` is correct* → it is probably nested under a parent collection. Set `collection_url`.

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
| `legend_type` | string | `"categorical"` for a discrete swatch legend (see `legend_classes`), or `"continuous"` for a graduated colorbar (see below). |
| `legend_classes` | array | `{ label, color }` entries describing the discrete legend swatches. Required when `legend_type` is `"categorical"` on a vector layer — vectors have no STAC `classification:classes` to derive from. |
| `legend_label` | string | Unit/axis label shown next to the colorbar end values (e.g. `"species"`). Applies to `"continuous"` legends. |
| `legend_range` | `[min, max]` | Override the colorbar's value-axis labels. Optional — derived from the `default_style` color stops when omitted. |
| `legend_gradient` | array | Override the colorbar colors, low→high (e.g. `["#edf8e9", "#005a32"]`). Optional — derived from the `default_style` color stops when omitted. |

### Continuous (graduated) vector legends

A vector layer styled with a graduated `default_style` — an `interpolate` or `step` color expression — can show the same colorbar a raster does. Set `legend_type: "continuous"`; the colorbar's gradient and value range are **derived automatically from the `default_style` color stops**, so no extra config is required:

```json
{
  "id": "ace-amphibian-richness-pmtiles",
  "display_name": "ACE Amphibian Richness",
  "legend_type": "continuous",
  "legend_label": "species",
  "default_style": {
    "fill-color": ["interpolate", ["linear"], ["get", "species"],
      0, "#edf8e9", 242, "#005a32"],
    "fill-opacity": 0.7
  }
}
```

Use `legend_range` and/or `legend_gradient` only to override the derived values (e.g. when the paint expression doesn't cleanly map to the labels you want, or the color stops aren't plain hex). If neither config nor a parseable color expression is present, the layer shows no legend.

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

For *temporal filtering of static features* — stepping a year/date field on an ordinary vector layer rather than animating moving points — use a reactive-parameter control (below) instead. Raster time-series playback remains future work.

## Reactive-parameter controls (sliders)

A `control` block turns an asset into a layer with a slider that rebinds a map property as you drag it — entirely client-side, with no LLM round-trip per step. The headline use is a **temporal filter**: scrub a year/date field across its range, either cumulatively ("show everything up to year N") or one step at a time ([#147](https://github.com/boettiger-lab/geo-agent/issues/147)). The slider panel floats over the map (like the trajectory controls) and appears whenever the layer is visible.

The same control is also available to the agent at runtime via the **`create_slider`** tool — e.g. "let me step through the fire years" attaches a year slider to the active layer without any config.

The slider composes with the layer's configured `default_filter` (applied as `["all", default_filter, sliderPredicate]`), so a base predicate survives. While a slider is active it governs the layer's filter slot, so a separate `set_filter` on the same layer is superseded the next time the slider moves.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | string | `"slider"` | Control widget. Currently only `"slider"` is supported. |
| `field` | string | — | **Required.** Feature property the slider filters on (must compare numerically). |
| `min` | number | — | **Required.** Low end of the slider range. |
| `max` | number | — | **Required.** High end of the slider range. |
| `step` | number | `1` | Slider increment. |
| `bind` | string | `"filter"` | What the slider drives. Currently `"filter"` (a MapLibre filter expression); `"style"` and `"query"` binds are reserved for future work. |
| `mode` | string | `"cumulative"` | For `filter` bind: `"cumulative"` shows `field <= value`; `"step"` shows `field == value`. |
| `label` | string | field name | Text shown on the slider panel. |
| `default` | number | `max` (cumulative) / `min` (step) | Initial slider value. |
| `animate` | boolean | `false` | Add a play/pause button that sweeps `min → max` automatically. |
| `duration_seconds` | number | `20` | Real-time seconds for one autoplay sweep (when `animate` is set). |
| `loop` | boolean | `true` | Restart at `min` after an autoplay sweep reaches `max`. |

```json
{
  "collection_id": "calfire-perimeters",
  "assets": [
    {
      "id": "firep-pmtiles",
      "display_name": "CAL FIRE Wildfire Perimeters",
      "control": {
        "type": "slider",
        "field": "YEAR_",
        "label": "Year",
        "min": 1835,
        "max": 2024,
        "step": 1,
        "mode": "cumulative",
        "animate": true,
        "duration_seconds": 20
      }
    }
  ]
}
```

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

By default, the system prompt includes only a compact hint for each collection — enough for the LLM to know the dataset exists, but it must call `get_schema` before writing SQL. This keeps token usage low when many collections are configured.

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

Collections without `preload` (or with `preload: false`) show a compact summary with coded-value hints and a prompt to call `get_schema`. The `get_schema` tool always returns the full schema regardless of the `preload` setting.

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

## Layer paint order

Overlays are painted in the order they are declared in `layers-input.json`: the **first** asset sits at the bottom of the overlay stack (just above the basemap) and the **last** asset paints on top. Reorder the entries to change the initial stacking.

At runtime, users can demote whichever overlay is currently on top with the **send-to-back button** (↩) in the **Overlays** panel header. Each click sends the topmost visible overlay to the bottom of the stack, so repeated clicks cycle through the visible overlays — useful for peeking at a layer hidden beneath another. The button is disabled until at least two overlays are visible, and the stacking resets to the configured order on reload (the change is not persisted).

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

## Sidebar layout

By default, GLEN renders a small translucent chat panel floating in the
bottom-right corner of the map. Apps that benefit from more chat real-estate
(e.g., heavy analytical use, long tool-call transcripts, prominent layer menus)
can opt in to a full-height, resizable sidebar via a top-level `sidebar` block
in `layers-input.json`.

### Enabling sidebar mode

**Step 1 — Update `index.html`** to use the minimal scaffold and include `sidebar.css`:

```html
<head>
  <!-- ... other tags ... -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.2.0/app/style.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.2.0/app/chat.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.2.0/app/sidebar.css">
</head>
<body>
  <div id="map"></div>
  <div id="menu"></div>
  <script type="module"
    src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.2.0/app/main.js">
  </script>
</body>
```

::: warning Remove hardcoded chat HTML
If your `index.html` contains a `<div id="chat-container">` block with nested chat elements, **remove it**. Since v3.2.0 the layout manager builds the entire chat DOM dynamically. The old hardcoded scaffold is cleaned up automatically on boot, but removing it keeps your HTML clean.
:::

**Step 2 — Add the `sidebar` block** to `layers-input.json`:

```json
"sidebar": {
    "enabled": true,
    "default_width": 420,
    "title": "Data Assistant",
    "chat_title": "Chatbot"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Opts in to sidebar mode. Omitting the whole `sidebar` block is equivalent to `false`. |
| `default_width` | number | `420` | Starting width in pixels. The user's last-dragged width (stored in `localStorage`) overrides this on reload, as long as it's within bounds. |
| `title` | string | `"Data Assistant"` | Text shown in the sidebar header (and in the floating panel header too — this key applies to both modes). This is the header at the **top** of the sidebar, above both the layers and the chat. |
| `chat_title` | string | _(unset)_ | Optional heading shown **persistently above the chat section**, mirroring the layers "Overlays" label. When unset, the chat section has no visible heading except a "Chat" label that appears only while the chat pane is collapsed. |

### Behavior

In sidebar mode, the layer-controls menu and the chat share one full-height
right-side panel. The map reflows to fill the remaining width. The sidebar's
left edge is draggable (width clamps to `[280px, 60vw]`), and a header button
collapses it off-screen for an unobstructed map. A floating "show" button on
the map restores the sidebar when collapsed.

Within the panel, the layer-controls menu sits on top (under its "Overlays"
heading) and the chat below, separated by a draggable splitter that lets you
rebalance the two. Each section can be collapsed independently. Set
`chat_title` to give the chat section a persistent heading that mirrors the
layers "Overlays" label; otherwise the chat has no heading except while
collapsed.

Below a viewport width of 700px (tablets, phones), the sidebar automatically
switches to overlay mode: it floats above the map rather than pushing it, and
drag-resize is disabled. It also starts collapsed by default, so mobile users
see the full map first.

The legend and H3/draw buttons remain free-floating overlays on the map in
both modes.

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
| `github` | URL to the app's source repository. Renders as a GitHub octocat icon in the chat footer. |
| `docs` | URL to a documentation or about page for the app. Renders as an "About" text link in the chat footer. |
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

### Sampling parameters (optional)

The agent sends **`temperature: 0` by default**, so identical questions give as reproducible an answer as the model allows. This is a deliberate client-side default: geo-agent talks to many OpenAI-compatible endpoints (the NRP llm-proxy, OpenRouter, a user's own key) whose own defaults vary (0.7 and up), so reproducibility shouldn't depend on which endpoint is behind it.

To change sampling, set any of `temperature`, `top_p`, or `seed`. Each is read **per-model first**, then falls back to a **top-level global default**, then to the built-in default (`temperature: 0`; `top_p`/`seed` unset). Per-model overrides the global.

```json
{
  "temperature": 0,
  "llm_models": [
    { "value": "minimax-m2", "endpoint": "…", "api_key": "…" },
    { "value": "deepseek-v3", "endpoint": "…", "api_key": "…", "temperature": 0.7, "seed": 42 }
  ]
}
```

| Field | Where | Default | Description |
|---|---|---|---|
| `temperature` | per-model and/or top-level | `0` | Sampling temperature. `0` is the most deterministic; raise it for more varied/creative output. Set to `null` on a model to omit it entirely and inherit the endpoint's own default. |
| `top_p` | per-model and/or top-level | unset | Nucleus-sampling cutoff. |
| `seed` | per-model and/or top-level | unset | Fixed RNG seed, where the provider honors it. |

> **Reproducibility caveat:** open-weights MoE inference (e.g. minimax-m2) is not bit-reproducible even at `temperature: 0`, so this is necessary-but-not-sufficient — pair it with a pinned methodology for headline numbers.

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

## Geocoding (optional)

Geocoding turns a free-text place reference — a street address, city, landmark, or named region — into real coordinates. It powers two things from one shared backend:

1. A **`geocode` agent tool**, so the LLM resolves a *traceable* coordinate instead of inventing lat/lng from memory. The model is instructed to echo the matched location back and to ask for clarification on ambiguous queries (e.g. "Springfield").
2. An optional **on-map search box** (the [maplibre-gl-geocoder](https://maplibre.org/maplibre-gl-geocoder/) control), enabled per-app.

The two surfaces toggle **independently**, sharing one backend:

- The **`geocode` agent tool** is **on by default** (opt-out) — it's invisible and just lets the LLM resolve coordinates traceably. Set `geocoder.enabled: false` to turn it off.
- The **on-map search box** is **off by default** (opt-in) — it's a visible UI change, so apps enable it deliberately with `geocoder.search_box: true`.

So `search_box: true` alone gives you the box *and* the tool; `enabled: false` + `search_box: true` gives the box with no agent tool; the default (no geocoder config) gives the tool with no box. The default provider is Nominatim (OpenStreetMap) — no API key required.

| Field | Type | Default | Description |
|---|---|---|---|
| `geocoder.enabled` | boolean | `true` | Register the `geocode` agent tool. Set `false` to disable it (the search box can still run independently). |
| `geocoder.provider` | string | `"nominatim"` | Backend: `"nominatim"`, `"photon"`, or `"maptiler"`. All are global. |
| `geocoder.maptiler_key` | string | — | Required for the `maptiler` provider. Falls back to the basemap `maptiler_key` if not set here. |
| `geocoder.email` | string | — | Contact email sent to Nominatim per its [usage policy](https://operations.osmfoundation.org/policies/nominatim/). Recommended for production apps. |
| `geocoder.endpoint` | string | — | Base-URL override (e.g. a self-hosted Nominatim instance). |
| `geocoder.search_box` | boolean | `false` | Show the on-map search box. Lazy-loads the geocoder library from CDN only when enabled. |
| `geocoder.search_box_position` | string | `"top-left"` | MapLibre control position for the search box. |
| `geocoder.search_box_placeholder` | string | `"Search address or place…"` | Placeholder text in the search box. |

```json
{
  "geocoder": {
    "provider": "nominatim",
    "email": "ops@example.org",
    "search_box": true
  }
}
```

**Provider notes.** `nominatim` and `photon` are both free OpenStreetMap-based services with no key — Nominatim returns richer confidence signals, Photon is more lenient on request volume. `maptiler` is higher quality but needs an API key. All three are global (not US-only) and work directly from a static browser app.

## Geolocation (optional)

Answers "where am *I*?" using the device's location. Two **independently opt-in** surfaces, both off by default:

| Field | Type | Default | Description |
|---|---|---|---|
| `geolocate.button` | boolean | `false` | "Locate me" button ([MapLibre `GeolocateControl`](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeolocateControl/)) in the top-left map controls; recenters the map on the user. Ships with MapLibre — nothing to pin. |
| `geolocate.agent_tool` | boolean | `false` | Register the `get_user_location` agent tool, which reads the device's coordinate so the agent can answer "what county/district am I in?", "carbon near me", etc. |

```json
{ "geolocate": { "button": true, "agent_tool": true } }
```

The shorthand `"geolocate": true` is equivalent to `{ "button": true }`.

Note the deliberate asymmetry with the [`geocode` tool](#geocoding-optional), which is **on** by default: `get_user_location` reaches into the user's *actual device location*, so it stays **off** unless an app opts in — even though, like `geocode`, it's an invisible agent tool. Both require a secure context (HTTPS) and a browser permission prompt. The `get_user_location` tool returns `{ latitude, longitude, accuracy_m }` only — it does not move the map; the agent calls `fly_to` itself if it wants to recenter.

## Tool call auto-approve

By default, the agent executes remote tool calls (SQL queries via the MCP server) immediately. Local tools — map controls like `show_layer`, `fly_to`, `set_filter` — also run without confirmation.

Set `auto_approve: false` to require a **Run** / **Cancel** confirmation before each remote call:

```json
{ "auto_approve": false }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_approve` | boolean | `true` | When `true`, remote tool calls execute immediately without user confirmation. Set to `false` to require manual approval. |

A ⚡ toggle button in the chat footer lets users switch auto-approve on or off at runtime. The toggle affects only the current session — every page load resets to the `auto_approve` value from config.

## Tool call checkpoints

On a complex question the agent may run many data queries. Rather than cutting it off at a hard limit, the agent pauses at a **checkpoint** after a configurable number of **remote queries** (MCP/SQL): it summarizes what it has done, the key findings, and what remains, then offers a **▶ Continue** button. Local map actions — `show_layer`, `fly_to`, `set_filter`, and the like — are instant and never count toward the limit.

Continuing preserves the agent's in-flight work, so it resumes where it left off instead of re-running earlier queries. Each Continue grants another full interval, so a session is effectively unlimited as long as you keep approving. You can also just type a follow-up to steer the resumed work (e.g. *"continue, but only for Alameda County"*).

```json
{ "max_tool_calls": 15, "max_tool_calls_manual": 100 }
```

| Field | Type | Default | Description |
|---|---|---|---|
| `max_tool_calls` | number | `15` | Remote queries in auto-approve mode before a checkpoint. The checkpoint is the user's periodic gate plus a progress report. Set to `0` to disable. |
| `max_tool_calls_manual` | number | `100` | Remote queries in manual mode (⚡ off) before a checkpoint. Set high because you already approve each remote call individually. Set to `0` to disable. |

Both keys may also be supplied at deploy time via `config.json`, which overrides the static `layers-input.json` value.

::: warning
The checkpoint is the only per-turn cap on tool use. Setting a value to `0` removes it entirely for that mode — a misbehaving model could then loop indefinitely, stopped only by the per-call timeout or a manual **Stop**. Prefer a high value (e.g. several hundred) over `0` unless you have another guard in place.
:::

## Chat export

A 💾 save button in the chat footer saves the current conversation as a self-contained HTML document you can share or print. The button is disabled until the first user message and enables automatically after. No configuration — it's always present.

The saved file mirrors what the user sees in the live chat: user prompts, assistant prose, and tool-call rows with collapsible SQL and result blocks. Everything is in a single `.html` with inlined CSS — no external assets, no JavaScript required to view it.

Two guarantees apply to the export:

- **Reproducible SQL.** Every `s3://bucket/...` URL inside a SQL block is rewritten to `https://s3-west.nrp-nautilus.io/bucket/...`. Pasting the SQL into any DuckDB with `INSTALL httpfs; LOAD httpfs;` will run it against the public endpoint without secret configuration (public buckets only).
- **Credential scrubbing.** On top of the live-chat redaction described in the agent-loop docs, the export pass replaces credential-shaped tokens with `[REDACTED]` — DuckDB `CREATE SECRET` key/value pairs, AWS access keys (`aws_access_key_id`, `aws_secret_access_key`), `Authorization: Bearer …` tokens, and pre-signed-URL `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token` query parameters.

## Finding STAC asset IDs

Browse the catalog in STAC Browser:

```
https://radiantearth.github.io/stac-browser/#/external/s3-west.nrp-nautilus.io/public-data/stac/catalog.json
```

Open a collection → click the **Assets** tab. The keys listed there (e.g., `"pmtiles"`, `"v2-total-2024-cog"`) are the `id` values to use. For PMTiles vector layers, the asset's `vector:layers` field gives the internal layer name used by MapLibre (the app reads this automatically).

::: tip Mismatched asset IDs are flagged at startup
If a configured `id` (or a `versions` entry's `asset_id`) doesn't match any key in the STAC collection, the app logs a `console.warn` at load naming the collection, the offending id, and the available keys. It's a warning, not an error — a mismatched id can still render via a source-layer fallback — but the warning surfaces the silent key-drift that's otherwise expensive to debug. Check the browser console if a layer behaves unexpectedly.
:::

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

### Categorical legend on a vector layer

When a vector layer is colored by category via a `match` expression, add a `legend_classes` list so the color scheme is explained in the legend panel. The labels and colors are authored to match the `match` arms (they are not derived automatically):

```json
{
  "id": "seafloor-geomorphology-pmtiles",
  "display_name": "Seafloor Geomorphology",
  "visible": true,
  "default_style": {
    "fill-color": ["match", ["get", "feature_type"],
      "Seamounts", "#F57F17",
      "Ridges", "#BF360C",
      "Trenches", "#311B92",
      "#888888"
    ],
    "fill-opacity": 0.7
  },
  "legend_type": "categorical",
  "legend_classes": [
    { "label": "Seamounts", "color": "#F57F17" },
    { "label": "Ridges", "color": "#BF360C" },
    { "label": "Trenches", "color": "#311B92" }
  ]
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
