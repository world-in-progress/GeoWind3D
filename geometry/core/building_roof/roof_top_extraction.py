"""Extract top-visible roof mesh from patch-level roof candidate triangles."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import numpy as np
import trimesh
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from utils.geo import extract_polygonal_geometry, to_local_projected, to_local_projected_geometry

XY_AREA_EPS = 1e-9
BARY_EPS = 1e-8


@dataclass(frozen=True)
class ProjectedRoofTriangle:
    vertices: np.ndarray
    xy_polygon: Polygon
    source: Dict[str, Any]


@dataclass(frozen=True)
class RoofTopExtractionResult:
    top_triangles: List[ProjectedRoofTriangle]
    candidate_triangle_count: int
    projected_triangle_count: int
    grid_cell_count: int
    valid_grid_cell_count: int


def project_patch_geometry(
    raw_geometry: Dict[str, Any],
    offset_2326: Sequence[float],
) -> Polygon | MultiPolygon | None:
    geom = shape(raw_geometry)
    if geom.is_empty:
        return None
    if not geom.is_valid:
        geom = geom.buffer(0)
        if geom.is_empty:
            return None

    polygonal = extract_polygonal_geometry(geom)
    if polygonal is None:
        return None

    unified = unary_union(polygonal)
    unified_polygonal = extract_polygonal_geometry(unified)
    if unified_polygonal is None or unified_polygonal.is_empty:
        return None

    projected = to_local_projected_geometry(unified_polygonal)
    if not projected.is_valid:
        projected = projected.buffer(0)

    projected_polygonal = extract_polygonal_geometry(projected)
    if projected_polygonal is None or projected_polygonal.is_empty:
        return None

    return translate(projected_polygonal, xoff=-float(offset_2326[0]), yoff=-float(offset_2326[1]))


def project_mesh_triangles(
    raw_triangles: Iterable[Dict[str, Any]],
    offset_2326: Sequence[float],
) -> List[ProjectedRoofTriangle]:
    projected: List[ProjectedRoofTriangle] = []
    offset_x, offset_y = float(offset_2326[0]), float(offset_2326[1])

    for raw in raw_triangles:
        geo = raw.get("geo") or []
        if len(geo) != 3:
            continue

        vertices: List[List[float]] = []
        valid = True
        for vertex in geo:
            if len(vertex) < 3:
                valid = False
                break
            lon, lat, z = float(vertex[0]), float(vertex[1]), float(vertex[2])
            x, y = to_local_projected.transform(lon, lat)
            xyz = [float(x) - offset_x, float(y) - offset_y, z]
            if not all(math.isfinite(value) for value in xyz):
                valid = False
                break
            vertices.append(xyz)

        if not valid:
            continue

        vertices_arr = np.asarray(vertices, dtype=np.float64)
        if abs(_triangle_area2_xy(vertices_arr)) <= XY_AREA_EPS:
            continue

        xy_polygon = Polygon(vertices_arr[:, :2])
        if xy_polygon.is_empty or xy_polygon.area <= XY_AREA_EPS:
            continue
        if not xy_polygon.is_valid:
            fixed = xy_polygon.buffer(0)
            if fixed.is_empty:
                continue
            if isinstance(fixed, MultiPolygon):
                fixed = max(fixed.geoms, key=lambda item: item.area)
            if not isinstance(fixed, Polygon) or fixed.area <= XY_AREA_EPS:
                continue
            xy_polygon = fixed

        projected.append(ProjectedRoofTriangle(vertices=vertices_arr, xy_polygon=xy_polygon, source=raw))

    return projected


def extract_top_visible_roof_triangles(
    raw_triangles: Sequence[Dict[str, Any]],
    buffered_geometry: Dict[str, Any],
    offset_2326: Sequence[float],
    grid_size_m: float = 0.5,
    top_epsilon_m: float = 0.35,
    max_grid_cells: int = 500000,
) -> RoofTopExtractionResult:
    if grid_size_m <= 0:
        raise ValueError("grid_size_m must be greater than 0")
    if top_epsilon_m < 0:
        raise ValueError("top_epsilon_m must be greater than or equal to 0")
    if max_grid_cells <= 0:
        raise ValueError("max_grid_cells must be greater than 0")

    projected_area = project_patch_geometry(buffered_geometry, offset_2326)
    projected_triangles = project_mesh_triangles(raw_triangles, offset_2326)
    if projected_area is None or not projected_triangles:
        return RoofTopExtractionResult(
            top_triangles=[],
            candidate_triangle_count=len(raw_triangles),
            projected_triangle_count=len(projected_triangles),
            grid_cell_count=0,
            valid_grid_cell_count=0,
        )

    min_x, min_y, max_x, max_y = projected_area.bounds
    col_count = max(0, int(math.ceil((max_x - min_x) / grid_size_m)))
    row_count = max(0, int(math.ceil((max_y - min_y) / grid_size_m)))
    grid_cell_count = row_count * col_count
    if grid_cell_count > max_grid_cells:
        raise ValueError(
            f"patch grid cell count {grid_cell_count} exceeds max_grid_cells={max_grid_cells}; "
            "reduce input extent or explicitly choose a larger grid_size_m"
        )

    triangle_polygons = [tri.xy_polygon for tri in projected_triangles]
    tree = STRtree(triangle_polygons)
    prepared_area = prep(projected_area)
    selected_indices: set[int] = set()
    valid_grid_cell_count = 0

    for row in range(row_count):
        y = min_y + (row + 0.5) * grid_size_m
        for col in range(col_count):
            x = min_x + (col + 0.5) * grid_size_m
            point = Point(x, y)
            if not prepared_area.intersects(point):
                continue

            hits = _triangle_heights_at_point(projected_triangles, tree, point, x, y)
            if not hits:
                continue

            valid_grid_cell_count += 1
            top_z = max(z for _, z in hits)
            for tri_index, z in hits:
                if z >= top_z - top_epsilon_m:
                    selected_indices.add(tri_index)

    # Small top faces may not contain a grid center; centroid sampling prevents silent loss.
    for tri_index, tri in enumerate(projected_triangles):
        if tri_index in selected_indices:
            continue
        centroid = tri.xy_polygon.centroid
        if not prepared_area.intersects(centroid):
            continue
        z = _triangle_z_at_xy(tri.vertices, float(centroid.x), float(centroid.y))
        if z is None:
            continue
        hits = _triangle_heights_at_point(projected_triangles, tree, centroid, float(centroid.x), float(centroid.y))
        if not hits:
            continue
        if z >= max(hit_z for _, hit_z in hits) - top_epsilon_m:
            selected_indices.add(tri_index)

    top_triangles = [projected_triangles[index] for index in sorted(selected_indices)]
    return RoofTopExtractionResult(
        top_triangles=top_triangles,
        candidate_triangle_count=len(raw_triangles),
        projected_triangle_count=len(projected_triangles),
        grid_cell_count=grid_cell_count,
        valid_grid_cell_count=valid_grid_cell_count,
    )


def write_roof_triangles_obj(output_path: str | Path, triangles: Sequence[ProjectedRoofTriangle]) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if not triangles:
        output.write_text("# CityWind roof top mesh\n# triangle_count 0\n", encoding="utf-8")
        return

    vertices: List[List[float]] = []
    faces: List[List[int]] = []
    index_by_key: Dict[Tuple[float, float, float], int] = {}

    for tri in triangles:
        face: List[int] = []
        for vertex in tri.vertices:
            key = (round(float(vertex[0]), 6), round(float(vertex[1]), 6), round(float(vertex[2]), 6))
            index = index_by_key.get(key)
            if index is None:
                index = len(vertices)
                index_by_key[key] = index
                vertices.append([float(vertex[0]), float(vertex[1]), float(vertex[2])])
            face.append(index)
        if len(set(face)) == 3:
            faces.append(face)

    if not faces:
        output.write_text("# CityWind roof top mesh\n# triangle_count 0\n", encoding="utf-8")
        return

    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    mesh.export(str(output))


def _triangle_area2_xy(vertices: np.ndarray) -> float:
    return float(
        (vertices[1, 0] - vertices[0, 0]) * (vertices[2, 1] - vertices[0, 1])
        - (vertices[1, 1] - vertices[0, 1]) * (vertices[2, 0] - vertices[0, 0])
    )


def _triangle_z_at_xy(vertices: np.ndarray, x: float, y: float) -> float | None:
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


def _query_tree_indices(tree: STRtree, geometry) -> List[int]:
    matches = tree.query(geometry, predicate="intersects")
    return [int(index) for index in matches]


def _triangle_heights_at_point(
    triangles: Sequence[ProjectedRoofTriangle],
    tree: STRtree,
    point: Point,
    x: float,
    y: float,
) -> List[Tuple[int, float]]:
    hits: List[Tuple[int, float]] = []
    for tri_index in _query_tree_indices(tree, point):
        z = _triangle_z_at_xy(triangles[tri_index].vertices, x, y)
        if z is not None and math.isfinite(z):
            hits.append((tri_index, z))
    return hits
