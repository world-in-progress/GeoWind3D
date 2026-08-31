"""
3D corridor-surface construction module.

Workflow:
1. Project WGS84 2D footprints to local EPSG:2326 coordinates.
2. Triangulate each connected component with CDT.
3. Interpolate top-surface elevations from edge-centerline Z data.
4. Export OBJ.
"""

import logging
import pickle
import subprocess
import sys
from typing import Any, Dict, List, Tuple, Union

import numpy as np
import trimesh
from shapely.geometry import LineString, Polygon, MultiPolygon
from shapely.ops import unary_union

from utils.geo import to_local_projected

from schemas.corridor import BuildSurfaceRequest, BuildSurfaceResponse, EdgeZData

logger = logging.getLogger(__name__)


# CDT subprocess using the same isolation pattern as terrain.py.

_CDT_WORKER_SCRIPT = r'''
import sys, pickle
import numpy as np
import triangle as tr

payload = sys.stdin.buffer.read()
pslg_data, opts = pickle.loads(payload)

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


def _run_cdt(pslg: Dict[str, Any], opts: str = "p") -> Dict[str, Any]:
    """Run triangle CDT in a subprocess."""
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
        if result.returncode < 0:
            raise RuntimeError(f"CDT killed by signal {-result.returncode}: {stderr_text}")
        raise RuntimeError(f"CDT failed (rc={result.returncode}): {stderr_text}")

    return pickle.loads(result.stdout)


# Elevation interpolation.

def _build_edge_segments(
    edges_z: List[EdgeZData],
    offset: Tuple[float, float],
) -> List[Tuple[np.ndarray, np.ndarray, float, float]]:
    """
    Split edge centerlines into (p0, p1, z0, z1) segments and convert their
    coordinates to the local frame by subtracting the shared offset.
    """
    segments = []
    for edge in edges_z:
        coords = edge.coords
        z_vals = edge.z_values
        for i in range(len(coords) - 1):
            x0 = coords[i][0] - offset[0]
            y0 = coords[i][1] - offset[1]
            x1 = coords[i + 1][0] - offset[0]
            y1 = coords[i + 1][1] - offset[1]
            z0 = z_vals[i] if i < len(z_vals) else 0.0
            z1 = z_vals[i + 1] if (i + 1) < len(z_vals) else 0.0
            if z0 > 0 or z1 > 0:
                segments.append((
                    np.array([x0, y0]),
                    np.array([x1, y1]),
                    z0, z1,
                ))
    return segments


def _project_to_nearest_visible_segment(
    query_xy: np.ndarray,
    segments: List[Tuple[np.ndarray, np.ndarray, float, float]],
    footprint: Union[Polygon, MultiPolygon],
) -> np.ndarray:
    """
    Project each query point onto the nearest visible centerline segment and interpolate Z.

    The connector from vertex to projection must remain inside the footprint,
    preventing folded or split footprints from using another strip's centerline.

    Test candidates in ascending distance order. If none is visible, keep Z=0
    and warn instead of falling back to a connector that crosses the footprint.
    """
    n = len(query_xy)
    result_z = np.zeros(n, dtype=np.float64)

    # Precompute segment vectors and squared lengths.
    seg_p0 = np.array([s[0] for s in segments])  # (M, 2)
    seg_p1 = np.array([s[1] for s in segments])  # (M, 2)
    seg_z0 = np.array([s[2] for s in segments])  # (M,)
    seg_z1 = np.array([s[3] for s in segments])  # (M,)
    seg_d = seg_p1 - seg_p0                      # (M, 2)
    seg_len_sq = np.sum(seg_d ** 2, axis=1)      # (M,)
    seg_len_sq = np.maximum(seg_len_sq, 1e-12)

    unreachable = 0

    for i in range(n):
        pt = query_xy[i]  # (2,)

        # Calculate projection parameter t for every segment and clamp it to [0, 1].
        v = pt - seg_p0
        t = np.sum(v * seg_d, axis=1) / seg_len_sq
        t = np.clip(t, 0.0, 1.0)

        # Projection coordinates.
        proj = seg_p0 + t[:, np.newaxis] * seg_d

        # Squared distances to projections.
        diff = pt - proj
        dist_sq = np.sum(diff ** 2, axis=1)

        # Select the first visible candidate in ascending distance order.
        sorted_indices = np.argsort(dist_sq)

        found = False
        for idx in sorted_indices:
            # A coincident vertex and projection are necessarily visible.
            if dist_sq[idx] < 1e-6:
                result_z[i] = seg_z0[idx] * (1.0 - t[idx]) + seg_z1[idx] * t[idx]
                found = True
                break

            # The connector must remain inside the footprint; boundary endpoints are allowed.
            proj_pt = proj[idx]
            connector = LineString([(pt[0], pt[1]), (proj_pt[0], proj_pt[1])])
            if footprint.covers(connector):
                result_z[i] = seg_z0[idx] * (1.0 - t[idx]) + seg_z1[idx] * t[idx]
                found = True
                break

        # No visible candidate: retain Z=0 and count a warning.
        if not found:
            unreachable += 1

    if unreachable > 0:
        logger.warning(
            f"[corridor/surface] {unreachable}/{n} vertices have no visible centerline "
            f"candidate, Z left as 0"
        )

    return result_z


# Main workflow helpers.

PolyData = List[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]]


def _parse_component_polygons(
    features: List[Dict],
    offset: Tuple[float, float],
) -> Dict[Tuple[int, str], PolyData]:
    """
    Group footprint features by (component, bridge), project them to local
    coordinates, and return {(comp_id, bridge): [(exterior, [holes]), ...]}.
    """
    grouped: Dict[Tuple[int, str], PolyData] = {}
    ox, oy = offset

    for feat in features:
        props = feat.get("properties", {})
        comp_id = props.get("component", 0)
        bridge = props.get("bridge", "")
        geom = feat.get("geometry", {})
        geom_type = geom.get("type", "")

        if geom_type == "Polygon":
            rings_list = [geom.get("coordinates", [])]
        elif geom_type == "MultiPolygon":
            rings_list = geom.get("coordinates", [])
        else:
            continue

        for rings in rings_list:
            if not rings:
                continue

            projected_rings: List[List[Tuple[float, float]]] = []
            for ring in rings:
                if len(ring) < 4:
                    continue
                proj = []
                for c in ring[:-1]:
                    x, y = to_local_projected.transform(float(c[0]), float(c[1]))
                    proj.append((x - ox, y - oy))
                if len(proj) >= 3:
                    projected_rings.append(proj)

            if projected_rings:
                exterior = projected_rings[0]
                holes = projected_rings[1:] if len(projected_rings) > 1 else []
                grouped.setdefault((comp_id, bridge), []).append((exterior, holes))

    return grouped


def _build_component_mesh(
    poly_data: List[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]],
    edge_segments: List[Tuple[np.ndarray, np.ndarray, float, float]],
) -> trimesh.Trimesh | None:
    """
    Build a component's top mesh by constructing a PSLG with constrained rings,
    holes, and injected centerline vertices; run CDT; then interpolate Z from centerlines.
    """
    vertices: List[List[float]] = []
    segments: List[List[int]] = []
    holes: List[List[float]] = []
    shapely_polys: List[Polygon] = []
    v_offset = 0

    for exterior, hole_rings in poly_data:
        all_rings = [exterior] + hole_rings

        for ring_idx, ring in enumerate(all_rings):
            n = len(ring)
            base = v_offset
            for pt in ring:
                vertices.append([pt[0], pt[1]])
            for i in range(n):
                segments.append([base + i, base + (i + 1) % n])
            v_offset += n

            # Interior ring and hole marker.
            if ring_idx > 0:
                hole_poly = Polygon(ring)
                if hole_poly.is_valid and not hole_poly.is_empty:
                    rep = hole_poly.representative_point()
                    holes.append([rep.x, rep.y])

        # Build a Shapely Polygon for visibility tests.
        poly = Polygon(exterior, hole_rings)
        if poly.is_valid and not poly.is_empty:
            shapely_polys.append(poly)

    if len(vertices) < 3 or not edge_segments:
        return None

    # Merge component polygons for visibility tests and centerline-vertex injection.
    footprint = unary_union(shapely_polys) if shapely_polys else None

    # Inject centerline vertices as unconstrained PSLG points. They anchor exact
    # centerline elevations and encourage smaller, regular triangles along the axis.
    if footprint:
        from shapely.geometry import Point
        # Deduplicate centerline endpoints shared by adjacent segments.
        boundary_arr = np.array(vertices, dtype=np.float64)  # Existing boundary vertices.
        seen: set = set()
        axis_points: List[List[float]] = []
        for p0, p1, z0, z1 in edge_segments:
            for p in (p0, p1):
                key = (round(p[0], 3), round(p[1], 3))
                if key in seen:
                    continue
                seen.add(key)
                # Skip points near boundary vertices to prevent degenerate triangles.
                if len(boundary_arr) > 0:
                    dists_sq = np.sum((boundary_arr - p) ** 2, axis=1)
                    if np.min(dists_sq) < 0.05 ** 2:  # < 5cm
                        continue
                # Keep strictly interior points to avoid constrained-boundary conflicts.
                pt = Point(p[0], p[1])
                if footprint.contains(pt):
                    axis_points.append([p[0], p[1]])

        if axis_points:
            vertices.extend(axis_points)
            logger.debug(
                f"[corridor/surface] injected {len(axis_points)} axis vertices into PSLG"
            )

    # CDT
    pslg: Dict[str, Any] = {"vertices": np.array(vertices, dtype=np.float64)}
    if segments:
        pslg["segments"] = np.array(segments, dtype=np.int32)
    if holes:
        pslg["holes"] = np.array(holes, dtype=np.float64)

    cdt_result = _run_cdt(pslg, "p")
    tri_verts = np.array(cdt_result["vertices"], dtype=np.float64)
    tri_faces = np.array(cdt_result["triangles"], dtype=np.int32)

    # Interpolate Z.
    full_z = _project_to_nearest_visible_segment(tri_verts, edge_segments, footprint)

    # Build the 3D mesh.
    vertices_3d = np.column_stack([tri_verts, full_z])
    mesh = trimesh.Trimesh(vertices=vertices_3d, faces=tri_faces, process=False)
    trimesh.repair.fix_normals(mesh)
    return mesh


def _close_mesh(top_mesh: trimesh.Trimesh, thickness: float) -> trimesh.Trimesh:
    """
    Close a top-surface mesh into a watertight solid with a copied base, side walls, and shared vertices.

    Copy top vertices downward by thickness, reverse base winding, connect each
    top boundary edge to its bottom counterpart, and retain shared indices for
    watertight topology.
    """
    top_verts = top_mesh.vertices  # (N, 3)
    top_faces = top_mesh.faces     # (M, 3)
    n_top = len(top_verts)

    # Base: lower Z and reverse face winding.
    bot_verts = top_verts.copy()
    bot_verts[:, 2] -= thickness
    # Swap columns 1 and 2 so base normals point downward.
    bot_faces = top_faces[:, [0, 2, 1]] + n_top

    # Boundary-edge detection: an edge occurring once is on the boundary.
    all_edges = np.vstack([
        top_faces[:, [0, 1]],
        top_faces[:, [1, 2]],
        top_faces[:, [2, 0]],
    ])
    # Sort edge endpoints as (min, max) for deduplication.
    sorted_edges = np.ascontiguousarray(np.sort(all_edges, axis=1))
    # Count unique edges with a structured array.
    edge_view = sorted_edges.view(dtype=[('a', sorted_edges.dtype), ('b', sorted_edges.dtype)])
    unique_edges, counts = np.unique(edge_view, return_counts=True)
    boundary_mask = counts == 1
    boundary_edges = np.array(
        [(e['a'], e['b']) for e in unique_edges[boundary_mask]], dtype=np.int64
    )

    # Side walls: map normalized boundary edges back to their oriented top-mesh
    # edges so wall winding produces outward normals.
    edge_to_ordered = {}
    for f in top_faces:
        for i in range(3):
            a, b = int(f[i]), int(f[(i + 1) % 3])
            key = (min(a, b), max(a, b))
            if key not in edge_to_ordered:
                edge_to_ordered[key] = (a, b)

    side_faces = []
    for edge in boundary_edges:
        key = (int(edge[0]), int(edge[1]))
        a, b = edge_to_ordered.get(key, key)
        # Form top a -> top b -> bottom b -> bottom a and split the quad into two triangles.
        a_bot = a + n_top
        b_bot = b + n_top
        side_faces.append([a, b, b_bot])
        side_faces.append([a, b_bot, a_bot])

    side_faces = np.array(side_faces, dtype=np.int64) if side_faces else np.empty((0, 3), dtype=np.int64)

    # Combine using shared vertex indices.
    all_verts = np.vstack([top_verts, bot_verts])
    all_faces = np.vstack([top_faces, bot_faces, side_faces])

    closed = trimesh.Trimesh(vertices=all_verts, faces=all_faces, process=False)
    trimesh.repair.fix_normals(closed)
    return closed


def _extrude_by_bridge_type(
    base_mesh: trimesh.Trimesh,
    bridge: str,
    height_floor: float,
    height_cover: float,
    height_interior: float,
) -> List[trimesh.Trimesh]:
    """
    Extrude upward from the floor_bottom datum according to bridge type.

    The graph stage has normalized base_mesh Z to floor_bottom. Build all types upward:

    - covered: one closed solid through floor, interior, and cover;
    - viaduct: the road slab only;
    - uncovered: separate floor and cover solids with an open interior.
      · floor: base → base + floor
      · cover: base + floor + interior → base + floor + interior + cover
    """
    total = height_cover + height_interior + height_floor

    if bridge == "covered":
        # Closed volume from base to the full covered height.
        mesh = base_mesh.copy()
        mesh.vertices[:, 2] += total
        return [_close_mesh(mesh, total)]

    elif bridge == "viaduct":
        # Viaduct road slab from base to floor height.
        mesh = base_mesh.copy()
        mesh.vertices[:, 2] += height_floor
        return [_close_mesh(mesh, height_floor)]

    else:
        # Uncovered type: separate road slab and cover with an open interior.
        # 1) Road slab.
        floor_mesh = base_mesh.copy()
        floor_mesh.vertices[:, 2] += height_floor
        floor_closed = _close_mesh(floor_mesh, height_floor)
        # 2) Cover slab.
        cover_mesh = base_mesh.copy()
        cover_mesh.vertices[:, 2] += total
        cover_closed = _close_mesh(cover_mesh, height_cover)
        return [floor_closed, cover_closed]


def _inter_component_union(
    meshes: List[trimesh.Trimesh],
    comp_ids: List[int],
    grouped_polys: Dict[Tuple[int, str], PolyData],
    boolean_union_fn,
) -> Tuple[List[trimesh.Trimesh], List[int]]:
    """
    Boolean-union connected components whose 2D footprints intersect.

    Merge bridge-type footprints per component, find intersections with an
    STRtree, group transitive intersections with Union-Find, and Boolean-union
    multi-component groups whose 3D axis-aligned bounding boxes overlap.
    """
    from shapely.ops import unary_union as shapely_union
    from shapely.strtree import STRtree

    if len(meshes) <= 1:
        return meshes, comp_ids

    # 1. Build one merged 2D footprint per component.
    comp_footprints: Dict[int, Polygon] = {}
    for (cid, bridge), poly_data in grouped_polys.items():
        polys = []
        for exterior, holes in poly_data:
            p = Polygon(exterior, holes)
            if p.is_valid and not p.is_empty:
                polys.append(p)
        if polys:
            merged = shapely_union(polys)
            if cid in comp_footprints:
                comp_footprints[cid] = shapely_union([comp_footprints[cid], merged])
            else:
                comp_footprints[cid] = merged

    # Map component IDs to indices in meshes.
    cid_to_idx: Dict[int, int] = {}
    for idx, cid in enumerate(comp_ids):
        cid_to_idx[cid] = idx

    # Include only components with footprints in intersection detection.
    active_cids = [cid for cid in comp_ids if cid in comp_footprints]
    if len(active_cids) <= 1:
        return meshes, comp_ids

    # 2. Find intersecting component pairs with an STRtree.
    footprint_list = [comp_footprints[cid] for cid in active_cids]
    tree = STRtree(footprint_list)

    # Union-Find
    parent: Dict[int, int] = {cid: cid for cid in active_cids}

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i, cid_i in enumerate(active_cids):
        fp_i = footprint_list[i]
        nearby = tree.query(fp_i, predicate="intersects")
        for j in nearby:
            if j <= i:
                continue
            cid_j = active_cids[j]
            # Require an area intersection rather than boundary contact alone.
            if fp_i.intersects(footprint_list[j]) and not fp_i.touches(footprint_list[j]):
                union(cid_i, cid_j)

    # 3. Form transitive groups with Union-Find.
    groups: Dict[int, List[int]] = {}
    for cid in active_cids:
        root = find(cid)
        groups.setdefault(root, []).append(cid)

    # Identify groups that require cross-component merging.
    merge_groups = {root: cids for root, cids in groups.items() if len(cids) > 1}
    if not merge_groups:
        logger.info("[corridor/surface] inter-component union: no overlapping components found")
        return meshes, comp_ids

    logger.info(
        f"[corridor/surface] inter-component union: "
        f"{len(merge_groups)} groups with overlapping components: "
        f"{[cids for cids in merge_groups.values()]}"
    )

    # 4. Boolean-union each group and track the mesh indices it replaces.
    consumed_indices: set = set()
    new_meshes: List[trimesh.Trimesh] = []
    new_cids: List[int] = []

    for root, group_cids in merge_groups.items():
        group_meshes: List[trimesh.Trimesh] = []
        group_indices: List[int] = []
        for cid in group_cids:
            idx = cid_to_idx.get(cid)
            if idx is not None:
                group_meshes.append(meshes[idx])
                group_indices.append(idx)

        if len(group_meshes) <= 1:
            continue

        # Use 3D AABB overlap as a fast rejection test.
        bounds = [m.bounds for m in group_meshes]  # [(min_xyz, max_xyz), ...]
        needs_union = False
        for a in range(len(bounds)):
            if needs_union:
                break
            for b in range(a + 1, len(bounds)):
                min_a, max_a = bounds[a]
                min_b, max_b = bounds[b]
                # AABB overlap test.
                if (min_a[0] <= max_b[0] and max_a[0] >= min_b[0] and
                    min_a[1] <= max_b[1] and max_a[1] >= min_b[1] and
                    min_a[2] <= max_b[2] and max_a[2] >= min_b[2]):
                    needs_union = True
                    break

        if needs_union:
            merged = boolean_union_fn(group_meshes)
            if merged is not None:
                consumed_indices.update(group_indices)
                new_meshes.append(merged)
                new_cids.append(root)
                logger.info(
                    f"[corridor/surface] inter-component union: "
                    f"components {group_cids} → {len(merged.vertices)}v, {len(merged.faces)}f"
                )
            else:
                logger.warning(
                    f"[corridor/surface] inter-component union failed for {group_cids}, keeping separate"
                )
        else:
            logger.info(
                f"[corridor/surface] inter-component union: "
                f"components {group_cids} footprints overlap but 3D AABBs don't, skipping"
            )

    # 5. Reassemble untouched and merged results.
    result_meshes: List[trimesh.Trimesh] = []
    result_cids: List[int] = []
    for idx in range(len(meshes)):
        if idx not in consumed_indices:
            result_meshes.append(meshes[idx])
            result_cids.append(comp_ids[idx])
    result_meshes.extend(new_meshes)
    result_cids.extend(new_cids)

    return result_meshes, result_cids


def build_corridor_surface(req: BuildSurfaceRequest) -> BuildSurfaceResponse:
    """
    Build a multi-type watertight corridor model by grouping footprints by
    component and bridge type, triangulating and interpolating each top surface,
    applying type-specific extrusion, unioning types within components, merging
    all components, and exporting OBJ.
    """
    from utils.bool_union import boolean_union

    offset_x, offset_y = req.offset_2326[0], req.offset_2326[1]
    features = req.footprints_geojson.get("features", [])

    if not features:
        return BuildSurfaceResponse(success=True, message="no footprints to process")

    # Group footprint polygons by component and bridge type.
    grouped_polys = _parse_component_polygons(features, (offset_x, offset_y))
    logger.info(f"[corridor/surface] {len(grouped_polys)} (component, bridge) groups to process")

    # Group edge Z data by component and bridge type.
    grouped_edges: Dict[Tuple[int, str], List[EdgeZData]] = {}
    for edge in req.edges_z:
        grouped_edges.setdefault((edge.component, edge.bridge), []).append(edge)

    # Collect bridge-type meshes for later union within each component.
    comp_meshes: Dict[int, List[trimesh.Trimesh]] = {}
    total_verts = 0
    total_tris = 0

    for (comp_id, bridge), poly_data in grouped_polys.items():
        # Centerline segments for this group.
        edge_list = grouped_edges.get((comp_id, bridge), [])
        edge_segs = _build_edge_segments(edge_list, (offset_x, offset_y))

        if not edge_segs:
            logger.warning(
                f"[corridor/surface] component {comp_id} bridge='{bridge}': "
                f"no edge Z data, skipped"
            )
            continue

        top_mesh = _build_component_mesh(poly_data, edge_segs)
        if top_mesh is None:
            continue

        # Extrude according to bridge type.
        type_meshes = _extrude_by_bridge_type(
            top_mesh, bridge,
            req.height_floor, req.height_cover, req.height_interior,
        )
        for m in type_meshes:
            total_verts += len(m.vertices)
            total_tris += len(m.faces)
        comp_meshes.setdefault(comp_id, []).extend(type_meshes)

        logger.info(
            f"[corridor/surface] component {comp_id} bridge='{bridge}': "
            f"{sum(len(m.vertices) for m in type_meshes)} verts, "
            f"{sum(len(m.faces) for m in type_meshes)} tris "
            f"({len(type_meshes)} mesh(es))"
        )

    if not comp_meshes:
        return BuildSurfaceResponse(success=True, message="no valid meshes generated")

    # Boolean-union all bridge types within each connected component.
    final_meshes: List[trimesh.Trimesh] = []
    comp_ids_sorted: List[int] = []  # Component ID corresponding to each final mesh.
    for comp_id in sorted(comp_meshes.keys()):
        parts = comp_meshes[comp_id]
        if len(parts) == 1:
            final_meshes.append(parts[0])
            comp_ids_sorted.append(comp_id)
        else:
            merged = boolean_union(parts)
            if merged is not None:
                final_meshes.append(merged)
                comp_ids_sorted.append(comp_id)
                logger.info(
                    f"[corridor/surface] component {comp_id}: boolean union "
                    f"{len(parts)} parts → {len(merged.vertices)}v, {len(merged.faces)}f"
                )

    if not final_meshes:
        return BuildSurfaceResponse(success=True, message="no valid meshes after union")

    # Union spatially intersecting connected components, such as at interchanges.
    final_meshes, comp_ids = _inter_component_union(
        final_meshes, comp_ids_sorted, grouped_polys, boolean_union,
    )

    # Combine all component meshes.
    merged = trimesh.util.concatenate(final_meshes) if len(final_meshes) > 1 else final_meshes[0]
    trimesh.repair.fix_normals(merged)

    from pathlib import Path
    output_path = Path(req.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    merged.export(str(output_path))

    # Calculate the origin in WGS84.
    from utils.geo import to_lonlat
    origin_lon, origin_lat = to_lonlat.transform(offset_x, offset_y)

    logger.info(
        f"[corridor/surface] OBJ exported: {output_path} "
        f"({total_verts} verts, {total_tris} tris, "
        f"{len(final_meshes)} components)"
    )

    return BuildSurfaceResponse(
        success=True,
        message="ok",
        vertex_count=total_verts,
        triangle_count=total_tris,
        origin_lonlat=[float(origin_lon), float(origin_lat)],
    )
