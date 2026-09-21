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
| `catalog_index_threshold` | No | Dataset count above which the front-loaded catalog switches to a compact index (id + title + one-line summary + layer ids) to shrink the cold prompt; full descriptions/paths then arrive on demand via `get_schema`. Default: `8`. Set very high (e.g. `9999`) to always front-load the full catalog. |
| `client_header_hosts` | No | Host suffixes that receive the `X-Client: geo-agent/<ref>` attribution header (for proxy log analysis). Default: `["nrp-nautilus.io"]`. The header is **only** sent to these hosts — never to bring-your-own external endpoints, where a custom header could trip CORS and block requests. Override only if your proxy runs on a different host. |
| `links` | No | Optional links shown in the chat UI — see below. |
| `header` | No | App chrome band across the top — logos and top-level nav. Off unless configured. See below. |
| `theme` | No | Chrome colour scheme — a mode string, or an object that also sets brand colours. See below. |

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
| `sidebar` | boolean | Whether this collection's layers get rows in the layer panel. Default: `true`. Set `false` to keep the layers configured and agent-addressable but out of the panel — see [Layers outside the panel](#layers-outside-the-panel). |
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
| `sidebar` | boolean | Overrides the collection-level `sidebar` for this specific layer. Default: inherited, which is `true` unless the collection sets otherwise — see [Layers outside the panel](#layers-outside-the-panel). |
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

### Legends follow runtime restyles

The config above describes the layer as it loads. The agent can recolor any layer at runtime with `set_style`, and the legend follows the paint that is actually on the map rather than the paint the layer was registered with:

- An `interpolate` or `step` recolor renders a **colorbar** over the new stops. This overrides `legend_range` / `legend_gradient`, which described the original ramp.
- A `match` recolor renders **discrete swatches**, one per match arm, using the colors from the expression. This applies even to a layer configured as `continuous` or to a dynamic hex layer, and it overrides `legend_classes`.
- A recolor with no describable structure (a flat color, a `case` expression) removes the legend rather than leaving a stale one behind.

A layer with no `legend_type` at all gains a legend when the agent recolors it into a choropleth, and `reset_style` removes it again along with the restyle.

Swatches derived from a `match` are labelled with the matched value itself (`1`, `2`, …), because the vector tiles carry only the code — what the code *means* usually lives in the SQL that produced the layer. Author-supplied `legend_classes` labels are used whenever the layer has not been recolored past them.

The agent closes that last gap with `set_legend`, which names the classes (`{"1": "Amphibians"}`), retitles the layer, adds a colorbar unit, or hides the section. It cannot set colors or value ranges — those stay derived from the paint, so a legend can't be made to contradict the map. `reset_legend` restores the labels configured here. Nothing in this file needs to change to allow it; `set_legend` overrides `legend_label` and `legend_classes` names for the session only.

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
| `group` | string | Overrides the collection-level `group` for this specific layer. |
| `sidebar` | boolean | Overrides the collection-level `sidebar` for this specific layer — see [Layers outside the panel](#layers-outside-the-panel). |

## Asset config — GeoJSON

STAC assets with MIME type `application/geo+json` (or an `.geojson` href) are loaded as MapLibre GeoJSON sources. This is the simplest path for small vector datasets — no PMTiles build step required, just host a `.geojson` file alongside the STAC collection.

GeoJSON assets accept the same config fields as PMTiles vectors (`display_name`, `visible`, `default_style`, `outline_style`, `layer_type`, `default_filter`, `tooltip_fields`, `group`, `sidebar`). They also work with [versioned assets](#versioned-assets) and [animated trajectories](#animated-trajectory-layers).

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

For GeoJSON assets containing `LineString` features with a parallel timestamp array, set `animation` on the asset config to turn it into an animated point-along-line layer. The framework adds a play/pause controller and emits colored dots that move along each trajectory. The layer appears in the layer menu like any other layer; the LLM agent's `show_layer` / `hide_layer` / `set_filter` tools work on it directly.

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
| `mode` | string | `"smooth"` | Playback mode — `"smooth"` interpolates between waypoints, `"stepped"` shows only the observations themselves (see below). |
| `mode_toggle` | boolean | `false` | Offer a mode switch in the playback panel so the user can compare the two. |
| `end_timestamp_field` | string | — | Feature property holding a parallel array of ISO timestamps — the last time each waypoint's position was still being reported. Used by `stepped` mode; ignored if its length doesn't match `timestamp_field`. |
| `hold_hours` | number | `0` with `end_timestamp_field`, else `6` | How long a stepped observation stays on screen past the time it was last seen. |
| `hex_resolution` | number | — | H3 resolution of the observations, when they are grid cells rather than points. In `stepped` mode the cell footprint is drawn in place of the dot. Requires `h3-js` on the page. |
| `hex_opacity` | number | `0.55` | Fill opacity of those cell footprints. |

### Smooth vs. stepped

The two modes make different claims about the data, so pick the one that matches what was actually measured:

- **`smooth`** interpolates each entity's position linearly between waypoints and (with `show_track_line`) draws the full trajectory underneath. It reads as continuous tracking. Use it when the fixes are dense enough that the path between them is a fair approximation — or when the animation is explicitly an illustration of a sequence.
- **`stepped`** never interpolates. An entity appears at a waypoint for the window it was reported (its timestamp through `end_timestamp_field`, plus `hold_hours`) and then vanishes until its next observation, and no track line is drawn in this mode. Gaps on screen are gaps in the data. Use it for sparse or irregular fixes, where a smooth path would invent movement that was never observed.

Set `hex_resolution` when each observation is a grid cell — a wildlife tracker that publishes ~6 km hexbins rather than GPS points, say. Stepped mode then draws the cell itself, so the mark on the map is the size of the datum instead of a point-sized dot implying point-sized precision. With `mode_toggle`, users can flip between the honest reading and the legible one.

`default_style` on the asset supplies paint overrides — `line-color` and `circle-color` are the common cases (plus `fill-color` / `fill-outline-color` for cell footprints). MapLibre `match` expressions let you color-code per entity against `id_field` or any other scalar property on the trajectory features.

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
        "end_timestamp_field": "end_timestamps",
        "id_field": "pack",
        "duration_seconds": 30,
        "static_positions_asset": "bins-latest",
        "mode": "stepped",
        "mode_toggle": true,
        "hex_resolution": 6,
        "show_track_line": false
      },
      "default_style": {
        "line-color":   ["match", ["get", "pack_origin"], "Whaleback", "#E65100", "Harvey", "#1565C0", "#888"],
        "circle-color": ["match", ["get", "pack_origin"], "Whaleback", "#E65100", "Harvey", "#1565C0", "#888"],
        "fill-color":   ["match", ["get", "pack_origin"], "Whaleback", "#E65100", "Harvey", "#1565C0", "#888"]
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

## Charts (opt-in)

By default the agent answers analytical questions with the map and SQL result **tables**. Enabling charts gives it one more primitive — a `render_chart` tool that turns a query result into a **bar**, **line**, **scatter**, or **histogram** in a floating panel ([#277](https://github.com/boettiger-lab/geo-agent/issues/277)).

It is **off by default** (zero footprint — the tool isn't registered and no charting library loads). Turn it on with a top-level flag in `layers-input.json`:

```json
{
  "catalog": "https://…/catalog.json",
  "charts": { "enabled": true }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Register the `render_chart` tool and lazy-load the charting library. |

When enabled, the agent calls `render_chart` with a chart type, the columns to plot (`x`, `y`, optional `series`), and the data — either an inline `data` array it already computed, or a `sql` query the panel runs itself (so large result sets never pass back through the LLM; if both are supplied, `sql` wins). An optional `title` and `x_label` / `y_label` override the panel heading and axis captions (axes default to the column names). Charts render client-side via [Observable Plot](https://observablehq.com/plot/), which (with d3) is fetched from the CDN via SRI-pinned scripts the first time a chart is drawn — downstream apps don't need to add any `<script>` tag. Each chart panel can be **resized** (drag the bottom-right grip — it re-plots to fit) or **popped out** to a large centered view, and closed with the ✕.

| Chart type | Shape | Channels |
|---|---|---|
| `bar` | ranking / category comparison | `x` = category, `y` = value |
| `line` | time series / trend | `x` = ordered field (e.g. year), `y` = value |
| `scatter` | relationship / trade-off (e.g. a Pareto frontier) | `x`, `y` = two numerics |
| `histogram` | distribution of one numeric | `x` = the value (bars are counts; omit `y`) |

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

## Layers outside the panel

`collapsed` only folds a group — every heading and row is still rendered. When an app has
dozens of reference layers that a user would rarely hunt for, but that the assistant should
still be able to draw on request, set `"sidebar": false`:

```json
{
  "collection_id": "woa23-salinity",
  "group": "Ocean reference",
  "sidebar": false,
  "assets": ["woa23-salinity-cog"]
}
```

The layer is registered exactly as usual. It stays in the map's layer registry, so the agent can
`show_layer` it, restyle it, filter it, and report it in `get_map_state`; when shown it gets its
legend entry (and its group heading) like any other layer. The **only** thing `sidebar: false`
removes is its row in the layer panel. A group whose members are all hidden this way renders no
heading at all.

Set it per asset to exempt individual layers, in either direction:

```json
{
  "collection_id": "bio-oracle",
  "sidebar": false,
  "assets": [
    "bio-oracle-nitrate-cog",
    "bio-oracle-phosphate-cog",
    { "id": "bio-oracle-temperature-cog", "sidebar": true }
  ]
}
```

The per-asset value wins where both are set; where neither is, the default is `true`.

> **`sidebar: false` with `visible: true`** is legal but leaves a layer drawn on load with no
> checkbox to turn it off — the assistant becomes the only off-switch. The framework logs a
> `console.warn` when it sees that pair; it is not an error.

**This is not access control.** A `sidebar: false` layer's URL, style and data are as reachable
as any other layer's. It is a navigation aid for a crowded panel, nothing more.

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

## App header

An optional chrome band across the top of the page, carrying deployment identity
(logos, app title) and top-level navigation. **Off by default** — with no
`header` block nothing renders and the layout is unchanged, so bumping a pin
never adds chrome an app did not ask for.

The split it introduces: *app-level* things (who made this, what else there is
to read) belong in the header; *map-level* things (legend, sliders, hex
controls) belong on the map, in the [overlay rail](#map-overlay-rail-and-stacking-order).

```json
{
  "header": {
    "enabled": true,
    "mode": "scrim",
    "title": "Protected Areas Explorer",
    "brand":   { "src": "https://example.org/dse.svg", "alt": "DSE", "href": "https://dse.berkeley.edu/" },
    "partner": { "src": "https://example.org/partner.svg", "alt": "Partner org" }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Render the band. Everything else is ignored when false. |
| `mode` | string | `"solid"` | `"solid"` is an opaque band with a separating edge, and the map starts below it. `"scrim"` floats a translucent band over a full-bleed map, costing no map area — but note it sits directly against the browser's own chrome, which can read as one bar. An unrecognised value falls back to `"solid"`. |
| `title` | string | `sidebar.title` | Text beside the logos. Hidden on narrow viewports, where the logos carry identity. |
| `brand` | object | — | Primary logo, shown first. `{ src, src_dark, alt, href }`; `src` is required or the logo is skipped, and `href` is optional (without one the image is not a link). |
| `partner` | object or array | — | Trailing logo(s), shown at the end of the bar after the nav. Same shape as `brand`; pass an array to show several (e.g. a partner mark alongside the hosting institution). |
| `nav` | array | derived | Top-level links — see below. |

No logo images ship with the library; `src` is always a URL the app supplies.

A logo is an image, so it cannot follow the [theme](#theme): a white-knockout
mark vanishes on a light bar and a black one vanishes on a dark bar. Give a slot
both and the right one shows automatically — including under `theme: "auto"`,
which tracks the OS live:

```json
"brand": {
  "src":      "https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.29.0/app/assets/dse-logo-black.png",
  "src_dark": "https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.29.0/app/assets/dse-logo-white.png",
  "alt":      "Eric and Wendy Schmidt Center for Data Science & Environment",
  "href":     "https://dse.berkeley.edu/"
}
```

The DSE mark ships with the library in both variants (`app/assets/`), so apps
can reference it from the CDN at their pinned ref. Prefer hosting a copy of a
*partner's* mark too, rather than hotlinking their site, which can change or
block the request.

### Nav

If `header.nav` is omitted, the nav is **derived from the existing top-level
`links` block**, so an app that already configures `links` gets a nav for free,
in the familiar order:

| From | Becomes |
|---|---|
| `links.docs` | **About** |
| `links.github` | **GitHub** |
| `links.carbon` | **Carbon** (the NRP LLM carbon dashboard; set a string to point elsewhere) |
| `links.contact` | **Contact us** — the one entry present **by default**, pointing at `mailto:dse@berkeley.edu`. Give a full URL, or a bare address which is normalised to a `mailto:`. Set `false` to drop it. |

Because Contact defaults on, enabling the header always yields at least one
nav entry. The mailto opens in the same tab, so no blank one is left behind.

When a nav is rendered, the chat footer **stops** showing those same links, so
they appear once rather than twice.

To take control, give an explicit list. It wins outright, and `[]` suppresses
the derived nav entirely:

```json
"header": {
  "enabled": true,
  "nav": [
    { "label": "About",   "href": "https://example.org/about" },
    { "label": "Methods", "href": "/methods", "external": false },
    { "label": "GitHub",  "href": "https://github.com/org/app" }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `label` | string | — | **Required.** Link text. |
| `href` | string | — | **Required.** Entries missing either field are skipped. |
| `external` | boolean | `true` | Open in a new tab with `rel="noopener noreferrer"`. Set `false` for a same-page route. |
| `icon` | string | — | `"github"` or `"leaf"`, drawn before the label. Unknown names are ignored. |
| `variant` | string | — | Styling hook: adds `.app-header-link--<variant>` for an app's own CSS. No built-in variants. |

### Layout effects

Enabling the header sets a `--app-header-h` custom property (`0px` when there
is no header, so dependent rules can be written unconditionally). It is the
64px band plus `env(safe-area-inset-top)`, so notched phones and browsers whose
UI eats into the viewport get real clearance rather than controls hugging the
top edge.

- The **sidebar** always starts below the band, in both modes.
- The **map** starts below it only in `solid` mode; under a `scrim` it stays
  full-bleed.
- The floating-mode **layer panel** is pushed down by the full offset.
- **MapLibre's controls** (zoom, geocoder, draw) are measured from the map, so
  they only need nudging in `scrim` mode — in `solid` mode the map already
  starts below the band.
- In `scrim` mode the band is click-through except for its own controls, so the
  empty middle does not steal map interaction.

### Narrow viewports

Below 700px the nav row and the title are replaced — not compressed — by a menu
button that opens a full-viewport takeover listing the same entries. It closes
on the button, the ✕, Escape, or choosing a link.

## Mobile layout

Below 700px the sidebar stops being a side panel and becomes a **bottom
sheet**. Nothing to configure; it applies automatically in sidebar mode.

Three detents:

| Detent | Height | Reads as |
|---|---|---|
| peek | ~96px | a full-screen map |
| half | 50vh | map above, panel below |
| full | viewport minus the header | a full-screen panel |

`half` is why this is a sheet rather than a set of full-screen tabs: toggling a
layer or asking a question is *about* the map, and if the panel covers it you
act blind and check afterwards.

**Gestures never touch the map.** Horizontal drag over the map is pan and pinch
is zoom — MapLibre keeps all of it. The sheet moves only from its own handle:
drag it, or tap it to cycle detents. A **Layers / Chat** tab strip switches
panes with a tap; choosing a tab from `peek` opens the sheet to `half` rather
than relabelling a closed panel.

The handle is a real button, so the keyboard gets the same moves (↑ / ↓ change
detent). Map overlay panels — legend, sliders, hex controls — are lifted to sit
above the sheet rather than behind it, and shrink as it grows.

## Theme

Colours the **chrome shell** — the header band, the sidebar surface, hairlines,
the chat bubbles inside the sidebar, and the backdrop behind the globe.

```json
{ "theme": "dark" }
```

| Value | Effect |
|---|---|
| `"light"` | Default. What the sidebar has always looked like, so bumping a pin does not change an app's colours. |
| `"dark"` | Dark chrome. |
| `"auto"` | Follows the viewer's `prefers-color-scheme`, live — switching the OS setting does not need a reload. |

### Brand colours

For anything past light and dark, give `theme` an object. `mode` picks the
palette to start from and the rest recolours it — no CSS needed:

```json
{
  "theme": {
    "mode": "dark",
    "primary": "#7a5cff",
    "surface": "#1b1533",
    "text": "#f2edff",
    "backdrop": "#120e26"
  }
}
```

| Key | Recolours |
|---|---|
| `mode` | Which palette to start from: `light` (default), `dark`, `auto`. |
| `primary` | Buttons, checkboxes, sliders, the send button — every control. Hover and selected states are derived from it, so this one key moves the whole set. |
| `surface` | The chrome surface: header band and sidebar. |
| `text` | Primary text on that surface. |
| `panel` | Floating panels over the map (legend, sliders, charts). |
| `backdrop` | The area behind the globe, under the hex texture. |

Values may be hex, `rgb()`, `hsl()` or a named colour. Anything else is
ignored rather than written into the page.

Derived states use CSS `color-mix()` against the palette's own direction —
darker on light, lighter on dark — so `mode: "auto"` still gets it right when
the viewer switches their OS setting, with no reload.

For a token the named keys do not reach, use the escape hatch:

```json
{ "theme": { "mode": "dark", "tokens": { "--chrome-carbon": "#a5d6a7" } } }
```

Token names are listed in `style.css` under *Theme tokens*. They are internal,
so treat them as less stable than the named keys above.

The header and sidebar deliberately share one palette and meet flush: the
header's drop shadow is carried on a pseudo-element that stops at the sidebar
edge, so it reads as a raised bar over the map while the two chrome surfaces
join without a seam. The inset tracks `--sidebar-width`, so it stays correct
through a sidebar resize or collapse.

**What is not themed yet:** syntax highlighting inside code blocks (that comes
from the highlight.js stylesheet in `index.html`), the legend and other
map-overlay panels, and the floating chat panel — which keeps its own dark
glass treatment, since it sits on the map rather than on a chrome surface.

Apps needing finer control can override the `--chrome-*` and `--chat-*` custom
properties directly; they are defined on `:root` and per theme class in
`style.css`.

### Map backdrop

Wherever no tile covers the canvas — most visibly the space around the globe in
globe projection, which used to be bare white — the map shows a themed backdrop
with a faint hexagonal texture, a nod to the H3 grid the analytics are built on.
It is deliberately low-contrast so it reads as texture rather than as data.
Override `--map-void-bg` and `--map-void-pattern` to change or remove it:

```css
:root { --map-void-pattern: none; }
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
| `llm_timeout_seconds` | per-model and/or top-level | `600` | Per-attempt client-side timeout for an LLM request. Resolved per-model first, then top-level. The default matches the upstream llm-proxy's own timeout; a shorter value aborts responses the proxy would still deliver, which makes slow-decode models (e.g. `glm-5.2`, or anything on the gb10) unusable. Raise it per-model for slow reasoning models when the whole request chain is configured to run longer. |

> **Reproducibility caveat:** open-weights MoE inference (e.g. minimax-m2) is not bit-reproducible even at `temperature: 0`, so this is necessary-but-not-sufficient — pair it with a pinned methodology for headline numbers.

### Reasoning toggle (optional)

Reasoning ("thinking") models spend a large, sequential **decode** budget generating hidden reasoning before the answer. On easy tasks — a simple filter, a lookup, a single tool call — that's mostly latency for little gain, while on hard analytical/SQL questions it materially improves the answer. Because that tradeoff is **per question, not per app**, geo-agent can surface a 🧠 toggle in the chat footer so the user picks *fast* vs. *thorough* per conversation.

The toggle emits a normalized `enable_thinking` flag that the [open-llm-proxy](https://github.com/boettiger-lab/open-llm-proxy) maps to the correct per-backend chat-template knob (e.g. `enable_thinking` for qwen3/glm, `thinking` for kimi). It is **off by default and opt-in per model** — when neither key below is set, geo-agent sends nothing and the model uses its own default (no behavior change).

> **Only enable it where "off" is safe.** On weaker models, disabling reasoning can degrade tool-calling/SQL reliability. Enable the toggle only for models where measurement (see [open-llm-proxy#58](https://github.com/boettiger-lab/open-llm-proxy/issues/58)) shows reasoning-off doesn't hurt tool use.

```json
{
  "llm_models": [
    { "value": "qwen3", "endpoint": "…", "api_key": "…", "reasoning_toggle": true, "reasoning_default": true },
    { "value": "minimax-m2", "endpoint": "…", "api_key": "…" }
  ]
}
```

| Field | Where | Default | Description |
|---|---|---|---|
| `reasoning_toggle` | per-model and/or top-level | `false` | Show the 🧠 reasoning on/off toggle for this model. Only enable it for models whose backend supports the thinking knob **and** where reasoning-off is safe for tool use. Hidden when `false`/absent. |
| `reasoning_default` | per-model and/or top-level | unset | Initial reasoning state (`true` = on). When unset **and the toggle is shown**, it starts *on* and `enable_thinking: true` is sent (so the toggle's displayed state matches what's sent). When set on a model with **no** toggle, it applies a fixed reasoning state without a user control. Unset **with no toggle** → `enable_thinking` is omitted and the model's own default is used. |

Resolution mirrors the sampling params: per-model first, then top-level global. A per-conversation toggle click overrides the configured default until the model is switched (which resets to that model's default).

### Prompt caching (optional)

The agentic tool-use loop is heavily prefill-dominated — every turn re-sends the system prompt, the tool definitions, and the running transcript, while outputs are tiny (roughly 43:1 prompt:completion tokens; see [#273](https://github.com/boettiger-lab/geo-agent/issues/273)). The biggest identical chunk re-sent on every call is the system prompt plus its injected dataset catalog (~34k tokens).

`prompt_cache` attaches an Anthropic-style `cache_control: {"type": "ephemeral"}` breakpoint to the system prompt so that prefix bills at cache-read rates (~10%) on repeat calls instead of full price.

> **Route Claude through OpenRouter for this to do anything.** The flag only saves money when the request reaches a provider that honors `cache_control`, and that depends entirely on the **model string** you configure in `value`:
>
> | `value` | [open-llm-proxy](https://github.com/boettiger-lab/open-llm-proxy) route | `prompt_cache` effect |
> |---|---|---|
> | `anthropic/claude-haiku-4.5` (OpenRouter naming) | OpenRouter → Anthropic | ✅ **caches** — first call writes the prefix, repeat calls read it (~12× cheaper on that prefix, measured) |
> | `claude-haiku-4-5` (bare) | Anthropic direct, via its OpenAI-compat endpoint | ❌ **no-op** — that endpoint ignores message-embedded `cache_control` (caching is native `/v1/messages`-only) |
>
> So: pin Claude entries to the `anthropic/…` OpenRouter model id **and** set `prompt_cache: true`. On the bare Anthropic-direct route the flag costs nothing but buys nothing.

```json
{
  "llm_models": [
    { "value": "anthropic/claude-haiku-4.5", "endpoint": "…", "api_key": "…", "prompt_cache": true },
    { "value": "minimax-m2", "endpoint": "…", "api_key": "…" }
  ]
}
```

| Field | Where | Default | Description |
|---|---|---|---|
| `prompt_cache` | per-model and/or top-level | `false` | Attach a `cache_control` breakpoint to the system prompt. Resolved per-model first, then top-level. |

> **Why per-model, not global.** This is a Claude-specific lever: Anthropic caching is *opt-in* (a request with no `cache_control` gets nothing), while open backends (NRP vLLM, most OpenRouter open-weight providers) already do automatic prefix caching for free and gain nothing from the breakpoint. Enabling it also reshapes the system message from a plain string into the content-parts array form so the breakpoint has a block to ride on — that reshape (not the ignored `cache_control` key) is the only cross-backend compatibility surface, so keeping it per-model avoids changing payload shape for models that don't benefit. The proxy forwards the `messages` array verbatim, so the message-embedded breakpoint reaches whichever upstream the model string routes to (top-level cache params are dropped by the proxy). Off by default → payload is byte-identical to before.

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

The saved file mirrors what the user sees in the live chat: user prompts, assistant prose, and tool-call rows with collapsible SQL and result blocks, plus the **map as it stood when Save was clicked** (see below).

Two guarantees apply to the export:

- **Reproducible SQL.** Every `s3://bucket/...` URL inside a SQL block is rewritten to `https://s3-west.nrp-nautilus.io/bucket/...`. Pasting the SQL into any DuckDB with `INSTALL httpfs; LOAD httpfs;` will run it against the public endpoint without secret configuration (public buckets only).
- **Credential scrubbing.** On top of the live-chat redaction described in the agent-loop docs, the export pass replaces credential-shaped tokens with `[REDACTED]` — DuckDB `CREATE SECRET` key/value pairs, AWS access keys (`aws_access_key_id`, `aws_secret_access_key`), `Authorization: Bearer …` tokens, and pre-signed-URL `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token` query parameters. This scrubbing also covers the embedded map state (below).

### Embedded map

The export captures the final map state — one map per saved log — as an **interactive MapLibre map**, not a static image. It serializes `map.getStyle()` (all sources, layers, and their current paint / filter / visibility) plus the camera (center, zoom, bearing, pitch, and globe-vs-mercator projection), embeds it in the HTML, and re-renders a live, pannable map when the file is opened. Because it's the real style rather than a screenshot, the recipient sees exactly the layers and styling that were on screen and can zoom and inspect them.

Trade-offs, by design:

- **Not fully offline.** The embedded map loads MapLibre GL JS and PMTiles from the same pinned CDN builds the app uses (`maplibre-gl@5.22.0`, `pmtiles@3.0.7`) and fetches tiles from the original public sources at view time. Without a network connection, the map area shows an error message; the rest of the transcript still renders.
- **Public layers only.** Terrain (whose DEM source is keyed to a private MapTiler token) is stripped, and any signed or private tile URL is redacted by the credential scrub — so such layers may not appear for a recipient. The transcript text remains complete.

## Map overlay rail and stacking order

Not a config block — background for apps that ship their own CSS overrides.

Every panel that floats over the map bottom-left — the legend, reactive-parameter
sliders, trajectory playback controls, and the H3 hex toggle and resolution badge —
mounts into a single container, `#map-overlay-rail`. The rail is a bottom-anchored
flex column, so panels queue above one another in a fixed order instead of each
anchoring itself to the same corner. Adding or removing a panel reflows the rest
automatically.

This replaces the previous arrangement, where each panel carried its own
`position: absolute; bottom; left` and two of them hand-computed an offset at
construction time. Panels overlapped whenever they didn't know about each other
(notably the legend covering a slider in sidebar mode).

**What this means for custom CSS:**

- Panels inside the rail are `position: static`. Overriding `bottom`, `left` or
  `z-index` on `#legend`, `.reactive-controls`, `.anim-controls`, `#h3-toggle` or
  `#h3-res-badge` no longer does anything — the rail places them. Such rules are
  inert rather than broken, so a stale workaround does no harm, but it can be deleted.
- Sizing and appearance overrides (`max-width`, colors, fonts, padding) still apply
  normally.
- To reposition the group as a whole, style `#map-overlay-rail` itself.

Stacking across the whole app uses a named scale defined on `:root` in `style.css`,
rather than ad-hoc numbers:

| Token | Value | Layer |
|---|---:|---|
| `--z-map` | 1 | map canvas |
| `--z-map-overlay` | 10 | `#map-overlay-rail` and the layer menu |
| `--z-chart-panel` | 20 | chart panels |
| `--z-sidebar` | 30 | sidebar (and the legacy floating chat) |
| `--z-sidebar-show` | 35 | sidebar re-open button |
| `--z-app-header` | 40 | reserved for app chrome |
| `--z-mobile-takeover` | 50 | reserved for full-viewport panels at phone width |
| `--z-tooltip` | 60 | hover readouts |
| `--z-modal` | 70 | blocking dialogs |

Custom overlays of your own should pick a token (or a value between two of them)
rather than escalating past everything with a large number.

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
