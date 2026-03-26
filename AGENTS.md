# Project Context & Instructions

## Overview
Core library for map-based applications with LLM-powered data analysis. Interactive MapLibre GL JS map with an agentic chatbot for natural language data queries and map control. Individual apps (different datasets, branding, deployments) import this library from the CDN and provide their own configuration.

## Key Technologies
- **Frontend**: MapLibre GL JS, PMTiles (vectors), COG + TiTiler (rasters), ES modules
- **Data**: STAC catalog → unified dataset records with visual + parquet assets
- **Analytics**: SQL queries via MCP (Model Context Protocol) to DuckDB on H3-indexed parquet
- **LLM**: OpenAI-compatible Chat Completions API (multiple models via proxy)
- **Deployment**: App JS/CSS is loaded from jsDelivr CDN (`@main` or a pinned tag). Downstream apps only need a static HTML file — see the [geo-agent-template](https://github.com/boettiger-lab/geo-agent-template) repo.

## Architecture (app/ modules)
- `main.js` — Bootstrap: loads config, initializes catalog → map → tools → agent → UI
- `dataset-catalog.js` — Fetches STAC collections, builds unified records
- `map-manager.js` — Creates MapLibre map, manages layers/filters/styles
- `map-tools.js` — 9 local tools the LLM agent can call
- `tool-registry.js` — Unified dispatch for local + remote (MCP) tools
- `mcp-client.js` — MCP transport wrapper (connect once, lazy reconnect)
- `agent.js` — LLM orchestration loop (agentic tool-use cycle)
- `chat-ui.js` — Chat UI with collapsible tool-call blocks

## Configuration
- `app/layers-input.json` — Static config: STAC catalog URL, collection IDs, map view
- `config.json` — Generated at deploy time by k8s (LLM models + API keys from secrets)
- Both are merged by `main.js` at startup; runtime config overrides static config

## Git workflow — branch protection

The `main` branch is protected: **direct pushes are rejected**. All changes must go through a pull request.

**Committing and pushing changes:**
1. Make changes, then commit:
   ```bash
   git add <files>
   git commit -m "<message>"
   ```
2. Create a feature branch and push:
   ```bash
   git checkout -b <branch-name>
   git push -u origin <branch-name>
   ```
3. The push output includes a PR URL — open it to create the pull request:
   ```
   remote: Create a pull request ... by visiting:
   remote:   https://github.com/boettiger-lab/geo-agent/pull/new/<branch-name>
   ```
4. After the PR is merged, **always clean up**:
   ```bash
   git checkout main
   git pull
   git branch -d <branch-name>
   ```

> If the user confirms the PR has been merged and asks to "clean up" or "switch back to main", run all three cleanup commands together.

## Deployment

Changes merged to `main` are picked up automatically by downstream apps via jsDelivr CDN — no restarts needed. jsDelivr caches `@main` aggressively; to force immediate refresh, purge the affected files:

```
https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js
https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/chat-ui.js
https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/chat.css
```

**Live deployments:**
- [boettiger-lab/geo-agent-template](https://github.com/boettiger-lab/geo-agent-template) → canonical starting point for new apps; deployed to GitHub Pages as live demo

All downstream apps serve a static HTML file that loads app code from jsDelivr, so a `kubectl rollout restart` is not required after merging changes here.

## Development
- Local: `cd app && python -m http.server 8000`
- Create a local `app/config.json` with LLM model configs for development
- `config.json` is in `.gitignore` — never committed (contains API keys)

