# Project Context & Instructions

## Overview
This is a map-based application for exploring California's protected lands using the California Protected Areas Database (CPAD).

## Key Technologies
- **Frontend**: MapLibre GL JS
- **Data**: PMTiles (hosted on S3), DuckDB (backend analysis)
- **Deployment**: Kubernetes (k8s)
- **Configuration**: `app/layers-config.json`

## Deployment
Deployment is managed via Kubernetes. The application runs in a container that clones the repository on startup.

**To deploy changes:**
1.  Commit and push changes to the `main` branch.
2.  Restart the deployment to trigger a re-clone:
    ```bash
    kubectl rollout restart deployment/ca-lands
    ```

**Kubernetes Resources:**
- Manifests are in the `k8s/` directory.
- See `k8s/README.md` for detailed deployment and secret management instructions.

## Layer Configuration
- Map layers are defined in `app/layers-config.json`.
- When adding PMTiles layers, **ALWAYS verify the internal layer name** using `ogrinfo` or similar tools, as it may differ from the filename.
- Config `sourceLayer` must match the vector layer name in the PMTiles archive.

## Testing
- Use a minimal `test.html` to verify layer rendering if issues arise.
- Local development: `python -m http.server` in `app/` directory.
