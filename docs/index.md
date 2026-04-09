---
layout: home

hero:
  name: Geo-Agent
  text: Map + AI Data Analyst
  tagline: Build interactive map applications with LLM-powered data analysis — no JavaScript required.
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quickstart
    - theme: alt
      text: Live Demo
      link: https://padus.nrp-nautilus.io/
    - theme: alt
      text: Template Repo
      link: https://github.com/boettiger-lab/geo-agent-template

features:
  - title: Zero JavaScript
    details: Your app is just three files — index.html, layers-input.json, and system-prompt.md. The core library loads from CDN.
  - title: STAC + SQL analytics
    details: Point at a STAC catalog; the agent queries H3-indexed Parquet via DuckDB/MCP and controls the map in response.
  - title: Flexible deployment
    details: GitHub Pages with user-supplied API keys, Hugging Face Spaces with a secret config, or Kubernetes with server-injected credentials.
---
