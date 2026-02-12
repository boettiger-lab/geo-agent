# Example: CA Protected Lands App

This is a **template** showing how to build a client app using the [geo-chat](../) core library. Copy this folder as a starting point for your own app.

## Structure

```
index.html          ← HTML shell — loads core JS/CSS from CDN
layers-input.json   ← which STAC collections + assets this app shows
system-prompt.md    ← LLM system prompt (customize per app)
k8s/                ← Kubernetes deployment manifests
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
2. **Edit `layers-input.json`** — set your STAC collections and asset selections
3. **Edit `system-prompt.md`** — customize the AI assistant's persona and guidelines
4. **Edit `index.html`** — change the page title, add analytics, adjust CDN version
5. **Edit `k8s/`** — set your hostname in `ingress.yaml`, adjust replicas, add secrets

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

## Local development

```bash
# Serve this folder
python -m http.server 8000

# For LLM to work locally, create config.json:
echo '{"llm_models":[{"value":"glm-4.7","label":"GLM","endpoint":"https://llm-proxy.nrp-nautilus.io/v1","api_key":"EMPTY"}]}' > config.json
```

## Deploying to Kubernetes

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

Update after changes: `kubectl rollout restart deployment/ca-lands`
