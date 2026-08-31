"""Building roof refinement request/response models."""

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class PatchRoofExtractionRequest(BaseModel):
    input_dir: str | None = None
    index_path: str | None = None
    output_dir: str | None = None
    offset_2326: List[float] | None = None
    grid_size_m: float = Field(default=0.5, gt=0)
    top_epsilon_m: float = Field(default=0.35, ge=0)
    max_grid_cells: int = Field(default=500000, gt=0)
    min_clipped_triangle_area_m2: float = Field(default=0.02, gt=0)
    min_abs_normal_z: float = Field(default=0.25, ge=0, le=1)
    terrain_clearance_m: float = Field(default=2.0, ge=0)
    eps_z_m: float = Field(default=0.3, gt=0)
    min_cluster_triangle_count: int = Field(default=2, gt=0)
    min_cluster_area_m2: float = Field(default=1.0, gt=0)
    cluster_shape_close_m: float = Field(default=0.4, ge=0)
    cluster_shape_open_m: float = Field(default=0.15, ge=0)
    cluster_simplify_m: float = Field(default=0.2, ge=0)
    min_cluster_component_area_m2: float = Field(default=1.0, ge=0)
    min_cluster_hole_area_m2: float = Field(default=1.0, ge=0)
    enhanced_terrain_clearance_m: float = Field(default=6.0, ge=0)
    enhanced_terrain_clearance_span_m: float = Field(default=8.0, ge=0)


class PatchRoofExtractionItem(BaseModel):
    patch_id: str
    patch_index: int | None = None
    input_path: str
    output_path: str
    candidate_triangle_count: int = 0
    top_triangle_count: int = 0
    grid_cell_count: int = 0
    valid_grid_cell_count: int = 0
    tree_range_count: int = 0


class UnresolvedRoofRangeItem(BaseModel):
    patch_id: str
    patch_index: int | None = None
    full_id: str | None = None
    reason: str | None = None


class MainClusterSamplingRangeItem(BaseModel):
    patch_id: str
    patch_index: int | None = None
    full_id: str | None = None
    osm_type: str | None = None
    tree_level: int | None = None
    geometry: Dict[str, Any] | None = None
    tree_range_area: float = 0.0
    main_cluster_area: float = 0.0
    main_cluster_area_ratio: float = 0.0


class PatchRoofExtractionResponse(BaseModel):
    success: bool
    message: str
    output_dir: str | None = None
    offset_2326: List[float] | None = None
    origin_lonlat: List[float] | None = None
    roof_plane_cluster_output_path: str | None = None
    roof_cluster_mesh_output_paths: List[str] = Field(default_factory=list)
    roof_plane_tree_range_count: int = 0
    roof_z_by_full_id: Dict[str, float] = Field(default_factory=dict)
    unresolved_tree_ranges: List[UnresolvedRoofRangeItem] = Field(default_factory=list)
    main_cluster_sampling_ranges: List[MainClusterSamplingRangeItem] = Field(default_factory=list)
    patches: List[PatchRoofExtractionItem] = Field(default_factory=list)
