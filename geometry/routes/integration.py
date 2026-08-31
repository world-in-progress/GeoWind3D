"""Model-topology integration routes."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.integration import structure_union
from schemas.integration import StructureUnionRequest, StructureUnionResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integration", tags=["integration"])


@router.post("/structure", response_model=StructureUnionResponse)
async def structure_endpoint(request: StructureUnionRequest):
    """Merge building and corridor models into structure.obj through Boolean union."""
    try:
        # Run the CPU-intensive Boolean union in a thread pool to avoid blocking the event loop.
        result = await asyncio.to_thread(structure_union, request)
        if not result.success:
            raise HTTPException(status_code=400, detail=result.message)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"structure union failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"structure union failed: {exc}")
