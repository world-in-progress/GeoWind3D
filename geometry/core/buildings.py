"""Building modeling with custom wall, roof, and base triangulation."""

import logging
from pathlib import Path
from typing import List, Tuple

import numpy as np
import mapbox_earcut as earcut
import trimesh
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.geometry import shape

from schemas.buildings import BuildingModelRequest, BuildingExtrudeResponse, CompoundBuildingPatch
from utils.geo import (
    extract_polygonal_geometry,
    to_local_projected_geometry,
    to_lonlat,
    count_non_manifold_edges,
)
from utils.bool_union import boolean_union

logger = logging.getLogger(__name__)
COMPOUND_MEMBER_INSERT_DEPTH_M = 0.05
COMPOUND_BASE_SLAB_THICKNESS_M = 0.1


def _build_single_polygon(
    poly: Polygon,
    roof_z: float,
    base_z_per_ring: List[List[float]] | None,
    enforce_roof_above_base: bool = True,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Generate a watertight wall, roof, and base mesh for one Polygon.

    Args:
        poly: Polygon in local coordinates, optionally with holes.
        roof_z: Absolute roof elevation.
        base_z_per_ring: Base Z values indexed by ring and vertex. None gives a flat base at Z=0.
                         Ring 0 is the exterior; subsequent rings are holes.

    Returns:
        NumPy arrays `(vertices_3d, faces)`. The roof and base share the earcut
        triangulation while referencing separate top and bottom vertex pools.
        Boundary vertices are shared exactly to preserve watertight topology.
    """
    # Collect ring coordinates without duplicate closing vertices.
    rings_coords: List[List[List[float]]] = []
    exterior_coords = list(poly.exterior.coords)[:-1]
    rings_coords.append([[c[0], c[1]] for c in exterior_coords])
    for interior in poly.interiors:
        hole_coords = list(interior.coords)[:-1]
        rings_coords.append([[c[0], c[1]] for c in hole_coords])

    # Resolve the base Z value for every ring vertex.
    rings_base_z: List[List[float]] = []
    for ring_idx, ring in enumerate(rings_coords):
        if base_z_per_ring is not None and ring_idx < len(base_z_per_ring):
            bz = base_z_per_ring[ring_idx]
            # Pad mismatched base-height arrays with zeros.
            if len(bz) >= len(ring):
                rings_base_z.append(bz[:len(ring)])
            else:
                rings_base_z.append(bz + [0.0] * (len(ring) - len(bz)))
        else:
            rings_base_z.append([0.0] * len(ring))

    # Keep the roof above every base vertex. This prevents inverted wall
    # triangles for low buildings on steep terrain.
    max_base_z = max(z for ring in rings_base_z for z in ring) if any(rings_base_z) else 0.0
    if enforce_roof_above_base and roof_z <= max_base_z:
        roof_z = max_base_z + 1.0
        logger.debug(f"roof_z adjusted to {roof_z:.2f} (was below max base_z {max_base_z:.2f})")

    # Build shared top and bottom vertex pools. Walls and roof reuse top
    # vertices, and adjacent wall quads reuse edge vertices for manifold continuity.
    all_verts: List[List[float]] = []
    all_faces: List[List[int]] = []

    # top_idx and bot_idx map each earcut-compatible flat index to its 3D vertex.
    top_idx: List[int] = []
    bot_idx: List[int] = []

    for ring_idx, ring in enumerate(rings_coords):
        base_z = rings_base_z[ring_idx]
        for vi, pt in enumerate(ring):
            ti = len(all_verts)
            all_verts.append([pt[0], pt[1], roof_z])
            top_idx.append(ti)
            bi = len(all_verts)
            all_verts.append([pt[0], pt[1], base_z[vi]])
            bot_idx.append(bi)

    # Generate walls from shared vertices.
    flat_offset = 0  # Start of the current ring in the flattened index.
    for ring_idx, ring in enumerate(rings_coords):
        n = len(ring)
        is_exterior = (ring_idx == 0)
        for i in range(n):
            j = (i + 1) % n
            # Four shared vertex indices for this wall quad.
            ti = top_idx[flat_offset + i]   # top-left
            tj = top_idx[flat_offset + j]   # top-right
            bj = bot_idx[flat_offset + j]   # bottom-right
            bi = bot_idx[flat_offset + i]   # bottom-left

            if is_exterior:
                # Exterior-ring normals point outward.
                all_faces.append([ti, tj, bj])
                all_faces.append([ti, bj, bi])
            else:
                # Hole-ring normals point into the opening.
                all_faces.append([ti, bj, tj])
                all_faces.append([ti, bi, bj])
        flat_offset += n

    # Triangulate the roof with earcut and shared top vertices.
    all_ring_coords = [np.array(ring, dtype=np.float64) for ring in rings_coords]
    vertices_2d = np.vstack(all_ring_coords) if all_ring_coords else np.zeros((0, 2), dtype=np.float64)
    ring_ends = np.cumsum([len(r) for r in all_ring_coords])

    try:
        face_indices = earcut.triangulate_float64(vertices_2d, ring_ends)
    except Exception as exc:
        logger.warning(f"earcut triangulation failed: {exc}, skipping roof")
        face_indices = np.array([], dtype=np.int32)

    if len(face_indices) > 0:
        # Earcut flat indices map directly to top_idx.
        for i in range(0, len(face_indices), 3):
            all_faces.append([
                top_idx[int(face_indices[i])],
                top_idx[int(face_indices[i + 1])],
                top_idx[int(face_indices[i + 2])],
            ])

        # Reuse the roof triangulation for the base, reverse its winding for
        # downward normals, and share bot_idx with the wall boundary.
        for i in range(0, len(face_indices), 3):
            all_faces.append([
                bot_idx[int(face_indices[i])],
                bot_idx[int(face_indices[i + 2])],
                bot_idx[int(face_indices[i + 1])],
            ])

    verts_arr = np.array(all_verts, dtype=np.float64)
    faces_arr = np.array(all_faces, dtype=np.int32)
    return verts_arr, faces_arr


def _build_single_polygon_between_surfaces(
    poly: Polygon,
    top_z_per_ring: List[List[float]],
    bottom_z_per_ring: List[List[float]],
) -> Tuple[np.ndarray, np.ndarray]:
    rings_coords: List[List[List[float]]] = []
    rings_coords.append([[c[0], c[1]] for c in list(poly.exterior.coords)[:-1]])
    for interior in poly.interiors:
        rings_coords.append([[c[0], c[1]] for c in list(interior.coords)[:-1]])

    all_verts: List[List[float]] = []
    all_faces: List[List[int]] = []
    top_idx: List[int] = []
    bot_idx: List[int] = []

    for ring_idx, ring in enumerate(rings_coords):
        top_z = top_z_per_ring[ring_idx] if ring_idx < len(top_z_per_ring) else []
        bottom_z = bottom_z_per_ring[ring_idx] if ring_idx < len(bottom_z_per_ring) else []
        for vi, pt in enumerate(ring):
            tz = float(top_z[vi]) if vi < len(top_z) and np.isfinite(top_z[vi]) else 0.0
            bz = float(bottom_z[vi]) if vi < len(bottom_z) and np.isfinite(bottom_z[vi]) else 0.0
            ti = len(all_verts)
            all_verts.append([pt[0], pt[1], tz])
            top_idx.append(ti)
            bi = len(all_verts)
            all_verts.append([pt[0], pt[1], bz])
            bot_idx.append(bi)

    flat_offset = 0
    for ring_idx, ring in enumerate(rings_coords):
        n = len(ring)
        is_exterior = ring_idx == 0
        for i in range(n):
            j = (i + 1) % n
            ti = top_idx[flat_offset + i]
            tj = top_idx[flat_offset + j]
            bj = bot_idx[flat_offset + j]
            bi = bot_idx[flat_offset + i]
            if is_exterior:
                all_faces.append([ti, tj, bj])
                all_faces.append([ti, bj, bi])
            else:
                all_faces.append([ti, bj, tj])
                all_faces.append([ti, bi, bj])
        flat_offset += n

    all_ring_coords = [np.array(ring, dtype=np.float64) for ring in rings_coords]
    vertices_2d = np.vstack(all_ring_coords) if all_ring_coords else np.zeros((0, 2), dtype=np.float64)
    ring_ends = np.cumsum([len(r) for r in all_ring_coords])
    try:
        face_indices = earcut.triangulate_float64(vertices_2d, ring_ends)
    except Exception as exc:
        logger.warning(f"earcut triangulation failed: {exc}, skipping slab caps")
        face_indices = np.array([], dtype=np.int32)

    for i in range(0, len(face_indices), 3):
        all_faces.append([
            top_idx[int(face_indices[i])],
            top_idx[int(face_indices[i + 1])],
            top_idx[int(face_indices[i + 2])],
        ])
        all_faces.append([
            bot_idx[int(face_indices[i])],
            bot_idx[int(face_indices[i + 2])],
            bot_idx[int(face_indices[i + 1])],
        ])

    return np.array(all_verts, dtype=np.float64), np.array(all_faces, dtype=np.int32)


def _clean_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    if hasattr(mesh, "remove_duplicate_faces"):
        mesh.remove_duplicate_faces()
    if hasattr(mesh, "remove_degenerate_faces"):
        mesh.remove_degenerate_faces()
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(mesh)
    return mesh


def _project_geometry_to_local_polygons(
    geometry: dict,
    offset_x: float,
    offset_y: float,
    label: str,
) -> List[Polygon]:
    raw_geom = shape(geometry)
    if raw_geom.is_empty:
        return []
    if not raw_geom.is_valid:
        raw_geom = raw_geom.buffer(0)
        if raw_geom.is_empty:
            return []

    polygonal_geom = extract_polygonal_geometry(raw_geom)
    if polygonal_geom is None:
        logger.warning(f"Skip unsupported geometry type at {label}: {raw_geom.geom_type}")
        return []

    unified = unary_union(polygonal_geom)
    unified_polygonal = extract_polygonal_geometry(unified)
    if unified_polygonal is None:
        return []

    local_projected_geom = to_local_projected_geometry(unified_polygonal)
    if not local_projected_geom.is_valid:
        local_projected_geom = local_projected_geom.buffer(0)
    local_projected_polygonal = extract_polygonal_geometry(local_projected_geom)
    if local_projected_polygonal is None or local_projected_polygonal.is_empty:
        return []

    local_geom = translate(local_projected_polygonal, xoff=-offset_x, yoff=-offset_y, zoff=0.0)
    polygonal = extract_polygonal_geometry(local_geom)
    if polygonal is None:
        return []

    if isinstance(polygonal, Polygon):
        return [polygonal]
    return list(polygonal.geoms)


def _mesh_from_polygons(
    polygons: List[Polygon],
    roof_z: float,
    base_heights: List[List[List[float]]] | None,
    enforce_roof_above_base: bool = True,
) -> trimesh.Trimesh | None:
    meshes: List[trimesh.Trimesh] = []
    for poly_idx, poly in enumerate(polygons):
        if poly.is_empty or poly.area <= 0:
            continue

        poly_base_z: List[List[float]] | None = None
        if base_heights is not None and poly_idx < len(base_heights):
            poly_base_z = base_heights[poly_idx]

        verts, faces = _build_single_polygon(poly, roof_z, poly_base_z, enforce_roof_above_base)
        if len(verts) == 0 or len(faces) == 0:
            continue
        meshes.append(_clean_mesh(trimesh.Trimesh(vertices=verts, faces=faces, process=False)))

    if not meshes:
        return None
    if len(meshes) == 1:
        return meshes[0]
    return _clean_mesh(trimesh.util.concatenate(meshes))


def _plane_coefficients(patch: CompoundBuildingPatch) -> tuple[float, float, float]:
    if patch.base_plane is None:
        return 0.0, 0.0, 0.0
    a = float(patch.base_plane.a)
    b = float(patch.base_plane.b)
    c = float(patch.base_plane.c)
    if not all(np.isfinite(value) for value in (a, b, c)):
        return 0.0, 0.0, 0.0
    return a, b, c


def _plane_heights_for_polygons(
    polygons: List[Polygon],
    plane: tuple[float, float, float],
    z_offset: float = 0.0,
) -> List[List[List[float]]]:
    a, b, c = plane
    result: List[List[List[float]]] = []
    for poly in polygons:
        rings: List[List[float]] = []
        ring_coords = list(poly.exterior.coords)[:-1]
        rings.append([float(a * x + b * y + c + z_offset) for x, y in ring_coords])
        for interior in poly.interiors:
            hole_coords = list(interior.coords)[:-1]
            rings.append([float(a * x + b * y + c + z_offset) for x, y in hole_coords])
        result.append(rings)
    return result


def _mesh_between_plane_surfaces(
    polygons: List[Polygon],
    plane: tuple[float, float, float],
    top_offset: float,
    bottom_offset: float = 0.0,
) -> trimesh.Trimesh | None:
    top_heights = _plane_heights_for_polygons(polygons, plane, top_offset)
    bottom_heights = _plane_heights_for_polygons(polygons, plane, bottom_offset)
    meshes: List[trimesh.Trimesh] = []
    for poly_idx, poly in enumerate(polygons):
        if poly.is_empty or poly.area <= 0:
            continue
        verts, faces = _build_single_polygon_between_surfaces(
            poly,
            top_heights[poly_idx],
            bottom_heights[poly_idx],
        )
        if len(verts) == 0 or len(faces) == 0:
            continue
        meshes.append(_clean_mesh(trimesh.Trimesh(vertices=verts, faces=faces, process=False)))

    if not meshes:
        return None
    if len(meshes) == 1:
        return meshes[0]
    return _clean_mesh(trimesh.util.concatenate(meshes))


def _valid_compound_members(patch: CompoundBuildingPatch) -> List:
    return [
        member
        for member in patch.members
        if np.isfinite(float(member.height)) and float(member.height) > 0.0
    ]


def _model_patch_base(
    patch: CompoundBuildingPatch,
    offset_x: float,
    offset_y: float,
) -> trimesh.Trimesh | None:
    polygons = _project_geometry_to_local_polygons(
        patch.base_geometry,
        offset_x,
        offset_y,
        f"compound patch base {patch.patch_id}",
    )
    return _mesh_between_plane_surfaces(
        polygons,
        _plane_coefficients(patch),
        top_offset=COMPOUND_BASE_SLAB_THICKNESS_M,
    )


def _model_compound_member(
    member_geometry: dict,
    member_height: float,
    patch_base_plane: tuple[float, float, float],
    offset_x: float,
    offset_y: float,
    label: str,
) -> trimesh.Trimesh | None:
    polygons = _project_geometry_to_local_polygons(member_geometry, offset_x, offset_y, label)
    if not polygons:
        return None
    base_heights = _plane_heights_for_polygons(
        polygons,
        patch_base_plane,
        COMPOUND_BASE_SLAB_THICKNESS_M - COMPOUND_MEMBER_INSERT_DEPTH_M,
    )
    return _mesh_from_polygons(polygons, float(member_height), base_heights)


def _safe_union_or_concat(meshes: List[trimesh.Trimesh], label: str) -> trimesh.Trimesh | None:
    valid = [mesh for mesh in meshes if mesh is not None and len(mesh.faces) > 0]
    if not valid:
        return None
    if len(valid) == 1:
        return valid[0]

    merged = boolean_union(valid)
    if merged is not None and len(merged.faces) > 0:
        return merged

    logger.warning(f"[buildings] {label}: boolean union failed, falling back to concatenate")
    return _clean_mesh(trimesh.util.concatenate(valid))


def _model_compound_patch(
    patch: CompoundBuildingPatch,
    offset_x: float,
    offset_y: float,
) -> trimesh.Trimesh | None:
    valid_members = _valid_compound_members(patch)
    if not valid_members:
        logger.warning(f"Skip compound patch {patch.patch_id}: no valid roof-attributed members")
        return None
    base_plane = _plane_coefficients(patch)
    base_mesh = _model_patch_base(patch, offset_x, offset_y)

    member_meshes: List[trimesh.Trimesh] = []
    for member in valid_members:
        mesh = _model_compound_member(
            member.geometry,
            float(member.height),
            base_plane,
            offset_x,
            offset_y,
            f"compound member {member.full_id}",
        )
        if mesh is not None:
            member_meshes.append(mesh)

    members_union = _safe_union_or_concat(member_meshes, f"compound patch {patch.patch_id} members")
    if members_union is None:
        if base_mesh is not None:
            return base_mesh
        logger.warning(f"Skip compound patch {patch.patch_id}: no member mesh generated")
        return None
    if base_mesh is None:
        return members_union

    patch_union = _safe_union_or_concat(
        [base_mesh, members_union],
        f"compound patch {patch.patch_id} base+members",
    )
    return patch_union


def model_buildings(req: BuildingModelRequest) -> BuildingExtrudeResponse:
    """
    Main building-modeling entry point. Generate watertight wall, roof, and
    base meshes from compound building patches with per-vertex base elevations.

    Every Polygon component, including through-holes, is topologically watertight
    and therefore valid input for Boolean model integration.
    """
    output_path = Path(req.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    offset_x, offset_y = req.offset_2326

    # 1. Generate meshes for compound patches.
    meshes: List[trimesh.Trimesh] = []
    for patch in req.compound_patches:
        try:
            mesh = _model_compound_patch(patch, offset_x, offset_y)
            if mesh is not None:
                meshes.append(mesh)
        except Exception as exc:
            logger.warning(f"Failed modeling compound patch {patch.patch_id}: {exc}")

    if len(meshes) == 0:
        return BuildingExtrudeResponse(
            success=False,
            message="No valid building mesh generated.",
            output_path=None,
            watertight=False,
            non_manifold_edges=0,
            components=0,
        )

    # 2. Combine all building meshes.
    merged = trimesh.util.concatenate(meshes)
    # Clean the combined mesh.
    _clean_mesh(merged)

    non_manifold_edges = count_non_manifold_edges(merged)
    # Components are independently watertight. The combined mesh may report
    # false when separate components do not share edges, which is expected.
    watertight = bool(merged.is_watertight and non_manifold_edges == 0)

    merged.export(output_path)

    origin_lon, origin_lat = to_lonlat.transform(offset_x, offset_y)

    return BuildingExtrudeResponse(
        success=True,
        message="Building modeling finished.",
        output_path=str(output_path),
        watertight=watertight,
        non_manifold_edges=non_manifold_edges,
        components=int(len(meshes)),
        origin_lonlat=[float(origin_lon), float(origin_lat)],
        offset_2326=[offset_x, offset_y],
    )
