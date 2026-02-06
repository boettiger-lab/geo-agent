# California Protected Lands

A map-based application for exploring California's protected lands using the California Protected Areas Database (CPAD).

## Overview

This application visualizes protected areas in California, allowing users to explore different agencies, access types, and designations. It uses a modern, data-driven architecture to render map layers and provide analytical tools.

## Data Sources

- **CPAD (California Protected Areas Database)**: The authoritative source for protected areas data in California.
  - **Source**: [CAL FIRE / GreenInfo Network](https://www.calands.org/)
  - **Layers**: Protected Areas (Units) and Holdings.
  - **Hosted at**: `s3-west.nrp-nautilus.io`

## Architecture

The application consists of two main parts:

1.  **Frontend Map**: A MapLibre GL JS visualization that renders PMTiles directly from S3.
2.  **Data Backend**: A DuckDB-powered backend (via MCP) that queries Parquet datasets indexed with H3 for fast analysis.

## Development

### Prerequisites

- Python 3.11+
- Node.js (for tooling, optional)

### Running Locally

```bash
# Serve the app directory
python -m http.server 8000 --directory app
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## Configuration

Layer configuration is managed in `app/layers-config.json`. To add or modify layers, edit this file. The application automatically generates map layers and chat tools based on this configuration.
