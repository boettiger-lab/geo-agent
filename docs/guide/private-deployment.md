# Private Deployment Patterns

The standard [Deployment](./deployment) guide covers the public k8s path: app source in a public GitHub repo, data in a public S3 bucket, LLM key injected via ConfigMap. This page covers the additional modules needed when parts of the app are private.

These modules are **independent and composable** — use whichever subset your app requires:

| Privacy need | Mechanism | What it protects |
|---|---|---|
| Private source code | ConfigMap deployment | GitHub repo not publicly cloneable |
| Private query data (S3 parquet) | Credential injection into system prompt | S3 keys for MCP/DuckDB queries |
| Private visual data (S3 PMTiles) | rclone sidecar + nginx proxy | S3 tiles served without exposing creds |
| Restricted user access | oauth2-proxy | Only authorized users see the app |

Each module is independent. A common combination: private source code + private visual data + restricted access, while query parquet remains on a public bucket. Or: public source, public tiles, private parquet (analytics only over restricted data), no auth wall. Any combination works.

---

## Module 1: Private source code (ConfigMap deployment)

When your GitHub repo is private, the pod can't `git clone` at startup. Instead, bundle your app files into a Kubernetes ConfigMap.

### How it works

A `scripts/generate-configmap.sh` script uses `kubectl create configmap --dry-run=client -o yaml` to produce a ConfigMap YAML from your source files. **Never hand-edit the ConfigMap YAML** — always regenerate it from source.

```bash
#!/bin/bash
# scripts/generate-configmap.sh
kubectl create configmap <app-name>-content \
  --from-file=index.html \
  --from-file=layers-input.json \
  --from-file=system-prompt.md \
  --from-file=stac/my-collection.json \   # optional: local STAC JSONs for private collections
  --dry-run=client -o yaml > k8s/content-configmap.yaml
```

Add any local STAC collection JSONs to the `--from-file` list when private collection metadata must not be hosted publicly.

### Deployment workflow

```bash
# 1. Edit source files (index.html, layers-input.json, system-prompt.md)
# 2. Regenerate the ConfigMap
bash scripts/generate-configmap.sh

# 3. Apply it — this is what the cluster reads
kubectl apply -f k8s/content-configmap.yaml

# 4. Restart to pick up the new content
kubectl rollout restart deployment/<app-name>
```

::: warning `rollout restart` alone does nothing
The cluster reads content from the ConfigMap, not from git. If you restart without re-applying the ConfigMap, the pod serves the old files.
:::

### Deployment spec

Replace the `git-clone` init container from the public template with a `busybox` init container that copies files from the ConfigMap volume to the nginx web root:

```yaml
initContainers:
  - name: copy-content
    image: busybox
    command: ["sh", "-c", "cp /content/* /usr/share/nginx/html/"]
    volumeMounts:
      - name: content
        mountPath: /content

volumes:
  - name: content
    configMap:
      name: <app-name>-content
```

---

## Module 2: Private query data (S3 parquet via MCP)

When the app queries parquet files on a private S3 bucket through the MCP/DuckDB server. This is separate from private visual layers — an app can have private parquet with public PMTiles, or vice versa.

### How it works

S3 credentials are stored in a Kubernetes Secret, injected as environment variables, and `envsubst` renders them into `system-prompt.md` at pod startup. The LLM reads the rendered credentials from its system prompt and passes them to the MCP `query` tool with each SQL call.

The MCP server's `query` tool accepts `s3_key`, `s3_secret`, `s3_endpoint`, and `s3_scope` parameters for per-request credential passing. Credentials are never stored on the MCP server — they travel per-request, scoped to a specific S3 prefix.

### system-prompt.md

Add a section to your system prompt with placeholder variables:

```markdown
## Private Data Access

Any SQL referencing `s3://private-<bucket>/` paths requires these credentials:
- `s3_key`: `${S3_KEY_ID}`
- `s3_secret`: `${S3_SECRET}`
- `s3_endpoint`: `<your-s3-endpoint>`
- `s3_scope`: `s3://private-<bucket>`
```

### Deployment spec

Store credentials in a Secret and inject as environment variables:

```yaml
# k8s/secret.yaml (never commit — create manually or via CI)
apiVersion: v1
kind: Secret
metadata:
  name: <app-name>-secrets
type: Opaque
stringData:
  s3-key-id: "<your-key>"
  s3-secret: "<your-secret>"
```

```yaml
# In the nginx container spec:
env:
  - name: S3_KEY_ID
    valueFrom:
      secretKeyRef:
        name: <app-name>-secrets
        key: s3-key-id
  - name: S3_SECRET
    valueFrom:
      secretKeyRef:
        name: <app-name>-secrets
        key: s3-secret
```

In the init container (or an entrypoint script), run `envsubst` to render the credentials into the system prompt before nginx serves it:

```bash
envsubst '${S3_KEY_ID} ${S3_SECRET}' < /content/system-prompt.md > /usr/share/nginx/html/system-prompt.md
```

::: tip Explicit variable list
Pass the explicit variable list to `envsubst` — `'${S3_KEY_ID} ${S3_SECRET}'` — to avoid clobbering other `$` references in the prompt (MapLibre expressions, code examples, etc.).
:::

### STAC collection JSONs for private data

Private STAC collection JSONs must reference `s3://` hrefs (not HTTPS) for parquet assets, and must be bundled in the ConfigMap (Module 1) rather than hosted publicly — otherwise the paths themselves reveal the bucket structure.

```json
{
  "assets": {
    "h3-parquet": {
      "href": "s3://private-<bucket>/<collection>/hex/",
      "type": "application/vnd.apache.parquet",
      "roles": ["data"]
    }
  }
}
```

---

## Module 3: Private visual data (rclone sidecar for PMTiles)

When the app serves PMTiles (or COG tiles) from a private S3 bucket. This handles what the **map renders** — separate from Module 2, which handles what the **LLM queries**.

### How it works

An `rclone` sidecar container runs in the same pod as nginx. It authenticates to private S3 and serves the bucket over HTTP on `localhost:8080`. nginx proxies `/tiles/*` requests to it. The browser fetches tiles from `https://<app>.nrp-nautilus.io/tiles/<path>` — S3 credentials never leave the pod.

### rclone sidecar spec

```yaml
- name: s3-proxy
  image: rclone/rclone:1.69
  args:
    - serve
    - http
    - ":s3:private-<bucket>"
    - --addr=:8080
    - --s3-provider=Other
    - --s3-endpoint=https://<s3-endpoint>
    - --s3-force-path-style
    - --read-only
    - --no-modtime
  env:
    - name: RCLONE_S3_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: <app-name>-secrets
          key: s3-key-id
    - name: RCLONE_S3_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: <app-name>-secrets
          key: s3-secret
```

The rclone sidecar and Module 2 credential injection can share the same Secret when they access the same bucket.

### nginx proxy config

Add a location block to your nginx ConfigMap to forward tile requests to the sidecar:

```nginx
location /tiles/ {
    proxy_pass http://localhost:8080/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
}
```

### STAC collection JSON

Visual assets reference the proxied URL; parquet assets reference raw `s3://` paths (accessed via Module 2):

```json
{
  "assets": {
    "pmtiles": {
      "href": "https://<app>.nrp-nautilus.io/tiles/<path>.pmtiles",
      "type": "application/vnd.pmtiles",
      "roles": ["visual"]
    },
    "h3-parquet": {
      "href": "s3://private-<bucket>/<path>/hex/",
      "type": "application/vnd.apache.parquet",
      "roles": ["data"]
    }
  }
}
```

This pattern works for any S3-hosted binary asset (PMTiles, COG, GeoTIFF), not just PMTiles.

---

## Module 4: Restricted user access (oauth2-proxy)

When only authorized users should see the app.

### How it works

An `oauth2-proxy` Deployment sits in front of nginx. The ingress routes to oauth2-proxy instead of directly to nginx. Google OAuth with an email allowlist is the standard pattern — the allowlist lives in a ConfigMap (safe to commit), OAuth credentials in a Secret (never committed).

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app-name>-oauth2-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: <app-name>-oauth2-proxy
  template:
    metadata:
      labels:
        app: <app-name>-oauth2-proxy
    spec:
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
          args:
            - --provider=google
            - --upstream=http://<app-name>:80
            - --http-address=0.0.0.0:4180
            - --email-domain=*
            - --authenticated-emails-file=/etc/oauth2-proxy/allowlist.txt
            - --skip-auth-regex=^/stac/          # exempt paths the MCP server must reach
            - --cookie-secret=$(COOKIE_SECRET)
            - --client-id=$(GOOGLE_CLIENT_ID)
            - --client-secret=$(GOOGLE_CLIENT_SECRET)
          env:
            - name: COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: <app-name>-oauth-secrets
                  key: cookie-secret
            - name: GOOGLE_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: <app-name>-oauth-secrets
                  key: client-id
            - name: GOOGLE_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: <app-name>-oauth-secrets
                  key: client-secret
          volumeMounts:
            - name: allowlist
              mountPath: /etc/oauth2-proxy
      volumes:
        - name: allowlist
          configMap:
            name: <app-name>-oauth-allowlist
```

### Allowlist ConfigMap

```yaml
# k8s/oauth-allowlist-configmap.yaml (safe to commit)
apiVersion: v1
kind: ConfigMap
metadata:
  name: <app-name>-oauth-allowlist
data:
  allowlist.txt: |
    alice@example.com
    bob@example.com
```

### Ingress (route to oauth2-proxy, not nginx)

```yaml
spec:
  rules:
    - host: <app-name>.nrp-nautilus.io
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: <app-name>-oauth2-proxy
                port:
                  number: 4180
```

::: tip Exempt internal paths
If your STAC catalog is served from the same pod and must be reachable by the MCP server (which carries no user auth), exempt it with `--skip-auth-regex=^/stac/`. Adjust the regex to match your catalog path.
:::

---

## Security summary

| Module | Where credentials live | What the browser sees |
|---|---|---|
| ConfigMap deployment | k8s ConfigMap (source files only, no secrets) | Static files served by nginx |
| Private parquet | k8s Secret → env var → rendered into system prompt at startup | LLM passes creds per SQL call; never in HTML/JS |
| Private PMTiles | k8s Secret → rclone sidecar env var | Proxied tile URLs only; no S3 creds |
| oauth2-proxy | k8s Secret (OAuth app credentials + cookie secret) | OAuth login flow; session cookie |

---

## Putting it all together

A fully private deployment uses all four modules. The apply order matters — Secrets and ConfigMaps before Deployments:

```bash
# Secrets (create manually — never committed)
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/oauth-secret.yaml

# ConfigMaps
bash scripts/generate-configmap.sh
kubectl apply -f k8s/content-configmap.yaml
kubectl apply -f k8s/oauth-allowlist-configmap.yaml

# Workloads
kubectl apply -f k8s/deployment.yaml          # nginx + rclone sidecar
kubectl apply -f k8s/oauth-deployment.yaml    # oauth2-proxy
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml

# Restart if ConfigMaps changed
kubectl rollout restart deployment/<app-name>
kubectl rollout restart deployment/<app-name>-oauth2-proxy
```

After initial setup, the day-to-day workflow for content changes is:

```bash
# Edit source files, then:
bash scripts/generate-configmap.sh
kubectl apply -f k8s/content-configmap.yaml
kubectl rollout restart deployment/<app-name>
```
