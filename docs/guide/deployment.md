# Deployment

Geo-agent apps are **static sites** — just HTML, JSON, and Markdown files. They can be hosted anywhere. The only variable is how the LLM API key reaches the app.

## Option 1: GitHub Pages (or any static host)

The simplest option. Each user supplies their own LLM API key via the in-app settings panel. No server-side secrets needed.

**Use the [`example-ghpages/`](https://github.com/boettiger-lab/geo-agent/tree/main/example-ghpages) template.**

1. Set `"user_provided": true` in the `llm` section of `layers-input.json`
2. Push to a GitHub repo and enable Pages (Settings → Pages → Source: **GitHub Actions**)
3. Add the [workflow](https://github.com/boettiger-lab/geo-agent/blob/main/.github/workflows/gh-pages.yml) — it deploys on push to `main`

Users visit the app and enter their own API key (e.g., from [OpenRouter](https://openrouter.ai)) in the ⚙ settings panel. Keys are stored in `localStorage` only — never sent to your server.

Works equally well on Netlify, Vercel, Cloudflare Pages, or any static host.

## Option 2: Hugging Face Spaces

Good for sharing demos with a pre-configured API key stored as a Space secret, so visitors don't need their own key.

1. Create a **static** Space on Hugging Face
2. Add a `config.json` as a secret-mounted file:
   ```json
   {
     "llm_models": [
       {
         "value": "anthropic/claude-sonnet-4",
         "label": "Claude Sonnet",
         "endpoint": "https://openrouter.ai/api/v1",
         "api_key": "sk-or-..."
       }
     ]
   }
   ```
3. Push the app files — the rest works the same as any static host

## Option 3: Kubernetes (NRP / cloud)

For production deployments with managed API keys and a private LLM proxy.

**Use the [`example-k8s/`](https://github.com/boettiger-lab/geo-agent/tree/main/example-k8s) template.**

API keys are injected into `config.json` at deploy time via a ConfigMap + init container:

```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

After code changes (merged to `main` and picked up from CDN), no restart is needed — the CDN delivers the latest JS. Only restart if you changed the ConfigMap or deployment manifests:

```bash
kubectl rollout restart deployment/my-app
```

## CDN versioning

All deployment options load the core library from jsDelivr. Pin to a tagged release for production stability:

```html
<!-- Pinned — immutable, recommended for production -->
<script type="module"
  src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@v1.0.0/app/main.js">
</script>

<!-- Latest main — use for staging/development -->
<script type="module"
  src="https://cdn.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js">
</script>
```

To release a new version: `git tag v1.1.0 && git push --tags`. Production apps upgrade by changing their tag in `index.html`.

::: tip jsDelivr cache
jsDelivr caches `@main` aggressively. After merging to `main`, force a refresh by hitting the purge URLs:
```
https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/main.js
https://purge.jsdelivr.net/gh/boettiger-lab/geo-agent@main/app/chat-ui.js
```
:::
