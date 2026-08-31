"""Pydantic models for model-topology integration."""

from pydantic import BaseModel


class StructureUnionRequest(BaseModel):
    """Load building and corridor OBJs and merge them into structure.obj by Boolean union."""
    # Required building OBJ; each component should be independently watertight.
    building_path: str
    # Optional corridor OBJ; when omitted, only buildings are processed.
    corridor_path: str | None = None
    # Output path for structure.obj.
    output_path: str


class StructureUnionResponse(BaseModel):
    success: bool
    message: str
    output_path: str | None = None
    # Input-component statistics.
    building_components: int = 0
    corridor_components: int = 0
    # Statistics for the merged output.
    vertex_count: int = 0
    triangle_count: int = 0
    watertight: bool = False
    non_manifold_edges: int = 0
