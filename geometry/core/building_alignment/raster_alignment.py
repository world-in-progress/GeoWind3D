"""Patch alignment preview based on section-raster distance fields."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import List, Sequence, Tuple

import numpy as np
import logging
from scipy import ndimage
from shapely.affinity import affine_transform
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform as shapely_transform, unary_union

from core.building_alignment.section_raster import RasterGrid
from core.building_alignment.secondary_correction import SMALL_GROUP_AREA_THRESHOLD_M2, special_component_full_ids
from schemas.building_alignment import AlignmentPatchMember, AlignmentPatchRequestItem
from utils.geo import extract_polygonal_geometry, to_local_projected, to_lonlat

logger = logging.getLogger(__name__)

DISTANCE_FIELD_RADIUS_M = 2.0
OSM_BOUNDARY_SAMPLE_STEP_M = 0.5
TRANSLATION_RANGE_M = 5.0
TRANSLATION_STEP_M = 0.5
REFINE_TRANSLATION_RANGE_M = 1.0
REFINE_TRANSLATION_STEP_M = 0.25
ROTATION_RANGE_DEG = 5.0
REFINE_ROTATION_RANGE_DEG = 5.0
REFINE_ROTATION_STEP_DEG = 1.0
MAX_ALIGNMENT_ITERATIONS = 10
FOOTPRINT_TEMPLATE_OFFSETS_M = (0.0, -0.5, 0.5)


@dataclass(frozen=True)
class AlignmentGroupPreview:
    group_index: int
    group_id: str | None
    member_ids: List[str]
    applied: bool
    rotation_deg: float
    dx_meters: float
    dy_meters: float
    score: float
    reason: str | None


@dataclass(frozen=True)
class AlignmentPreview:
    patch_id: str
    member_features: List[dict]
    group_previews: List[AlignmentGroupPreview]


@dataclass(frozen=True)
class AlignmentGroupCoarseEvaluation:
    group_index: int
    group_id: str | None
    member_ids: List[str]
    members: List[AlignmentPatchMember]
    points: List[Tuple[float, float]]
    member_point_groups: List[List[Tuple[float, float]]]
    center: Tuple[float, float] | None
    translation_constraint: "TranslationConstraint | None"
    score: float
    dx_meters: float
    dy_meters: float
    footprint_template_offset_meters: float
    reason: str | None


@dataclass(frozen=True)
class FootprintTemplate:
    offset_meters: float
    member_point_groups: List[List[Tuple[float, float]]]


@dataclass(frozen=True)
class TranslationConstraint:
    axis_x: Tuple[float, float]
    axis_y: Tuple[float, float]
    half_x: float
    half_y: float


@dataclass(frozen=True)
class GroupGeometryContext:
    projected_geometries: List[Polygon | MultiPolygon]
    union_geometry: Polygon | MultiPolygon | None
    area_m2: float
    center: Tuple[float, float] | None
    translation_constraint: TranslationConstraint | None
    member_point_groups: List[List[Tuple[float, float]]]


def _classify_count_grid(count_grid: np.ndarray) -> np.ndarray:
    levels = np.zeros(count_grid.shape, dtype=np.float32)
    levels[(count_grid >= 4) & (count_grid <= 15)] = 0.6
    levels[(count_grid >= 16) & (count_grid <= 28)] = 0.8
    levels[count_grid > 28] = 1.0
    return levels


def _alignment_field(raster: RasterGrid) -> np.ndarray:
    count_grid = raster.grid
    weights = _classify_count_grid(count_grid)
    active_weights = sorted(float(value) for value in np.unique(weights) if float(value) > 0.0)
    if not active_weights:
        return np.zeros(count_grid.shape, dtype=np.float32)

    field = np.zeros(count_grid.shape, dtype=np.float32)
    for weight in active_weights:
        structure = weights == weight
        if not np.any(structure):
            continue
        distances = ndimage.distance_transform_edt(~structure)
        distance_m = distances.astype(np.float32) * raster.pixel_size_meters
        decay = np.maximum(0.0, 1.0 - distance_m / DISTANCE_FIELD_RADIUS_M)
        candidate_field = np.float32(weight) * decay
        candidate_field[distance_m > DISTANCE_FIELD_RADIUS_M] = 0.0
        field = np.maximum(field, candidate_field)
    return field.astype(np.float32)


def _project_geometry(geometry: dict) -> Polygon | MultiPolygon | None:
    polygonal = extract_polygonal_geometry(shape(geometry))
    if polygonal is None or polygonal.is_empty:
        return None
    return shapely_transform(lambda x, y, z=None: to_local_projected.transform(x, y), polygonal)


def _to_lonlat_geometry(geometry: Polygon | MultiPolygon) -> dict:
    lonlat = shapely_transform(lambda x, y, z=None: to_lonlat.transform(x, y), geometry)
    return dict(mapping(lonlat))


def _iter_polygons(geometry: Polygon | MultiPolygon):
    if isinstance(geometry, Polygon):
        yield geometry
    else:
        yield from geometry.geoms


def _sample_ring(coords: Sequence[Tuple[float, float]]) -> List[Tuple[float, float]]:
    points: List[Tuple[float, float]] = []
    if len(coords) < 2:
        return points
    for i in range(len(coords) - 1):
        x0, y0 = coords[i]
        x1, y1 = coords[i + 1]
        length = math.hypot(x1 - x0, y1 - y0)
        if length <= 1e-9:
            continue
        count = max(1, int(math.floor(length / OSM_BOUNDARY_SAMPLE_STEP_M)))
        for j in range(count):
            t = j / count
            points.append((
                float(x0 + (x1 - x0) * t),
                float(y0 + (y1 - y0) * t),
            ))
    return points


def _member_boundary_point_groups_from_projected(
    projected_geometries: Sequence[Polygon | MultiPolygon | None],
) -> List[List[Tuple[float, float]]]:
    groups: List[List[Tuple[float, float]]] = []
    for projected in projected_geometries:
        member_points: List[Tuple[float, float]] = []
        if projected is not None:
            for polygon in _iter_polygons(projected):
                member_points.extend(_sample_ring(list(polygon.exterior.coords)))
                for interior in polygon.interiors:
                    member_points.extend(_sample_ring(list(interior.coords)))
        groups.append(member_points)
    return groups


def _radial_offset_point(
    point: Tuple[float, float],
    center: Tuple[float, float],
    offset_meters: float,
) -> Tuple[float, float]:
    if abs(offset_meters) <= 1e-12:
        return point
    x, y = point
    cx, cy = center
    vx = x - cx
    vy = y - cy
    distance = math.hypot(vx, vy)
    if distance <= 1e-9:
        return point
    adjusted_distance = max(0.0, distance + offset_meters)
    scale = adjusted_distance / distance
    return cx + vx * scale, cy + vy * scale


def _radial_offset_point_groups(
    member_point_groups: Sequence[Sequence[Tuple[float, float]]],
    center: Tuple[float, float],
    offset_meters: float,
) -> List[List[Tuple[float, float]]]:
    return [
        [_radial_offset_point(point, center, offset_meters) for point in points]
        for points in member_point_groups
    ]


def _footprint_templates(
    member_point_groups: Sequence[Sequence[Tuple[float, float]]],
    center: Tuple[float, float],
    allow_offset: bool = True,
) -> List[FootprintTemplate]:
    offsets = FOOTPRINT_TEMPLATE_OFFSETS_M if allow_offset else (0.0,)
    return [
        FootprintTemplate(
            offset_meters=offset,
            member_point_groups=_radial_offset_point_groups(member_point_groups, center, offset),
        )
        for offset in offsets
    ]


def _union_projected_geometries(
    projected_geometries: Sequence[Polygon | MultiPolygon],
) -> Polygon | MultiPolygon | None:
    if not projected_geometries:
        return None
    try:
        unioned = unary_union(projected_geometries)
    except Exception:
        unioned = projected_geometries[0]
    if unioned.is_empty:
        return None
    if not unioned.is_valid:
        unioned = unioned.buffer(0)
    if unioned.is_empty or not isinstance(unioned, (Polygon, MultiPolygon)):
        return None
    return unioned


def _translation_constraint_for_geometry(
    projected: Polygon | MultiPolygon | None,
) -> TranslationConstraint | None:
    if projected is None or projected.is_empty:
        return None
    rectangle = projected.minimum_rotated_rectangle
    if not isinstance(rectangle, Polygon):
        return None
    coords = list(rectangle.exterior.coords)
    if len(coords) < 5:
        return None

    p0 = coords[0]
    p1 = coords[1]
    p2 = coords[2]
    edge_x = (float(p1[0] - p0[0]), float(p1[1] - p0[1]))
    edge_y = (float(p2[0] - p1[0]), float(p2[1] - p1[1]))
    span_x = math.hypot(edge_x[0], edge_x[1])
    span_y = math.hypot(edge_y[0], edge_y[1])
    if span_x <= 1e-9 or span_y <= 1e-9:
        return None
    return TranslationConstraint(
        axis_x=(edge_x[0] / span_x, edge_x[1] / span_x),
        axis_y=(edge_y[0] / span_y, edge_y[1] / span_y),
        half_x=span_x * 0.5,
        half_y=span_y * 0.5,
    )


def _group_geometry_context(members: Sequence[AlignmentPatchMember]) -> GroupGeometryContext:
    projected_by_member = [_project_geometry(member.geometry) for member in members]
    projected_geometries = [projected for projected in projected_by_member if projected is not None]
    union_geometry = _union_projected_geometries(projected_geometries)
    if union_geometry is None:
        return GroupGeometryContext(
            projected_geometries=projected_geometries,
            union_geometry=None,
            area_m2=0.0,
            center=None,
            translation_constraint=None,
            member_point_groups=_member_boundary_point_groups_from_projected(projected_by_member),
        )
    centroid = union_geometry.centroid
    return GroupGeometryContext(
        projected_geometries=projected_geometries,
        union_geometry=union_geometry,
        area_m2=float(union_geometry.area),
        center=(float(centroid.x), float(centroid.y)),
        translation_constraint=_translation_constraint_for_geometry(union_geometry),
        member_point_groups=_member_boundary_point_groups_from_projected(projected_by_member),
    )


def _member_attachment_group_key(member: AlignmentPatchMember, fallback_index: int) -> Tuple[int, str | None]:
    group_index = member.attachmentGroupIndex
    if group_index is None:
        group_index = fallback_index
    return int(group_index), member.attachmentGroupId


def _attachment_member_groups(patch: AlignmentPatchRequestItem) -> List[Tuple[int, str | None, List[AlignmentPatchMember]]]:
    groups: dict[Tuple[int, str | None], List[AlignmentPatchMember]] = {}
    order: List[Tuple[int, str | None]] = []
    for fallback_index, member in enumerate(patch.members):
        key = _member_attachment_group_key(member, fallback_index)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(member)
    return [(group_index, group_id, groups[(group_index, group_id)]) for group_index, group_id in order]


def _group_tree_no_offset_ids(
    patch: AlignmentPatchRequestItem,
    deferred_group_ids: set[str],
) -> set[str]:
    if not deferred_group_ids or not patch.attachmentGroupTree:
        return set()

    parent_by_id = {
        node.groupId: node.parentGroupId
        for node in patch.attachmentGroupTree
    }
    children_by_id: dict[str, list[str]] = {
        node.groupId: list(node.childGroupIds)
        for node in patch.attachmentGroupTree
    }

    no_offset_ids: set[str] = set()
    for group_id in deferred_group_ids:
        current: str | None = group_id
        while current is not None and current not in no_offset_ids:
            no_offset_ids.add(current)
            current = parent_by_id.get(current)

        stack = list(children_by_id.get(group_id, []))
        while stack:
            child_id = stack.pop()
            if child_id in no_offset_ids:
                continue
            no_offset_ids.add(child_id)
            stack.extend(children_by_id.get(child_id, []))

    return no_offset_ids


def _score_at(field: np.ndarray, raster: RasterGrid, x: float, y: float) -> float:
    min_x, _min_y, _max_x, max_y = raster.bbox_2326
    col = (x - min_x) / raster.pixel_size_meters
    row = (max_y - y) / raster.pixel_size_meters
    if row < 0 or col < 0 or row >= field.shape[0] - 1 or col >= field.shape[1] - 1:
        return 0.0
    r0 = int(math.floor(row))
    c0 = int(math.floor(col))
    dr = row - r0
    dc = col - c0
    return float(
        field[r0, c0] * (1 - dr) * (1 - dc)
        + field[r0 + 1, c0] * dr * (1 - dc)
        + field[r0, c0 + 1] * (1 - dr) * dc
        + field[r0 + 1, c0 + 1] * dr * dc
    )


def _transform_xy(
    x: float,
    y: float,
    center: Tuple[float, float],
    angle_deg: float,
    dx: float,
    dy: float,
) -> Tuple[float, float]:
    angle = math.radians(angle_deg)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    cx, cy = center
    return (
        cx + (x - cx) * cos_a - (y - cy) * sin_a + dx,
        cy + (x - cx) * sin_a + (y - cy) * cos_a + dy,
    )


def _transform_point(
    point: Tuple[float, float],
    center: Tuple[float, float],
    angle_deg: float,
    dx: float,
    dy: float,
) -> Tuple[float, float]:
    return _transform_xy(point[0], point[1], center, angle_deg, dx, dy)


def _candidate_score(
    field: np.ndarray,
    raster: RasterGrid,
    member_point_groups: Sequence[Sequence[Tuple[float, float]]],
    center: Tuple[float, float],
    angle_deg: float,
    dx: float,
    dy: float,
) -> float:
    points = [point for group in member_point_groups for point in group]
    if not points:
        return -math.inf

    score_total = 0.0
    point_count = 0
    for member_points in member_point_groups:
        for point in member_points:
            rx, ry = _transform_point(point, center, angle_deg, dx, dy)
            score_total += _score_at(field, raster, rx, ry)
            point_count += 1

    return max(0.0, min(1.0, score_total / point_count))


def _frange(start: float, stop: float, step: float) -> List[float]:
    values: List[float] = []
    value = start
    while value <= stop + 1e-9:
        values.append(round(value, 6))
        value += step
    return values


def _angle_values_around(center: float, radius: float, step: float) -> List[float]:
    return [
        value
        for value in _frange(center - radius, center + radius, step)
        if -ROTATION_RANGE_DEG <= value <= ROTATION_RANGE_DEG
    ]


def _candidate_tie_cost(angle_deg: float, dx: float, dy: float) -> float:
    return dx * dx + dy * dy + abs(angle_deg) * 1e-3


def _translation_allowed(dx: float, dy: float, constraint: TranslationConstraint) -> bool:
    along_x = dx * constraint.axis_x[0] + dy * constraint.axis_x[1]
    along_y = dx * constraint.axis_y[0] + dy * constraint.axis_y[1]
    return (
        abs(along_x) <= constraint.half_x + 1e-9
        and abs(along_y) <= constraint.half_y + 1e-9
    )


def _search(
    field: np.ndarray,
    raster: RasterGrid,
    member_point_groups: Sequence[Sequence[Tuple[float, float]]],
    center: Tuple[float, float],
    translation_constraint: TranslationConstraint,
    angles: Sequence[float],
    dx_values: Sequence[float],
    dy_values: Sequence[float],
) -> Tuple[float, float, float, float]:
    best = (-math.inf, 0.0, 0.0, 0.0)
    best_tie_cost = math.inf
    for angle in angles:
        for dx in dx_values:
            for dy in dy_values:
                if not _translation_allowed(dx, dy, translation_constraint):
                    continue
                candidate_score = _candidate_score(field, raster, member_point_groups, center, angle, dx, dy)
                tie_cost = _candidate_tie_cost(angle, dx, dy)
                if candidate_score > best[0] + 1e-12 or (
                    abs(candidate_score - best[0]) <= 1e-12 and tie_cost < best_tie_cost
                ):
                    best = (
                        candidate_score,
                        angle,
                        dx,
                        dy,
                    )
                    best_tie_cost = tie_cost
    return best


def _coarse_translation_search(
    field: np.ndarray,
    raster: RasterGrid,
    templates: Sequence[FootprintTemplate],
    center: Tuple[float, float],
    translation_constraint: TranslationConstraint,
    dx_values: Sequence[float],
    dy_values: Sequence[float],
) -> Tuple[float, float, float, float, List[List[Tuple[float, float]]]]:
    if not dx_values or not dy_values or not templates:
        return -math.inf, 0.0, 0.0, 0.0, []

    best_score = -math.inf
    best_dx = 0.0
    best_dy = 0.0
    best_template_offset = 0.0
    best_template_groups: List[List[Tuple[float, float]]] = []
    best_tie_cost = math.inf
    for template in templates:
        for dx in dx_values:
            for dy in dy_values:
                if not _translation_allowed(dx, dy, translation_constraint):
                    continue
                candidate_score = _candidate_score(field, raster, template.member_point_groups, center, 0.0, dx, dy)
                tie_cost = _candidate_tie_cost(0.0, dx, dy) + abs(template.offset_meters) * 1e-4
                if candidate_score > best_score + 1e-12 or (
                    abs(candidate_score - best_score) <= 1e-12 and tie_cost < best_tie_cost
                ):
                    best_score = candidate_score
                    best_dx = dx
                    best_dy = dy
                    best_template_offset = template.offset_meters
                    best_template_groups = template.member_point_groups
                    best_tie_cost = tie_cost

    return (
        best_score,
        best_dx,
        best_dy,
        best_template_offset,
        best_template_groups,
    )


def _search_with_timing(
    label: str,
    patch_id: str,
    field: np.ndarray,
    raster: RasterGrid,
    member_point_groups: Sequence[Sequence[Tuple[float, float]]],
    center: Tuple[float, float],
    translation_constraint: TranslationConstraint,
    angles: Sequence[float],
    dx_values: Sequence[float],
    dy_values: Sequence[float],
) -> Tuple[float, float, float, float]:
    started = time.perf_counter()
    result = _search(
        field,
        raster,
        member_point_groups,
        center,
        translation_constraint,
        angles,
        dx_values,
        dy_values,
    )
    candidate_count = len(angles) * len(dx_values) * len(dy_values)
    logger.info(
        "[building-raster-align] patch=%s %s: candidates=%d, points=%d, score=%.4f, angle=%.2f, dx=%.2f, dy=%.2f, elapsed=%.3fs",
        patch_id,
        label,
        candidate_count,
        sum(len(points) for points in member_point_groups),
        result[0],
        result[1],
        result[2],
        result[3],
        time.perf_counter() - started,
    )
    return result


def _coarse_translation_search_with_timing(
    label: str,
    patch_id: str,
    field: np.ndarray,
    raster: RasterGrid,
    templates: Sequence[FootprintTemplate],
    center: Tuple[float, float],
    translation_constraint: TranslationConstraint,
    dx_values: Sequence[float],
    dy_values: Sequence[float],
) -> Tuple[float, float, float, float, List[List[Tuple[float, float]]]]:
    started = time.perf_counter()
    score, dx, dy, template_offset, template_groups = _coarse_translation_search(
        field,
        raster,
        templates,
        center,
        translation_constraint,
        dx_values,
        dy_values,
    )
    candidate_count = len(templates) * len(dx_values) * len(dy_values)
    logger.info(
        "[building-raster-align] patch=%s %s: candidates=%d, templates=%d, points=%d, score=%.4f, templateOffset=%.2f, dx=%.2f, dy=%.2f, elapsed=%.3fs",
        patch_id,
        label,
        candidate_count,
        len(templates),
        sum(len(points) for points in template_groups),
        score,
        template_offset,
        dx,
        dy,
        time.perf_counter() - started,
    )
    return score, dx, dy, template_offset, template_groups


def _radial_offset_geometry(
    geometry: Polygon | MultiPolygon,
    center: Tuple[float, float],
    offset_meters: float,
) -> Polygon | MultiPolygon:
    if abs(offset_meters) <= 1e-12:
        return geometry
    cx, cy = center

    def transform_xy(x, y, z=None):
        x_values = np.asarray(x, dtype=np.float64)
        y_values = np.asarray(y, dtype=np.float64)
        vx = x_values - cx
        vy = y_values - cy
        distance = np.hypot(vx, vy)
        scale = np.ones_like(distance, dtype=np.float64)
        np.divide(
            np.maximum(0.0, distance + offset_meters),
            distance,
            out=scale,
            where=distance > 1e-9,
        )
        result_x = cx + vx * scale
        result_y = cy + vy * scale
        return result_x, result_y

    return shapely_transform(transform_xy, geometry)


def _transform_geometry(
    geometry: Polygon | MultiPolygon,
    center: Tuple[float, float],
    angle_deg: float,
    dx: float,
    dy: float,
) -> Polygon | MultiPolygon:
    angle = math.radians(angle_deg)
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    cx, cy = center
    xoff = cx - cx * cos_a + cy * sin_a + dx
    yoff = cy - cx * sin_a - cy * cos_a + dy
    return affine_transform(geometry, [cos_a, -sin_a, sin_a, cos_a, xoff, yoff])


def _aligned_member_features(
    patch: AlignmentPatchRequestItem,
    members: Sequence[AlignmentPatchMember],
    group_index: int,
    group_id: str | None,
    angle_deg: float,
    dx_meters: float,
    dy_meters: float,
    applied: bool,
    score: float,
    center: Tuple[float, float] | None = None,
    footprint_template_offset_meters: float = 0.0,
) -> List[dict]:
    features: List[dict] = []
    member_ids = [member.fullId for member in members]
    for member in members:
        geometry = member.geometry
        if applied and center is not None:
            projected = _project_geometry(member.geometry)
            if projected is not None:
                template_geometry = _radial_offset_geometry(projected, center, footprint_template_offset_meters)
                geometry = _to_lonlat_geometry(
                    _transform_geometry(template_geometry, center, angle_deg, dx_meters, dy_meters)
                )
        features.append({
            "type": "Feature",
            "properties": {
                "patchId": patch.patchId,
                "fullId": member.fullId,
                "osmType": member.osmType,
                "attachmentGroupIndex": group_index,
                "attachmentGroupId": group_id,
                "attachmentGroupSize": len(members),
                "attachmentGroupMemberIds": member_ids,
                "rotationDeg": angle_deg,
                "dxMeters": dx_meters,
                "dyMeters": dy_meters,
                "score": score,
            },
            "geometry": geometry,
        })
    return features


def _evaluate_member_group_coarse_with_field(
    patch: AlignmentPatchRequestItem,
    members: Sequence[AlignmentPatchMember],
    group_index: int,
    group_id: str | None,
    field: np.ndarray,
    raster: RasterGrid,
    context: GroupGeometryContext | None = None,
    allow_footprint_offset: bool = True,
) -> AlignmentGroupCoarseEvaluation:
    group_label = f"{patch.patchId}/group={group_index}"
    member_ids = [member.fullId for member in members]
    points_started = time.perf_counter()
    if context is None:
        context = _group_geometry_context(members)
    member_point_groups = context.member_point_groups
    points = [point for group in member_point_groups for point in group]
    logger.info(
        "[building-raster-align] patch=%s member-boundary-points: group=%d, members=%d, points=%d, step=%.2fm, elapsed=%.3fs",
        patch.patchId,
        group_index,
        len(members),
        len(points),
        OSM_BOUNDARY_SAMPLE_STEP_M,
        time.perf_counter() - points_started,
    )
    geom_started = time.perf_counter()
    center = context.center
    translation_constraint = context.translation_constraint
    logger.info(
        "[building-raster-align] patch=%s group-geometry: group=%d, valid=%s, translationHalf=(%.2f, %.2f), elapsed=%.3fs",
        patch.patchId,
        group_index,
        bool(center is not None and translation_constraint is not None),
        translation_constraint.half_x if translation_constraint else 0.0,
        translation_constraint.half_y if translation_constraint else 0.0,
        time.perf_counter() - geom_started,
    )
    if not members:
        reason = "empty_members"
    elif not points:
        reason = "no_member_boundary_points"
    elif center is None:
        reason = "invalid_group_geometry"
    elif translation_constraint is None:
        reason = "invalid_translation_constraint"
    elif float(np.max(field)) <= 0:
        reason = "empty_distance_field"
    else:
        reason = None

    if reason is not None:
        return AlignmentGroupCoarseEvaluation(
            group_index=group_index,
            group_id=group_id,
            member_ids=member_ids,
            members=list(members),
            points=points,
            member_point_groups=member_point_groups,
            center=center,
            translation_constraint=translation_constraint,
            score=0.0,
            dx_meters=0.0,
            dy_meters=0.0,
            footprint_template_offset_meters=0.0,
            reason=reason,
        )

    coarse_dx = _frange(-TRANSLATION_RANGE_M, TRANSLATION_RANGE_M, TRANSLATION_STEP_M)
    coarse_dy = _frange(-TRANSLATION_RANGE_M, TRANSLATION_RANGE_M, TRANSLATION_STEP_M)
    templates = _footprint_templates(member_point_groups, center, allow_footprint_offset)
    coarse_score, trans_dx, trans_dy, template_offset, template_groups = _coarse_translation_search_with_timing(
        "translation-coarse",
        group_label,
        field,
        raster,
        templates,
        center,
        translation_constraint,
        coarse_dx,
        coarse_dy,
    )
    return AlignmentGroupCoarseEvaluation(
        group_index=group_index,
        group_id=group_id,
        member_ids=member_ids,
        members=list(members),
        points=points,
        member_point_groups=template_groups,
        center=center,
        translation_constraint=translation_constraint,
        score=coarse_score,
        dx_meters=trans_dx,
        dy_meters=trans_dy,
        footprint_template_offset_meters=template_offset,
        reason=None,
    )


def _failed_group_alignment(
    patch: AlignmentPatchRequestItem,
    members: Sequence[AlignmentPatchMember],
    group_index: int,
    group_id: str | None,
    reason: str,
):
    preview = AlignmentGroupPreview(
        group_index=group_index,
        group_id=group_id,
        member_ids=[member.fullId for member in members],
        applied=False,
        rotation_deg=0.0,
        dx_meters=0.0,
        dy_meters=0.0,
        score=0.0,
        reason=reason,
    )
    return preview, _aligned_member_features(
        patch,
        members,
        group_index,
        group_id,
        0.0,
        0.0,
        0.0,
        False,
        0.0,
    )


def _small_group_alignment(
    patch: AlignmentPatchRequestItem,
    members: Sequence[AlignmentPatchMember],
    group_index: int,
    group_id: str | None,
    area_m2: float,
    reason: str = "small_group_excluded",
):
    preview = AlignmentGroupPreview(
        group_index=group_index,
        group_id=group_id,
        member_ids=[member.fullId for member in members],
        applied=False,
        rotation_deg=0.0,
        dx_meters=0.0,
        dy_meters=0.0,
        score=0.0,
        reason=reason,
    )
    features = _aligned_member_features(
        patch,
        members,
        group_index,
        group_id,
        0.0,
        0.0,
        0.0,
        False,
        0.0,
    )
    for feature in features:
        properties = feature["properties"]
        properties["smallGroupExcluded"] = True
        properties["smallGroupAreaM2"] = area_m2
        properties["smallGroupInheritedFromGroupId"] = None
        properties["deferredAlignmentReason"] = reason
    return preview, features


def _deferred_group_reason(members: Sequence[AlignmentPatchMember], area_m2: float) -> str | None:
    if area_m2 < SMALL_GROUP_AREA_THRESHOLD_M2:
        return "small_group_excluded"
    special_ids = special_component_full_ids()
    if special_ids and any(member.fullId in special_ids for member in members):
        return "special_component_group_excluded"
    return None


def _align_member_group_with_field(
    patch: AlignmentPatchRequestItem,
    members: Sequence[AlignmentPatchMember],
    group_index: int,
    group_id: str | None,
    field: np.ndarray,
    raster: RasterGrid,
    coarse: AlignmentGroupCoarseEvaluation | None = None,
):
    total_started = time.perf_counter()
    group_label = f"{patch.patchId}/group={group_index}"
    if coarse is None:
        coarse = _evaluate_member_group_coarse_with_field(
            patch,
            members,
            group_index,
            group_id,
            field,
            raster,
        )
    if coarse.reason is not None:
        return _failed_group_alignment(
            patch,
            members,
            group_index,
            group_id,
            coarse.reason,
        )

    member_point_groups = coarse.member_point_groups
    center = coarse.center
    translation_constraint = coarse.translation_constraint
    trans_dx = coarse.dx_meters
    trans_dy = coarse.dy_meters
    footprint_template_offset_meters = coarse.footprint_template_offset_meters
    if center is None or translation_constraint is None:
        return _failed_group_alignment(
            patch,
            members,
            group_index,
            group_id,
            "invalid_translation_constraint" if center is not None else "invalid_group_geometry",
        )

    refine_dx = _frange(trans_dx - REFINE_TRANSLATION_RANGE_M, trans_dx + REFINE_TRANSLATION_RANGE_M, REFINE_TRANSLATION_STEP_M)
    refine_dy = _frange(trans_dy - REFINE_TRANSLATION_RANGE_M, trans_dy + REFINE_TRANSLATION_RANGE_M, REFINE_TRANSLATION_STEP_M)
    refine_angles = _angle_values_around(0.0, REFINE_ROTATION_RANGE_DEG, REFINE_ROTATION_STEP_DEG)
    trans_score, _angle, trans_dx, trans_dy = _search_with_timing(
        "translation-refine",
        group_label,
        field,
        raster,
        member_point_groups,
        center,
        translation_constraint,
        [0.0],
        refine_dx,
        refine_dy,
    )

    rot_score = trans_score
    rot_angle = 0.0
    rot_dx = trans_dx
    rot_dy = trans_dy
    converged = False
    iterations = 0
    for iteration in range(1, MAX_ALIGNMENT_ITERATIONS + 1):
        iterations = iteration
        prev_angle = rot_angle
        prev_dx = rot_dx
        prev_dy = rot_dy

        trans_iter_score, _angle, rot_dx, rot_dy = _search_with_timing(
            f"iteration={iteration} translation-search",
            group_label,
            field,
            raster,
            member_point_groups,
            center,
            translation_constraint,
            [rot_angle],
            refine_dx,
            refine_dy,
        )

        rot_score, rot_angle, _dx, _dy = _search_with_timing(
            f"iteration={iteration} rotation-search",
            group_label,
            field,
            raster,
            member_point_groups,
            center,
            translation_constraint,
            refine_angles,
            [rot_dx],
            [rot_dy],
        )

        if rot_angle == prev_angle and rot_dx == prev_dx and rot_dy == prev_dy:
            converged = True
            break

    final_score = rot_score
    final_angle = rot_angle
    final_dx = rot_dx
    final_dy = rot_dy
    logger.info(
        "[building-raster-align] patch=%s group=%d result: score=%.4f, iterations=%d, converged=%s, dx=%.2f, dy=%.2f, rot=%.2f, elapsed=%.3fs",
        patch.patchId,
        group_index,
        final_score,
        iterations,
        converged,
        final_dx,
        final_dy,
        final_angle,
        time.perf_counter() - total_started,
    )

    preview = AlignmentGroupPreview(
        group_index=group_index,
        group_id=group_id,
        member_ids=[member.fullId for member in members],
        applied=True,
        rotation_deg=final_angle,
        dx_meters=final_dx,
        dy_meters=final_dy,
        score=final_score,
        reason=None,
    )
    return preview, _aligned_member_features(
        patch,
        members,
        group_index,
        group_id,
        final_angle,
        final_dx,
        final_dy,
        True,
        final_score,
        center,
        footprint_template_offset_meters,
    )


def _distance_field_for_raster(
    patch: AlignmentPatchRequestItem,
    raster: RasterGrid,
) -> np.ndarray:
    distance_started = time.perf_counter()
    field = _alignment_field(raster)
    distance_field_max_value = float(np.max(field)) if field.size else 0.0
    logger.info(
        "[building-raster-align] patch=%s alignment-field: grid=%dx%d, nonzero=%d, max=%.4f, elapsed=%.3fs",
        patch.patchId,
        raster.width,
        raster.height,
        int(np.count_nonzero(field)),
        distance_field_max_value,
        time.perf_counter() - distance_started,
    )
    return field


def _make_alignment_preview(
    patch_id: str,
    member_features: List[dict],
    group_previews: List[AlignmentGroupPreview],
) -> AlignmentPreview:
    return AlignmentPreview(
        patch_id=patch_id,
        member_features=member_features,
        group_previews=group_previews,
    )


def _log_attachment_groups(
    patch: AlignmentPatchRequestItem,
    groups: Sequence[Tuple[int, str | None, List[AlignmentPatchMember]]],
) -> None:
    logger.info(
        "[building-raster-align] patch=%s attachment-groups: count=%d, sizes=%s",
        patch.patchId,
        len(groups),
        [len(members) for _group_index, _group_id, members in groups],
    )


def align_patch_first_pass(
    patch: AlignmentPatchRequestItem,
    raster: RasterGrid,
) -> AlignmentPreview:
    field = _distance_field_for_raster(patch, raster)
    group_previews: List[AlignmentGroupPreview] = []
    member_features: List[dict] = []
    groups = _attachment_member_groups(patch)
    _log_attachment_groups(patch, groups)
    group_contexts: dict[str, GroupGeometryContext] = {}
    deferred_group_ids: set[str] = set()
    for _group_index, group_id, members in groups:
        if group_id is None:
            continue
        context = _group_geometry_context(members)
        group_contexts[group_id] = context
        if _deferred_group_reason(members, context.area_m2) is not None:
            deferred_group_ids.add(group_id)
    no_offset_group_ids = _group_tree_no_offset_ids(patch, deferred_group_ids)

    for group_index, group_id, members in groups:
        context = group_contexts.get(group_id) if group_id is not None else None
        if context is None:
            context = _group_geometry_context(members)
        area_m2 = context.area_m2
        deferred_reason = _deferred_group_reason(members, area_m2)
        if deferred_reason is not None:
            group_preview, features = _small_group_alignment(
                patch,
                members,
                group_index,
                group_id,
                area_m2,
                deferred_reason,
            )
            group_previews.append(group_preview)
            member_features.extend(features)
            continue
        coarse = _evaluate_member_group_coarse_with_field(
            patch,
            members,
            group_index,
            group_id,
            field,
            raster,
            context,
            group_id not in no_offset_group_ids,
        )
        if coarse.reason is not None:
            group_preview, features = _failed_group_alignment(
                patch,
                members,
                group_index,
                group_id,
                coarse.reason,
            )
        else:
            group_preview, features = _align_member_group_with_field(
                patch,
                members,
                group_index,
                group_id,
                field,
                raster,
                coarse,
            )
        group_previews.append(group_preview)
        member_features.extend(features)

    logger.info(
        "[building-raster-align] patch=%s first-pass: aligned=%d, failed=%d",
        patch.patchId,
        sum(1 for group in group_previews if group.applied),
        sum(1 for group in group_previews if not group.applied),
    )
    return _make_alignment_preview(
        patch.patchId,
        member_features,
        group_previews,
    )


def failed_alignment_preview(patch: AlignmentPatchRequestItem, reason: str) -> AlignmentPreview:
    group_previews: List[AlignmentGroupPreview] = []
    member_features: List[dict] = []
    for group_index, group_id, members in _attachment_member_groups(patch):
        area_m2 = _group_geometry_context(members).area_m2
        deferred_reason = _deferred_group_reason(members, area_m2)
        if deferred_reason is not None:
            group_preview, features = _small_group_alignment(
                patch,
                members,
                group_index,
                group_id,
                area_m2,
                deferred_reason,
            )
            group_previews.append(group_preview)
            member_features.extend(features)
            continue
        group_previews.append(AlignmentGroupPreview(
            group_index=group_index,
            group_id=group_id,
            member_ids=[member.fullId for member in members],
            applied=False,
            rotation_deg=0.0,
            dx_meters=0.0,
            dy_meters=0.0,
            score=0.0,
            reason=reason,
        ))
        member_features.extend(_aligned_member_features(
            patch,
            members,
            group_index,
            group_id,
            0.0,
            0.0,
            0.0,
            False,
            0.0,
        ))
    return AlignmentPreview(
        patch_id=patch.patchId,
        member_features=member_features,
        group_previews=group_previews,
    )


def build_aligned_buildings_geojson(items: Sequence[AlignmentPreview]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [feature for item in items for feature in item.member_features],
    }
