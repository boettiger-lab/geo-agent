# Geo-Agent: Map + AI Data Analyst

A reusable JavaScript library for interactive map applications with LLM-powered data analysis. MapLibre GL JS on the front end, agentic tool-use with MCP (Model Context Protocol) for SQL analytics via DuckDB.

**This repo is the core library.** Individual apps (different datasets, URLs, branding) import these modules from the CDN and provide their own configuration.

**Live demo (GitHub Pages):** <https://boettiger-lab.github.io/geo-agent/>

## Quick start: create a new app

1. Copy one of the example templates into a new repo
2. Edit `layers-input.json` — choose your STAC collections, assets, and LLM config
3. Edit `index.html` — set page title, pin CDN version
4. Deploy (see options below)

| Template | Deployment | API key handling |
|---|---|---|
| [`example/`](example/) | Kubernetes / managed host | Injected server-side via `config.json` |
| [`example-ghpages/`](example-ghpages/) | GitHub Pages / any static host | Entered by the user in-browser |

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

Each client app is a tiny repo (~4–5 files) that provides:
- `index.html` — loads core JS/CSS from CDN, sets page title
- `layers-input.json` — STAC collections, assets, and (optionally) LLM config
- `system-prompt.md` — LLM personality and guidelines
- `k8s/` — Kubernetes deployment manifests (hostname, replicas, secrets) — optional

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

Client apps provide `layers-input.json`. All fields except `collections` are optional.

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
            { "value": "google/gemini-2.5-flash",  "label": "Gemini Flash" }
        ]
    },

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

### LLM configuration

There are two ways to supply model credentials:

**Server-provided** (Kubernetes / managed deployments): omit the `llm` section from `layers-input.json` and provide a `config.json` on the same server with `llm_models` + API keys. The `k8s/` manifests in `example/` inject secrets this way at deploy time.

**User-provided** (static sites — GitHub Pages, Netlify, etc.): set `"user_provided": true` in the `llm` section. A ⚙ button appears in the chat footer; visitors enter their own API key (stored in `localStorage`, never sent to the hosting server). The `default_endpoint` is pre-filled — [OpenRouter](https://openrouter.ai) is a good default giving access to many models via a single key.

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

| Option | Template | How secrets are handled |
|---|---|---|
| **GitHub Pages** (or any static host) | [`example-ghpages/`](example-ghpages/) | User enters their own API key in-browser |
| **Hugging Face Spaces** | Start from either example | Mount a `config.json` as a Space secret-file |
| **Kubernetes** | [`example/`](example/) with [`k8s/`](example/k8s/) | Secrets injected into `config.json` via ConfigMap + init container |

The `k8s/` directory in this repo deploys the core library's own demo instance on the [NRP](https://nrp-nautilus.io) cluster. See [`example/k8s/`](example/k8s/) for the client app deployment template, and [`example/README.md`](example/README.md) for a full walkthrough of all three options.

