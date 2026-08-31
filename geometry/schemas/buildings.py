"""Building extrusion request/response models."""

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class CompoundBuildingMember(BaseModel):
    full_id: str
    osm_type: str
    level: int
    geometry: Dict[str, Any]
    height: float
    height_source: str | None = None


class BuildingBasePlane(BaseModel):
    a: float
    b: float
    c: float
    source: str | None = None


class CompoundBuildingPatch(BaseModel):
    mode: str = "compound"
    patch_id: str
    base_geometry: Dict[str, Any]
    base_heights: List[List[List[float]]] | None = None
    base_plane: BuildingBasePlane | None = None
    members: List[CompoundBuildingMember] = Field(default_factory=list)


class BuildingModelRequest(BaseModel):
    output_path: str
    compound_patches: List[CompoundBuildingPatch] = Field(default_factory=list)
    offset_2326: List[float]


class BuildingExtrudeResponse(BaseModel):
    success: bool
    message: str
    output_path: str | None = None
    watertight: bool = False
    non_manifold_edges: int = 0
    components: int = 0
    origin_lonlat: List[float] | None = None
    offset_2326: List[float] | None = None
