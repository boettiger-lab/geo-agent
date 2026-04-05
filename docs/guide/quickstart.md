# Quick Start

## Two repos, one workflow

| Repo | What it is | Who it's for |
|---|---|---|
| [`geo-agent`](https://github.com/boettiger-lab/geo-agent) | Core library — map, chat, agent, tools. Loaded from CDN. | Library contributors; this docs site. |
| [`geo-agent-template`](https://github.com/boettiger-lab/geo-agent-template) | Starter template. Three files to edit, then deploy. | App builders — **start here**. |

**To build a new map app:** use the template. You never touch the library repo.

## Start from the template

Go to [boettiger-lab/geo-agent-template](https://github.com/boettiger-lab/geo-agent-template) and click **Use this template → Create a new repository**. You get a ready-to-deploy repo with the three files you need. Edit them for your dataset and deploy.

**Live demo:** <https://boettiger-lab.github.io/geo-agent-template/>

## Your app is just three files

```
index.html          ← HTML shell — loads core JS/CSS from CDN
layers-input.json   ← which datasets to show, how to connect to the LLM
system-prompt.md    ← personality and guidelines for the AI assistant
```

No JavaScript to write. The core library (map, chat, agent, tools) loads from CDN.

## index.html

Pick a CDN version and paste it in:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>My Map App</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v2.5.0/app/style.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v2.5.0/app/chat.css">
</head>
<body>
  <script type="module"
    src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v2.5.0/app/main.js">
  </script>
</body>
</html>
```

| CDN reference | When to use |
|---|---|
| `@v2.5.0` | Production — pinned, immutable |
| `@main` | Staging/dev — always latest |

## layers-input.json

Minimal example:

```json
{
  "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
  "collections": ["cpad-2025b"],
  "llm": {
    "user_provided": true,
    "default_endpoint": "https://openrouter.ai/api/v1",
    "models": [
      { "value": "anthropic/claude-sonnet-4", "label": "Claude Sonnet" },
      { "value": "google/gemini-2.5-flash", "label": "Gemini Flash" }
    ]
  }
}
```

See [Configuration Reference](./configuration) for all fields.

## system-prompt.md

Plain Markdown instructions for the AI assistant. Tell it what data it's looking at, what kinds of questions it should help with, and any style preferences.

```markdown
You are a helpful assistant for exploring California's protected lands.
You can show or hide map layers, filter by attributes, and run SQL queries
to answer quantitative questions about the data.
```

## Local development

```bash
# From your app folder (index.html + layers-input.json + system-prompt.md)
python -m http.server 8000
# Open http://localhost:8000
# Enter your API key in the ⚙ settings panel
```

## Next steps

- [Configuration Reference](./configuration) — all `layers-input.json` fields
- [Deployment](./deployment) — GitHub Pages, Hugging Face Spaces, Kubernetes
- [Agent Loop](./agent-loop) — how the LLM tool-use loop works internally
