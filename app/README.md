# Wetlands MapLibre Application

An interactive web application combining MapLibre GL JS for geospatial visualization with an AI-powered chatbot that can analyze wetlands data and control map layers.

## Features

- **Interactive Map** with multiple global wetlands datasets:
  - Global Wetlands Database (GLWD) - raster COG
  - Nature's Contributions to People (NCP) - raster COG  
  - Vulnerable Carbon Storage - raster COG
  - Ramsar Wetlands of International Importance - PMTiles polygons
  - World Database on Protected Areas (WDPA) - PMTiles polygons
  - HydroBASINS Level 6 Watersheds - PMTiles polygons

- **AI Chatbot** powered by LLM + Model Context Protocol (MCP):
  - Natural language queries about wetlands data
  - Statistical analysis using DuckDB on GeoParquet files
  - Dynamic map layer control

- **Chatbot-Controlled Map Layers** - The chatbot can show/hide map layers based on analysis context

## Quick Start

### 1. Start the MCP Server

The chatbot requires an MCP server to access the wetlands database:

```bash
cd ../mcp
uvx mcp-server-motherduck --transport stream --port 8001 --host 127.0.0.1 --db-path :memory: --json-response
```

See `../mcp/README.md` for details.

### 2. Start the Web Server

```bash
cd maplibre
python3 -m http.server 8000
```

### 3. Open in Browser

Navigate to `http://localhost:8000`


```

## Example Chatbot Queries

- "How many different types of wetlands are there?"
- "What's the total area of peatlands globally?"
- "Which countries have the most wetlands?"
- "Compare protected vs unprotected wetlands"
- "Show me statistics about Ramsar sites"

**Layer Control:**

Users can show/hide layers using the checkboxes in the UI. All map layers are controlled manually by the user through the interactive controls.

## File Structure

```
maplibre/
├── index.html              # Main HTML page
├── map.js                  # MapLibre map setup and layer control
├── chat.js                 # Chatbot UI and MCP integration
├── chat.css                # Chatbot styling
├── style.css               # Map styling
├── config.json             # LLM configuration
├── wetland-colormap.json   # GLWD wetland type colors
├── category_codes.csv      # Wetland type descriptions
└── system-prompt.md        # Chatbot system prompt
```

## Data Sources

All data is served from MinIO S3-compatible storage:

- **GLWD v2.0**: Global Lakes and Wetlands Database
- **NCP**: Nature's Contributions to People (biodiversity importance)
- **Carbon**: Irrecoverable Carbon (Conservation International 2018)
- **Ramsar**: Ramsar Sites Information Service
- **WDPA**: World Database on Protected Areas
- **HydroBASINS**: Level 6 watershed boundaries

Data is stored as:
- **COG** (Cloud-Optimized GeoTIFF) for raster layers
- **PMTiles** for vector polygon layers
- **GeoParquet** for tabular data accessed via MCP/DuckDB

## Supported LLM Providers

Any OpenAI-compatible API:
- **OpenAI**: `https://api.openai.com/v1/chat/completions`
- **Local models** (e.g., Ollama with litellm): `http://localhost:4000/v1/chat/completions`


## Development

### Debugging

Open browser console to see:
- Layer loading events
- Layer visibility changes
- MCP communication

## License

See main project README for licensing information.
