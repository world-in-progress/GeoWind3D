"""Corridor routes: graph construction, planar modeling, and 3D top-surface modeling."""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from core.corridor.graph import build_corridor_footprints, build_corridor_graph
from core.corridor.surface import build_corridor_surface
from schemas.corridor import (
    BuildFootprintsRequest,
    BuildFootprintsResponse,
    BuildGraphRequest,
    BuildGraphResponse,
    BuildSurfaceRequest,
    BuildSurfaceResponse,
    ProjectPointsToWgs84Request,
    ProjectPointsToWgs84Response,
)
from utils.geo import to_lonlat

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/corridor", tags=["corridor"])


@router.post("/build_graph", response_model=BuildGraphResponse)
async def corridor_build_graph(request: BuildGraphRequest):
    """Build the corridor graph through endpoint snapping, intersection detection, selective splitting, and NetworkX export to GeoJSON."""
    try:
        geojson, edges_for_width, edges_z, nodes_z, stats = await asyncio.to_thread(
            build_corridor_graph,
            request.features,
            request.snap_tolerance,
            request.crossing_z_threshold,
            request.height_floor,
            request.height_cover,
            request.height_interior,
            request.suspicious_slope_threshold_deg,
        )
        return BuildGraphResponse(
            success=True,
            message="ok",
            geojson=geojson,
            edges_for_width=edges_for_width,
            edges_z=edges_z,
            nodes_z=nodes_z,
            component_count=stats["component_count"],
            node_count=stats["node_count"],
            edge_count=stats["edge_count"],
        )
    except Exception as exc:
        logger.error(f"corridor build_graph failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"corridor build_graph failed: {exc}")


@router.post("/build_footprints", response_model=BuildFootprintsResponse)
async def corridor_build_footprints_endpoint(request: BuildFootprintsRequest):
    """Build planar corridor strips per edge, union them by connected component, and export GeoJSON."""
    try:
        edges_data = [e.model_dump() for e in request.edges]
        footprints_geojson, strips_geojson = await asyncio.to_thread(
            build_corridor_footprints, edges_data
        )
        return BuildFootprintsResponse(
            success=True,
            message="ok",
            footprints_geojson=footprints_geojson,
            strips_geojson=strips_geojson,
        )
    except Exception as exc:
        logger.error(f"corridor build_footprints failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"corridor build_footprints failed: {exc}")


@router.post("/project_points_to_wgs84", response_model=ProjectPointsToWgs84Response)
async def corridor_project_points_to_wgs84(request: ProjectPointsToWgs84Request):
    """Batch convert EPSG:2326 points to WGS84 using the shared geometry transformer."""
    try:
        projected = []
        for point in request.points:
            if len(point) < 2:
                raise ValueError("Each point must contain x and y coordinates.")
            x = float(point[0])
            y = float(point[1])
            lon, lat = to_lonlat.transform(x, y)
            projected.append([float(lon), float(lat)])
        return ProjectPointsToWgs84Response(success=True, message="ok", points=projected)
    except Exception as exc:
        logger.error(f"corridor point projection failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"corridor point projection failed: {exc}")


@router.post("/build_surface", response_model=BuildSurfaceResponse)
async def corridor_build_surface(request: BuildSurfaceRequest):
    """Build the 3D corridor top surface through CDT, Z interpolation, and OBJ export."""
    try:
        result = await asyncio.to_thread(build_corridor_surface, request)
        if not result.success:
            raise HTTPException(status_code=400, detail=result.message)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"corridor build_surface failed: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"corridor build_surface failed: {exc}")
