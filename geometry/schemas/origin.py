"""Pydantic models for projection-origin calculation."""

from typing import Any, Dict, List

from pydantic import BaseModel


class ComputeOriginRequest(BaseModel):
    patches: List[Dict[str, Any]]  # GeoJSON geometries


class ComputeOriginResponse(BaseModel):
    success: bool
    offset_2326: List[float]
    origin_lonlat: List[float]
