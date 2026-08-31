"""Building-modeling routes."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.buildings import model_buildings
from schemas.buildings import BuildingExtrudeResponse, BuildingModelRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/buildings", tags=["buildings"])


@router.post("/extrude_model", response_model=BuildingExtrudeResponse)
async def extrude_building_model(request: BuildingModelRequest):
    try:
        # Run CPU-intensive modeling in a thread pool to avoid blocking the event loop.
        result = await asyncio.to_thread(model_buildings, request)
        if not result.success:
            raise HTTPException(status_code=400, detail=result.message)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"building modeling failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"building modeling failed: {exc}")
