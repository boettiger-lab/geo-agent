# Example: GitHub Pages Deployment

This example shows how to deploy a geo-agent app as a **static site on GitHub Pages**. Users supply their own LLM API key (e.g., from [OpenRouter](https://openrouter.ai)) via an in-app settings panel — no server-side secrets needed.

**Live demo:** <https://boettiger-lab.github.io/geo-agent/>

## How it works

The key difference from the [Kubernetes example](../example/) is the `llm` section in `layers-input.json`:

```json
"llm": {
    "user_provided": true,
    "default_endpoint": "https://openrouter.ai/api/v1",
    "models": [
        { "value": "anthropic/claude-sonnet-4", "label": "Claude Sonnet" },
        { "value": "google/gemini-2.5-flash", "label": "Gemini Flash" },
        { "value": "openai/gpt-4.1-mini", "label": "GPT-4.1 mini" }
    ]
}
```

When `user_provided` is `true` and no server-side `config.json` is present:
- The app shows a ⚙ settings button in the chat footer
- On first visit, a settings panel opens asking for an API endpoint and key
- Keys are stored in the browser's `localStorage` only — never sent to the hosting server
- The default endpoint is pre-filled with OpenRouter, but users can change it to any OpenAI-compatible API

No `config.json` file is needed. No `k8s/` folder is needed.

## Structure

```
index.html          ← HTML shell (identical to the k8s example)
layers-input.json   ← data config + user-provided LLM settings
system-prompt.md    ← LLM system prompt
```

## Deploying to your own repo

1. Copy this folder into a new repo (or use it in place)
2. Edit `layers-input.json` — set your STAC collections and preferred model list
3. Edit `system-prompt.md` — customize the AI assistant
4. Enable GitHub Pages in your repo settings (Settings → Pages → Source: **GitHub Actions**)
5. Push — the [workflow](../.github/workflows/gh-pages.yml) deploys automatically on changes to `main`

## Local development

```bash
cd example-ghpages
python -m http.server 8000
# Open http://localhost:8000 — enter your API key in the settings panel
```

## Getting an API key

[OpenRouter](https://openrouter.ai) is a good default — it gives you access to many models (Claude, GPT, Gemini, etc.) with a single API key. Sign up, add credits, and copy your key into the settings panel.

You can also point to any OpenAI-compatible endpoint (e.g., `https://api.openai.com/v1`, `https://api.anthropic.com/v1`, a local Ollama instance, etc.).
