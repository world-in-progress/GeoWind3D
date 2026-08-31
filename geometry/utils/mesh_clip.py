"""2D footprint clipping for roof triangle meshes."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, List, Sequence

import mapbox_earcut as earcut
import numpy as np
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

BARY_EPS = 1e-8
AREA_EPS = 1e-9


@dataclass(frozen=True)
class ClippedMeshTriangle:
    vertices: np.ndarray
    footprint: Polygon
    area: float


def clip_triangle_to_polygonal_geometry(
    vertices: np.ndarray,
    clip_geometry: Polygon | MultiPolygon,
    min_area_m2: float = 0.02,
) -> List[ClippedMeshTriangle]:
    """Clip one 3D triangle by a 2D polygonal geometry and retriangulate the clipped area."""
    if vertices.shape != (3, 3):
        return []

    triangle_xy = Polygon(vertices[:, :2])
    if triangle_xy.is_empty or triangle_xy.area <= max(min_area_m2, AREA_EPS):
        return []
    if not triangle_xy.is_valid:
        triangle_xy = triangle_xy.buffer(0)
        if triangle_xy.is_empty:
            return []
        if isinstance(triangle_xy, MultiPolygon):
            triangle_xy = max(triangle_xy.geoms, key=lambda item: item.area)
        if not isinstance(triangle_xy, Polygon) or triangle_xy.area <= max(min_area_m2, AREA_EPS):
            return []

    try:
        clipped = triangle_xy.intersection(clip_geometry)
    except Exception:
        clipped = triangle_xy.buffer(0).intersection(clip_geometry.buffer(0))

    clipped_triangles: List[ClippedMeshTriangle] = []
    for polygon in iter_polygonal_parts(clipped):
        clipped_triangles.extend(_triangulate_clipped_polygon(vertices, polygon, min_area_m2))
    return clipped_triangles


def iter_polygonal_parts(geometry) -> Iterable[Polygon]:
    if geometry is None or geometry.is_empty:
        return
    if isinstance(geometry, Polygon):
        if geometry.area > AREA_EPS:
            yield geometry
        return
    if isinstance(geometry, MultiPolygon):
        for part in geometry.geoms:
            if part.area > AREA_EPS:
                yield part
        return
    if isinstance(geometry, GeometryCollection):
        for child in geometry.geoms:
            yield from iter_polygonal_parts(child)


def _triangulate_clipped_polygon(
    source_vertices: np.ndarray,
    polygon: Polygon,
    min_area_m2: float,
) -> List[ClippedMeshTriangle]:
    if polygon.is_empty or polygon.area <= max(min_area_m2, AREA_EPS):
        return []
    if not polygon.is_valid:
        polygon = polygon.buffer(0)
        if polygon.is_empty:
            return []

    rings = _polygon_rings_without_closure(polygon)
    if not rings:
        return []

    coords_2d = np.vstack([np.asarray(ring, dtype=np.float64) for ring in rings])
    ring_ends = np.cumsum([len(ring) for ring in rings])
    if len(coords_2d) < 3:
        return []

    try:
        face_indices = earcut.triangulate_float64(coords_2d, ring_ends)
    except Exception:
        return []

    output: List[ClippedMeshTriangle] = []
    for i in range(0, len(face_indices), 3):
        xy = coords_2d[
            [
                int(face_indices[i]),
                int(face_indices[i + 1]),
                int(face_indices[i + 2]),
            ]
        ]
        footprint = Polygon(xy)
        if footprint.is_empty or footprint.area <= max(min_area_m2, AREA_EPS):
            continue

        vertices_3d = []
        valid = True
        for x, y in xy:
            z = interpolate_triangle_z(source_vertices, float(x), float(y))
            if z is None or not math.isfinite(z):
                valid = False
                break
            vertices_3d.append([float(x), float(y), z])
        if not valid:
            continue

        output.append(ClippedMeshTriangle(
            vertices=np.asarray(vertices_3d, dtype=np.float64),
            footprint=footprint,
            area=float(footprint.area),
        ))
    return output


def interpolate_triangle_z(vertices: np.ndarray, x: float, y: float) -> float | None:
    x0, y0, z0 = vertices[0]
    x1, y1, z1 = vertices[1]
    x2, y2, z2 = vertices[2]
    denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if abs(float(denom)) <= BARY_EPS:
        return None

    l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denom
    l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denom
    l2 = 1.0 - l0 - l1
    if l0 < -BARY_EPS or l1 < -BARY_EPS or l2 < -BARY_EPS:
        return None
    return float(l0 * z0 + l1 * z1 + l2 * z2)


def _polygon_rings_without_closure(polygon: Polygon) -> List[List[Sequence[float]]]:
    rings: List[List[Sequence[float]]] = []
    exterior = list(polygon.exterior.coords)[:-1]
    if len(exterior) < 3:
        return []
    rings.append(exterior)
    for interior in polygon.interiors:
        hole = list(interior.coords)[:-1]
        if len(hole) >= 3:
            rings.append(hole)
    return rings
