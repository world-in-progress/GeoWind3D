"""Building roof refinement routes."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.building_roof.pipeline import extract_patch_roofs
from schemas.building_roof import PatchRoofExtractionRequest, PatchRoofExtractionResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/buildings", tags=["buildings"])


@router.post("/extract_patch_roofs", response_model=PatchRoofExtractionResponse)
async def extract_patch_roofs_endpoint(request: PatchRoofExtractionRequest):
    try:
        result = await asyncio.to_thread(extract_patch_roofs, request)
        if not result.success:
            raise HTTPException(status_code=400, detail=result.message)
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning("patch roof extraction rejected: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("patch roof extraction failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"patch roof extraction failed: {exc}")
