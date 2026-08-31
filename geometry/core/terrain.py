"""Terrain CDT generation with triangle.triangulate isolated in a subprocess."""

import json
import logging
import math
import pickle
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import trimesh
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Point, Polygon, shape
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from schemas.terrain import TerrainBuildRequest, TerrainBuildResponse
from utils.geo import (
    extract_polygonal_geometry,
    to_local_projected,
    to_local_projected_geometry,
    to_lonlat,
)

logger = logging.getLogger(__name__)
CORRIDOR_TERRAIN_CLEARANCE_M = 0.5
BUILDING_BASE_PLANE_RANSAC_ITERATIONS = 80
BUILDING_BASE_PLANE_RESIDUAL_M = 2.0
BUILDING_BASE_PLANE_MAX_SLOPE_DEG = 25.0
BUILDING_BASE_PLANE_MIN_SAMPLES = 3

# CDT worker script executed in a separate process so C-library global state cannot corrupt the server process.
_CDT_WORKER_SCRIPT = r'''
import sys, pickle, base64
import numpy as np
import triangle as tr

payload = sys.stdin.buffer.read()
pslg_data, opts = pickle.loads(payload)

# Restore NumPy arrays.
pslg = {}
for k, v in pslg_data.items():
    pslg[k] = np.array(v)

result = tr.triangulate(pslg, opts)

output = {
    "vertices": result["vertices"].tolist(),
    "triangles": result["triangles"].tolist(),
}
sys.stdout.buffer.write(pickle.dumps(output))
'''


def _run_cdt_in_subprocess(pslg: Dict[str, Any], opts: str) -> Dict[str, Any]:
    """
    Run triangle.triangulate in a fresh subprocess for every call. C-library
    global state cannot accumulate, a segmentation fault only terminates the
    worker, and serialized data is exchanged through stdin and stdout.
    """
    # Convert NumPy arrays to lists for serialization.
    pslg_data = {}
    for k, v in pslg.items():
        if hasattr(v, "tolist"):
            pslg_data[k] = v.tolist()
        else:
            pslg_data[k] = v

    payload = pickle.dumps((pslg_data, opts))

    result = subprocess.run(
        [sys.executable, "-c", _CDT_WORKER_SCRIPT],
        input=payload,
        capture_output=True,
        timeout=120,
    )

    if result.returncode != 0:
        stderr_text = result.stderr.decode(errors="replace").strip()
        # A negative return code means the worker was terminated by a signal, such as -11 for a segmentation fault.
        if result.returncode < 0:
            raise RuntimeError(
                f"CDT subprocess killed by signal {-result.returncode} (segfault?). stderr: {stderr_text}"
            )
        raise RuntimeError(f"CDT subprocess failed (rc={result.returncode}): {stderr_text}")

    return pickle.loads(result.stdout)


def _build_interpolators(
    xy: np.ndarray, z: np.ndarray
) -> Tuple[LinearNDInterpolator, NearestNDInterpolator]:
    """Build a linear interpolator with nearest-neighbor fallback."""
    linear = LinearNDInterpolator(xy, z)
    nearest = NearestNDInterpolator(xy, z)
    return linear, nearest


def _interpolate_z(
    linear: LinearNDInterpolator,
    nearest: NearestNDInterpolator,
    query_xy: np.ndarray,
) -> np.ndarray:
    """Prefer linear interpolation, use nearest neighbors for NaN values, and fall back to zero."""
    z_lin = linear(query_xy)
    z_near = nearest(query_xy)
    z_result = np.where(np.isnan(z_lin), z_near, z_lin)
    return np.nan_to_num(z_result, nan=0.0)


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _fit_plane_lstsq(xy: np.ndarray, z: np.ndarray) -> tuple[float, float, float] | None:
    if len(xy) < BUILDING_BASE_PLANE_MIN_SAMPLES:
        return None
    try:
        a_mat = np.column_stack([xy[:, 0], xy[:, 1], np.ones(len(xy), dtype=np.float64)])
        coeff, *_ = np.linalg.lstsq(a_mat, z, rcond=None)
    except np.linalg.LinAlgError:
        return None
    a, b, c = (float(coeff[0]), float(coeff[1]), float(coeff[2]))
    if not all(math.isfinite(v) for v in (a, b, c)):
        return None
    max_slope = math.tan(math.radians(BUILDING_BASE_PLANE_MAX_SLOPE_DEG))
    if math.hypot(a, b) > max_slope:
        return None
    return a, b, c


def _fit_patch_base_plane(
    xy: np.ndarray,
    z: np.ndarray,
    seed: int,
) -> tuple[float, float, float] | None:
    if len(xy) < BUILDING_BASE_PLANE_MIN_SAMPLES:
        return None

    best_plane: tuple[float, float, float] | None = None
    best_inliers: np.ndarray | None = None
    best_score: tuple[int, float] | None = None
    rng = np.random.default_rng(seed)
    sample_count = len(xy)

    for _ in range(BUILDING_BASE_PLANE_RANSAC_ITERATIONS):
        indices = rng.choice(sample_count, size=3, replace=False)
        plane = _fit_plane_lstsq(xy[indices], z[indices])
        if plane is None:
            continue

        a, b, c = plane
        residuals = np.abs(z - (a * xy[:, 0] + b * xy[:, 1] + c))
        inliers = residuals <= BUILDING_BASE_PLANE_RESIDUAL_M
        inlier_count = int(np.sum(inliers))
        if inlier_count < BUILDING_BASE_PLANE_MIN_SAMPLES:
            continue

        mean_residual = float(np.mean(residuals[inliers]))
        score = (inlier_count, -mean_residual)
        if best_score is None or score > best_score:
            best_score = score
            best_plane = plane
            best_inliers = inliers

    if best_plane is None or best_inliers is None:
        return None

    refined = _fit_plane_lstsq(xy[best_inliers], z[best_inliers])
    return refined if refined is not None else best_plane


def _median_fallback_plane(z: np.ndarray) -> tuple[float, float, float]:
    finite_z = [float(value) for value in z if math.isfinite(float(value))]
    if not finite_z:
        return 0.0, 0.0, 0.0
    return 0.0, 0.0, float(np.median(np.asarray(finite_z, dtype=np.float64)))


def _local_patch_geometry(
    patch_geojson: Dict[str, Any],
    offset_x: float,
    offset_y: float,
) -> Polygon | MultiPolygon | None:
    raw_geom = shape(patch_geojson)
    if raw_geom.is_empty:
        return None
    if not raw_geom.is_valid:
        raw_geom = raw_geom.buffer(0)

    polygonal = extract_polygonal_geometry(raw_geom)
    if polygonal is None:
        return None

    projected = to_local_projected_geometry(polygonal)
    local_geom = translate(projected, xoff=-offset_x, yoff=-offset_y)
    return extract_polygonal_geometry(local_geom)


def _samples_in_patch_buffer(
    patch_geom: Polygon | MultiPolygon,
    terrain_xy: np.ndarray,
    terrain_z: np.ndarray,
    buffer_m: float,
) -> tuple[np.ndarray, np.ndarray]:
    buffered = patch_geom.buffer(buffer_m)
    if buffered.is_empty:
        return np.empty((0, 2), dtype=np.float64), np.empty((0,), dtype=np.float64)

    min_x, min_y, max_x, max_y = buffered.bounds
    prepared = prep(buffered)
    selected_xy: list[list[float]] = []
    selected_z: list[float] = []
    for point_xy, point_z in zip(terrain_xy, terrain_z):
        x = float(point_xy[0])
        y = float(point_xy[1])
        z_value = float(point_z)
        if x < min_x or x > max_x or y < min_y or y > max_y:
            continue
        if not math.isfinite(z_value):
            continue
        if prepared.covers(Point(x, y)):
            selected_xy.append([x, y])
            selected_z.append(z_value)

    if not selected_xy:
        return np.empty((0, 2), dtype=np.float64), np.empty((0,), dtype=np.float64)
    return np.asarray(selected_xy, dtype=np.float64), np.asarray(selected_z, dtype=np.float64)


def _assign_building_patch_boundary_planes(
    full_z: np.ndarray,
    tri_verts: np.ndarray,
    patch_vertex_map: List[List[Tuple[int, int, int]]],
    raw_patches: List[Dict[str, Any]],
    terrain_xy: np.ndarray,
    terrain_z: np.ndarray,
    offset_x: float,
    offset_y: float,
    buffer_m: float,
) -> tuple[list[dict[str, float | str]], list[int]]:
    base_planes: list[dict[str, float | str]] = []
    median_fallback_patch_indices: list[int] = []
    for patch_idx, patch_rings in enumerate(patch_vertex_map):
        if patch_idx >= len(raw_patches):
            base_planes.append({"a": 0.0, "b": 0.0, "c": 0.0, "source": "median"})
            median_fallback_patch_indices.append(patch_idx)
            continue
        patch_geom = _local_patch_geometry(raw_patches[patch_idx], offset_x, offset_y)
        if patch_geom is None or patch_geom.is_empty:
            sample_xy = np.empty((0, 2), dtype=np.float64)
            sample_z = np.empty((0,), dtype=np.float64)
        else:
            sample_xy, sample_z = _samples_in_patch_buffer(patch_geom, terrain_xy, terrain_z, buffer_m)

        plane = _fit_patch_base_plane(sample_xy, sample_z, seed=20260806 + patch_idx)
        source = "ransac"
        if plane is None:
            plane = _median_fallback_plane(sample_z)
            source = "median"
            median_fallback_patch_indices.append(patch_idx)

        a, b, c = plane
        base_planes.append({"a": float(a), "b": float(b), "c": float(c), "source": source})
        for _ring_idx, start_idx, num_verts in patch_rings:
            if num_verts <= 0 or start_idx < 0 or start_idx + num_verts > len(full_z):
                continue
            ring_xy = tri_verts[start_idx:start_idx + num_verts]
            full_z[start_idx:start_idx + num_verts] = a * ring_xy[:, 0] + b * ring_xy[:, 1] + c
    return base_planes, median_fallback_patch_indices


def _base_ring_z_from_patch_vertices(
    patch_rings: List[Tuple[int, int, int]],
    ring_index: int,
    expected_count: int,
    full_z: np.ndarray,
) -> np.ndarray | None:
    if ring_index >= len(patch_rings):
        return None
    _stored_ring_index, start_idx, num_verts = patch_rings[ring_index]
    if num_verts != expected_count:
        return None
    if num_verts <= 0 or start_idx < 0 or start_idx + num_verts > len(full_z):
        return None
    return np.asarray(full_z[start_idx:start_idx + num_verts], dtype=np.float64)


def _triangle_area2_xy(tri_xy: np.ndarray) -> float:
    """Return twice the area of a 2D triangle for degeneracy detection."""
    return float(
        (tri_xy[1, 0] - tri_xy[0, 0]) * (tri_xy[2, 1] - tri_xy[0, 1])
        - (tri_xy[1, 1] - tri_xy[0, 1]) * (tri_xy[2, 0] - tri_xy[0, 0])
    )


def _build_corridor_bottom_index(
    raw_corridor_bottom_mesh: Dict[str, Any] | None,
) -> tuple[list[Polygon], STRtree | None, np.ndarray | None]:
    """
    Convert the corridor base mesh into a 2D query structure. Each triangle
    stores its XY projection and the minimum Z among its three vertices.
    """
    if not raw_corridor_bottom_mesh:
        return [], None, None

    raw_vertices = raw_corridor_bottom_mesh.get("vertices") or []
    raw_faces = raw_corridor_bottom_mesh.get("faces") or []
    if not raw_vertices or not raw_faces:
        return [], None, None

    vertices = np.array(raw_vertices, dtype=np.float64)
    polygons: list[Polygon] = []
    z_mins: list[float] = []

    for raw_face in raw_faces:
        if len(raw_face) != 3:
            continue
        face = np.array(raw_face, dtype=np.int32)
        if np.any(face < 0) or np.any(face >= len(vertices)):
            continue
        tri = vertices[face]
        tri_xy = tri[:, :2]
        if abs(_triangle_area2_xy(tri_xy)) < 1e-9:
            continue

        poly = Polygon(
            [
                (float(tri_xy[0, 0]), float(tri_xy[0, 1])),
                (float(tri_xy[1, 0]), float(tri_xy[1, 1])),
                (float(tri_xy[2, 0]), float(tri_xy[2, 1])),
            ]
        )
        if poly.is_empty or not poly.is_valid or poly.area <= 0:
            continue

        polygons.append(poly)
        z_mins.append(float(np.min(tri[:, 2])))

    if not polygons:
        return [], None, None

    return polygons, STRtree(polygons), np.array(z_mins, dtype=np.float64)


def _apply_corridor_clearance_to_terrain(
    tri_verts: np.ndarray,
    tri_faces: np.ndarray,
    full_z: np.ndarray,
    raw_corridor_bottom_mesh: Dict[str, Any] | None,
    clearance: float,
) -> np.ndarray:
    """
    Apply a conservative elevation ceiling to terrain faces intersecting the
    corridor base projection. Use the lowest matching corridor-face Z and lower
    all three vertices of the terrain face together.
    """
    corridor_polys, corridor_tree, corridor_z_mins = _build_corridor_bottom_index(raw_corridor_bottom_mesh)
    if corridor_tree is None or corridor_z_mins is None:
        logger.info("[terrain] corridor separation skipped: no corridor bottom faces")
        return full_z

    vertex_caps = np.full(len(full_z), np.inf, dtype=np.float64)
    affected_faces = 0

    for face in tri_faces:
        tri_xy = tri_verts[face]
        if abs(_triangle_area2_xy(tri_xy)) < 1e-9:
            continue

        terrain_poly = Polygon(
            [
                (float(tri_xy[0, 0]), float(tri_xy[0, 1])),
                (float(tri_xy[1, 0]), float(tri_xy[1, 1])),
                (float(tri_xy[2, 0]), float(tri_xy[2, 1])),
            ]
        )
        if terrain_poly.is_empty or not terrain_poly.is_valid or terrain_poly.area <= 0:
            continue

        candidate_indices = corridor_tree.query(terrain_poly, predicate="intersects")
        if len(candidate_indices) == 0:
            continue

        z_cap = float(np.min(corridor_z_mins[np.asarray(candidate_indices, dtype=np.int64)]) - clearance)
        vertex_caps[face] = np.minimum(vertex_caps[face], z_cap)
        affected_faces += 1

    affected_vertices = np.isfinite(vertex_caps)
    if np.any(affected_vertices):
        full_z[affected_vertices] = np.minimum(full_z[affected_vertices], vertex_caps[affected_vertices])

    logger.info(
        f"[terrain] corridor separation applied: "
        f"corridor_faces={len(corridor_polys)}, affected_faces={affected_faces}, "
        f"affected_vertices={int(np.sum(affected_vertices))}, clearance={clearance:.3f}m"
    )
    return full_z


def build_terrain(req: TerrainBuildRequest) -> TerrainBuildResponse:
    """
    Generate a terrain CDT by projecting to EPSG:2326, applying the shared
    building offset, constructing a PSLG with building patches as holes,
    triangulating in a subprocess, interpolating Steiner and patch-boundary
    elevations, deriving building-base elevations with the same interpolator,
    and exporting the result as OBJ.
    """
    output_path = Path(req.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    offset_x, offset_y = req.offset_2326

    # Read large payloads from files.
    logger.info(f"[terrain] loading data from {req.input_data_path}")
    with open(req.input_data_path, encoding="utf-8") as f:
        data = json.load(f)
    raw_points = data["terrain_points"]
    raw_patches = data["building_patches"]
    raw_transition_control_rings = data.get("transition_control_rings") or []
    raw_transition_boundary = data.get("transition_boundary")
    raw_domain_boundary = data.get("domain_boundary")
    raw_flat_anchor_points = data.get("flat_anchor_points") or []
    raw_boundary = data.get("mesh_boundary")
    z_flat = float(data.get("z_flat", 0.0))
    transition_buffer_distance = float(data.get("transition_buffer_distance", 0.0))
    building_base_plane_buffer_m = float(data.get("building_base_plane_buffer_m", 6.0))
    raw_building_geometries = data.get("building_geometries", [])
    raw_corridor_bottom_mesh = data.get("corridor_bottom_mesh")
    logger.info(
        f"[terrain] loaded: points={len(raw_points)}, patches={len(raw_patches)}, "
        f"transition_control_rings={len(raw_transition_control_rings)}, "
        f"transition_boundary={len(raw_transition_boundary or [])}, "
        f"domain_boundary={len(raw_domain_boundary or [])}, "
        f"flat_anchor_points={len(raw_flat_anchor_points)}, "
        f"legacy_boundary={len(raw_boundary or [])}, building_geometries={len(raw_building_geometries)}, "
        f"transition_buffer={transition_buffer_distance:.3f}, z_flat={z_flat:.3f}, "
        f"base_plane_buffer={building_base_plane_buffer_m:.3f}, "
        f"corridor_faces={len((raw_corridor_bottom_mesh or {}).get('faces', []))}"
    )

    # 1. Project terrain samples to local coordinates.
    terrain_xy = []
    terrain_z = []
    for pt in raw_points:
        x, y = to_local_projected.transform(pt["lon"], pt["lat"])
        terrain_xy.append([x - offset_x, y - offset_y])
        terrain_z.append(pt["z"])

    terrain_xy = np.array(terrain_xy, dtype=np.float64)
    terrain_z = np.array(terrain_z, dtype=np.float64)
    logger.info(f"[terrain] terrain points: {len(terrain_xy)}")

    terrain_linear_interp = None
    terrain_nearest_interp = None
    if len(terrain_xy) >= 3:
        terrain_linear_interp, terrain_nearest_interp = _build_interpolators(terrain_xy, terrain_z)

    # 2. Collect building-patch boundary vertices and constrained segments.
    all_vertices = list(terrain_xy)  # Begin with terrain samples.
    all_z = list(terrain_z)          # Corresponding Z values.
    segments = []                    # Constrained vertex-index pairs.
    holes = []                       # Interior point for each patch.

    # Track patch-boundary indices for later Z extraction.
    # patch_vertex_map[patch_idx] = [(ring_idx, start_global_idx, num_verts), ...]
    patch_vertex_map: List[List[Tuple[int, int, int]]] = []

    for patch_geojson in raw_patches:
        patch_rings: List[Tuple[int, int, int]] = []
        try:
            raw_geom = shape(patch_geojson)
            if raw_geom.is_empty:
                patch_vertex_map.append(patch_rings)
                continue
            if not raw_geom.is_valid:
                raw_geom = raw_geom.buffer(0)

            polygonal = extract_polygonal_geometry(raw_geom)
            if polygonal is None:
                patch_vertex_map.append(patch_rings)
                continue

            # Project to local coordinates.
            projected = to_local_projected_geometry(polygonal)
            local_geom = translate(projected, xoff=-offset_x, yoff=-offset_y)
            local_polygonal = extract_polygonal_geometry(local_geom)
            if local_polygonal is None or local_polygonal.is_empty:
                patch_vertex_map.append(patch_rings)
                continue

            # Add rings from every polygon component as constrained segments.
            polys = [local_polygonal] if isinstance(local_polygonal, Polygon) else list(local_polygonal.geoms)
            ring_counter = 0
            for poly in polys:
                if poly.is_empty:
                    continue
                # Exterior ring.
                ring_coords = list(poly.exterior.coords)[:-1]  # Remove the duplicate closing vertex.
                if len(ring_coords) < 3:
                    continue
                start_idx = len(all_vertices)
                for coord in ring_coords:
                    all_vertices.append([coord[0], coord[1]])
                    all_z.append(np.nan)  # Patch-boundary Z is interpolated later.
                # Connect the constrained ring.
                for i in range(len(ring_coords)):
                    segments.append([start_idx + i, start_idx + (i + 1) % len(ring_coords)])
                patch_rings.append((ring_counter, start_idx, len(ring_coords)))
                ring_counter += 1

                # Interior rings are also constrained boundaries.
                for interior in poly.interiors:
                    hole_coords = list(interior.coords)[:-1]
                    if len(hole_coords) < 3:
                        continue
                    hole_start = len(all_vertices)
                    for coord in hole_coords:
                        all_vertices.append([coord[0], coord[1]])
                        all_z.append(np.nan)
                    for i in range(len(hole_coords)):
                        segments.append([hole_start + i, hole_start + (i + 1) % len(hole_coords)])
                    patch_rings.append((ring_counter, hole_start, len(hole_coords)))
                    ring_counter += 1

                # Interior point used to mark the patch as a hole.
                rep = poly.representative_point()
                holes.append([float(rep.x), float(rep.y)])
        except Exception as exc:
            logger.warning(f"[terrain] failed processing patch: {exc}")

        patch_vertex_map.append(patch_rings)

    # 3. Add transition-zone and computational-domain boundaries.
    def _to_local_boundary_coords(raw_loop: List[Dict[str, Any]] | None) -> list[list[float]]:
        if not raw_loop:
            return []

        boundary_coords = []
        for pt in raw_loop:
            x, y = to_local_projected.transform(pt["lon"], pt["lat"])
            boundary_coords.append([x - offset_x, y - offset_y])
        return boundary_coords

    def _append_boundary_loop(
        raw_loop: List[Dict[str, Any]] | None,
        label: str,
        z_values: float | np.ndarray,
    ) -> None:
        if not raw_loop:
            return

        boundary_coords = _to_local_boundary_coords(raw_loop)
        if len(boundary_coords) < 3:
            return

        start_idx = len(all_vertices)
        if np.isscalar(z_values):
            ring_z = np.full(len(boundary_coords), float(z_values), dtype=np.float64)
        else:
            ring_z = np.asarray(z_values, dtype=np.float64)
            if len(ring_z) != len(boundary_coords):
                raise ValueError(f"{label} z_values length mismatch: {len(ring_z)} vs {len(boundary_coords)}")

        for coord, z_value in zip(boundary_coords, ring_z):
            all_vertices.append([coord[0], coord[1]])
            all_z.append(float(z_value))

        n = len(boundary_coords)
        for i in range(n):
            segments.append([start_idx + i, start_idx + (i + 1) % n])

        logger.info(
            f"[terrain] {label}: {n} vertices, z_min={float(np.min(ring_z)):.3f}, z_max={float(np.max(ring_z)):.3f}"
        )

    def _append_flat_anchor_points(raw_points: List[Dict[str, Any]] | None, z_value: float) -> None:
        if not raw_points:
            return

        count = 0
        for pt in raw_points:
            x, y = to_local_projected.transform(pt["lon"], pt["lat"])
            all_vertices.append([x - offset_x, y - offset_y])
            all_z.append(float(z_value))
            count += 1

        logger.info(f"[terrain] flat anchor points: {count} vertices, z={z_value:.3f}")

    for ring_entry in raw_transition_control_rings:
        raw_ring = ring_entry.get("points") or []
        t = float(ring_entry.get("t", 0.0))
        boundary_coords = _to_local_boundary_coords(raw_ring)
        if len(boundary_coords) < 3:
            continue

        if terrain_linear_interp is not None and terrain_nearest_interp is not None:
            base_xy = np.array(boundary_coords, dtype=np.float64)
            base_z = _interpolate_z(terrain_linear_interp, terrain_nearest_interp, base_xy)
        else:
            base_z = np.full(len(boundary_coords), z_flat, dtype=np.float64)

        ease = 0.5 - 0.5 * math.cos(math.pi * np.clip(t, 0.0, 1.0))
        target_z = (1.0 - ease) * base_z + ease * z_flat
        _append_boundary_loop(raw_ring, f"transition control ring t={t:.2f}", target_z)

    _append_boundary_loop(raw_transition_boundary, "transition boundary", z_flat)
    _append_boundary_loop(raw_domain_boundary, "domain boundary", z_flat)
    _append_flat_anchor_points(raw_flat_anchor_points, z_flat)

    if not raw_transition_boundary and not raw_domain_boundary and raw_boundary:
        boundary_coords = []
        for pt in raw_boundary:
            x, y = to_local_projected.transform(pt["lon"], pt["lat"])
            boundary_coords.append([x - offset_x, y - offset_y])

        if len(boundary_coords) >= 3:
            start_idx = len(all_vertices)
            for coord in boundary_coords:
                all_vertices.append([coord[0], coord[1]])
                all_z.append(np.nan)
            n = len(boundary_coords)
            for i in range(n):
                segments.append([start_idx + i, start_idx + (i + 1) % n])

            logger.info(f"[terrain] legacy mesh boundary: {n} vertices")

    # 4. Run CDT in a subprocess.
    vertices_arr = np.array(all_vertices, dtype=np.float64)
    z_arr = np.array(all_z, dtype=np.float64)

    pslg: Dict[str, Any] = {"vertices": vertices_arr}
    if segments:
        pslg["segments"] = np.array(segments, dtype=np.int32)
    if holes:
        pslg["holes"] = np.array(holes, dtype=np.float64)

    # Use p to preserve constrained segments. Do not add q30: its minimum-angle
    # control inserts extra Steiner points and changes the intended mesh form.
    logger.info(f"[terrain] CDT input: vertices={len(vertices_arr)}, segments={len(segments)}, holes={len(holes)}")

    cdt_result = _run_cdt_in_subprocess(pslg, "p")

    tri_verts = np.array(cdt_result["vertices"], dtype=np.float64)
    tri_faces = np.array(cdt_result["triangles"], dtype=np.int32)
    logger.info(f"[terrain] CDT output: vertices={len(tri_verts)}, triangles={len(tri_faces)}")

    # 5. Assign elevations. Patch-boundary and Steiner vertices require interpolation.
    full_z = np.full(len(tri_verts), np.nan, dtype=np.float64)
    # Copy known input Z values from the first len(z_arr) vertices.
    n_input = min(len(z_arr), len(tri_verts))
    full_z[:n_input] = z_arr[:n_input]

    # Build interpolators from terrain samples with valid Z values.
    valid_mask = ~np.isnan(full_z)
    linear_interp = None
    nearest_interp = None

    if np.sum(valid_mask) >= 3:
        known_xy = tri_verts[valid_mask]
        known_z = full_z[valid_mask]
        linear_interp, nearest_interp = _build_interpolators(known_xy, known_z)

        need_interp = np.isnan(full_z)
        if np.any(need_interp):
            interp_xy = tri_verts[need_interp]
            full_z[need_interp] = _interpolate_z(linear_interp, nearest_interp, interp_xy)

    full_z = np.nan_to_num(full_z, nan=0.0)
    full_z = _apply_corridor_clearance_to_terrain(
        tri_verts,
        tri_faces,
        full_z,
        raw_corridor_bottom_mesh,
        CORRIDOR_TERRAIN_CLEARANCE_M,
    )
    building_base_planes, median_fallback_patch_indices = _assign_building_patch_boundary_planes(
        full_z,
        tri_verts,
        patch_vertex_map,
        raw_patches,
        terrain_xy,
        terrain_z,
        offset_x,
        offset_y,
        building_base_plane_buffer_m,
    )
    if median_fallback_patch_indices:
        joined = ",".join(str(index) for index in median_fallback_patch_indices)
        logger.warning(
            f"[terrain/base-plane] median fallback patches: "
            f"{len(median_fallback_patch_indices)}/{len(patch_vertex_map)} patchIndex={joined}"
        )
    else:
        logger.info(f"[terrain/base-plane] robust planes applied: {len(patch_vertex_map)}/{len(patch_vertex_map)}")
    if len(tri_verts) >= 3:
        linear_interp, nearest_interp = _build_interpolators(tri_verts, full_z)

    building_base_heights: List[List[List[List[float]]]] | None = None

    if raw_building_geometries and linear_interp is not None:
        building_base_heights = []
        for building_index, bldg_entry in enumerate(raw_building_geometries):
            try:
                # Match model_buildings() exactly so base-height and model vertex order remain aligned.
                raw_geom = shape(bldg_entry["geometry"])
                if raw_geom.is_empty:
                    building_base_heights.append([])
                    continue
                if not raw_geom.is_valid:
                    raw_geom = raw_geom.buffer(0)
                    if raw_geom.is_empty:
                        building_base_heights.append([])
                        continue

                polygonal = extract_polygonal_geometry(raw_geom)
                if polygonal is None:
                    building_base_heights.append([])
                    continue

                # Match building.py by using unary_union for MultiPolygon overlap and ordering.
                unified = unary_union(polygonal)
                unified_polygonal = extract_polygonal_geometry(unified)
                if unified_polygonal is None:
                    building_base_heights.append([])
                    continue

                projected = to_local_projected_geometry(unified_polygonal)
                # Apply the same post-projection validity repair as building.py.
                if not projected.is_valid:
                    projected = projected.buffer(0)
                projected_polygonal = extract_polygonal_geometry(projected)
                if projected_polygonal is None or projected_polygonal.is_empty:
                    building_base_heights.append([])
                    continue

                local_geom = translate(projected_polygonal, xoff=-offset_x, yoff=-offset_y)
                local_polygonal = extract_polygonal_geometry(local_geom)
                if local_polygonal is None or local_polygonal.is_empty:
                    building_base_heights.append([])
                    continue

                patch_rings = patch_vertex_map[building_index] if building_index < len(patch_vertex_map) else []
                patch_ring_cursor = 0
                polys = [local_polygonal] if isinstance(local_polygonal, Polygon) else list(local_polygonal.geoms)
                bldg_z: List[List[List[float]]] = []
                for poly in polys:
                    poly_z: List[List[float]] = []
                    # Exterior ring.
                    ring_coords = list(poly.exterior.coords)[:-1]
                    if ring_coords:
                        z_vals = _base_ring_z_from_patch_vertices(
                            patch_rings,
                            patch_ring_cursor,
                            len(ring_coords),
                            full_z,
                        )
                        poly_z.append(z_vals.tolist() if z_vals is not None else [])
                    else:
                        poly_z.append([])
                    # Interior rings.
                    patch_ring_cursor += 1
                    for interior in poly.interiors:
                        hole_coords = list(interior.coords)[:-1]
                        if hole_coords:
                            z_vals = _base_ring_z_from_patch_vertices(
                                patch_rings,
                                patch_ring_cursor,
                                len(hole_coords),
                                full_z,
                            )
                            poly_z.append(z_vals.tolist() if z_vals is not None else [])
                        else:
                            poly_z.append([])
                        patch_ring_cursor += 1
                    bldg_z.append(poly_z)
                building_base_heights.append(bldg_z)
            except Exception as exc:
                logger.warning(f"[terrain] failed computing base heights for building: {exc}")
                building_base_heights.append([])

        logger.info(f"[terrain] computed base heights for {len(building_base_heights)} buildings")

    # 6. Build the 3D mesh and export OBJ.
    vertices_3d = np.column_stack([tri_verts, full_z])
    terrain_mesh = trimesh.Trimesh(vertices=vertices_3d, faces=tri_faces, process=False)
    trimesh.repair.fix_normals(terrain_mesh)
    terrain_mesh.export(str(output_path))

    origin_lon, origin_lat = to_lonlat.transform(offset_x, offset_y)

    logger.info(f"[terrain] exported to {output_path}")
    return TerrainBuildResponse(
        success=True,
        message="Terrain mesh generated.",
        output_path=str(output_path),
        vertex_count=int(len(tri_verts)),
        triangle_count=int(len(tri_faces)),
        origin_lonlat=[float(origin_lon), float(origin_lat)],
        building_base_heights=building_base_heights,
        building_base_planes=building_base_planes,
    )
