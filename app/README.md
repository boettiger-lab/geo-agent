# Core Modules

These are the shared ES modules that power all geo-chat client apps. They are served via [jsdelivr CDN](https://www.jsdelivr.com/github) and loaded by each client app's `index.html`.

**Do not deploy this directory directly.** Use the [`example/`](../example/) template to create client apps.

## Modules

| File | Responsibility |
|---|---|
| `main.js` | Bootstrap — wires everything together |
| `dataset-catalog.js` | Loads STAC collections, builds unified dataset records |
| `map-manager.js` | Creates MapLibre map, manages layers/filters/styles |
| `map-tools.js` | 9 local tools the LLM can call (show/hide/filter/style + dataset info) |
| `tool-registry.js` | Unified registry for local + remote (MCP) tools, single dispatch |
| `mcp-client.js` | MCP transport wrapper — connect, lazy reconnect, callTool |
| `agent.js` | LLM orchestration loop — agentic while-loop with tool-use |
| `chat-ui.js` | Chat UI with collapsible tool-call blocks |

### Supporting files

| File | Purpose |
|---|---|
| `style.css` | Map + layer control styles (loaded by client HTML from CDN) |
| `chat.css` | Chat interface styles (loaded by client HTML from CDN) |
| `index.html` | Local dev shell (not used by client apps) |
| `layers-input.json` | Local dev config (not used by client apps) |
| `system-prompt.md` | Default system prompt (clients provide their own) |

## How client apps load these modules

Client apps use a `<script type="module">` tag pointing at the CDN:

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/main.js"></script>
```

All internal imports (`./dataset-catalog.js`, `./agent.js`, etc.) resolve relative to `main.js` on the CDN. The client app provides `layers-input.json`, `system-prompt.md`, and `config.json` locally — `main.js` fetches these relative to the HTML page.

## Local development

This directory includes `index.html`, `layers-input.json`, and `system-prompt.md` for developing the core modules locally:

```bash
cd app && python -m http.server 8000
```

For LLM functionality, create `config.json`:
```json
{
    "llm_models": [
        { "value": "glm-4.7", "label": "GLM-4.7", "endpoint": "https://llm-proxy.nrp-nautilus.io/v1", "api_key": "EMPTY" }
    ]
}
```

## Tool architecture

**Local tools** (auto-approved, instant):
- `show_layer`, `hide_layer`, `set_filter`, `clear_filter`, `set_style`, `reset_style`, `get_map_state`
- `list_datasets`, `get_dataset_details`

**Remote tools** (require user approval):
- `query(sql_query)` — DuckDB SQL via MCP server

The agent runs an agentic loop: call LLM → if tool_calls → approve/execute → feed results → repeat.
