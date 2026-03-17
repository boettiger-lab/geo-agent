# Example: CA Protected Lands App

This is a **template** showing how to build a client app using the [geo-chat](../) core library. Copy this folder as a starting point for your own app.

## Structure

```
index.html          ← HTML shell — loads core JS/CSS from CDN
layers-input.json   ← data config + optional LLM settings
system-prompt.md    ← LLM system prompt (customize per app)
k8s/                ← Kubernetes deployment manifests (optional)
```

That's it. **No JavaScript to write.** The core modules (map, chat, agent, tools) are loaded from the CDN. You just configure which data to show.

## How it works

`index.html` loads the core library from jsdelivr:

```html
<!-- Core styles -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/chat.css">

<!-- Core app (all modules resolve from CDN) -->
<script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/main.js"></script>
```

When `main.js` runs, it fetches `layers-input.json`, `system-prompt.md`, and `config.json` **from the same server** as the HTML page — i.e., from your app's own files. So each app provides its own data configuration while sharing the same application code.

## Creating a new app

1. **Copy this folder** into a new repo
2. **Edit `layers-input.json`** — set your STAC collections, asset selections, and LLM config
3. **Edit `system-prompt.md`** — customize the AI assistant's persona and guidelines
4. **Edit `index.html`** — change the page title, add analytics, adjust CDN version
5. **Deploy** — see the deployment options below

### Pin a stable version

For production, pin to a tagged release:

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/main.js"></script>
```

For staging/development, track `main`:

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js"></script>
```

## `layers-input.json` reference

### Top-level fields

| Field | Required | Description |
|---|---|---|
| `catalog` | Yes | STAC catalog root URL. The app traverses child links to find collection metadata. |
| `titiler_url` | No | TiTiler server for COG/raster tile rendering. Defaults to `https://titiler.nrp-nautilus.io`. |
| `mcp_url` | No | MCP server URL for DuckDB SQL queries. Omit to disable analytics. |
| `view` | No | Initial map view: `{ "center": [lon, lat], "zoom": z }` |
| `llm` | No | LLM configuration (see below). Omit for server-provided mode. |
| `collections` | Yes | Array of collection specs (see below). |
| `welcome` | No | Welcome message: `{ "message": "...", "examples": ["...", "..."] }` |

### Collection-level fields

Each entry in `collections` is either a **bare string** (loads all visual assets from that collection) or an **object**:

| Field | Type | Description |
|---|---|---|
| `collection_id` | string | STAC collection ID to load. |
| `collection_url` | string | Direct URL to the STAC collection JSON. Bypasses root catalog traversal — useful for private or external catalogs. |
| `group` | string | Group label shown in the layer toggle panel. |
| `assets` | array | Asset selector: bare strings load a named asset with no extra config; objects configure a specific asset (see below). Omit to load all visual assets. |
| `display_name` | string | Override the collection title shown in the UI. |

### Asset config fields — vector (PMTiles)

Each entry in `assets` may be a **bare string** (the STAC asset key, loaded with defaults) or a **config object**:

| Field | Type | Description |
|---|---|---|
| `id` | string | **Required.** STAC asset key in the collection JSON (e.g., `"pmtiles"`). |
| `alias` | string | Alternative layer ID when you need two logical layers from one STAC asset (e.g., two `default_filter` views of the same file). |
| `display_name` | string | Label in the layer toggle UI. Falls back to the STAC asset title. |
| `visible` | boolean | Default visibility on load. Default: `false`. |
| `default_style` | object | MapLibre **fill** paint properties for polygon layers (e.g., `fill-color`, `fill-opacity`). |
| `outline_style` | object | MapLibre **line** paint for an auto-added outline on top of the fill (e.g., `{"line-color": "#333", "line-width": 1.5}`). Use this — not `layer_type` — to draw polygon borders. |
| `layer_type` | `"line"` | Set **only** when tile features are true LineString/MultiLineString geometries. |
| `default_filter` | array | MapLibre filter expression applied at load time. |
| `tooltip_fields` | array | Feature property names shown in the hover tooltip. |
| `group` | string | Overrides the collection-level `group` for this specific layer. |

### Asset config fields — raster (COG)

| Field | Type | Description |
|---|---|---|
| `id` | string | **Required.** STAC asset key. |
| `display_name` | string | Label in the layer toggle UI. |
| `visible` | boolean | Default visibility. Default: `false`. |
| `colormap` | string | TiTiler colormap name (e.g., `"reds"`, `"blues"`, `"viridis"`). Default: `"reds"`. |
| `rescale` | string | TiTiler min,max range for color scaling (e.g., `"0,150"`). |
| `legend_label` | string | Label shown next to the color legend. |
| `legend_type` | string | `"categorical"` to use STAC `classification:classes` color codes for a discrete legend. |

### LLM configuration

The `llm` section controls how the chat agent connects to a language model. Two modes:

**Server-provided** (default — omit `llm`): A `config.json` on the same server provides model endpoints and API keys (e.g., injected by Kubernetes at deploy time). The `llm` section is ignored if `config.json` is present.

**User-provided** (`"user_provided": true`): No `config.json` needed. A ⚙ button appears in the chat footer; visitors enter their own API key, stored in `localStorage` (never sent to the server). Ideal for static-site deployments.

| Field | Description |
|---|---|
| `user_provided` | `true` to enable browser-side API key entry. Omit or `false` for server-provided mode. |
| `default_endpoint` | Pre-filled endpoint URL shown in the settings panel. [OpenRouter](https://openrouter.ai) gives access to many models via one key. |
| `models` | Array of `{ "value": "<model-id>", "label": "<display name>" }` entries in the model selector. |

### How to find STAC asset IDs

Browse the catalog in STAC Browser:

```
https://radiantearth.github.io/stac-browser/#/external/s3-west.nrp-nautilus.io/public-data/stac/catalog.json
```

Open a collection → click the **Assets** tab. The keys listed there (e.g., `"pmtiles"`, `"v2-total-2024-cog"`) are the `id` values to use. For PMTiles vector layers, the asset's `vector:layers` field gives the internal layer name used by MapLibre (the app reads this automatically — no manual config needed).

### Worked example: polygon fill with categorical coloring

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

### Worked example: boundary-only (outline) layer for polygon features

To render polygon features as outlines only (e.g., census tracts, admin boundaries), keep the fill type but make the fill transparent and set `outline_style`:

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

> **Common mistake:** do not use `"layer_type": "line"` for polygon outline layers. That flag tells the renderer the tile features are LineString geometries — on a polygon layer it causes features to silently not render. `outline_style` is the correct approach.

**Filter syntax note:** use `["match", ["get", "col"], ["val1", "val2"], true, false]` for list membership. Do **not** use the legacy `["in", "col", val1, val2]` form — it is silently ignored in current MapLibre.

## Deployment options

This is a **static site** — just HTML, CSS, JSON, and Markdown files. It can be hosted anywhere. Here are a few approaches:

### Option 1: GitHub Pages (or any static host)

The simplest option. Each user supplies their own LLM API key via the in-app settings panel.

1. Enable `"user_provided": true` in the `llm` section of `layers-input.json`
2. Push to a GitHub repo and enable Pages (or deploy to Netlify, Vercel, Cloudflare Pages, etc.)
3. No server-side secrets needed — users enter their own key (e.g., from [OpenRouter](https://openrouter.ai))

### Option 2: Hugging Face Spaces

Good for sharing demos with a pre-configured API key stored as a Space secret.

1. Create a **static** Space on Hugging Face
2. Add your `config.json` containing `llm_models` (with endpoint + API key) as a secret-mounted file
3. Push the app files — works the same as any static host, but the key is managed by HF

### Option 3: Kubernetes (NRP / cloud)

For production deployments with managed API keys and a private LLM proxy.

1. Set your hostname in `k8s/ingress.yaml`, adjust replicas, add secrets
2. API keys are injected into `config.json` at deploy time via a ConfigMap + init container (see `k8s/configmap.yaml`)
3. Deploy:

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

Update after changes: `kubectl rollout restart deployment/ca-lands`

The `k8s/` manifests in this example show how to host on the [NRP](https://nrp-nautilus.io) Kubernetes cluster using the boettiger-lab's LLM proxy — adapt them for your own cluster and endpoints.

## Local development

```bash
# Serve this folder
python -m http.server 8000

# For LLM to work locally, either:

# (a) Create a config.json with server-provided keys:
echo '{"llm_models":[{"value":"glm-4.7","label":"GLM","endpoint":"https://llm-proxy.nrp-nautilus.io/v1","api_key":"EMPTY"}]}' > config.json

# (b) Or enable user_provided mode in layers-input.json and enter
#     your own API key in the settings panel when the app loads.
```
