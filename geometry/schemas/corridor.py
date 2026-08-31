"""Pydantic models for corridor modeling."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel

# Graph construction.

CORRIDOR_HEIGHT_FLOOR_DEFAULT = 0.5
CORRIDOR_HEIGHT_COVER_DEFAULT = 0.3
CORRIDOR_HEIGHT_INTERIOR_DEFAULT = 3.0


class ElevatedWayFeature(BaseModel):
    """A corridor line with sampled Z values; samples inside buildings are removed by the Node service."""

    id: int | str
    geometry: Dict[str, Any]  # GeoJSON LineString
    z_values: List[float]  # Z value for each geometry vertex.
    bridge: str = ""  # covered / viaduct / other
    osm_type: str = ""  # walkway / walkway_step


class BuildGraphRequest(BaseModel):
    """Request for graph construction."""

    features: List[ElevatedWayFeature]
    # Endpoint-snapping tolerance in projected metres.
    snap_tolerance: float = 0.5
    # Z-difference threshold for grade-separated crossings, in metres.
    crossing_z_threshold: float = 3.0
    # Component heights referenced to the common floor_bottom datum.
    height_floor: float = CORRIDOR_HEIGHT_FLOOR_DEFAULT
    height_cover: float = CORRIDOR_HEIGHT_COVER_DEFAULT
    height_interior: float = CORRIDOR_HEIGHT_INTERIOR_DEFAULT
    # Extreme-slope safeguard for non-step edges, in degrees.
    suspicious_slope_threshold_deg: float = 45.0


class BuildGraphResponse(BaseModel):
    """Graph response; planar footprints are built later by /corridor/build_footprints after width sampling."""
    success: bool
    message: str
    geojson: Optional[Dict[str, Any]] = None
    # WGS84 coordinates, original Z values, and topological endpoints for per-edge width sampling.
    edges_for_width: Optional[List[Dict[str, Any]]] = None
    # Edge centerline Z data in EPSG:2326 for top-surface construction.
    edges_z: Optional[List[Dict[str, Any]]] = None
    # Node coordinates, Z, component, and degree in EPSG:2326 for node-platform generation.
    nodes_z: Optional[List[Dict[str, Any]]] = None
    component_count: int = 0
    node_count: int = 0
    edge_count: int = 0

# Planar modeling after width sampling.

class FootprintEdge(BaseModel):
    """A WGS84 edge with width attributes for planar modeling."""

    edge_index: int = 0
    coords_wgs84: List[List[float]]
    width_left: float = 2.5
    width_right: float = 2.5
    component: int = 0
    bridge: str = ""


class BuildFootprintsRequest(BaseModel):
    """Request for planar modeling."""

    edges: List[FootprintEdge]


class BuildFootprintsResponse(BaseModel):
    """Response from planar modeling."""

    success: bool
    message: str = ""
    footprints_geojson: Optional[Dict[str, Any]] = None
    strips_geojson: Optional[Dict[str, Any]] = None


class ProjectPointsToWgs84Request(BaseModel):
    """Batch coordinate conversion from EPSG:2326 to WGS84."""

    points: List[List[float]]


class ProjectPointsToWgs84Response(BaseModel):
    """Batch coordinate conversion response."""

    success: bool
    message: str = ""
    points: List[List[float]] = []

# 3D top-surface construction.

class EdgeZData(BaseModel):
    """Centerline coordinates and Z values for one edge in EPSG:2326."""

    edge_index: int = 0
    coords: List[List[float]]       # Projected [[x, y], ...] coordinates.
    z_values: List[float]           # One Z value per coordinate.
    component: int = 0              # Connected-component identifier.
    bridge: str = ""                # Corridor type: covered, viaduct, or another type.


class NodeZData(BaseModel):
    """Graph-node coordinates and Z value in EPSG:2326."""

    coord: List[float]
    z: float
    component: int = 0
    degree: int = 1


class BuildSurfaceRequest(BaseModel):
    """Request for watertight 3D corridor-model construction."""

    footprints_geojson: Dict[str, Any]
    edges_z: List[EdgeZData]
    nodes_z: List[NodeZData] = []
    output_path: str
    offset_2326: List[float] = [0.0, 0.0]
    height_floor: float = CORRIDOR_HEIGHT_FLOOR_DEFAULT
    height_cover: float = CORRIDOR_HEIGHT_COVER_DEFAULT
    height_interior: float = CORRIDOR_HEIGHT_INTERIOR_DEFAULT


class BuildSurfaceResponse(BaseModel):
    """Response from 3D corridor top-surface construction."""

    success: bool
    message: str = ""
    vertex_count: int = 0
    triangle_count: int = 0
    origin_lonlat: Optional[List[float]] = None
