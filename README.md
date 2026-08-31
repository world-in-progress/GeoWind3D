# GeoWind3D

GeoWind3D is a web application for constructing high-fidelity CFD-ready 3D city models from 3D image data and OpenStreetMap (OSM) data. Users can define an area of interest and generate integrated models of buildings, terrain and elevated walkways, together with an OpenFOAM case for wind simulation.

## Repository structure

- `app/`: React and Vite frontend
- `server/`: Node.js and Express backend
- `geometry/`: Python geometry service
- `database/`: PostgreSQL/PostGIS schema and OSM source data

## Requirements

- Node.js and npm (Node.js 20 or later recommended)
- Python 3.10 or later and uv
- PostgreSQL with PostGIS
- A Mapbox access token
- The 3D image data distributed through Figshare

## Data setup

### 1. Download the 3D image data

The downloadable case data cover the Central District of Hong Kong and are available on 
[Figshare](https://figshare.com/s/a7be4e23c895eaa6182f). Download `central.zip` from the item and extract it. The extracted `central` directory must contain `tileset.json` and its associated tile files.

### 2. Create the database

Create an empty PostgreSQL database and import the supplied SQL file:

```bash
createdb -U postgres citywind
psql -U postgres -d citywind -f database/citywind.sql
```

The SQL file enables PostGIS and creates the `osm_building` and `osm_elevated_walkway` tables with the data required by the system.

## Configuration

Copy the example environment files:

```bash
cp server/.env.example server/.env
cp app/.env.example app/.env
```

On Windows PowerShell, use:

```powershell
Copy-Item server/.env.example server/.env
Copy-Item app/.env.example app/.env
```

Edit `server/.env` and set:

- `TILE_DATA_DIR` to the absolute path of the extracted `central` directory
- `TEMP_DIR` to an existing writable directory for generated files
- the PostgreSQL connection values for the imported database
- `GEOMETRY_SERVICE_URL` if the Python service is not running at `http://localhost:8000`

Edit `app/.env` and provide a valid `VITE_MAPBOX_TOKEN`. Change `VITE_BACKEND_URL` if the Node.js backend is not running at `http://localhost:5000`.

## Installation

Install the frontend dependencies:

```bash
cd app
npm ci
```

Install the backend dependencies:

```bash
cd server
npm ci
```

Install the Python dependencies:

```bash
cd geometry
uv sync
```

## Running the system

Start the Python geometry service:

```bash
cd geometry
uv run main.py
```

Start the Node.js backend in a second terminal:

```bash
cd server
npm run dev
```

Start the frontend in a third terminal:

```bash
cd app
npm run dev
```

Open `http://localhost:5173` in a web browser.

## Data availability

The OSM data required by the system are included in `database/citywind.sql`. The 3D image data are provided as `central.zip` in the linked Figshare item.
