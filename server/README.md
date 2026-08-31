# GeoWind3D server

The Node.js backend orchestrates data preprocessing, city-model generation, and OpenFOAM case preparation. CORS is enabled for local prototype use.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

The server listens on the port configured by `PORT` (5000 by default).

## Core endpoints

- `GET /`: service information
- `GET /health`: health check
- `POST /model/generate`: city-model generation workflow
- `GET /osm/mvt/:z/:x/:y`: OSM vector tiles

## CORS

The prototype accepts requests from all origins. Adjust the CORS configuration in `server.ts` before deploying it in a restricted environment.
