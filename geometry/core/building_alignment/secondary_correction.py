"""Secondary correction for building patch alignment preview."""

from __future__ import annotations

import math
import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from pyproj import Transformer
from shapely.affinity import affine_transform, translate
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform as shapely_transform, unary_union

from schemas.building_alignment import AlignmentPatchRequestItem
from utils.geo import extract_polygonal_geometry


SMALL_GROUP_AREA_THRESHOLD_M2 = 15.0
SPECIAL_COMPONENT_FULL_IDS_PATH = Path(__file__).with_name("special_component_full_ids.json")
STRONG_SCORE_THRESHOLD = 0.75
TREND_NEIGHBOR_DISTANCE_M = 5.0
TREND_MIN_NEIGHBORS = 3
TREND_TWO_NEIGHBOR_MAX_DELTA_M = 2.0
TREND_MIN_RESIDUAL_M = 1.5
TREND_SPREAD_MULTIPLIER = 2.5
TREND_MIN_SPREAD_M = 0.5
TREND_MAX_SPREAD_M = 1.5

to_local_projected = Transformer.from_crs("EPSG:4326", "EPSG:2326", always_xy=True)
to_lonlat = Transformer.from_crs("EPSG:2326", "EPSG:4326", always_xy=True)


def special_component_full_ids() -> frozenset[str]:
    try:
        with SPECIAL_COMPONENT_FULL_IDS_PATH.open("r", encoding="utf-8") as file:
            raw = json.load(file)
    except FileNotFoundError:
        return frozenset()
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(str(item).strip() for item in raw if str(item).strip())


@dataclass
class SecondaryGroupState:
    key: tuple[str, str]
    group_id: str
    aligned_feature_indices: list[int]
    original_features: list[dict[str, Any]]
    current_features: list[dict[str, Any]]
    original_geometry_2326: Polygon | MultiPolygon
    current_geometry_2326: Polygon | MultiPolygon
    score: float
    dx_meters: float
    dy_meters: float
    rotation_deg: float
    strong: bool = False
    corrected: bool = False
    correction_source_group_id: str | None = None
    correction_iteration: int | None = None
    trend_corrected: bool = False
    trend_neighbor_count: int | None = None
    trend_dx_meters: float | None = None
    trend_dy_meters: float | None = None
    trend_residual_meters: float | None = None
    trend_spread_meters: float | None = None
    children: list[tuple[str, str]] = field(default_factory=list)


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if np.isfinite(result) else default


def _clone_feature(feature: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": dict(feature.get("properties") or {}),
        "geometry": feature.get("geometry"),
    }


def _group_key(properties: dict[str, Any]) -> tuple[str, str] | None:
    patch_id = properties.get("patchId")
    if patch_id is None:
        return None
    group_id = properties.get("attachmentGroupId")
    group_index = properties.get("attachmentGroupIndex")
    key = str(group_id) if group_id not in (None, "") else f"group-index-{group_index}"
    return str(patch_id), key


def _project_geometry(geometry: dict[str, Any]) -> Polygon | MultiPolygon | None:
    polygonal = extract_polygonal_geometry(shape(geometry))
    if polygonal is None or polygonal.is_empty:
        return None
    projected = shapely_transform(lambda x, y, z=None: to_local_projected.transform(x, y), polygonal)
    if projected.is_empty:
        return None
    if not projected.is_valid:
        projected = projected.buffer(0)
    if projected.is_empty:
        return None
    if isinstance(projected, (Polygon, MultiPolygon)):
        return projected
    polygons = [geom for geom in getattr(projected, "geoms", []) if isinstance(geom, Polygon)]
    return MultiPolygon(polygons) if polygons else None


def _to_lonlat_geometry(geometry: Polygon | MultiPolygon) -> dict[str, Any]:
    lonlat = shapely_transform(lambda x, y, z=None: to_lonlat.transform(x, y), geometry)
    return dict(mapping(lonlat))


def _features_by_group(features: Sequence[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for feature in features:
        key = _group_key(feature.get("properties") or {})
        if key is None:
            continue
        groups.setdefault(key, []).append(feature)
    return groups


def _feature_indices_by_group(features: Sequence[dict[str, Any]]) -> dict[tuple[str, str], list[int]]:
    groups: dict[tuple[str, str], list[int]] = {}
    for index, feature in enumerate(features):
        key = _group_key(feature.get("properties") or {})
        if key is None:
            continue
        groups.setdefault(key, []).append(index)
    return groups


def _union_projected_features(features: Sequence[dict[str, Any]]) -> Polygon | MultiPolygon | None:
    geometries = []
    for feature in features:
        geometry = feature.get("geometry")
        if not geometry:
            continue
        projected = _project_geometry(geometry)
        if projected is not None:
            geometries.append(projected)
    if not geometries:
        return None
    unioned = unary_union(geometries)
    if not unioned.is_valid:
        unioned = unioned.buffer(0)
    if unioned.is_empty or not isinstance(unioned, (Polygon, MultiPolygon)):
        return None
    return unioned


def _footprints_intersect(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) -> bool:
    if a.bounds[2] < b.bounds[0] or a.bounds[0] > b.bounds[2] or a.bounds[3] < b.bounds[1] or a.bounds[1] > b.bounds[3]:
        return False
    try:
        return bool(a.intersects(b))
    except Exception:
        return bool(a.buffer(0).intersects(b.buffer(0)))


def _footprint_distance(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) -> float:
    if _footprints_intersect(a, b):
        return 0.0
    try:
        return float(a.distance(b))
    except Exception:
        return float(a.buffer(0).distance(b.buffer(0)))


def _contours_intersect(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon) -> bool:
    if a.bounds[2] < b.bounds[0] or a.bounds[0] > b.bounds[2] or a.bounds[3] < b.bounds[1] or a.bounds[1] > b.bounds[3]:
        return False
    try:
        intersection = a.boundary.intersection(b.boundary)
    except Exception:
        intersection = a.buffer(0).boundary.intersection(b.buffer(0).boundary)
    return not intersection.is_empty


def _find_new_intersection_groups(
    original_features: Sequence[dict[str, Any]],
    aligned_features: Sequence[dict[str, Any]],
) -> set[tuple[str, str]]:
    original_groups = {
        key: geometry
        for key, features in _features_by_group(original_features).items()
        if (geometry := _union_projected_features(features)) is not None
    }
    aligned_groups = {
        key: geometry
        for key, features in _features_by_group(aligned_features).items()
        if (geometry := _union_projected_features(features)) is not None
    }
    flagged: set[tuple[str, str]] = set()
    keys = sorted(aligned_groups.keys())
    for i, key_a in enumerate(keys):
        for key_b in keys[i + 1:]:
            original_a = original_groups.get(key_a)
            original_b = original_groups.get(key_b)
            if original_a is None or original_b is None:
                continue
            if _contours_intersect(original_a, original_b):
                continue
            if _contours_intersect(aligned_groups[key_a], aligned_groups[key_b]):
                flagged.add(key_a)
                flagged.add(key_b)
    return flagged


def _aligned_group_score(features: Sequence[dict[str, Any]]) -> float:
    values = [
        _safe_float((feature.get("properties") or {}).get("score"), np.nan)
        for feature in features
    ]
    finite_values = [value for value in values if np.isfinite(value)]
    return float(np.mean(finite_values)) if finite_values else 0.0


def _group_transform_value(features: Sequence[dict[str, Any]], property_name: str) -> float:
    values = [
        _safe_float((feature.get("properties") or {}).get(property_name), np.nan)
        for feature in features
    ]
    finite_values = [value for value in values if np.isfinite(value)]
    return float(np.mean(finite_values)) if finite_values else 0.0


def _original_feature_lookup(features: Sequence[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    lookup = {}
    for feature in features:
        properties = feature.get("properties") or {}
        patch_id = properties.get("patchId")
        osm_type = properties.get("osmType")
        full_id = properties.get("fullId")
        if patch_id is None or osm_type is None or full_id is None:
            continue
        lookup[(str(patch_id), str(osm_type), str(full_id))] = feature
    return lookup


def _matching_original_features(
    aligned_features: Sequence[dict[str, Any]],
    original_lookup: dict[tuple[str, str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    originals = []
    for feature in aligned_features:
        properties = feature.get("properties") or {}
        original = original_lookup.get((
            str(properties.get("patchId")),
            str(properties.get("osmType")),
            str(properties.get("fullId")),
        ))
        if original is not None:
            originals.append(original)
    return originals


def _build_secondary_group_states(
    original_features: Sequence[dict[str, Any]],
    aligned_features: Sequence[dict[str, Any]],
    candidate_keys: set[tuple[str, str]],
    strong_score_threshold: float,
) -> dict[tuple[str, str], SecondaryGroupState]:
    aligned_by_group = _features_by_group(aligned_features)
    aligned_indices_by_group = _feature_indices_by_group(aligned_features)
    original_lookup = _original_feature_lookup(original_features)
    states: dict[tuple[str, str], SecondaryGroupState] = {}
    for key in sorted(candidate_keys):
        aligned_group_features = aligned_by_group.get(key)
        if not aligned_group_features:
            continue
        current_features = [_clone_feature(feature) for feature in aligned_group_features]
        current_geometry = _union_projected_features(current_features)
        if current_geometry is None:
            continue
        original_group_features = _matching_original_features(current_features, original_lookup)
        original_geometry = _union_projected_features(original_group_features) if original_group_features else None
        if original_geometry is None:
            original_geometry = current_geometry
        group_score = _aligned_group_score(current_features)
        states[key] = SecondaryGroupState(
            key=key,
            group_id=key[1],
            aligned_feature_indices=aligned_indices_by_group.get(key, []),
            original_features=original_group_features,
            current_features=current_features,
            original_geometry_2326=original_geometry,
            current_geometry_2326=current_geometry,
            score=group_score,
            dx_meters=_group_transform_value(current_features, "dxMeters"),
            dy_meters=_group_transform_value(current_features, "dyMeters"),
            rotation_deg=_group_transform_value(current_features, "rotationDeg"),
            strong=group_score > strong_score_threshold,
        )
    return states


def _build_reference_group_states(
    original_features: Sequence[dict[str, Any]],
    aligned_features: Sequence[dict[str, Any]],
) -> dict[tuple[str, str], SecondaryGroupState]:
    return _build_secondary_group_states(
        original_features,
        aligned_features,
        set(_features_by_group(aligned_features).keys()),
        float("inf"),
    )


def _snapshot_reference_group_states(
    states: dict[tuple[str, str], SecondaryGroupState],
) -> dict[tuple[str, str], SecondaryGroupState]:
    return {key: replace(state) for key, state in states.items()}


def _translated_original_feature(
    original_feature: dict[str, Any],
    aligned_feature: dict[str, Any],
    dx_meters: float,
    dy_meters: float,
) -> dict[str, Any]:
    projected = _project_geometry(original_feature.get("geometry"))
    output = _clone_feature(aligned_feature)
    if projected is not None:
        output["geometry"] = _to_lonlat_geometry(translate(projected, xoff=dx_meters, yoff=dy_meters))
    properties = output["properties"]
    properties["dxMeters"] = dx_meters
    properties["dyMeters"] = dy_meters
    properties["rotationDeg"] = 0.0
    return output


def _apply_source_transform(weak: SecondaryGroupState, source: SecondaryGroupState, iteration: int) -> None:
    corrected_features = [
        _translated_original_feature(original_feature, aligned_feature, source.dx_meters, source.dy_meters)
        for aligned_feature, original_feature in zip(weak.current_features, weak.original_features)
    ]
    if len(corrected_features) != len(weak.current_features):
        return
    corrected_geometry = _union_projected_features(corrected_features)
    if corrected_geometry is None:
        return
    weak.current_features = corrected_features
    weak.current_geometry_2326 = corrected_geometry
    weak.dx_meters = source.dx_meters
    weak.dy_meters = source.dy_meters
    weak.rotation_deg = 0.0
    weak.corrected = True
    weak.strong = True
    weak.correction_source_group_id = source.group_id
    weak.correction_iteration = iteration


def _apply_trend_transform(weak: SecondaryGroupState, trend_dx: float, trend_dy: float) -> None:
    corrected_features = [
        _translated_original_feature(original_feature, aligned_feature, trend_dx, trend_dy)
        for aligned_feature, original_feature in zip(weak.current_features, weak.original_features)
    ]
    if len(corrected_features) != len(weak.current_features):
        return
    corrected_geometry = _union_projected_features(corrected_features)
    if corrected_geometry is None:
        return
    weak.current_features = corrected_features
    weak.current_geometry_2326 = corrected_geometry
    weak.dx_meters = trend_dx
    weak.dy_meters = trend_dy
    weak.rotation_deg = 0.0
    weak.trend_corrected = True


def _run_strong_group_propagation_stage(
    original_features: Sequence[dict[str, Any]],
    aligned_features: Sequence[dict[str, Any]],
) -> tuple[dict[tuple[str, str], SecondaryGroupState], dict[str, int]]:
    candidate_keys = _find_new_intersection_groups(original_features, aligned_features)
    states = _build_secondary_group_states(
        original_features,
        aligned_features,
        candidate_keys,
        STRONG_SCORE_THRESHOLD,
    )
    initial_strong_count = sum(1 for state in states.values() if state.strong)
    iteration = 0
    while True:
        iteration += 1
        strong_states = [state for state in states.values() if state.strong]
        weak_states = [state for state in states.values() if not state.strong]
        corrections: list[tuple[SecondaryGroupState, SecondaryGroupState]] = []
        for weak in weak_states:
            sources = [
                strong
                for strong in strong_states
                if _footprints_intersect(weak.current_geometry_2326, strong.current_geometry_2326)
            ]
            if sources:
                corrections.append((weak, max(sources, key=lambda item: (item.score, item.group_id))))
        if not corrections:
            iteration -= 1
            break
        for weak, source in corrections:
            _apply_source_transform(weak, source, iteration)
    strong_count = sum(1 for state in states.values() if state.strong)
    return states, {
        "secondaryCandidateGroupCount": len(states),
        "secondaryInitialStrongGroupCount": initial_strong_count,
        "secondaryFinalStrongGroupCount": strong_count,
        "secondaryStrongCorrectedGroupCount": sum(1 for state in states.values() if state.corrected),
        "secondaryStrongIterationCount": iteration,
    }


def _patch_id_from_key(key: tuple[str, str]) -> str:
    return key[0]


def _local_trend_neighbors(
    weak: SecondaryGroupState,
    reference_states: dict[tuple[str, str], SecondaryGroupState],
) -> list[SecondaryGroupState]:
    neighbors: dict[tuple[str, str], SecondaryGroupState] = {}
    weak_patch_id = _patch_id_from_key(weak.key)
    for candidate in reference_states.values():
        if candidate.key == weak.key:
            continue
        same_patch = _patch_id_from_key(candidate.key) == weak_patch_id
        nearby = _footprint_distance(weak.original_geometry_2326, candidate.original_geometry_2326) <= TREND_NEIGHBOR_DISTANCE_M
        if same_patch or nearby:
            neighbors[candidate.key] = candidate
    return list(neighbors.values())


def _median(values: list[float]) -> float:
    return float(np.median(np.asarray(values, dtype=np.float64))) if values else 0.0


def _scaled_mad(values: list[float]) -> float:
    if not values:
        return 0.0
    median_value = _median(values)
    return 1.4826 * _median([abs(value - median_value) for value in values])


def _local_translation_trend(neighbors: Sequence[SecondaryGroupState]) -> tuple[float, float, float]:
    trend_dx = _median([neighbor.dx_meters for neighbor in neighbors])
    trend_dy = _median([neighbor.dy_meters for neighbor in neighbors])
    spread_dx = _scaled_mad([neighbor.dx_meters for neighbor in neighbors])
    spread_dy = _scaled_mad([neighbor.dy_meters for neighbor in neighbors])
    spread = float(math.sqrt((spread_dx * spread_dx + spread_dy * spread_dy) / 2.0))
    return trend_dx, trend_dy, spread


def _run_local_translation_trend_stage(
    states: dict[tuple[str, str], SecondaryGroupState],
    reference_states: dict[tuple[str, str], SecondaryGroupState],
) -> dict[str, int]:
    corrected_count = 0
    skipped_insufficient = 0
    skipped_unstable = 0
    skipped_not_outlier = 0
    for weak in [state for state in states.values() if not state.strong]:
        neighbors = _local_trend_neighbors(weak, reference_states)
        weak.trend_neighbor_count = len(neighbors)
        has_two_neighbor_trend = False
        if len(neighbors) == 2:
            first, second = neighbors
            has_two_neighbor_trend = (
                abs(first.dx_meters - second.dx_meters) <= TREND_TWO_NEIGHBOR_MAX_DELTA_M
                and abs(first.dy_meters - second.dy_meters) <= TREND_TWO_NEIGHBOR_MAX_DELTA_M
            )
        if len(neighbors) < TREND_MIN_NEIGHBORS and not has_two_neighbor_trend:
            skipped_insufficient += 1
            continue
        trend_dx, trend_dy, raw_spread = _local_translation_trend(neighbors)
        local_spread = max(TREND_MIN_SPREAD_M, raw_spread)
        residual = float(np.hypot(weak.dx_meters - trend_dx, weak.dy_meters - trend_dy))
        weak.trend_dx_meters = trend_dx
        weak.trend_dy_meters = trend_dy
        weak.trend_residual_meters = residual
        weak.trend_spread_meters = local_spread
        if local_spread > TREND_MAX_SPREAD_M:
            skipped_unstable += 1
            continue
        threshold = max(TREND_MIN_RESIDUAL_M, TREND_SPREAD_MULTIPLIER * local_spread)
        if residual <= threshold or (abs(weak.dx_meters) <= 1.0 and abs(weak.dy_meters) <= 1.0):
            skipped_not_outlier += 1
            continue
        _apply_trend_transform(weak, trend_dx, trend_dy)
        corrected_count += 1
    return {
        "secondaryTrendCorrectedGroupCount": corrected_count,
        "secondaryTrendSkippedInsufficientNeighborCount": skipped_insufficient,
        "secondaryTrendSkippedUnstableCount": skipped_unstable,
        "secondaryTrendSkippedNotOutlierCount": skipped_not_outlier,
    }


def _merge_secondary_features(
    aligned_features: Sequence[dict[str, Any]],
    states: dict[tuple[str, str], SecondaryGroupState],
) -> list[dict[str, Any]]:
    corrected_by_index = {}
    for state in states.values():
        for index, feature in zip(state.aligned_feature_indices, state.current_features):
            corrected_by_index[index] = _clone_feature(feature)

    features = []
    for index, feature in enumerate(aligned_features):
        if index in corrected_by_index:
            features.append(corrected_by_index[index])
        else:
            features.append(_clone_feature(feature))
    return features


def _split_deferred_group_features(
    features: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    eligible = []
    deferred = []
    for feature in features:
        properties = feature.get("properties") or {}
        if properties.get("smallGroupExcluded") is True:
            deferred.append(feature)
        else:
            eligible.append(feature)
    return eligible, deferred


def _feature_identity(feature: dict[str, Any]) -> tuple[str, str, str] | None:
    properties = feature.get("properties") or {}
    patch_id = properties.get("patchId")
    osm_type = properties.get("osmType")
    full_id = properties.get("fullId")
    if patch_id is None or osm_type is None or full_id is None:
        return None
    return str(patch_id), str(osm_type), str(full_id)


def _feature_member_identity(feature: dict[str, Any]) -> tuple[str, str] | None:
    properties = feature.get("properties") or {}
    osm_type = properties.get("osmType")
    full_id = properties.get("fullId")
    if osm_type is None or full_id is None:
        return None
    return str(osm_type), str(full_id)


def _merge_matching_aligned_properties(
    original_feature: dict[str, Any],
    aligned_group_features: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    output = _clone_feature(original_feature)
    original_identity = _feature_member_identity(original_feature)
    matched = None
    for aligned_feature in aligned_group_features:
        if _feature_member_identity(aligned_feature) == original_identity:
            matched = aligned_feature
            break
    if matched is not None:
        output["properties"].update(matched.get("properties") or {})
    elif aligned_group_features:
        representative = aligned_group_features[0].get("properties") or {}
        for key in (
            "attachmentGroupIndex",
            "attachmentGroupId",
            "attachmentGroupSize",
            "attachmentGroupMemberIds",
            "dxMeters",
            "dyMeters",
            "rotationDeg",
            "score",
            "smallGroupExcluded",
            "smallGroupAreaM2",
            "smallGroupInheritedFromGroupId",
            "deferredAlignmentReason",
        ):
            if key in representative:
                output["properties"][key] = representative[key]
    return output


def _original_patch_member_features(patches: Sequence[AlignmentPatchRequestItem]) -> list[dict[str, Any]]:
    features = []
    for patch in patches:
        member_ids_by_group: dict[tuple[int, str | None], list[str]] = {}
        group_sizes: dict[tuple[int, str | None], int] = {}
        for fallback_index, member in enumerate(patch.members):
            group_index = int(member.attachmentGroupIndex if member.attachmentGroupIndex is not None else fallback_index)
            group_id = member.attachmentGroupId or f"{patch.patchId}-attachment-group-{group_index}"
            key = (group_index, group_id)
            member_ids_by_group.setdefault(key, []).append(member.fullId)
            group_sizes[key] = int(member.attachmentGroupSize or 0)
        for fallback_index, member in enumerate(patch.members):
            group_index = int(member.attachmentGroupIndex if member.attachmentGroupIndex is not None else fallback_index)
            group_id = member.attachmentGroupId or f"{patch.patchId}-attachment-group-{group_index}"
            key = (group_index, group_id)
            member_ids = member_ids_by_group.get(key, [member.fullId])
            features.append({
                "type": "Feature",
                "properties": {
                    "patchId": patch.patchId,
                    "fullId": member.fullId,
                    "osmType": member.osmType,
                    "attachmentGroupIndex": group_index,
                    "attachmentGroupId": group_id,
                    "attachmentGroupSize": group_sizes.get(key) or len(member_ids),
                    "attachmentGroupMemberIds": member_ids,
                    "dxMeters": 0.0,
                    "dyMeters": 0.0,
                    "rotationDeg": 0.0,
                    "score": 0.0,
                },
                "geometry": member.geometry,
            })
    return features


def _transform_geometry(
    geometry: Polygon | MultiPolygon,
    center: tuple[float, float],
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


def _group_transform_from_features(features: Sequence[dict[str, Any]]) -> tuple[float, float, float]:
    return (
        _group_transform_value(features, "dxMeters"),
        _group_transform_value(features, "dyMeters"),
        _group_transform_value(features, "rotationDeg"),
    )


def _inherit_deferred_group_features(
    patches: Sequence[AlignmentPatchRequestItem],
    original_deferred_features: Sequence[dict[str, Any]],
    original_eligible_features: Sequence[dict[str, Any]],
    final_eligible_features: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    eligible_by_key = _features_by_group(final_eligible_features)
    original_eligible_by_key = _features_by_group(original_eligible_features)
    tree_by_key: dict[tuple[str, str], Any] = {}
    for patch in patches:
        for node in patch.attachmentGroupTree:
            tree_by_key[(patch.patchId, node.groupId)] = node

    inherited_features = []
    for deferred_features in _features_by_group(original_deferred_features).values():
        sample_properties = deferred_features[0].get("properties") or {}
        key = _group_key(sample_properties)
        deferred_geometry = _union_projected_features(deferred_features)
        deferred_area_m2 = float(deferred_geometry.area) if deferred_geometry is not None else 0.0
        deferred_reason = sample_properties.get("deferredAlignmentReason")
        node = tree_by_key.get(key) if key else None
        inherited_key = None
        while node is not None and node.parentGroupId is not None:
            parent_key = (key[0], node.parentGroupId) if key else None
            if parent_key in eligible_by_key:
                inherited_key = parent_key
                break
            node = tree_by_key.get(parent_key) if parent_key else None

        inherited_dx = inherited_dy = inherited_rotation = 0.0
        inherited_center: tuple[float, float] | None = None
        if inherited_key is not None:
            inherited_dx, inherited_dy, inherited_rotation = _group_transform_from_features(eligible_by_key[inherited_key])
            parent_original_geometry = _union_projected_features(original_eligible_by_key.get(inherited_key, []))
            if parent_original_geometry is not None:
                centroid = parent_original_geometry.centroid
                inherited_center = (float(centroid.x), float(centroid.y))
            else:
                inherited_key = None
                inherited_dx = inherited_dy = inherited_rotation = 0.0

        for feature in deferred_features:
            output = _clone_feature(feature)
            projected = _project_geometry(feature.get("geometry"))
            if projected is not None and inherited_center is not None:
                output["geometry"] = _to_lonlat_geometry(
                    _transform_geometry(projected, inherited_center, inherited_rotation, inherited_dx, inherited_dy)
                )
            properties = output["properties"]
            properties["dxMeters"] = inherited_dx
            properties["dyMeters"] = inherited_dy
            properties["rotationDeg"] = inherited_rotation if inherited_center is not None else 0.0
            properties["score"] = 0.0
            properties["smallGroupExcluded"] = True
            properties["smallGroupAreaM2"] = deferred_area_m2
            properties["smallGroupInheritedFromGroupId"] = inherited_key[1] if inherited_key else None
            properties["deferredAlignmentReason"] = deferred_reason
            inherited_features.append(output)
    return inherited_features


def apply_secondary_correction(
    patches: Sequence[AlignmentPatchRequestItem],
    aligned_features: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    eligible_aligned, deferred_features = _split_deferred_group_features(aligned_features)
    eligible_keys = set(_features_by_group(eligible_aligned).keys())
    deferred_keys = set(_features_by_group(deferred_features).keys())
    original_features = _original_patch_member_features(patches)
    original_eligible = [
        feature
        for feature in original_features
        if _group_key(feature.get("properties") or {}) in eligible_keys
    ]
    deferred_aligned_by_key = _features_by_group(deferred_features)
    original_deferred = []
    for feature in original_features:
        key = _group_key(feature.get("properties") or {})
        if key not in deferred_keys:
            continue
        original_deferred.append(_merge_matching_aligned_properties(
            feature,
            deferred_aligned_by_key.get(key, []),
        ))
    final_eligible, secondary_summary = apply_secondary_correction_to_eligible_features(
        original_eligible,
        eligible_aligned,
    )
    final_deferred = _inherit_deferred_group_features(patches, original_deferred, original_eligible, final_eligible)
    feature_by_identity = {
        identity: feature
        for feature in [*final_eligible, *final_deferred]
        if (identity := _feature_identity(feature)) is not None
    }
    final_features = [
        feature_by_identity.get(_feature_identity(feature), _clone_feature(feature))
        for feature in aligned_features
    ]
    return final_features, {
        **secondary_summary,
        "secondaryEligibleFeatureCount": len(final_eligible),
        "secondarySmallFeatureCount": len(final_deferred),
    }


def apply_secondary_correction_to_eligible_features(
    original_features: Sequence[dict[str, Any]],
    aligned_features: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    reference_states = _build_reference_group_states(original_features, aligned_features)
    states, strong_summary = _run_strong_group_propagation_stage(original_features, aligned_features)
    reference_states.update(states)
    trend_summary = _run_local_translation_trend_stage(states, _snapshot_reference_group_states(reference_states))
    final_features = _merge_secondary_features(aligned_features, states)
    return final_features, {
        **strong_summary,
        **trend_summary,
        "secondaryEligibleFeatureCount": len(final_features),
        "secondarySmallFeatureCount": 0,
    }
