# Configuration Reference

Client apps configure geo-agent via `layers-input.json`. All fields except `catalog` and `collections` are optional.

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `catalog` | Yes | STAC catalog root URL. The app traverses child links to find collection metadata. |
| `collections` | Yes | Array of collection specs — see below. |
| `titiler_url` | No | TiTiler server for COG/raster tile rendering. Defaults to `https://titiler.nrp-nautilus.io`. |
| `mcp_url` | No | MCP server URL for DuckDB SQL queries. Omit to disable analytics. |
| `view` | No | Initial map view: `{ "center": [lon, lat], "zoom": z }` |
| `llm` | No | LLM configuration — see below. Omit for server-provided mode. |
| `welcome` | No | Welcome message: `{ "message": "...", "examples": ["...", "..."] }` |
| `default_basemap` | No | Which basemap is active on load: `"natgeo"` (default), `"satellite"`, or `"plain"`. |
| `custom_basemap` | No | Replace the NatGeo slot with a custom tile URL — see below. |
| `links` | No | Optional links shown in the chat UI — see below. |

## Collections

Each entry in `collections` is either a **bare string** (loads all visual assets from that collection) or an **object**:

| Field | Type | Description |
|---|---|---|
| `collection_id` | string | STAC collection ID to load. |
| `collection_url` | string | Direct URL to the STAC collection JSON. Bypasses root catalog traversal — useful for private or external catalogs. |
| `group` | string | Group label shown in the layer toggle panel. |
| `assets` | array | Asset selector — see below. Omit to load all visual assets. |
| `display_name` | string | Override the collection title shown in the UI. |

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
| `legend_label` | string | Label shown next to the color legend. |
| `legend_type` | string | `"categorical"` to use STAC `classification:classes` color codes for a discrete legend. |

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
  "view": { "center": [-119.4, 36.8], "zoom": 6 },

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
