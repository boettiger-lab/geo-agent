# Deployment

GLEN apps are **static sites** — just HTML, JSON, and Markdown files. They can be hosted anywhere. The only variable is how the LLM API key reaches the app.

## Option 1: GitHub Pages (or any static host)

The simplest option. Each user supplies their own LLM API key via the in-app settings panel. No server-side secrets needed.

**Use the [geo-agent-template](https://github.com/boettiger-lab/geo-agent-template)** — it includes a ready-to-use GitHub Actions workflow.

1. Set `"user_provided": true` in the `llm` section of `layers-input.json`
2. Push to a GitHub repo and enable Pages (Settings → Pages → Source: **GitHub Actions**)
3. The workflow in the template deploys on push to `main`

Users visit the app and enter their own API key (e.g., from [OpenRouter](https://openrouter.ai)) in the ⚙ settings panel. Keys are stored in `localStorage` only — never sent to your server.

Works equally well on Netlify, Vercel, Cloudflare Pages, or any static host.

::: tip Free hosting with a pre-configured key
If you want visitors to use the app without supplying their own API key, but don't have access to Kubernetes, [Hugging Face Spaces](https://huggingface.co/spaces) is a free option. Create a static Space and store your `config.json` (containing the API key) as a Space secret — it gets mounted as a file at runtime, never committed to the repo. The app works the same as any static host, but the key is managed by HF.
:::

## Option 2: Kubernetes (NRP / cloud)

For production deployments with managed API keys and a private LLM proxy.

**Use the [geo-agent-template](https://github.com/boettiger-lab/geo-agent-template)** — it includes `k8s/` manifests ready to adapt.

API keys are injected into `config.json` at deploy time via a ConfigMap + init container:

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

A release of the library changes nothing for a running app: the app's `index.html` pins a version, so it keeps loading the same code until you bump that pin. Restart when *your* files change:

- **You bumped the pin, or edited `index.html` / `layers-input.json`.** If the pod `git clone`s the app at startup (an initContainer, as in the template), the running pod keeps serving what it cloned, so restart it to re-clone. If those files come from a ConfigMap, `kubectl apply` it first.
- **You changed the ConfigMap or deployment manifests.** Apply, then restart.

```bash
kubectl rollout restart deployment/my-app
```

### `config.json`

The deploy-time `config.json` sits beside `layers-input.json` and is merged over it at startup. It holds what shouldn't be committed. The app reads these keys from it:

| Key | Description |
|---|---|
| `llm_models` | Array of `{ value, label, endpoint, api_key }`, the models offered in the chat footer. |
| `llm_model` | Which of them is selected on load. Defaults to the first. |
| `mcp_server_url` | MCP server URL. Overrides `mcp_url` from `layers-input.json`. |
| `mcp_auth_token` | Sent to the MCP server as `Authorization: Bearer …`. |
| `transcription_model` | Enables voice input. See [Voice input](./configuration#voice-input-optional). |
| `draw_enabled`, `geolocate` | Override the same keys in `layers-input.json`. |
| `max_tool_calls`, `max_tool_calls_manual` | Override the checkpoint caps. `0` disables a cap. |
| `export` | Overrides the [export settings](./configuration#chat-export). |
| `maptiler_key` | MapTiler key for the basemap, and for the `maptiler` geocoder when it has none of its own. |

Without a `config.json` (local development, GitHub Pages), set `llm.user_provided` instead so visitors supply their own key.

## CDN versioning

All deployment options load the core library from jsDelivr. **Always pin to a release tag** — `@main` is not supported for deployed apps because changes can land between page loads and break tooling/MCP-server contracts that the app depends on.

```html
<!-- Pinned to a release tag — required for any deployed app -->
<script type="module"
  src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v3.32.0/app/main.js">
</script>
```

For short-lived demos previewing an in-flight feature branch, pin to a commit SHA (`@<40-char-sha>`); never use a branch name, since jsDelivr's branch-ref resolution is non-deterministic.

To release a new version: create a GitHub release via `gh release create vX.Y.Z --target main --generate-notes`. Apps upgrade by changing their tag in `index.html` (coordinated through the geo-agent-ops repo for in-house apps).
