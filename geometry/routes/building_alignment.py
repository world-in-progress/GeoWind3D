"""Building patch alignment route."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.building_alignment.pipeline import run_building_alignment
from schemas.building_alignment import BuildingAlignmentRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/buildings", tags=["buildings"])


@router.post("/align_patches")
async def run_building_alignment_endpoint(request: BuildingAlignmentRequest):
    try:
        logger.info(
            "[building-alignment] request received: patches=%d, patchFiles=%d",
            len(request.patches),
            len(request.patchInputPaths),
        )
        result = await asyncio.to_thread(run_building_alignment, request)
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("message", "building alignment failed"))
        logger.info(
            "[building-alignment] request completed: patches=%d, sectionSegments=%d",
            result.get("patchCount", 0),
            result.get("sectionSegmentCount", 0),
        )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("building alignment failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"building alignment failed: {exc}")
