# California Protected Lands

A map-based application for exploring California's protected lands with an integrated LLM chatbot for natural language queries and analysis.

## Overview

This application provides an interactive map interface for exploring protected areas in California, powered by STAC (SpatioTemporal Asset Catalog) for dynamic layer configuration and DuckDB for analytical queries. Users can interact with the map through natural language using the integrated AI chatbot.

## Architecture

### Frontend
- **Map Visualization**: MapLibre GL JS renders vector tiles (PMTiles) and raster tiles (COG via TiTiler) directly from S3
- **Dynamic Configuration**: Layers are configured at runtime by fetching STAC catalog metadata
- **AI Chatbot**: LLM-powered interface using Model Context Protocol (MCP) tools for map control and data analysis

### Backend
- **MCP Data Server**: DuckDB-powered analytical backend that queries H3-indexed Parquet datasets
- **STAC Catalog**: Metadata-driven layer discovery and configuration

### Key Components

```
User Input → Chatbot (chat.js) → MCP Tools → MapController → MapLibre GL JS
                ↓
          MCP Data Server (DuckDB queries on H3 Parquet)
                ↓
          STAC Catalog (layer metadata)
```

## Configuration

### Layer Configuration

Layers are configured in [`app/layers-input.json`](app/layers-input.json). This file specifies which STAC collections to load:

```json
{
    "catalog": "https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json",
    "layers": [
        {
            "collection_id": "cpad-2025b",
            "asset_id": "cpad-units-pmtiles",
            "layer_key": "cpad",
            "display_name": "California Protected Areas"
        }
    ]
}
```

On startup, the application:
1. Fetches STAC collections
2. Extracts layer properties from `table:columns`
3. Generates tool definitions for the LLM
4. Registers layers with the map

See [`scripts/README.md`](scripts/README.md) for configuration details.

## Development

### Prerequisites
- Python 3.11+ (for local HTTP server)
- Access to MCP data server (for analytical queries)

### Running Locally

```bash
# Serve the app directory
python -m http.server 8000 --directory app
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

### Project Structure

```
app/
├── config-loader.js      # Runtime STAC metadata fetching
├── layer-registry.js     # Layer metadata management
├── map.js                # Map initialization & MapController
├── chat.js               # LLM chatbot integration
├── mcp-tools.js          # MCP tool definitions
├── system-prompt.md      # LLM system prompt
└── layers-input.json     # Layer configuration

scripts/
├── README.md             # Configuration guide
└── layers-input-example.json

k8s/
└── README.md             # Deployment guide
```

## Deployment

The application is deployed on Kubernetes. Changes are not automatically deployed.

```bash
# Trigger rollout after pushing changes
kubectl rollout restart deployment/ca-protected-lands -n boettiger-lab
```

See [`k8s/README.md`](k8s/README.md) for detailed deployment instructions.

## Data Sources

- **CPAD**: [CAL FIRE / GreenInfo Network](https://www.calands.org/)
- **STAC Catalog**: `https://s3-west.nrp-nautilus.io/public-data/stac/catalog.json`
- **Storage**: S3-compatible object storage hosted at `s3-west.nrp-nautilus.io`

