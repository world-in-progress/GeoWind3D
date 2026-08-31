"""Terrain CDT request and response schemas."""

from typing import List

from pydantic import BaseModel


class TerrainPoint(BaseModel):
    lon: float
    lat: float
    z: float


class MeshBoundaryPoint(BaseModel):
    lon: float
    lat: float


class TerrainBuildRequest(BaseModel):
    output_path: str
    input_data_path: str
    offset_2326: List[float]


class BuildingBasePlane(BaseModel):
    a: float
    b: float
    c: float
    source: str


class TerrainBuildResponse(BaseModel):
    success: bool
    message: str
    output_path: str | None = None
    vertex_count: int = 0
    triangle_count: int = 0
    origin_lonlat: List[float] | None = None
    # [building][polygon][ring][vertex] = z
    building_base_heights: List[List[List[List[float]]]] | None = None
    building_base_planes: List[BuildingBasePlane] | None = None
