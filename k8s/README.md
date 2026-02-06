# Kubernetes Deployment for CA Protected Lands Website

This directory contains Kubernetes manifests for deploying the CA Protected Lands visualization website.

## Files

- `deployment.yaml` - Deployment with git clone init container and nginx web server
- `service.yaml` - ClusterIP service to expose the deployment
- `ingress.yaml` - Ingress configuration for external access
- `configmap-nginx.yaml` - Nginx server configuration

## Deployment

The deployment uses an init container to clone the repository and serve the app directory contents.

### Deploy the Application

```bash
kubectl apply -f k8s/configmap-nginx.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

### Update the Deployment

To pull the latest code from the repository, simply restart the deployment:

```bash
kubectl rollout restart deployment/ca-lands
```

The init container will clone the latest version of the repository on each pod restart.

### Update Configuration

If you modify the ConfigMap (`configmap-nginx.yaml`), you need to:

1. Apply the updated ConfigMap:
   ```bash
   kubectl apply -f k8s/configmap-nginx.yaml
   ```

2. Restart the deployment to pick up the changes:
   ```bash
   kubectl rollout restart deployment ca-lands
   ```

3. Check the rollout status:
   ```bash
   kubectl rollout status deployment ca-lands
   ```

**Note:** ConfigMap changes don't automatically trigger pod restarts. You must manually restart the deployment for pods to pick up the new configuration.

## Access

After deployment, the website will be available at:
- Internal: http://ca-lands.default.svc.cluster.local
- External: https://nature.nrp-nautilus.io

## Configuration

The application uses a two-layer configuration approach:

1. **ConfigMap** (`ca-lands-config`) - Contains the config template with placeholders
2. **Secrets** (`llm-proxy-secrets`) - Contains the shared API key for the LLM proxy

### Environment Variables

The deployment injects these environment variables into the runtime config:

- `MCP_SERVER_URL` - MCP server SSE endpoint (default: https://duckdb-mcp.nrp-nautilus.io/mcp)
- `LLM_ENDPOINT` - Shared LLM proxy base URL (default: https://llm-proxy.nrp-nautilus.io/v1)
- `PROXY_KEY` - Shared API key for all models using the same endpoint (from `llm-proxy-secrets`)

### Setting up Secrets

The deployment requires two secrets:

1. **LLM Proxy Key** (`llm-proxy-secrets`):
   ```bash
   # Copy the example secrets file
   cp k8s/secrets.yaml.example k8s/secrets.yaml
   
   # Edit k8s/secrets.yaml and replace the placeholder with your actual API key
   # Then apply:
   kubectl apply -f k8s/secrets.yaml
   ```
   
   **Note:** Since all models in this example use the same endpoint, they share the same API key. Use `"EMPTY"` if no authentication is required.

2. **Nimbus API Key** (`nimbus-api-key`):
   ```bash
   # Create the nimbus secret directly (or use create-nimbus-secret.sh)
   kubectl create secret generic nimbus-api-key \
     --from-literal=iNIMBUS_API_KEY="your-nimbus-key-here"
   
   # Or use the provided script:
   ./k8s/create-nimbus-secret.sh
   ```

### Updating Secrets

To update an existing secret:

```bash
# Delete the old secret
kubectl delete secret llm-proxy-secrets

# Recreate with new values
kubectl apply -f k8s/secrets.yaml

# Restart deployment to use new secret
kubectl rollout restart deployment ca-lands
```

**Important:** Changing secrets requires a deployment restart, as pods don't automatically reload secret values.

### Per-Model Endpoints and Keys

If you need different endpoints or API keys for different models:

1. Edit the ConfigMap template in `configmap-nginx.yaml` to use different environment variables per model
2. Add corresponding environment variables and secrets in `deployment.yaml`
3. Update the secrets to include the additional keys

**Note:** The configuration template is injected at pod startup using `envsubst`, substituting environment variables from the ConfigMap and Secrets into the final `config.json` served to the browser.

## Deployment Order

To deploy everything in the correct order:

```bash
# 1. Create secrets first
# Edit secrets.yaml with your actual proxy key
kubectl apply -f k8s/secrets.yaml

# Create nimbus API key secret
kubectl create secret generic nimbus-api-key \
  --from-literal=iNIMBUS_API_KEY="your-nimbus-key-here"

# 2. Apply ConfigMaps
kubectl apply -f k8s/configmap-nginx.yaml

# 3. Deploy the application
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

## Common Workflows

### Adding a New Model

1. Edit `k8s/configmap-nginx.yaml` to add the model to the `llm_models` array:
   ```json
   {
     "value": "new-model",
     "label": "New Model Name",
     "endpoint": "${LLM_ENDPOINT}",
     "api_key": "${PROXY_KEY}"
   }
   ```

2. Apply the updated ConfigMap and restart:
   ```bash
   kubectl apply -f k8s/configmap-nginx.yaml
   kubectl rollout restart deployment ca-lands
   ```

### Changing the Default Model

1. Update the `llm_model` value in `k8s/configmap-nginx.yaml`
2. Apply changes:
   ```bash
   kubectl apply -f k8s/configmap-nginx.yaml
   kubectl rollout restart deployment ca-lands
   ```

### Updating MCP Server URL

1. Edit the `MCP_SERVER_URL` environment variable in `k8s/deployment.yaml`
2. Apply the updated deployment:
   ```bash
   kubectl apply -f k8s/deployment.yaml
   ```
   (This will trigger an automatic rollout)

## Monitoring

Check deployment status:
```bash
kubectl get deployments ca-lands
kubectl get pods -l app=ca-lands
kubectl get service ca-lands
kubectl get ingress ca-lands-ingress
```

View logs:
```bash
# View nginx logs
kubectl logs -l app=ca-lands --tail=100 -f

# View init container logs (git clone)
kubectl logs -l app=ca-lands -c git-clone
```

## Configuration

- The ingress uses the `haproxy` ingress class
- CORS is enabled to allow cross-origin requests
- Static assets are cached for 7 days
- Health checks are configured on `/health` endpoint
- Content is cloned from GitHub on each pod start via init container

## Troubleshooting

If pods fail to start, check the init container logs:
```bash
kubectl logs <pod-name> -c git-clone
```

Common issues:
- Git clone failures: Check network connectivity and repository URL
- Empty content: Verify the app directory exists in the repository
- Secret errors: Ensure secrets are created or set `optional: true` in deployment
