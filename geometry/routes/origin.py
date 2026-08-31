"""Projection-origin routes."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.origin import compute_origin
from schemas.origin import ComputeOriginRequest, ComputeOriginResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["origin"])


@router.post("/compute_origin", response_model=ComputeOriginResponse)
async def compute_origin_endpoint(request: ComputeOriginRequest):
    try:
        result = await asyncio.to_thread(compute_origin, request)
        if not result.success:
            raise HTTPException(status_code=400, detail="Failed to compute origin from patches")
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"compute_origin failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"compute_origin failed: {exc}")
