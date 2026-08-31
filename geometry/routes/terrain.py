"""Terrain modeling routes."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.terrain import build_terrain
from schemas.terrain import TerrainBuildRequest, TerrainBuildResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/terrain", tags=["terrain"])


@router.post("/build", response_model=TerrainBuildResponse)
async def terrain_build(request: TerrainBuildRequest):
    try:
        result = await asyncio.to_thread(build_terrain, request)
        if not result.success:
            raise HTTPException(status_code=400, detail=result.message)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"terrain build failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"terrain build failed: {exc}")
