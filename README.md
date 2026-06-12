---
title: Aether Urban
emoji: 🏙️
colorFrom: indigo
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Aether Urban

Aether is an expert geospatial analysis AI agent for urban planning in Colombo, Sri Lanka.

## Features
- **Spatial Queries & Filtering**: Filter and inspect building conditions, local authority zones, road networks, and land use classes.
- **Proximity & Access Analysis**: Calculate walking service coverage (isochrones) and walking routes across Colombo.
- **Zoning Compliance**: Perform checks on proposed urban designs against local zoning regulations.
- **Interactive Map**: View spatial query results instantly on an interactive, map-based dashboard.

## Tech Stack
- **Backend**: FastAPI, Python, Uvicorn
- **Spatial Libraries**: GeoPandas, Shapely, NetworkX, OSMnx, PyArrow, PyOgrio
- **Frontend**: Vanilla HTML, CSS, JavaScript (Leaflet for map rendering)
- **AI Agent**: Google Gemini API
