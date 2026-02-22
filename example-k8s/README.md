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

## layers-input.json reference

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

    "collections": [
        "some-collection",
        {
            "collection_id": "another-collection",
            "assets": [
                "asset-id-1",
                { "id": "asset-id-2", "display_name": "Friendly Name" }
            ]
        }
    ]
}
```

- **String** collection entries load all visual assets
- **Object** entries with `assets` cherry-pick specific STAC asset IDs for map layers
- Asset filtering only affects map toggles — all parquet/H3 data remains available to the AI for SQL

### LLM configuration

The `llm` section controls how the chat agent connects to a language model. There are two modes:

1. **Server-provided** (default): A `config.json` file on the same server provides model endpoints and API keys (e.g., injected by Kubernetes secrets at deploy time). The `llm` section is ignored.

2. **User-provided** (`"user_provided": true`): No `config.json` is needed. The app presents a settings panel where each visitor enters their own API key. Keys are stored in `localStorage` (never sent to the hosting server). This is ideal for static-site deployments where there is no server-side secret injection.

| Field | Description |
|---|---|
| `user_provided` | `true` to enable browser-side API key entry. Omit or `false` for server-provided mode. |
| `default_endpoint` | Pre-filled endpoint URL (default: `https://openrouter.ai/api/v1`). Users can change it. |
| `models` | Array of `{ "value", "label" }` entries shown in the model selector. |

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
