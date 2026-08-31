"""FastAPI entry point that aggregates domain routes and delegates logic to core modules."""

import logging

from fastapi import FastAPI

from routes.building_alignment import router as building_alignment_router
from routes.building_roof import router as building_roof_router
from routes.buildings import router as buildings_router
from routes.convert import router as convert_router
from routes.corridor import router as corridor_router
from routes.origin import router as origin_router
from routes.integration import router as integration_router
from routes.terrain import router as terrain_router

logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")

app = FastAPI(title="Geometry Converter API", version="2.0.0")

# Register domain routes.
app.include_router(convert_router)
app.include_router(origin_router)
app.include_router(buildings_router)
app.include_router(building_alignment_router)
app.include_router(building_roof_router)
app.include_router(terrain_router)
app.include_router(corridor_router)
app.include_router(integration_router)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "geometry-converter"}
