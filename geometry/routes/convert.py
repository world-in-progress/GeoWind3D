"""Format-conversion routes for B3DM/glTF to OBJ."""

import asyncio
import logging
from pathlib import Path
from typing import List

import trimesh
from fastapi import APIRouter, HTTPException

from schemas.common import (
    BatchConvertRequest,
    BatchConvertResponse,
    ConvertRequest,
    ConvertResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["convert"])


@router.post("/convert", response_model=ConvertResponse)
async def convert_gltf_to_obj(request: ConvertRequest):
    try:
        input_path = Path(request.input_path)
        output_path = Path(request.output_path)
        if not input_path.exists():
            raise HTTPException(status_code=404, detail=f"Input file not found: {input_path}")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        mesh = trimesh.load(input_path)
        mesh.export(output_path)

        return ConvertResponse(success=True, message="ok", output_path=str(output_path))
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"convert failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"convert failed: {exc}")


def _batch_convert_sync(request: BatchConvertRequest) -> BatchConvertResponse:
    """Run batch conversion in a thread pool to avoid blocking the event loop."""
    output_paths: List[str] = []
    failed_items: List[dict] = []

    total = len(request.items)
    logger.info(f"Batch convert start: total={total}")
    for idx, item in enumerate(request.items, start=1):
        try:
            input_path = Path(item.input_path)
            output_path = Path(item.output_path)
            logger.info(f"[{idx}/{total}] converting {input_path.name}")

            if not input_path.exists():
                failed_items.append(
                    {
                        "input_path": str(input_path),
                        "output_path": str(output_path),
                        "error": f"Input file not found: {input_path}",
                    }
                )
                continue

            output_path.parent.mkdir(parents=True, exist_ok=True)
            mesh = trimesh.load(input_path)
            mesh.export(output_path)
            output_paths.append(str(output_path))
        except Exception as exc:
            failed_items.append(
                {
                    "input_path": item.input_path,
                    "output_path": item.output_path,
                    "error": f"convert failed: {exc}",
                }
            )

    success = len(failed_items) == 0
    msg = f"batch done: success={len(output_paths)}, failed={len(failed_items)}"
    return BatchConvertResponse(
        success=success,
        message=msg,
        output_paths=output_paths,
        failed_items=failed_items,
    )


@router.post("/convert/batch", response_model=BatchConvertResponse)
async def batch_convert_gltf_to_obj(request: BatchConvertRequest):
    return await asyncio.to_thread(_batch_convert_sync, request)
