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

The HTML shell loads two kinds of code: a set of **pinned third-party libraries** (MapLibre, PMTiles, marked, DOMPurify, highlight.js) as page-global `<script>` tags, and the **geo-agent core** (JS + CSS) from the CDN. The `<body>` only needs two placeholder `<div>`s — the layout manager builds the rest (chat panel, controls, etc.) dynamically.

::: warning Copy this file from the template — don't hand-author it
The canonical `index.html` lives in [boettiger-lab/geo-agent-template](https://github.com/boettiger-lab/geo-agent-template). **Copy it verbatim** rather than retyping the script tags below. In particular, never hand-edit the `integrity="sha384-…"` hashes — see [Subresource Integrity](#about-the-integrity-hashes) for why. The block below is reproduced for reference and matches the template at the pinned release.
:::

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Map App</title>

  <!-- MCP SDK import map -->
  <script type="importmap">
  {
    "imports": {
      "@modelcontextprotocol/sdk/client/index.js": "https://esm.sh/@modelcontextprotocol/sdk@1.12.0/client/index",
      "@modelcontextprotocol/sdk/client/streamableHttp.js": "https://esm.sh/@modelcontextprotocol/sdk@1.12.0/client/streamableHttp"
    }
  }
  </script>

  <!-- MapLibre GL JS -->
  <script src="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.js"
    integrity="sha384-U054LTKiMIJKEecR8PKFiUZdvkGWHjfPBnen5hSmR9TwfOfgZmKbskC8Rs9dCm/1"
    crossorigin="anonymous"></script>
  <link href="https://unpkg.com/maplibre-gl@5.22.0/dist/maplibre-gl.css" rel="stylesheet"
    integrity="sha384-MGCxhspF/+ufueUgol3FDkiAYQbpSNRhBT0VWHJt64U8qIy9qlnXWx8LAbj6niPH"
    crossorigin="anonymous" />

  <!-- PMTiles protocol -->
  <script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js"
    integrity="sha384-MjejsnWXHmuz93aE35YWLh5AbS/6ceRB3Vb+ukOwqFzJRTpQ8vvbkLbNV7I0QK4f"
    crossorigin="anonymous"></script>

  <!-- h3-js (hex grid overlay) -->
  <script src="https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js"
    integrity="sha384-nKUDlg+fT0U/eEt4KWP9n034kLe/eVj6k7CVjbu6qfRhJdEyinlGajS9+9AU+UZ5"
    crossorigin="anonymous"></script>

  <!-- Markdown rendering (lib/marked.umd.js is the package-shipped artifact;
       marked.min.js is CDN-generated and unsafe to hash) -->
  <script src="https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.umd.js"
    integrity="sha384-ZD0fTOwPMHi7zM6WTVIWJR21I07lq0ccnqz3J6WMvQKG9thh4y7TA1QE6PJu0Af8"
    crossorigin="anonymous"></script>

  <!-- HTML sanitizer — chat-ui.js refuses to render markdown without it -->
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.8/dist/purify.min.js"
    integrity="sha384-jrsBdrv4eDpEYIq32u13DPbvB6tRmqIDnA6UlgFBoexpetaiWi7g/VbfMEL1WVen"
    crossorigin="anonymous"></script>

  <!-- Code highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
    integrity="sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH"
    crossorigin="anonymous">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
    integrity="sha384-F/bZzf7p3Joyp5psL90p/p89AZJsndkSoGwRpXcZhleCWhd8SnRuoYo4d0yirjJp"
    crossorigin="anonymous"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/sql.min.js"
    integrity="sha384-8q00eP+tyV9451aJYD5ML3ftuHKsGnDcezp7EXMEclDg1fZVSoj8O+3VyJTkXmWp"
    crossorigin="anonymous"></script>

  <!-- geo-agent core styles (pinned) -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.9.0/app/style.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.9.0/app/chat.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.9.0/app/sidebar.css">
</head>
<body>
  <div id="map"></div>
  <div id="menu"></div>
  <!-- geo-agent bootstrap (pinned) -->
  <script type="module"
    src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.9.0/app/main.js">
  </script>
</body>
</html>
```

::: tip Sidebar CSS is safe to always include
`sidebar.css` is scoped to `body.sidebar-mode` and sidebar-only IDs, so it has zero effect on floating-mode apps. Include it unconditionally to keep all apps on the same scaffold.
:::

### About the `integrity` hashes

Each third-party `<script>`/`<link>` carries an `integrity="sha384-…"` attribute — that's [Subresource Integrity (SRI)](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity). The browser downloads the file, hashes it, and **refuses to run it unless the hash matches**. If a CDN were ever compromised and served a tampered library, the mismatch blocks the swapped-in code instead of executing it. This matters here specifically because the agent renders model output (which can be steered by attacker-controllable data) into the page — DOMPurify sanitizes it, and SRI guarantees the *real* DOMPurify is the thing that loaded. `crossorigin="anonymous"` is required for SRI to work on cross-origin files.

**You normally never touch these values.** They're maintained in the template repo and this repo's `app/index.html`, kept in lockstep with the release the app pins. Copy them; don't retype them.

A hash needs updating in exactly one situation: **you bump a pinned library to a new version** (e.g. `marked@18.0.5` → a later release). A new version is different bytes, so the old hash will no longer match and the browser will block the file — chat text then renders as escaped plain markdown (a deliberate fail-closed, with a console warning), which is your signal that a hash and its URL have drifted apart. Recompute with:

```bash
curl -sL "<the pinned URL>" | openssl dgst -sha384 -binary | openssl base64 -A
# prefix the result with "sha384-"
```

Update the URL and its `integrity` value together in the same commit. Because every URL pins an *exact* version (never a floating range like `@18` or bare `marked`), the served bytes are immutable and the hash is stable indefinitely — so this is rare and only done by maintainers bumping a dependency.

| CDN reference | When to use |
|---|---|
| `@vX.Y.Z` (e.g. `@v3.6.0`) | Every deployed app — pinned, immutable |
| `@<40-char-commit-sha>` | Short-lived demo of an in-flight feature branch |

`@main` is **not** used by deployed apps: a merge to `main` can change behavior under a running page, and tooling/MCP contracts evolve between releases. Bump the pin deliberately, never implicitly.

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
