"""Estimate main roof elevation for each tree range."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence

import numpy as np
from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.ops import transform as shapely_transform, unary_union

from core.building_roof.roof_top_extraction import ProjectedRoofTriangle, project_patch_geometry
from utils.geo import to_lonlat
from utils.mesh_clip import ClippedMeshTriangle, clip_triangle_to_polygonal_geometry, iter_polygonal_parts

DEFAULT_UNRESOLVED_ROOF_Z = -100000.0


@dataclass(frozen=True)
class RoofPlaneOptions:
    min_clipped_triangle_area_m2: float = 0.02
    min_abs_normal_z: float = 0.25
    terrain_clearance_m: float = 2.0
    eps_z_m: float = 0.3
    min_cluster_triangle_count: int = 2
    min_cluster_area_m2: float = 1.0
    cluster_shape_close_m: float = 0.4
    cluster_shape_open_m: float = 0.15
    cluster_simplify_m: float = 0.2
    min_cluster_component_area_m2: float = 1.0
    min_cluster_hole_area_m2: float = 1.0
    enhanced_terrain_clearance_m: float = 6.0
    enhanced_terrain_clearance_span_m: float = 8.0


@dataclass(frozen=True)
class RangeRoofTriangle:
    vertices: np.ndarray
    footprint: Polygon
    area: float
    z_mean: float
    z_min: float
    z_max: float
    normal_z: float


@dataclass
class RoofHeightCluster:
    cluster_id: int
    triangles: List[RangeRoofTriangle]
    raw_geometry: Polygon | MultiPolygon | None = None
    cleaned_geometry: Polygon | MultiPolygon | None = None
    visible_geometry: Polygon | MultiPolygon | None = None
    raw_area: float = 0.0
    cleaned_area: float = 0.0
    visible_area: float = 0.0
    cluster_z: float | None = None
    mad: float | None = None


@dataclass(frozen=True)
class RoofPlaneRangeResult:
    patch_id: str
    patch_index: int | None
    full_id: str | None
    osm_type: str | None
    tree_level: int | None
    parent_full_id: str | None
    geometry: Dict[str, Any] | None
    resolved: bool
    roof_z: float | None
    unresolved_reason: str | None
    tree_range_area: float
    roof_candidate_area: float
    main_cluster_area: float
    support_area_ratio: float
    raw_cluster_count: int
    sample_triangle_count: int
    main_cluster_triangle_count: int
    mad: float | None
    eps_z_m: float
    main_cluster_raw_area: float
    main_cluster_cleaned_area: float
    main_cluster_visible_area: float
    main_cluster_visible_geometry: Dict[str, Any] | None = None
    clusters: List[Dict[str, Any]] = field(default_factory=list)
    cluster_geometries: List[Dict[str, Any]] = field(default_factory=list)


def extract_patch_roof_planes(
    patch: Dict[str, Any],
    roof_triangles: Sequence[ProjectedRoofTriangle],
    offset_2326: Sequence[float],
    options: RoofPlaneOptions | None = None,
    cluster_mesh_writer: Any | None = None,
) -> List[RoofPlaneRangeResult]:
    opts = options or RoofPlaneOptions()
    patch_id = str(patch.get("patchId") or "")
    patch_index = patch.get("patchIndex")
    base_plane = _parse_base_plane(patch.get("basePlane") or patch.get("base_plane"))
    ranges = list(patch.get("treeRanges") or [])
    ranges.sort(key=lambda item: int(item.get("treeLevel") or 0), reverse=True)

    results: List[RoofPlaneRangeResult] = []
    for tree_range in ranges:
        sampling_geometry = tree_range.get("samplingGeometry")
        if not sampling_geometry:
            results.append(_unresolved_result(
                patch_id,
                patch_index,
                tree_range,
                0,
                opts,
                "missing_geometry",
                tree_range_area=0.0,
                offset_2326=offset_2326,
            ))
            continue

        range_geometry = project_patch_geometry(sampling_geometry, offset_2326)
        if range_geometry is None or range_geometry.is_empty:
            results.append(_unresolved_result(
                patch_id,
                patch_index,
                tree_range,
                0,
                opts,
                "invalid_geometry",
                tree_range_area=0.0,
                offset_2326=offset_2326,
            ))
            continue

        range_terrain_z = _range_terrain_z(range_geometry, base_plane)
        clipped = _collect_range_triangles(roof_triangles, range_geometry, range_terrain_z, opts)
        clusters = _build_height_clusters(clipped, range_geometry, opts)
        main_cluster = _select_main_cluster(clusters, range_terrain_z, opts)
        main_cluster_id = main_cluster.cluster_id if main_cluster is not None else None
        _write_cluster_mesh_diagnostics(
            cluster_mesh_writer,
            patch_id,
            int(patch_index) if patch_index is not None else None,
            tree_range,
            clusters,
            main_cluster_id,
        )

        if main_cluster is None:
            results.append(_unresolved_result(
                patch_id,
                patch_index,
                tree_range,
                len(clipped),
                opts,
                "no_valid_cluster",
                clusters,
                tree_range_area=_geometry_area(range_geometry),
                offset_2326=offset_2326,
            ))
            continue

        total_visible_area = sum(cluster.visible_area for cluster in clusters)
        support_area_ratio = (
            main_cluster.visible_area / total_visible_area
            if total_visible_area > 0
            else 0.0
        )
        roof_z = main_cluster.cluster_z
        mad = main_cluster.mad
        results.append(RoofPlaneRangeResult(
            patch_id=patch_id,
            patch_index=int(patch_index) if patch_index is not None else None,
            full_id=tree_range.get("fullId"),
            osm_type=tree_range.get("osmType"),
            tree_level=int(tree_range.get("treeLevel")) if tree_range.get("treeLevel") is not None else None,
            parent_full_id=tree_range.get("parentFullId"),
            geometry=sampling_geometry,
            resolved=roof_z is not None,
            roof_z=roof_z,
            unresolved_reason=None,
            tree_range_area=_geometry_area(range_geometry),
            roof_candidate_area=total_visible_area,
            main_cluster_area=main_cluster.visible_area,
            support_area_ratio=support_area_ratio,
            raw_cluster_count=len(clusters),
            sample_triangle_count=len(clipped),
            main_cluster_triangle_count=len(main_cluster.triangles),
            mad=mad,
            eps_z_m=opts.eps_z_m,
            main_cluster_raw_area=main_cluster.raw_area,
            main_cluster_cleaned_area=main_cluster.cleaned_area,
            main_cluster_visible_area=main_cluster.visible_area,
            main_cluster_visible_geometry=_local_geometry_to_lonlat_geojson(
                main_cluster.visible_geometry,
                offset_2326,
            ),
            clusters=[_cluster_summary(cluster) for cluster in clusters],
            cluster_geometries=_cluster_geometry_items(
                clusters,
                patch_id,
                patch_index,
                tree_range,
                offset_2326,
                main_cluster_id,
            ),
        ))

    return results


def _write_cluster_mesh_diagnostics(
    cluster_mesh_writer: Any | None,
    patch_id: str,
    patch_index: int | None,
    tree_range: Dict[str, Any],
    clusters: Sequence["RoofHeightCluster"],
    main_cluster_id: int | None,
) -> None:
    if cluster_mesh_writer is None or not clusters:
        return
    cluster_mesh_writer.write_tree_range_clusters(
        patch_id=patch_id,
        patch_index=patch_index,
        tree_range=tree_range,
        clusters=clusters,
        main_cluster_id=main_cluster_id,
    )


def build_roof_plane_cluster_geojson(results: Sequence[RoofPlaneRangeResult]) -> Dict[str, Any]:
    features = []
    for item in results:
        features.extend(item.cluster_geometries)
    return {"type": "FeatureCollection", "features": features}


def roof_plane_main_cluster_sampling_ranges(
    results: Sequence[RoofPlaneRangeResult],
    _offset_2326: Sequence[float],
) -> List[Dict[str, Any]]:
    ranges: List[Dict[str, Any]] = []
    for item in results:
        if item.full_id is None:
            continue
        geometry = item.main_cluster_visible_geometry if item.resolved else item.geometry
        if geometry is None:
            geometry = item.geometry
        if geometry is None:
            continue
        tree_range_area = float(item.tree_range_area or 0.0)
        main_area = float(item.main_cluster_visible_area or 0.0) if item.resolved else 0.0
        ranges.append({
            "patch_id": item.patch_id,
            "patch_index": item.patch_index,
            "full_id": item.full_id,
            "osm_type": item.osm_type,
            "tree_level": item.tree_level,
            "geometry": geometry,
            "tree_range_area": tree_range_area,
            "main_cluster_area": main_area,
            "main_cluster_area_ratio": main_area / tree_range_area if item.resolved and tree_range_area > 0 else 0.0,
        })
    return ranges


def _collect_range_triangles(
    roof_triangles: Sequence[ProjectedRoofTriangle],
    range_geometry: Polygon | MultiPolygon,
    terrain_z: float | None,
    opts: RoofPlaneOptions,
) -> List[RangeRoofTriangle]:
    output: List[RangeRoofTriangle] = []
    for source_triangle in roof_triangles:
        clipped = clip_triangle_to_polygonal_geometry(
            source_triangle.vertices,
            range_geometry,
            min_area_m2=opts.min_clipped_triangle_area_m2,
        )
        for clipped_triangle in clipped:
            item = _range_triangle_from_clipped(clipped_triangle)
            if item is None:
                continue
            if abs(item.normal_z) < opts.min_abs_normal_z:
                continue
            if terrain_z is not None and item.z_max <= terrain_z + opts.terrain_clearance_m:
                continue
            output.append(item)
    return output


def _parse_base_plane(value: Any) -> tuple[float, float, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        a = float(value.get("a"))
        b = float(value.get("b"))
        c = float(value.get("c"))
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(item) for item in (a, b, c)):
        return None
    return a, b, c


def _range_terrain_z(
    range_geometry: Polygon | MultiPolygon,
    base_plane: tuple[float, float, float] | None,
) -> float | None:
    """Use the low side of the local base plane as the near-terrain filter baseline."""
    if base_plane is None:
        return None

    a, b, c = base_plane
    values: List[float] = []
    polygons = [range_geometry] if isinstance(range_geometry, Polygon) else list(range_geometry.geoms)
    for poly in polygons:
        for x, y in list(poly.exterior.coords)[:-1]:
            values.append(float(a * x + b * y + c))
        for interior in poly.interiors:
            for x, y in list(interior.coords)[:-1]:
                values.append(float(a * x + b * y + c))
    finite_values = [value for value in values if math.isfinite(value)]
    return min(finite_values) if finite_values else None


def _range_triangle_from_clipped(clipped: ClippedMeshTriangle) -> RangeRoofTriangle | None:
    normal = np.cross(clipped.vertices[1] - clipped.vertices[0], clipped.vertices[2] - clipped.vertices[0])
    normal_length = float(np.linalg.norm(normal))
    if not math.isfinite(normal_length) or normal_length <= 0:
        return None
    z_values = clipped.vertices[:, 2]
    if not np.isfinite(z_values).all():
        return None
    return RangeRoofTriangle(
        vertices=clipped.vertices,
        footprint=clipped.footprint,
        area=clipped.area,
        z_mean=float(np.mean(z_values)),
        z_min=float(np.min(z_values)),
        z_max=float(np.max(z_values)),
        normal_z=float(normal[2] / normal_length),
    )


def _build_height_clusters(
    triangles: Sequence[RangeRoofTriangle],
    range_geometry: Polygon | MultiPolygon,
    opts: RoofPlaneOptions,
) -> List[RoofHeightCluster]:
    if not triangles:
        return []

    groups = _build_area_weighted_height_bands(triangles, opts.eps_z_m, opts.min_cluster_triangle_count)
    clusters: List[RoofHeightCluster] = []
    for group in groups:
        cluster_triangles = [triangles[index] for index in group]
        if len(cluster_triangles) < opts.min_cluster_triangle_count:
            continue
        cluster = RoofHeightCluster(cluster_id=len(clusters), triangles=cluster_triangles)
        _compute_cluster_geometry(cluster, range_geometry, opts)
        if cluster.cleaned_area < opts.min_cluster_area_m2:
            continue
        z_values = [tri.z_mean for tri in cluster.triangles]
        weights = [tri.area for tri in cluster.triangles]
        cluster.cluster_z = _weighted_median(z_values, weights)
        cluster.mad = _weighted_median([abs(z - cluster.cluster_z) for z in z_values], weights)
        clusters.append(cluster)

    _compute_visible_cluster_areas(clusters)
    return clusters


def _build_area_weighted_height_bands(
    triangles: Sequence[RangeRoofTriangle],
    band_width_m: float,
    min_triangle_count: int,
) -> List[List[int]]:
    """Build non-overlapping fixed-height bands by descending support area."""

    remaining = sorted(range(len(triangles)), key=lambda index: triangles[index].z_mean)
    groups: List[List[int]] = []
    while len(remaining) >= min_triangle_count:
        best_start = 0
        best_end = 0
        best_area = -1.0
        best_count = 0
        best_span = float("inf")
        right = 0
        window_area = 0.0

        for left in range(len(remaining)):
            if right < left:
                right = left
                window_area = 0.0
            left_z = triangles[remaining[left]].z_mean
            while right < len(remaining) and triangles[remaining[right]].z_mean - left_z <= band_width_m:
                window_area += triangles[remaining[right]].area
                right += 1

            count = right - left
            if count >= min_triangle_count:
                span = triangles[remaining[right - 1]].z_mean - left_z
                if (
                    window_area > best_area
                    or (
                        math.isclose(window_area, best_area)
                        and (count > best_count or (count == best_count and span < best_span))
                    )
                ):
                    best_start = left
                    best_end = right
                    best_area = window_area
                    best_count = count
                    best_span = span

            window_area -= triangles[remaining[left]].area

        if best_count < min_triangle_count:
            break

        group = remaining[best_start:best_end]
        groups.append(group)
        remaining = remaining[:best_start] + remaining[best_end:]

    return groups


def _compute_cluster_geometry(
    cluster: RoofHeightCluster,
    range_geometry: Polygon | MultiPolygon,
    opts: RoofPlaneOptions,
) -> None:
    raw = unary_union([tri.footprint for tri in cluster.triangles])
    raw = _polygonal_or_none(raw)
    cluster.raw_geometry = raw
    cluster.raw_area = _geometry_area(raw)

    cleaned = _clean_cluster_footprint(raw, range_geometry, opts)
    cluster.cleaned_geometry = cleaned
    cluster.cleaned_area = _geometry_area(cleaned)


def _clean_cluster_footprint(
    geometry: Polygon | MultiPolygon | None,
    range_geometry: Polygon | MultiPolygon,
    opts: RoofPlaneOptions,
) -> Polygon | MultiPolygon | None:
    geom = _polygonal_or_none(geometry)
    if geom is None:
        return None

    if opts.cluster_shape_close_m > 0:
        closed = _polygonal_or_none(geom.buffer(opts.cluster_shape_close_m).buffer(-opts.cluster_shape_close_m))
        if closed is not None:
            geom = closed

    if opts.cluster_shape_open_m > 0:
        opened = _polygonal_or_none(geom.buffer(-opts.cluster_shape_open_m).buffer(opts.cluster_shape_open_m))
        if opened is not None:
            geom = opened

    geom = _fill_small_holes(geom, opts.min_cluster_hole_area_m2)
    geom = _filter_small_components(geom, opts.min_cluster_component_area_m2)
    if geom is None:
        return None

    if opts.cluster_simplify_m > 0:
        simplified = _polygonal_or_none(geom.simplify(opts.cluster_simplify_m, preserve_topology=True))
        if simplified is not None:
            geom = simplified

    geom = _polygonal_or_none(geom.intersection(range_geometry))
    geom = _fill_small_holes(geom, opts.min_cluster_hole_area_m2)
    return _filter_small_components(geom, opts.min_cluster_component_area_m2)


def _compute_visible_cluster_areas(clusters: Sequence[RoofHeightCluster]) -> None:
    occupied = None
    ordered = sorted(
        clusters,
        key=lambda cluster: cluster.cluster_z if cluster.cluster_z is not None else float("-inf"),
        reverse=True,
    )
    for cluster in ordered:
        visible = cluster.cleaned_geometry
        if visible is not None and occupied is not None:
            visible = _polygonal_or_none(visible.difference(occupied))
        cluster.visible_geometry = visible
        cluster.visible_area = _geometry_area(visible)
        if visible is not None:
            occupied = visible if occupied is None else _polygonal_or_none(unary_union([occupied, visible]))


def _select_main_cluster(
    clusters: Sequence[RoofHeightCluster],
    terrain_z: float | None,
    opts: RoofPlaneOptions,
) -> RoofHeightCluster | None:
    valid = [
        cluster
        for cluster in clusters
        if cluster.cluster_z is not None
        and cluster.visible_area >= opts.min_cluster_area_m2
        and len(cluster.triangles) >= opts.min_cluster_triangle_count
    ]
    if not valid:
        return None
    valid = _filter_near_terrain_clusters_on_large_span(valid, terrain_z, opts)
    if not valid:
        return None
    return max(valid, key=lambda cluster: (cluster.visible_area, -float(cluster.mad or 0.0), len(cluster.triangles)))


def _filter_near_terrain_clusters_on_large_span(
    clusters: Sequence[RoofHeightCluster],
    terrain_z: float | None,
    opts: RoofPlaneOptions,
) -> List[RoofHeightCluster]:
    if terrain_z is None or not math.isfinite(terrain_z) or len(clusters) < 2:
        return list(clusters)

    z_values = [float(cluster.cluster_z) for cluster in clusters if cluster.cluster_z is not None]
    if len(z_values) < 2 or max(z_values) - min(z_values) < opts.enhanced_terrain_clearance_span_m:
        return list(clusters)

    clearance = max(opts.terrain_clearance_m, opts.enhanced_terrain_clearance_m)
    retained = [
        cluster
        for cluster in clusters
        if cluster.cluster_z is not None and float(cluster.cluster_z) > terrain_z + clearance
    ]
    return retained or list(clusters)


def _unresolved_result(
    patch_id: str,
    patch_index,
    tree_range: Dict[str, Any],
    sample_triangle_count: int,
    opts: RoofPlaneOptions,
    reason: str,
    clusters: Sequence[RoofHeightCluster] | None = None,
    tree_range_area: float = 0.0,
    offset_2326: Sequence[float] = (0.0, 0.0),
) -> RoofPlaneRangeResult:
    return RoofPlaneRangeResult(
        patch_id=patch_id,
        patch_index=int(patch_index) if patch_index is not None else None,
        full_id=tree_range.get("fullId"),
        osm_type=tree_range.get("osmType"),
        tree_level=int(tree_range.get("treeLevel")) if tree_range.get("treeLevel") is not None else None,
        parent_full_id=tree_range.get("parentFullId"),
        geometry=tree_range.get("samplingGeometry") or tree_range.get("memberGeometry"),
        resolved=False,
        roof_z=DEFAULT_UNRESOLVED_ROOF_Z,
        unresolved_reason=reason,
        tree_range_area=float(tree_range_area),
        roof_candidate_area=sum(cluster.visible_area for cluster in clusters or []),
        main_cluster_area=0.0,
        support_area_ratio=0.0,
        raw_cluster_count=len(clusters or []),
        sample_triangle_count=sample_triangle_count,
        main_cluster_triangle_count=0,
        mad=None,
        eps_z_m=opts.eps_z_m,
        main_cluster_raw_area=0.0,
        main_cluster_cleaned_area=0.0,
        main_cluster_visible_area=0.0,
        clusters=[{**_cluster_summary(cluster), "unresolvedReason": reason} for cluster in clusters or []],
        cluster_geometries=_cluster_geometry_items(
            clusters or [],
            patch_id,
            patch_index,
            tree_range,
            offset_2326,
            None,
        ),
    )


def _cluster_summary(cluster: RoofHeightCluster) -> Dict[str, Any]:
    return {
        "clusterId": cluster.cluster_id,
        "clusterZ": cluster.cluster_z,
        "rawArea": cluster.raw_area,
        "cleanedArea": cluster.cleaned_area,
        "visibleArea": cluster.visible_area,
        "triangleCount": len(cluster.triangles),
        "mad": cluster.mad,
    }


def _cluster_geometry_items(
    clusters: Sequence[RoofHeightCluster],
    patch_id: str,
    patch_index,
    tree_range: Dict[str, Any],
    offset_2326: Sequence[float],
    main_cluster_id: int | None,
) -> List[Dict[str, Any]]:
    features: List[Dict[str, Any]] = []
    selected_clusters = _select_main_secondary_clusters(clusters, main_cluster_id)
    for cluster, role in selected_clusters:
        if cluster.cleaned_geometry is None or cluster.cleaned_geometry.is_empty:
            continue
        lonlat_geometry = _local_geometry_to_lonlat_geojson(cluster.cleaned_geometry, offset_2326)
        if lonlat_geometry is None:
            continue
        features.append({
            "type": "Feature",
            "geometry": lonlat_geometry,
            "properties": {
                "patchId": patch_id,
                "patchIndex": int(patch_index) if patch_index is not None else None,
                "fullId": tree_range.get("fullId"),
                "osmType": tree_range.get("osmType"),
                "treeLevel": int(tree_range.get("treeLevel")) if tree_range.get("treeLevel") is not None else None,
                "parentFullId": tree_range.get("parentFullId"),
                "clusterId": cluster.cluster_id,
                "clusterZ": cluster.cluster_z,
                "rawArea": cluster.raw_area,
                "cleanedArea": cluster.cleaned_area,
                "visibleArea": cluster.visible_area,
                "triangleCount": len(cluster.triangles),
                "mad": cluster.mad,
                "clusterRole": role,
                "isMainCluster": cluster.cluster_id == main_cluster_id,
                "isSecondaryCluster": role == "secondary",
            },
        })
    return features


def _select_main_secondary_clusters(
    clusters: Sequence[RoofHeightCluster],
    main_cluster_id: int | None,
) -> List[tuple[RoofHeightCluster, str]]:
    ranked = sorted(
        [
            cluster
            for cluster in clusters
            if cluster.cleaned_geometry is not None and not cluster.cleaned_geometry.is_empty
        ],
        key=lambda cluster: (
            float(cluster.visible_area or 0.0),
            float(cluster.cleaned_area or 0.0),
            len(cluster.triangles),
        ),
        reverse=True,
    )
    if not ranked:
        return []

    selected: List[tuple[RoofHeightCluster, str]] = []
    main_cluster = next((cluster for cluster in ranked if cluster.cluster_id == main_cluster_id), None)
    if main_cluster is not None:
        selected.append((main_cluster, "main"))
        secondary = next((cluster for cluster in ranked if cluster.cluster_id != main_cluster_id), None)
        if secondary is not None:
            selected.append((secondary, "secondary"))
        return selected

    for index, cluster in enumerate(ranked[:2]):
        selected.append((cluster, "secondary" if index == 1 else "candidate"))
    return selected


def _local_geometry_to_lonlat_geojson(
    geometry: Polygon | MultiPolygon,
    offset_2326: Sequence[float],
) -> Dict[str, Any] | None:
    offset_x, offset_y = float(offset_2326[0]), float(offset_2326[1])

    def project(x, y, z=None):
        lon, lat = to_lonlat.transform(float(x) + offset_x, float(y) + offset_y)
        return float(lon), float(lat)

    try:
        lonlat = shapely_transform(project, geometry)
        polygonal = _polygonal_or_none(lonlat)
    except GEOSException:
        return None
    return dict(mapping(polygonal)) if polygonal is not None else None


def _weighted_median(values: Sequence[float], weights: Sequence[float]) -> float:
    pairs = sorted(
        [(float(value), float(weight)) for value, weight in zip(values, weights) if math.isfinite(value) and weight > 0],
        key=lambda item: item[0],
    )
    if not pairs:
        return float("nan")
    total = sum(weight for _, weight in pairs)
    cutoff = total / 2.0
    running = 0.0
    for value, weight in pairs:
        running += weight
        if running >= cutoff:
            return value
    return pairs[-1][0]


def _polygonal_or_none(geometry) -> Polygon | MultiPolygon | None:
    try:
        if geometry is not None and not geometry.is_valid:
            geometry = geometry.buffer(0)
    except GEOSException:
        return None

    parts = [part for part in iter_polygonal_parts(geometry)]
    if not parts:
        return None
    if len(parts) == 1:
        part = parts[0]
        try:
            return part if part.is_valid else part.buffer(0)
        except GEOSException:
            return None
    try:
        merged = unary_union(parts)
    except GEOSException:
        fixed_parts = []
        for part in parts:
            try:
                fixed = part if part.is_valid else part.buffer(0)
                if fixed is not None and not fixed.is_empty:
                    fixed_parts.append(fixed)
            except GEOSException:
                continue
        if not fixed_parts:
            return None
        try:
            merged = unary_union(fixed_parts)
        except GEOSException:
            return None
    if isinstance(merged, Polygon):
        return merged
    if isinstance(merged, MultiPolygon):
        return merged
    return None


def _fill_small_holes(
    geometry: Polygon | MultiPolygon | None,
    min_hole_area_m2: float,
) -> Polygon | MultiPolygon | None:
    if geometry is None:
        return None
    polygons = list(iter_polygonal_parts(geometry))
    filled: List[Polygon] = []
    for polygon in polygons:
        holes = []
        for ring in polygon.interiors:
            hole = Polygon(ring)
            if hole.area >= min_hole_area_m2:
                holes.append(list(ring.coords))
        filled.append(Polygon(polygon.exterior.coords, holes))
    return _polygonal_or_none(unary_union(filled))


def _filter_small_components(
    geometry: Polygon | MultiPolygon | None,
    min_area_m2: float,
) -> Polygon | MultiPolygon | None:
    if geometry is None:
        return None
    parts = [part for part in iter_polygonal_parts(geometry) if part.area >= min_area_m2]
    if not parts:
        return None
    return _polygonal_or_none(unary_union(parts))


def _geometry_area(geometry: Polygon | MultiPolygon | None) -> float:
    return float(geometry.area) if geometry is not None and not geometry.is_empty else 0.0
