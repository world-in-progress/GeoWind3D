"""
Corridor graph-construction module.

Workflow:
- Project Z-enabled GeoJSON lines to EPSG:2326 Shapely LineStrings.
- Snap endpoints within tolerance and resolve T-junctions.
- Detect crossings and classify them by Z as same-level or grade-separated.
- Split only at same-level crossings.
- Build a NetworkX graph and identify connected components.
- Export component-colored GeoJSON.
"""

import logging
import math
from collections import defaultdict, deque
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import lsqr
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, mapping
from shapely.ops import linemerge, snap, split, unary_union
from shapely import STRtree

from utils.geo import to_local_projected, to_lonlat

logger = logging.getLogger(__name__)


# Data structures.

class WaySegment:
    """A projected corridor segment with Z values after Node-side building filtering."""
    def __init__(
        self,
        line_2d: LineString,         # 2D EPSG:2326 geometry.
        z_values: List[float],       # One Z value per vertex.
        original_id: int | str = -1, # Source-feature identifier.
        bridge: str = "",            # Corridor type: covered, uncovered, or viaduct.
        osm_type: str = "",          # walkway / walkway_step
    ):
        self.line_2d = line_2d
        self.z_values = z_values
        self.original_id = original_id
        self.bridge = bridge
        self.osm_type = osm_type

    @property
    def start(self) -> Tuple[float, float]:
        return self.line_2d.coords[0]

    @property
    def end(self) -> Tuple[float, float]:
        return self.line_2d.coords[-1]

    def interpolate_z_at(self, point_2d: Point) -> float:
        """Linearly interpolate Z at a position along the line."""
        d = self.line_2d.project(point_2d)
        total_length = self.line_2d.length
        if total_length < 1e-9:
            return self.z_values[0] if self.z_values else 0.0

        coords = list(self.line_2d.coords)
        cum_dist = 0.0
        for i in range(len(coords) - 1):
            seg_len = Point(coords[i]).distance(Point(coords[i + 1]))
            if cum_dist + seg_len >= d - 1e-9:
                # Interpolate on segment i.
                t = (d - cum_dist) / seg_len if seg_len > 1e-9 else 0.0
                t = max(0.0, min(1.0, t))
                z0 = self.z_values[i] if i < len(self.z_values) else self.z_values[-1]
                z1 = self.z_values[i + 1] if (i + 1) < len(self.z_values) else self.z_values[-1]
                return z0 + t * (z1 - z0)
            cum_dist += seg_len

        return self.z_values[-1] if self.z_values else 0.0



# Convert GeoJSON to projected WaySegments.

def _parse_features(features: list) -> List[WaySegment]:
    """Convert Z-enabled GeoJSON lines to projected WaySegments."""
    segments: List[WaySegment] = []
    for feat in features:
        geom = feat.geometry
        coords_wgs84 = geom.get("coordinates", [])
        if len(coords_wgs84) < 2:
            continue

        # Project to EPSG:2326.
        coords_2326 = []
        for c in coords_wgs84:
            lon, lat = float(c[0]), float(c[1])
            x, y = to_local_projected.transform(lon, lat)
            coords_2326.append((x, y))

        line_2d = LineString(coords_2326)
        if line_2d.length < 1e-6:
            continue

        segments.append(WaySegment(
            line_2d=line_2d,
            z_values=list(feat.z_values),
            original_id=feat.id,
            bridge=feat.bridge,
            osm_type=getattr(feat, "osm_type", ""),
        ))

    logger.info(f"[corridor/graph] parsed {len(segments)} way segments")
    return segments


# Snap endpoints with Union-Find.

class _UnionFind:
    """Lightweight Union-Find for merging equivalent endpoints."""
    def __init__(self):
        self.parent: Dict[int, int] = {}
        self.rank: Dict[int, int] = {}

    def find(self, x: int) -> int:
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def _snap_endpoints(
    segments: List[WaySegment],
    tolerance: float,
) -> List[WaySegment]:
    """
    Merge endpoints within tolerance at their centroid and update segment ends
    so topologically connected features share exactly the same coordinates.
    """
    # Collect all endpoints.
    endpoints: List[Tuple[float, float]] = []
    ep_indices: List[Tuple[int, str]] = []  # (segment_idx, 'start'|'end')
    for i, seg in enumerate(segments):
        endpoints.append(seg.start)
        ep_indices.append((i, 'start'))
        endpoints.append(seg.end)
        ep_indices.append((i, 'end'))

    if not endpoints:
        return segments

    # Use an STRtree to find endpoints within tolerance.
    points = [Point(p) for p in endpoints]
    tree = STRtree(points)

    uf = _UnionFind()
    for i, pt in enumerate(points):
        # The query returns neighboring-point indices.
        nearby = tree.query(pt, predicate="dwithin", distance=tolerance)
        for j in nearby:
            if j != i:
                uf.union(i, j)

    # Calculate a centroid for each equivalence class.
    groups: Dict[int, List[int]] = {}
    for i in range(len(endpoints)):
        root = uf.find(i)
        groups.setdefault(root, []).append(i)

    centroid_map: Dict[int, Tuple[float, float]] = {}
    for root, members in groups.items():
        cx = np.mean([endpoints[m][0] for m in members])
        cy = np.mean([endpoints[m][1] for m in members])
        centroid = (float(cx), float(cy))
        for m in members:
            centroid_map[m] = centroid

    # Update segment endpoints.
    result: List[WaySegment] = []
    for i, seg in enumerate(segments):
        coords = list(seg.line_2d.coords)
        start_idx = i * 2
        end_idx = i * 2 + 1

        new_start = centroid_map.get(start_idx, coords[0])
        new_end = centroid_map.get(end_idx, coords[-1])
        coords[0] = new_start
        coords[-1] = new_end

        new_line = LineString(coords)
        if new_line.length < 1e-6:
            continue

        result.append(WaySegment(
            line_2d=new_line,
            z_values=seg.z_values,
            original_id=seg.original_id,
            bridge=seg.bridge,
            osm_type=seg.osm_type,
        ))

    snapped_count = sum(1 for root, members in groups.items() if len(members) > 1)
    logger.info(f"[corridor/graph] endpoint snapping: {snapped_count} groups merged (tolerance={tolerance}m)")
    return result


# Resolve T-junctions.

def _resolve_t_junctions(
    segments: List[WaySegment],
    tolerance: float,
) -> List[WaySegment]:
    """
    Detect endpoints near the interior of another segment, split the host at
    the projected point, and align the incident endpoint to form a shared node.

    The result is a standard endpoint connection that later crossing detection skips.
    """
    lines = [seg.line_2d for seg in segments]
    tree = STRtree(lines)

    # Map each host-segment index to its projected split points.
    splits_map: Dict[int, List[Point]] = {}
    # Collect endpoint-alignment tuples: segment index, endpoint name, and coordinate.
    endpoint_updates: List[Tuple[int, str, Tuple[float, float]]] = []

    for i, seg in enumerate(segments):
        for which, ep_coord in [('start', seg.start), ('end', seg.end)]:
            ep = Point(ep_coord)

            # Query candidate segments within tolerance.
            nearby = tree.query(ep.buffer(tolerance), predicate="intersects")
            for j in nearby:
                if j == i:
                    continue

                other_seg = segments[j]
                other_line = lines[j]

                # Skip endpoint connections already handled by _snap_endpoints.
                if ep.distance(Point(other_seg.start)) < tolerance:
                    continue
                if ep.distance(Point(other_seg.end)) < tolerance:
                    continue

                # Check distance to the segment interior.
                if other_line.distance(ep) >= tolerance:
                    continue

                # Confirm the T-junction using the endpoint projection onto the host.
                proj_pt = other_line.interpolate(other_line.project(ep))

                splits_map.setdefault(j, []).append(proj_pt)
                endpoint_updates.append((i, which, (proj_pt.x, proj_pt.y)))

    if not splits_map and not endpoint_updates:
        logger.info("[corridor/graph] T-junction resolution: none found")
        return segments

    # Align incident endpoints to split points.
    updated_segments = list(segments)
    for seg_idx, which, new_coord in endpoint_updates:
        seg = updated_segments[seg_idx]
        coords = list(seg.line_2d.coords)
        if which == 'start':
            coords[0] = new_coord
        else:
            coords[-1] = new_coord
        updated_segments[seg_idx] = WaySegment(
            line_2d=LineString(coords),
            z_values=seg.z_values,
            original_id=seg.original_id,
            bridge=seg.bridge,
            osm_type=seg.osm_type,
        )

    # Split host segments with _split_segment_at_point.
    result: List[WaySegment] = []
    for i, seg in enumerate(updated_segments):
        if i not in splits_map:
            result.append(seg)
            continue

        pts = splits_map[i]
        # Split in descending along-line order to avoid index shifts.
        pts.sort(key=lambda p: seg.line_2d.project(p), reverse=True)

        current_segs = [seg]
        for pt in pts:
            new_segs: List[WaySegment] = []
            for s in current_segs:
                if s.line_2d.distance(pt) < 1.0:
                    new_segs.extend(_split_segment_at_point(s, pt))
                else:
                    new_segs.append(s)
            current_segs = new_segs

        result.extend(current_segs)

    t_count = len(endpoint_updates)
    logger.info(
        f"[corridor/graph] T-junction resolution: {t_count} T-junctions found, "
        f"{len(segments)} → {len(result)} segments"
    )
    return result


# Detect crossings and classify them by Z.

def _detect_and_classify_crossings(
    segments: List[WaySegment],
    z_threshold: float,
) -> Tuple[List[Tuple[int, int, Point, bool]], dict]:
    """
    Detect 2D crossings between segment pairs and classify them by Z difference.

    Returns:
      crossings: [(seg_i, seg_j, intersection_point, is_same_level), ...]
      stats: Summary statistics.
    """
    lines = [seg.line_2d for seg in segments]
    tree = STRtree(lines)
    crossings: List[Tuple[int, int, Point, bool]] = []
    same_level_count = 0
    multi_level_count = 0

    for i, line_a in enumerate(lines):
        candidates = tree.query(line_a, predicate="intersects")
        for j in candidates:
            if j <= i:
                continue
            line_b = lines[j]
            intersection = line_a.intersection(line_b)
            if intersection.is_empty:
                continue

            # Keep point crossings and skip linear overlaps.
            pts: List[Point] = []
            if intersection.geom_type == 'Point':
                pts = [intersection]
            elif intersection.geom_type == 'MultiPoint':
                pts = list(intersection.geoms)

            for pt in pts:
                # Endpoint connections are handled by graph connectivity and need no split.
                dist_to_start_a = pt.distance(Point(segments[i].start))
                dist_to_end_a = pt.distance(Point(segments[i].end))
                dist_to_start_b = pt.distance(Point(segments[j].start))
                dist_to_end_b = pt.distance(Point(segments[j].end))
                min_endpoint_dist = min(dist_to_start_a, dist_to_end_a, dist_to_start_b, dist_to_end_b)
                # Skip crossings near already-snapped endpoints.
                if min_endpoint_dist < 0.5:
                    continue

                # Interpolate both lines' Z values at the crossing.
                z_a = segments[i].interpolate_z_at(pt)
                z_b = segments[j].interpolate_z_at(pt)
                is_same_level = abs(z_a - z_b) < z_threshold

                crossings.append((i, j, pt, is_same_level))
                if is_same_level:
                    same_level_count += 1
                else:
                    multi_level_count += 1

    logger.info(
        f"[corridor/graph] crossings detected: same_level={same_level_count}, "
        f"multi_level={multi_level_count}"
    )
    return crossings, {"same_level": same_level_count, "multi_level": multi_level_count}


# Split at same-level crossings.

def _split_segment_at_point(seg: WaySegment, pt: Point) -> List[WaySegment]:
    """Split a WaySegment at a point while preserving interpolated Z values."""
    # Snap the crossing exactly onto the line.
    snapped_line = snap(seg.line_2d, pt, tolerance=1.0)

    try:
        result = split(snapped_line, pt)
    except Exception:
        # Return the original segment if splitting fails on degenerate geometry.
        return [seg]

    parts: List[WaySegment] = []
    for part_geom in result.geoms:
        if part_geom.geom_type != 'LineString' or part_geom.length < 1e-6:
            continue

        # Interpolate Z for every child-segment vertex.
        sub_z: List[float] = [seg.interpolate_z_at(Point(coord)) for coord in part_geom.coords]

        parts.append(WaySegment(
            line_2d=part_geom,
            z_values=sub_z,
            original_id=seg.original_id,
            bridge=seg.bridge,
            osm_type=seg.osm_type,
        ))

    return parts if parts else [seg]


def _selective_noding(
    segments: List[WaySegment],
    crossings: List[Tuple[int, int, Point, bool]],
) -> List[WaySegment]:
    """Split segments only at same-level crossings."""
    # Group split points by segment index.
    split_points: Dict[int, List[Point]] = {}
    for seg_i, seg_j, pt, is_same_level in crossings:
        if not is_same_level:
            continue
        split_points.setdefault(seg_i, []).append(pt)
        split_points.setdefault(seg_j, []).append(pt)

    if not split_points:
        logger.info("[corridor/graph] no same-level crossings to node")
        return segments

    result: List[WaySegment] = []
    for i, seg in enumerate(segments):
        if i not in split_points:
            result.append(seg)
            continue

        # Process split points from the end of the segment to avoid index shifts.
        pts = split_points[i]
        # Sort by descending along-line distance.
        pts.sort(key=lambda p: seg.line_2d.project(p), reverse=True)

        current_segs = [seg]
        for pt in pts:
            new_segs: List[WaySegment] = []
            for s in current_segs:
                # Split only the child segment containing the point.
                if s.line_2d.distance(pt) < 1.0:
                    new_segs.extend(_split_segment_at_point(s, pt))
                else:
                    new_segs.append(s)
            current_segs = new_segs

        result.extend(current_segs)

    logger.info(
        f"[corridor/graph] selective noding: {len(segments)} → {len(result)} segments "
        f"(split at {len(split_points)} lines)"
    )
    return result


# Build the NetworkX graph.

def _round_coord(coord: Tuple[float, float], precision: int = 3) -> Tuple[float, float]:
    """Round coordinates to millimetres for stable endpoint matching."""
    return (round(coord[0], precision), round(coord[1], precision))


def _osm_type_priority(osm_type: str) -> int:
    return 2 if osm_type == "walkway_step" else 1


def _should_replace_duplicate_edge(existing: dict, candidate: dict) -> bool:
    existing_priority = _osm_type_priority(str(existing.get("osm_type", "")))
    candidate_priority = _osm_type_priority(str(candidate.get("osm_type", "")))
    if candidate_priority != existing_priority:
        return candidate_priority > existing_priority

    existing_valid = int(existing.get("valid_sample_count", 0))
    candidate_valid = int(candidate.get("valid_sample_count", 0))
    if candidate_valid != existing_valid:
        return candidate_valid > existing_valid

    return float(candidate.get("length", 0.0)) > float(existing.get("length", 0.0))


def _build_graph(segments: List[WaySegment]) -> nx.Graph:
    """Build a NetworkX graph from WaySegments."""
    G = nx.Graph()
    duplicate_count = 0
    duplicate_replaced = 0

    for i, seg in enumerate(segments):
        start = _round_coord(seg.start)
        end = _round_coord(seg.end)

        # Avoid self-loops.
        if start == end:
            continue

        edge_attrs = {
            "edge_id": i,
            "geometry": seg.line_2d,
            "z_values": seg.z_values,
            "original_id": seg.original_id,
            "bridge": seg.bridge,
            "osm_type": seg.osm_type,
            "length": seg.line_2d.length,
            "valid_sample_count": sum(1 for z in seg.z_values if z > 0),
        }

        if G.has_edge(start, end):
            duplicate_count += 1
            if not _should_replace_duplicate_edge(G.edges[start, end], edge_attrs):
                continue
            duplicate_replaced += 1

        G.add_edge(start, end, **edge_attrs)

    components = list(nx.connected_components(G))
    logger.info(
        f"[corridor/graph] graph built: {G.number_of_nodes()} nodes, "
        f"{G.number_of_edges()} edges, {len(components)} components"
    )
    if duplicate_count:
        logger.info(
            f"[corridor/graph] duplicate graph edges resolved: "
            f"{duplicate_count} duplicates, {duplicate_replaced} replaced by source/quality priority"
        )

    # Label every edge and node with its connected component.
    for comp_id, comp_nodes in enumerate(components):
        for node in comp_nodes:
            G.nodes[node]['component'] = comp_id
        for u, v in G.subgraph(comp_nodes).edges():
            G.edges[u, v]['component'] = comp_id

    return G


# Fit Z globally with least squares.

# Residual threshold in metres; larger residuals are rejected before the second fit.
_Z_FIT_RESIDUAL_THRESHOLD = 2.0
_STEPS_OSM_TYPE = "walkway_step"


def _edge_key(u: Tuple[float, float], v: Tuple[float, float]) -> Tuple[Tuple[float, float], Tuple[float, float]]:
    return (u, v) if u <= v else (v, u)


def _median(values: List[float]) -> float:
    return float(np.median(values)) if values else 0.0


def _detect_suspicious_slope_edges(
    sub: nx.Graph,
    node_to_idx: Dict,
    node_z: np.ndarray,
    threshold_gradient: float,
) -> Set[Tuple[Tuple[float, float], Tuple[float, float]]]:
    """Identify extreme slopes on non-step edges while preserving step semantics."""
    suspicious: Set[Tuple[Tuple[float, float], Tuple[float, float]]] = set()
    for u, v, data in sub.edges(data=True):
        if data.get("osm_type") == _STEPS_OSM_TYPE:
            continue
        edge_len = float(data.get("length", 0.0))
        if edge_len < 1e-6:
            continue
        slope = abs(float(node_z[node_to_idx[u]]) - float(node_z[node_to_idx[v]])) / edge_len
        if slope > threshold_gradient:
            suspicious.add(_edge_key(u, v))
    return suspicious


def _propagate_node_z(
    sub: nx.Graph,
    seed_z: Dict[Tuple[float, float], float],
) -> Dict[Tuple[float, float], float]:
    """Propagate flat elevations through the graph, using the median for equidistant sources."""
    if not seed_z:
        return {}

    candidates: Dict[Tuple[float, float], List[float]] = defaultdict(list)
    best_dist: Dict[Tuple[float, float], int] = {}
    queue = deque()

    for node, z in seed_z.items():
        if node not in sub:
            continue
        best_dist[node] = 0
        candidates[node].append(float(z))
        queue.append((node, float(z), 0))

    while queue:
        node, z, dist = queue.popleft()
        next_dist = dist + 1
        for neighbor in sub.neighbors(node):
            known_dist = best_dist.get(neighbor)
            if known_dist is None or next_dist < known_dist:
                best_dist[neighbor] = next_dist
                candidates[neighbor] = [z]
                queue.append((neighbor, z, next_dist))
            elif next_dist == known_dist and z not in candidates[neighbor]:
                candidates[neighbor].append(z)
                queue.append((neighbor, z, next_dist))

    return {node: _median(values) for node, values in candidates.items()}


def _rewrite_edge_z_from_nodes(
    G: nx.Graph,
    sub: nx.Graph,
    node_z_map: Dict[Tuple[float, float], float],
) -> int:
    """Rewrite edge Z values by linear interpolation between fitted node elevations."""
    fitted = 0
    for u, v, data in sub.edges(data=True):
        if u not in G or v not in G or not G.has_edge(u, v):
            continue
        if u not in node_z_map or v not in node_z_map:
            continue
        if 'original_z_values' not in data:
            G.edges[u, v]['original_z_values'] = list(data['z_values'])

        geom: LineString = data['geometry']
        geom_start = Point(geom.coords[0])
        if geom_start.distance(Point(u)) <= geom_start.distance(Point(v)):
            z_start, z_end = node_z_map[u], node_z_map[v]
        else:
            z_start, z_end = node_z_map[v], node_z_map[u]

        total_len = geom.length
        new_z = []
        cum_dist = 0.0
        coords = list(geom.coords)
        for k in range(len(coords)):
            if k > 0:
                cum_dist += Point(coords[k - 1]).distance(Point(coords[k]))
            t = cum_dist / total_len if total_len > 1e-9 else 0.0
            t = max(0.0, min(1.0, t))
            new_z.append(z_start + t * (z_end - z_start))

        G.edges[u, v]['z_values'] = new_z
        fitted += 1

    for node, z in node_z_map.items():
        if node in G:
            G.nodes[node]['z'] = round(float(z), 3)

    return fitted


def _fit_z_global(G: nx.Graph, suspicious_slope_threshold_deg: float = 45.0) -> None:
    """
    Fit node elevations globally by least squares within each connected component.

    Treat node Z values as unknowns. Every valid non-building sample with Z > 0
    contributes z_sample ≈ (1-t)*z_a + t*z_b. Solve the overdetermined system,
    reject large residuals, refit, and rewrite edge Z values from the fitted nodes.
    """
    threshold_gradient = math.tan(math.radians(suspicious_slope_threshold_deg))
    components = list(nx.connected_components(G))
    total_fitted = 0
    total_removed = 0
    total_suspicious_edges = 0
    total_removed_components = 0

    for comp_nodes in components:
        comp_nodes = [node for node in comp_nodes if node in G]
        sub = G.subgraph(comp_nodes)
        nodes = list(sub.nodes())
        if len(nodes) < 2:
            continue

        node_to_idx = {n: i for i, n in enumerate(nodes)}
        n_nodes = len(nodes)

        samples = _collect_edge_samples(sub, node_to_idx)
        if not samples:
            continue

        # First fit.
        node_z = _solve_node_z(samples, n_nodes)
        if node_z is None:
            continue

        # Reject large residuals.
        filtered_samples = []
        removed = 0
        for row_idx_a, row_idx_b, t, z_obs, edge_key in samples:
            z_pred = (1 - t) * node_z[row_idx_a] + t * node_z[row_idx_b]
            if abs(z_obs - z_pred) <= _Z_FIT_RESIDUAL_THRESHOLD:
                filtered_samples.append((row_idx_a, row_idx_b, t, z_obs, edge_key))
            else:
                removed += 1

        total_removed += removed

        # Remove edges for which every sample was rejected. An endpoint-index
        # pair in filtered_samples indicates that the edge still has support.
        surviving_pairs = {
            edge_key for _, _, _, _, edge_key in filtered_samples
        }
        edges_to_remove = [
            (u, v) for u, v in sub.edges()
            if _edge_key(u, v) not in surviving_pairs
        ]
        if edges_to_remove:
            G.remove_edges_from(edges_to_remove)
            isolated = list(nx.isolates(G))
            G.remove_nodes_from(isolated)
            logger.info(
                f"[corridor/graph] removed {len(edges_to_remove)} unreliable edges "
                f"(all samples outliers after pass 1), {len(isolated)} isolated nodes cleaned"
            )

        comp_nodes = [node for node in comp_nodes if node in G]
        sub = G.subgraph(comp_nodes)
        nodes = list(sub.nodes())
        if len(nodes) < 2 or sub.number_of_edges() == 0:
            continue

        node_to_idx = {n: i for i, n in enumerate(nodes)}
        n_nodes = len(nodes)
        current_samples = _collect_edge_samples(sub, node_to_idx)
        if not current_samples:
            continue

        diagnostic_node_z = _solve_node_z(current_samples, n_nodes)
        if diagnostic_node_z is None:
            continue

        suspicious_edges = _detect_suspicious_slope_edges(
            sub, node_to_idx, diagnostic_node_z, threshold_gradient
        )
        total_suspicious_edges += len(suspicious_edges)

        if suspicious_edges and len(suspicious_edges) == sub.number_of_edges():
            G.remove_edges_from(list(sub.edges()))
            isolated = list(nx.isolates(G))
            G.remove_nodes_from(isolated)
            total_removed_components += 1
            logger.info(
                f"[corridor/graph] removed fully suspicious component: "
                f"{len(suspicious_edges)} edges, {len(isolated)} isolated nodes cleaned"
            )
            continue

        filtered_current_samples = []
        for row_idx_a, row_idx_b, t, z_obs, edge_key in current_samples:
            z_pred = (1 - t) * diagnostic_node_z[row_idx_a] + t * diagnostic_node_z[row_idx_b]
            if abs(z_obs - z_pred) <= _Z_FIT_RESIDUAL_THRESHOLD:
                filtered_current_samples.append((row_idx_a, row_idx_b, t, z_obs, edge_key))

        final_samples = [
            sample for sample in filtered_current_samples
            if sample[4] not in suspicious_edges
        ]
        if not final_samples:
            continue

        final_node_z = _solve_node_z(final_samples, n_nodes)
        if final_node_z is None:
            continue

        constrained_indices = set()
        for idx_a, idx_b, _, _, _ in final_samples:
            constrained_indices.add(idx_a)
            constrained_indices.add(idx_b)

        seed_z = {
            node: float(final_node_z[idx])
            for node, idx in node_to_idx.items()
            if idx in constrained_indices
        }
        node_z_map = _propagate_node_z(sub, seed_z)
        total_fitted += _rewrite_edge_z_from_nodes(G, sub, node_z_map)

    logger.info(
        f"[corridor/graph] global Z fit: {total_fitted} edges fitted, "
        f"{total_removed} outlier samples removed in pass 2, "
        f"{total_suspicious_edges} suspicious slope edges, "
        f"{total_removed_components} fully suspicious components removed"
    )


# Thresholds for suspicious leaf nodes.
_LEAF_MAX_VALID_SAMPLES = 6   # Fewer samples are considered insufficient evidence.
_LEAF_MAX_GRADIENT = 0.4      # Larger fitted gradients (m/m) are considered anomalous.


def _correct_suspicious_leaf_nodes(G: nx.Graph) -> None:
    """
    Correct suspicious leaf-node Z values.

    Degree-one nodes lack global LSQR constraints. If their edge has few valid
    samples and an excessive fitted gradient, assign the neighboring node's Z
    as a conservative flat-elevation assumption.
    """
    corrected = 0
    for node in list(G.nodes()):
        if G.degree(node) != 1:
            continue

        neighbors = list(G.neighbors(node))
        if not neighbors:
            continue
        neighbor = neighbors[0]

        edge_data = G.edges[node, neighbor]
        n_valid = edge_data.get('valid_sample_count', 0)
        if n_valid >= _LEAF_MAX_VALID_SAMPLES:
            continue  # Sufficient samples support the LSQR result.

        z_leaf = G.nodes[node].get('z', 0.0)
        z_neighbor = G.nodes[neighbor].get('z', 0.0)
        edge_len = edge_data.get('length', 0.0)
        if edge_len < 1e-6:
            continue

        gradient = abs(z_leaf - z_neighbor) / edge_len
        if gradient <= _LEAF_MAX_GRADIENT:
            continue  # A normal gradient supports the LSQR result.

        # Replace an under-supported steep leaf with its neighbor's Z and rewrite the edge.
        G.nodes[node]['z'] = z_neighbor
        n_pts = len(edge_data.get('geometry').coords)
        G.edges[node, neighbor]['z_values'] = [z_neighbor] * n_pts
        corrected += 1
        logger.debug(
            f"[corridor/graph] leaf node corrected: "
            f"z {z_leaf:.2f}→{z_neighbor:.2f}, gradient={gradient:.2f}, n_valid={n_valid}"
        )

    if corrected:
        logger.info(f"[corridor/graph] suspicious leaf nodes corrected: {corrected}")


def _collect_edge_samples(
    sub: nx.Graph,
    node_to_idx: Dict,
) -> List[Tuple[int, int, float, float, Tuple[Tuple[float, float], Tuple[float, float]]]]:
    """
    Collect valid edge samples as
    (node_idx_a, node_idx_b, t, z_observed, edge_key), where t is in [0, 1].
    """
    samples = []
    for u, v, data in sub.edges(data=True):
        edge_key = _edge_key(u, v)
        z_vals = data.get('z_values', [])
        geom: LineString = data['geometry']
        total_len = geom.length
        if total_len < 1e-9 or not z_vals:
            continue

        coords = list(geom.coords)
        # Align geometry direction with graph endpoints (u, v).
        geom_start = Point(coords[0])
        if geom_start.distance(Point(u)) <= geom_start.distance(Point(v)):
            idx_start, idx_end = node_to_idx[u], node_to_idx[v]
        else:
            idx_start, idx_end = node_to_idx[v], node_to_idx[u]

        cum_dist = 0.0
        for k in range(len(coords)):
            if k > 0:
                cum_dist += Point(coords[k - 1]).distance(Point(coords[k]))

            # Skip invalid samples; Z=0 means no mesh observation.
            z = z_vals[k] if k < len(z_vals) else 0.0
            if z <= 0:
                continue

            t = cum_dist / total_len
            t = max(0.0, min(1.0, t))
            samples.append((idx_start, idx_end, t, z, edge_key))

    return samples


def _solve_node_z(
    samples: List[Tuple[int, int, float, float, Tuple[Tuple[float, float], Tuple[float, float]]]],
    n_nodes: int,
) -> Optional[np.ndarray]:
    """
    Solve the least-squares problem for node elevations.

    Each sample (idx_a, idx_b, t, z, edge_key) contributes one row:
        (1-t) * z_a + t * z_b = z
    Assemble sparse A·x = b and solve it with LSQR.
    """
    n_samples = len(samples)
    if n_samples < 1:
        return None

    # Build a COO sparse matrix.
    rows = []
    cols = []
    vals = []
    rhs = np.zeros(n_samples)

    for i, (idx_a, idx_b, t, z_obs, _edge_key_value) in enumerate(samples):
        rows.append(i)
        cols.append(idx_a)
        vals.append(1.0 - t)

        rows.append(i)
        cols.append(idx_b)
        vals.append(t)

        rhs[i] = z_obs

    A = sparse.coo_matrix((vals, (rows, cols)), shape=(n_samples, n_nodes)).tocsr()

    # LSQR is suitable for large sparse overdetermined systems.
    result = lsqr(A, rhs)
    node_z = result[0]

    return node_z


# Build planar geometry by connected component.

def _build_footprints(G: nx.Graph) -> tuple[dict, dict]:
    """
    Build 2D footprints per connected component. Offset each edge independently
    by its left and right widths, union strips within the component, and return
    the result as a WGS84 GeoJSON FeatureCollection.

    Returns:
        (footprints_geojson, strips_geojson): merged footprints and pre-union strips.
    """
    components = list(nx.connected_components(G))
    features = []
    strip_features = []  # Individual pre-union strips for diagnostics.

    for comp_id, comp_nodes in enumerate(components):
        subgraph = G.subgraph(comp_nodes)
        strips = []
        color = _COMPONENT_COLORS[comp_id % len(_COMPONENT_COLORS)]

        for u, v, data in subgraph.edges(data=True):
            geom: LineString = data['geometry']
            wl: float = data.get('width_left', 2.5)
            wr: float = data.get('width_right', 2.5)
            if geom.length < 1e-6 or (wl <= 0 and wr <= 0):
                continue

            # Extend along endpoint tangents so adjacent strips overlap for union.
            EXTEND_M = max(wl, wr) * 0.3  # 30% of the larger side width.
            coords_list = list(geom.coords)
            # Extend the start outward.
            x0, y0 = coords_list[0]
            x1, y1 = coords_list[1]
            dx, dy = x0 - x1, y0 - y1
            seg_len = (dx * dx + dy * dy) ** 0.5
            if seg_len > 1e-9:
                coords_list[0] = (x0 + dx / seg_len * EXTEND_M, y0 + dy / seg_len * EXTEND_M)
            # Extend the end outward.
            xn, yn = coords_list[-1]
            xn1, yn1 = coords_list[-2]
            dx, dy = xn - xn1, yn - yn1
            seg_len = (dx * dx + dy * dy) ** 0.5
            if seg_len > 1e-9:
                coords_list[-1] = (xn + dx / seg_len * EXTEND_M, yn + dy / seg_len * EXTEND_M)
            geom = LineString(coords_list)

            # Build an asymmetric strip; positive offset_curve is left and negative is right.
            def _safe_offset(line: LineString, distance: float) -> LineString:
                """Offset the line, falling back to the centerline if the result collapses."""
                if distance == 0:
                    return line
                raw = line.offset_curve(distance, join_style=2, mitre_limit=5.0)
                if raw.is_empty:
                    return line
                # Merge MultiLineString results.
                if isinstance(raw, MultiLineString):
                    merged = linemerge(raw)
                    if isinstance(merged, MultiLineString):
                        coords = []
                        for part in merged.geoms:
                            coords.extend(part.coords)
                        return LineString(coords) if len(coords) >= 2 else line
                    return merged
                return raw

            left_line = _safe_offset(geom, wl)
            right_line = _safe_offset(geom, -wr)

            # Join forward left and reversed right offsets into a closed polygon.
            strip = Polygon(
                list(left_line.coords) + list(right_line.coords)[::-1]
            )
            if not strip.is_valid:
                strip = strip.buffer(0)
            if not strip.is_empty:
                strips.append(strip)

                # Export each strip as a WGS84 GeoJSON feature.
                if isinstance(strip, Polygon):
                    ext_wgs = []
                    for x, y in strip.exterior.coords:
                        lon, lat = to_lonlat.transform(x, y)
                        ext_wgs.append([round(lon, 8), round(lat, 8)])
                    strip_features.append({
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [ext_wgs]},
                        "properties": {
                            "component": comp_id,
                            "color": color,
                            "original_id": data.get("original_id", ""),
                            "width_left": round(wl, 2),
                            "width_right": round(wr, 2),
                            "length": round(geom.length, 2),
                        },
                    })

        if not strips:
            continue

        # Union all strips in the connected component.
        footprint = unary_union(strips)
        if footprint.is_empty:
            continue

        # Repair invalid geometry.
        if not footprint.is_valid:
            footprint = footprint.buffer(0)

        # Extract polygonal components.
        polys: list[Polygon] = []
        if isinstance(footprint, Polygon):
            polys = [footprint]
        elif isinstance(footprint, MultiPolygon):
            polys = list(footprint.geoms)

        color = _COMPONENT_COLORS[comp_id % len(_COMPONENT_COLORS)]

        for poly in polys:
            # Transform back to WGS84.
            exterior_wgs84 = []
            for x, y in poly.exterior.coords:
                lon, lat = to_lonlat.transform(x, y)
                exterior_wgs84.append([round(lon, 8), round(lat, 8)])

            holes_wgs84 = []
            for interior in poly.interiors:
                ring_wgs84 = []
                for x, y in interior.coords:
                    lon, lat = to_lonlat.transform(x, y)
                    ring_wgs84.append([round(lon, 8), round(lat, 8)])
                holes_wgs84.append(ring_wgs84)

            coords = [exterior_wgs84] + holes_wgs84

            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": coords,
                },
                "properties": {
                    "component": comp_id,
                    "color": color,
                },
            })

    logger.info(f"[corridor/graph] footprints built: {len(features)} polygons from {len(components)} components, {len(strip_features)} strips (pre-union)")

    footprints_geojson = {
        "type": "FeatureCollection",
        "features": features,
    }
    strips_geojson = {
        "type": "FeatureCollection",
        "features": strip_features,
    }
    return footprints_geojson, strips_geojson


def build_corridor_footprints(edges: list) -> tuple[dict, dict]:
    """
    Public API for building 2D corridor footprints from width-enabled edges.

    The Node service supplies WGS84 coordinates, widths, and components. Project
    them to EPSG:2326 and apply the same strip-and-union logic as _build_footprints.

    Args:
        edges: [{ coords_wgs84, width_left, width_right, component }, ...]

    Returns:
        (footprints_geojson, strips_geojson)
    """
    # Group by component and bridge type so each type is unioned independently.
    group_key_edges: Dict[tuple, list] = {}
    for edge in edges:
        comp_id = edge.get("component", 0)
        bridge = edge.get("bridge", "")
        group_key_edges.setdefault((comp_id, bridge), []).append(edge)

    features = []
    strip_features = []

    for (comp_id, bridge) in sorted(group_key_edges.keys()):
        group = group_key_edges[(comp_id, bridge)]
        strips = []
        color = _COMPONENT_COLORS[comp_id % len(_COMPONENT_COLORS)]

        for edge in group:
            edge_index = edge.get("edge_index", 0)
            coords_wgs84 = edge["coords_wgs84"]
            wl: float = edge.get("width_left", 2.5)
            wr: float = edge.get("width_right", 2.5)

            # Project to EPSG:2326.
            coords_2326 = []
            for c in coords_wgs84:
                x, y = to_local_projected.transform(float(c[0]), float(c[1]))
                coords_2326.append((x, y))
            if len(coords_2326) < 2:
                continue
            geom = LineString(coords_2326)
            if geom.length < 1e-6 or (wl <= 0 and wr <= 0):
                continue

            # Extend endpoints so adjacent strips overlap for union.
            EXTEND_M = max(wl, wr) * 0.3
            coords_list = list(geom.coords)
            x0, y0 = coords_list[0]
            x1, y1 = coords_list[1]
            dx, dy = x0 - x1, y0 - y1
            seg_len = (dx * dx + dy * dy) ** 0.5
            if seg_len > 1e-9:
                coords_list[0] = (x0 + dx / seg_len * EXTEND_M, y0 + dy / seg_len * EXTEND_M)
            xn, yn = coords_list[-1]
            xn1, yn1 = coords_list[-2]
            dx, dy = xn - xn1, yn - yn1
            seg_len = (dx * dx + dy * dy) ** 0.5
            if seg_len > 1e-9:
                coords_list[-1] = (xn + dx / seg_len * EXTEND_M, yn + dy / seg_len * EXTEND_M)
            geom = LineString(coords_list)

            # Build an asymmetrically offset strip.
            def _safe_offset(line: LineString, distance: float) -> LineString:
                if distance == 0:
                    return line
                raw = line.offset_curve(distance, join_style=2, mitre_limit=5.0)
                if raw.is_empty:
                    return line
                if isinstance(raw, MultiLineString):
                    merged = linemerge(raw)
                    if isinstance(merged, MultiLineString):
                        coords = []
                        for part in merged.geoms:
                            coords.extend(part.coords)
                        return LineString(coords) if len(coords) >= 2 else line
                    return merged
                return raw

            left_line = _safe_offset(geom, wl)
            right_line = _safe_offset(geom, -wr)

            strip = Polygon(list(left_line.coords) + list(right_line.coords)[::-1])
            if not strip.is_valid:
                strip = strip.buffer(0)
            if not strip.is_empty:
                strips.append(strip)

                # Export each strip as a WGS84 GeoJSON diagnostic feature.
                if isinstance(strip, Polygon):
                    ext_wgs = []
                    for x, y in strip.exterior.coords:
                        lon, lat = to_lonlat.transform(x, y)
                        ext_wgs.append([round(lon, 8), round(lat, 8)])
                    strip_features.append({
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [ext_wgs]},
                        "properties": {
                            "edge_index": edge_index,
                            "component": comp_id,
                            "bridge": bridge,
                            "color": color,
                            "width_left": round(wl, 2),
                            "width_right": round(wr, 2),
                            "projected_exterior": [[round(x, 4), round(y, 4)] for x, y in strip.exterior.coords],
                        },
                    })

        if not strips:
            continue

        footprint = unary_union(strips)
        if footprint.is_empty:
            continue
        if not footprint.is_valid:
            footprint = footprint.buffer(0)

        polys: list[Polygon] = []
        if isinstance(footprint, Polygon):
            polys = [footprint]
        elif isinstance(footprint, MultiPolygon):
            polys = list(footprint.geoms)

        for poly in polys:
            exterior_wgs84 = []
            for x, y in poly.exterior.coords:
                lon, lat = to_lonlat.transform(x, y)
                exterior_wgs84.append([round(lon, 8), round(lat, 8)])
            holes_wgs84 = []
            for interior in poly.interiors:
                ring_wgs84 = []
                for x, y in interior.coords:
                    lon, lat = to_lonlat.transform(x, y)
                    ring_wgs84.append([round(lon, 8), round(lat, 8)])
                holes_wgs84.append(ring_wgs84)
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [exterior_wgs84] + holes_wgs84},
                "properties": {"component": comp_id, "bridge": bridge, "color": color},
            })

    logger.info(
        f"[corridor/graph] footprints built: {len(features)} polygons from "
        f"{len(group_key_edges)} (component, bridge) groups, {len(strip_features)} strips (pre-union)"
    )
    return (
        {"type": "FeatureCollection", "features": features},
        {"type": "FeatureCollection", "features": strip_features},
    )


# Export GeoJSON.

# High-contrast colors for connected components.
_COMPONENT_COLORS = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
    "#dcbeff", "#9A6324", "#fffac8", "#800000", "#aaffc3",
    "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#000000",
]


def _graph_to_geojson(G: nx.Graph) -> dict:
    """Export a NetworkX graph as WGS84 GeoJSON."""
    features = []

    # Edges to LineStrings.
    for u, v, data in G.edges(data=True):
        geom: LineString = data['geometry']
        # Transform back to WGS84.
        coords_wgs84 = []
        z_vals = data.get('z_values', [])
        for idx, (x, y) in enumerate(geom.coords):
            lon, lat = to_lonlat.transform(x, y)
            z = z_vals[idx] if idx < len(z_vals) else 0.0
            coords_wgs84.append([round(lon, 8), round(lat, 8), round(z, 3)])

        comp_id = data.get('component', 0)
        color = _COMPONENT_COLORS[comp_id % len(_COMPONENT_COLORS)]

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": coords_wgs84,
            },
            "properties": {
                "type": "edge",
                "component": comp_id,
                "color": color,
                "original_id": data.get('original_id', -1),
                "length": round(data.get('length', 0), 2),
                "degree_start": G.degree(u),
                "degree_end": G.degree(v),
            },
        })

    # Nodes to Points.
    for node, data in G.nodes(data=True):
        x, y = node
        lon, lat = to_lonlat.transform(x, y)
        deg = G.degree(node)
        comp_id = data.get('component', 0)
        color = _COMPONENT_COLORS[comp_id % len(_COMPONENT_COLORS)]

        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(lon, 8), round(lat, 8)],
            },
            "properties": {
                "type": "node",
                "component": comp_id,
                "color": color,
                "degree": deg,
                "z": round(data.get('z', 0.0), 3),  # Least-squares fitted node Z.
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
    }


# Main entry point.

def build_corridor_graph(
    features: list,
    snap_tolerance: float,
    crossing_z_threshold: float,
    height_floor: float,
    height_cover: float,
    height_interior: float,
    suspicious_slope_threshold_deg: float = 45.0,
) -> Tuple[dict, dict]:
    """
    Main corridor graph-construction function.

    Args:
        features: Pydantic ElevatedWayFeature objects.
        snap_tolerance: Endpoint-snapping tolerance in projected metres.
        crossing_z_threshold: Z threshold for grade-separated crossings, in metres.
        height_floor: Floor-slab thickness in metres.
        height_cover: Cover-slab thickness in metres.
        height_interior: Interior clear height in metres.
        suspicious_slope_threshold_deg: Extreme-slope threshold for non-step edges.

    Returns:
        (geojson, edges_for_width, edges_z, nodes_z, stats)
    """
    logger.info(f"[corridor/graph] === START: {len(features)} input features ===")

    # Parse and project source features.
    segments = _parse_features(features)
    if not segments:
        empty = {"type": "FeatureCollection", "features": []}
        return empty, [], [], [], {
            "component_count": 0, "node_count": 0, "edge_count": 0,
        }

    # Snap endpoints.
    segments = _snap_endpoints(segments, snap_tolerance)

    # Split T-junction hosts and align incident endpoints.
    segments = _resolve_t_junctions(segments, snap_tolerance)

    # Detect and classify crossings by Z.
    crossings, crossing_stats = _detect_and_classify_crossings(segments, crossing_z_threshold)

    # Split selectively at same-level crossings.
    segments = _selective_noding(segments, crossings)

    # Build the graph.
    G = _build_graph(segments)

    # Remove edges with fewer than two valid samples and delete
    # isolated nodes; such edges cannot constrain the Z fit.
    edges_to_remove = [
        (u, v) for u, v, data in G.edges(data=True)
        if sum(1 for z in data.get('z_values', []) if z > 0) < 2
    ]
    if edges_to_remove:
        G.remove_edges_from(edges_to_remove)
        isolated = list(nx.isolates(G))
        G.remove_nodes_from(isolated)
        logger.info(
            f"[corridor/graph] removed {len(edges_to_remove)} edges with < 2 valid Z samples, "
            f"{len(isolated)} isolated nodes cleaned"
        )

    # Normalize sampled Z values to the floor_bottom datum. Covered
    # types sample the cover top, while viaducts sample the road surface.
    shift_full = height_cover + height_interior + height_floor  # Covered-type offset.
    shift_viaduct = height_floor                                 # Road-slab-only offset.
    corrected_count = 0
    for u, v, data in G.edges(data=True):
        # Preserve original sampled Z for Node-side width probing against the 3D mesh.
        data['original_z_values'] = list(data['z_values'])
        bridge = data.get('bridge', '')
        shift = shift_viaduct if bridge == 'viaduct' else shift_full
        # Normalize only valid samples; Z=0 means no observation.
        data['z_values'] = [
            z - shift if z > 0 else 0.0 for z in data['z_values']
        ]
        corrected_count += 1
    logger.info(
        f"[corridor/graph] Z baseline correction: {corrected_count} edges normalized to floor_bottom "
        f"(shift_full={shift_full:.2f}m, shift_viaduct={shift_viaduct:.2f}m)"
    )

    # Fit Z globally within each connected component.
    _fit_z_global(G, suspicious_slope_threshold_deg)

    # Correct under-supported, steep leaf nodes from their neighbors.
    _correct_suspicious_leaf_nodes(G)

    # Reassign component IDs after edge and residual filtering may have changed connectivity.
    for comp_id, comp_nodes in enumerate(nx.connected_components(G)):
        for node in comp_nodes:
            G.nodes[node]['component'] = comp_id
        for u, v in G.subgraph(comp_nodes).edges():
            G.edges[u, v]['component'] = comp_id

    # Export graph GeoJSON.
    geojson = _graph_to_geojson(G)

    # Export WGS84 edges, original Z, and components for Node-side width sampling.
    edges_for_width = []
    edges_z = []
    for edge_index, (u, v, data) in enumerate(G.edges(data=True)):
        geom: LineString = data['geometry']
        z_vals = data.get('z_values', [])
        original_z = data.get('original_z_values', data.get('z_values', []))
        comp = data.get('component', 0)

        # WGS84 coordinates and original Z values for width sampling.
        coords_wgs84 = []
        for x, y in geom.coords:
            lon, lat = to_lonlat.transform(x, y)
            coords_wgs84.append([round(lon, 8), round(lat, 8)])
        node_start_lon, node_start_lat = to_lonlat.transform(u[0], u[1])
        node_end_lon, node_end_lat = to_lonlat.transform(v[0], v[1])
        edges_for_width.append({
            "edge_index": edge_index,
            "coords_wgs84": coords_wgs84,
            "original_z": [round(z, 3) for z in original_z],
            "component": comp,
            "bridge": data.get("bridge", ""),
            "node_start": [round(node_start_lon, 8), round(node_start_lat, 8)],
            "node_end": [round(node_end_lon, 8), round(node_end_lat, 8)],
        })

        # EPSG:2326 centerline data for top-surface construction.
        coords_proj = [[round(x, 4), round(y, 4)] for x, y in geom.coords]
        z_list = [z_vals[i] if i < len(z_vals) else 0.0 for i in range(len(coords_proj))]
        edges_z.append({
            "edge_index": edge_index,
            "coords": coords_proj,
            "z_values": z_list,
            "component": comp,
            "bridge": data.get("bridge", ""),
        })

    # Export projected node Z, component, and degree data for node platforms.
    nodes_z = []
    for node, ndata in G.nodes(data=True):
        nodes_z.append({
            "coord": [round(node[0], 4), round(node[1], 4)],
            "z": round(ndata.get("z", 0.0), 3),
            "component": ndata.get("component", 0),
            "degree": G.degree(node),
        })

    components = list(nx.connected_components(G))
    stats = {
        "component_count": len(components),
        "node_count": G.number_of_nodes(),
        "edge_count": G.number_of_edges(),
        **crossing_stats,
    }

    logger.info(f"[corridor/graph] === DONE: {stats} ===")
    return geojson, edges_for_width, edges_z, nodes_z, stats
