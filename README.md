# Geo-Agent: Map + AI Data Analyst

A reusable JavaScript library for interactive map applications with LLM-powered data analysis. MapLibre GL JS on the front end, agentic tool-use with MCP (Model Context Protocol) for SQL analytics via DuckDB.

**This repo is the core library.** Individual apps (different datasets, URLs, branding) import these modules from the CDN and provide their own configuration. See [`example/`](example/) for a complete client app template.

## Quick start: create a new app

1. Copy [`example/`](example/) into a new repo
2. Edit `layers-input.json` — choose your STAC collections and assets
3. Edit `index.html` — set page title, pin CDN version
4. Deploy with `kubectl apply -f k8s/`

See the [example README](example/README.md) for full details.

## Using the CDN

Client apps load the core modules directly from jsdelivr:

```html
<!-- Styles -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/style.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/chat.css">

<!-- App (all modules resolve from CDN via relative imports) -->
<script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/main.js"></script>
```

### Versioning

| CDN reference | Behavior |
|---|---|
| `@v1.0.0` | Pinned — immutable, use for production |
| `@main` | Tracks latest commit — use for staging/dev |

**Releasing:** tag a commit on `main` → `git tag v1.1.0 && git push --tags` → all apps on `@main` get it immediately; production apps upgrade by changing their tag.

## Architecture

```
                     ┌───────────────────────────────┐
                     │  This repo (core library)     │
                     │  served via CDN               │
                     └──────────┬────────────────────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
     ┌─────▼──────┐     ┌──────▼─────┐     ┌───────▼──────┐
     │ App 1      │     │ App 2      │     │ App 3        │
     │ ca-lands   │     │ wetlands   │     │ fire-risk    │
     │            │     │            │     │              │
     │ index.html │     │ index.html │     │ index.html   │
     │ config     │     │ config     │     │ config       │
     │ k8s/       │     │ k8s/       │     │ k8s/         │
     └────────────┘     └────────────┘     └──────────────┘
```

Each client app is a tiny repo (~5 files) that provides:
- `index.html` — loads core JS/CSS from CDN, sets page title
- `layers-input.json` — which STAC collections + assets to show
- `system-prompt.md` — LLM personality and guidelines
- `k8s/` — deployment manifests (hostname, replicas, secrets)

### Core modules (`app/`)

| File | Responsibility |
|---|---|
| `main.js` | Bootstrap — wires all modules together |
| `dataset-catalog.js` | Loads STAC collections, builds unified dataset records |
| `map-manager.js` | Creates MapLibre map, manages layers/filters/styles |
| `map-tools.js` | 9 local tools the LLM can call (show/hide/filter/style + dataset info) |
| `tool-registry.js` | Unified registry for local + remote (MCP) tools, single dispatch |
| `mcp-client.js` | MCP transport wrapper — connect, lazy reconnect, callTool |
| `agent.js` | LLM orchestration loop — agentic while-loop with tool-use |
| `chat-ui.js` | Chat UI with collapsible tool-call blocks |

### Data flow

1. **STAC catalog** is the single source of truth for dataset metadata
2. Each collection provides **visual assets** (PMTiles/COG for map) and **parquet assets** (H3-indexed for SQL)
3. The agent can **query parquet** via the MCP SQL tool and **control the map** via local tools

## Configuration

Client apps provide `layers-input.json`:

```json
{
    "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
    "titiler_url": "https://titiler.nrp-nautilus.io",
    "mcp_url": "https://duckdb-mcp.nrp-nautilus.io/mcp",
    "view": { "center": [-119.4, 36.8], "zoom": 6 },
    "collections": [
        {
            "collection_id": "cpad-2025b",
            "assets": ["cpad-holdings-pmtiles", "cpad-units-pmtiles"]
        },
        {
            "collection_id": "irrecoverable-carbon",
            "assets": [
                { "id": "irrecoverable-total-2018-cog", "display_name": "Irrecoverable Carbon (2018)" },
                { "id": "manageable-total-2018-cog", "display_name": "Manageable Carbon (2018)" }
            ]
        }
    ]
}
```

- **String** collection entries load all visual assets
- **Object** entries with `assets` cherry-pick specific STAC asset IDs for map layers
- Asset filtering only affects map toggles — all parquet/H3 data remains available for SQL

## Development

### Working on the core library

```bash
cd app && python -m http.server 8000
```

The `app/` directory includes its own `index.html`, `layers-input.json`, and `system-prompt.md` for local development. Changes here are what client apps consume via CDN.

### Staging → Production workflow

1. Push to `main` — staging apps (using `@main`) pick up changes on next load
2. Test on staging
3. Tag a release: `git tag v1.1.0 && git push --tags`
4. Update production apps' importmap to `@v1.1.0`

## Deployment

The `k8s/` directory in this repo deploys the core library's own demo instance. See [`example/k8s/`](example/k8s/) for the client app deployment template.

