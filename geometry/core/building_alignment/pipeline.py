"""Building patch alignment pipeline."""

import json
import logging
import math
import os
import time
from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple

import numpy as np

from core.building_alignment.raster_alignment import (
    align_patch_first_pass,
    build_aligned_buildings_geojson,
    failed_alignment_preview,
)
from core.building_alignment.secondary_correction import apply_secondary_correction
from core.building_alignment.section_raster import (
    build_patch_section_count_grid,
)
from schemas.building_alignment import AlignmentPatchRequestItem, BuildingAlignmentRequest
from utils.geo import to_local_projected

logger = logging.getLogger(__name__)

SECTION_SCAN_STEP_M = 1.0
MIN_SECTION_SEGMENT_LENGTH_M = 0.3
Z_EPS = 1e-7
XY_EPS = 1e-7
ALIGNED_BUILDINGS_FILE_NAME = "aligned_buildings.geojson"
ALIGNMENT_FIGURE_DATA_DIR_NAME = "alignment_figure_data"
SECTION_SEGMENTS_OBJ_FILE_NAME = "section_segments.obj"
SECTION_SEGMENTS_2D_FILE_NAME = "section_segments_2d.geojson"


@dataclass(frozen=True)
class ProjectedTriangle:
    points: np.ndarray
    z_min: float
    z_max: float
    tile_id: str | None = None
    face_index: int | None = None


@dataclass(frozen=True)
class SectionSegment:
    start_xy: Tuple[float, float]
    end_xy: Tuple[float, float]
    z: float
    tile_id: str | None = None
    face_index: int | None = None


def _safe_obj_stem(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value) or "patch"


def _project_lonlat(lon: float, lat: float) -> Tuple[float, float]:
    x, y = to_local_projected.transform(lon, lat)
    return float(x), float(y)


def _mesh_triangle_points(tri) -> np.ndarray | None:
    if len(tri.geo) != 3:
        return None
    projected: List[List[float]] = []
    for vertex in tri.geo:
        if len(vertex) < 3:
            return None
        lon, lat, z = float(vertex[0]), float(vertex[1]), float(vertex[2])
        x, y = _project_lonlat(lon, lat)
        projected.append([x, y, z])
    points = np.asarray(projected, dtype=np.float64)
    if not np.isfinite(points).all():
        return None
    return points


def _project_mesh_triangles(mesh_triangles) -> List[ProjectedTriangle]:
    projected: List[ProjectedTriangle] = []
    for tri in mesh_triangles:
        points = _mesh_triangle_points(tri)
        if points is None:
            continue
        projected.append(ProjectedTriangle(
            points=points,
            z_min=float(np.min(points[:, 2])),
            z_max=float(np.max(points[:, 2])),
            tile_id=tri.tileId,
            face_index=tri.faceIndex,
        ))
    return projected


def _dedupe_points(points: List[np.ndarray]) -> List[np.ndarray]:
    result: List[np.ndarray] = []
    for point in points:
        if not any(float(np.linalg.norm(point - existing)) <= XY_EPS for existing in result):
            result.append(point)
    return result


def _triangle_section_segment(
    points: np.ndarray,
    z: float,
    tile_id: str | None,
    face_index: int | None,
) -> SectionSegment | None:
    z_values = points[:, 2]
    if np.all(np.abs(z_values - z) <= Z_EPS):
        return None

    intersections: List[np.ndarray] = []
    for start_index, end_index in ((0, 1), (1, 2), (2, 0)):
        start = points[start_index]
        end = points[end_index]
        d0 = float(start[2] - z)
        d1 = float(end[2] - z)
        if abs(d0) <= Z_EPS and abs(d1) <= Z_EPS:
            continue
        if abs(d0) <= Z_EPS:
            intersections.append(start[:2])
        elif abs(d1) <= Z_EPS:
            intersections.append(end[:2])
        elif d0 * d1 < 0:
            t = (z - float(start[2])) / float(end[2] - start[2])
            intersections.append(start[:2] + t * (end[:2] - start[:2]))

    unique = _dedupe_points(intersections)
    if len(unique) < 2:
        return None
    if len(unique) > 2:
        best_pair = (unique[0], unique[1])
        best_distance = -math.inf
        for i in range(len(unique)):
            for j in range(i + 1, len(unique)):
                distance = float(np.linalg.norm(unique[i] - unique[j]))
                if distance > best_distance:
                    best_pair = (unique[i], unique[j])
                    best_distance = distance
        p0, p1 = best_pair
    else:
        p0, p1 = unique

    length = float(np.linalg.norm(p1 - p0))
    if length < MIN_SECTION_SEGMENT_LENGTH_M:
        return None
    return SectionSegment(
        start_xy=(float(p0[0]), float(p0[1])),
        end_xy=(float(p1[0]), float(p1[1])),
        z=float(z),
        tile_id=tile_id,
        face_index=face_index,
    )


def _section_segments_at_height(projected_triangles: Sequence[ProjectedTriangle], z: float) -> List[SectionSegment]:
    segments: List[SectionSegment] = []
    for tri in projected_triangles:
        if z < tri.z_min - Z_EPS or z > tri.z_max + Z_EPS:
            continue
        segment = _triangle_section_segment(tri.points, z, tri.tile_id, tri.face_index)
        if segment is not None:
            segments.append(segment)
    return segments


def _scan_heights(projected_triangles: Sequence[ProjectedTriangle]) -> List[float]:
    if not projected_triangles:
        return []
    z_min = min(tri.z_min for tri in projected_triangles)
    z_max = max(tri.z_max for tri in projected_triangles)
    start = math.floor(z_min / SECTION_SCAN_STEP_M) * SECTION_SCAN_STEP_M
    heights: List[float] = []
    z = start
    while z <= z_max + Z_EPS:
        if z >= z_min - Z_EPS:
            heights.append(float(z))
        z += SECTION_SCAN_STEP_M
    return heights


def _section_segments_local_origin(segments: Sequence[SectionSegment]) -> Tuple[float, float, float]:
    xs: List[float] = []
    ys: List[float] = []
    zs: List[float] = []
    for segment in segments:
        xs.extend([segment.start_xy[0], segment.end_xy[0]])
        ys.extend([segment.start_xy[1], segment.end_xy[1]])
        zs.append(segment.z)
    if not xs or not ys or not zs:
        return 0.0, 0.0, 0.0
    return (
        (min(xs) + max(xs)) / 2.0,
        (min(ys) + max(ys)) / 2.0,
        min(zs),
    )


def _write_section_segments_obj(
    output_path: str,
    patch_id: str,
    segments: Sequence[SectionSegment],
) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    origin_x, origin_y, origin_z = _section_segments_local_origin(segments)
    with open(output_path, "w", encoding="utf-8") as file:
        file.write("# CityWind building alignment section segments\n")
        file.write(f"# patch_id {patch_id}\n")
        file.write(f"# segment_count {len(segments)}\n")
        file.write("# visualization coordinates: x/y centered on segment bbox, z relative to minimum scan height\n")
        file.write(f"# origin_2326_x {origin_x:.6f}\n")
        file.write(f"# origin_2326_y {origin_y:.6f}\n")
        file.write(f"# origin_z {origin_z:.6f}\n")
        vertex_index = 1
        for segment in segments:
            x0 = segment.start_xy[0] - origin_x
            y0 = segment.start_xy[1] - origin_y
            x1 = segment.end_xy[0] - origin_x
            y1 = segment.end_xy[1] - origin_y
            z = segment.z - origin_z
            file.write(f"v {x0:.6f} {y0:.6f} {z:.6f}\n")
            file.write(f"v {x1:.6f} {y1:.6f} {z:.6f}\n")
            file.write(f"l {vertex_index} {vertex_index + 1}\n")
            vertex_index += 2


def _write_section_segments_2d_geojson(
    output_path: str,
    patch_id: str,
    segments: Sequence[SectionSegment],
    raster,
) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    min_x, min_y, _max_x, _max_y = raster.bbox_2326
    features = []
    for index, segment in enumerate(segments):
        features.append({
            "type": "Feature",
            "properties": {
                "patchId": patch_id,
                "segmentIndex": index,
                "z": segment.z,
                "tileId": segment.tile_id,
                "faceIndex": segment.face_index,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [
                        round(segment.start_xy[0] - min_x, 6),
                        round(segment.start_xy[1] - min_y, 6),
                    ],
                    [
                        round(segment.end_xy[0] - min_x, 6),
                        round(segment.end_xy[1] - min_y, 6),
                    ],
                ],
            },
        })

    payload = {
        "type": "FeatureCollection",
        "name": f"{patch_id}_section_segments_2d",
        "metadata": {
            "patchId": patch_id,
            "coordinateSpace": "raster-local meters",
            "localOrigin2326": [min_x, min_y],
            "segmentCount": len(segments),
        },
        "features": features,
    }
    with open(output_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


def _write_patch_figure_manifest(output_path: str, patch_id: str, files: dict) -> None:
    payload = {
        "patchId": patch_id,
        "coordinateSpace": "raster-local meters for 2D figure data",
        "files": files,
    }
    with open(output_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


def _load_patch_input(path: str) -> AlignmentPatchRequestItem:
    with open(path, "r", encoding="utf-8") as file:
        raw = json.load(file)
    return AlignmentPatchRequestItem.model_validate(raw)


def _iter_request_patch_sources(req: BuildingAlignmentRequest) -> Iterable[Tuple[str, int | str, AlignmentPatchRequestItem]]:
    for index, patch in enumerate(req.patches):
        yield "inline", index, patch
    for input_path in req.patchInputPaths:
        yield "file", input_path, _load_patch_input(input_path)


def _resolve_building_output_dir(req: BuildingAlignmentRequest) -> str:
    if req.buildingOutputDir:
        return req.buildingOutputDir
    raise ValueError("buildingOutputDir is required for building alignment")


def run_building_alignment(req: BuildingAlignmentRequest) -> dict:
    alignment_items = []
    processed_patches: List[AlignmentPatchRequestItem] = []
    building_output_dir = _resolve_building_output_dir(req)
    figure_data_dir = os.path.join(building_output_dir, ALIGNMENT_FIGURE_DATA_DIR_NAME)
    section_segments_obj_paths: List[str] = []
    section_segments_2d_paths: List[str] = []
    patch_figure_data_dirs: List[str] = []
    patch_figure_data_manifests: List[str] = []
    processed_patch_count = 0
    total_section_segment_count = 0
    os.makedirs(building_output_dir, exist_ok=True)
    os.makedirs(figure_data_dir, exist_ok=True)
    logger.info(
        "[building-alignment] start: patches=%d, patchFiles=%d, buildingOutput=%s",
        len(req.patches) + len(req.patchInputPaths),
        len(req.patchInputPaths),
        building_output_dir,
    )

    for _source_kind, _source_ref, patch in _iter_request_patch_sources(req):
        processed_patch_count += 1
        processed_patches.append(patch)
        patch_started = time.perf_counter()
        project_started = time.perf_counter()
        projected_triangles = _project_mesh_triangles(patch.meshTriangles)
        logger.info(
            "[building-alignment] patch=%s project-mesh: meshTriangles=%d, projected=%d, elapsed=%.3fs",
            patch.patchId,
            len(patch.meshTriangles),
            len(projected_triangles),
            time.perf_counter() - project_started,
        )
        heights_started = time.perf_counter()
        heights = _scan_heights(projected_triangles)
        logger.info(
            "[building-alignment] patch=%s scan-heights: count=%d, elapsed=%.3fs",
            patch.patchId,
            len(heights),
            time.perf_counter() - heights_started,
        )
        patch_segment_count = 0
        patch_segments: List[SectionSegment] = []
        section_started = time.perf_counter()
        for z in heights:
            segments = _section_segments_at_height(projected_triangles, z)
            patch_segment_count += len(segments)
            patch_segments.extend(segments)
        total_section_segment_count += patch_segment_count
        logger.info(
            "[building-alignment] patch=%s section-slicing: heights=%d, segments=%d, elapsed=%.3fs",
            patch.patchId,
            len(heights),
            patch_segment_count,
            time.perf_counter() - section_started,
        )
        safe_stem = _safe_obj_stem(patch.patchId)
        patch_figure_dir = os.path.join(figure_data_dir, safe_stem)
        os.makedirs(patch_figure_dir, exist_ok=True)
        patch_figure_data_dirs.append(patch_figure_dir)
        segments_obj_path = os.path.join(patch_figure_dir, SECTION_SEGMENTS_OBJ_FILE_NAME)
        _write_section_segments_obj(segments_obj_path, patch.patchId, patch_segments)
        section_segments_obj_paths.append(segments_obj_path)
        logger.info(
            "[building-alignment] patch=%s section-segments-obj: %s",
            patch.patchId,
            segments_obj_path,
        )

        raster_started = time.perf_counter()
        count_raster = build_patch_section_count_grid(
            patch,
            patch_segments,
            len(heights),
        )
        logger.info(
            "[building-alignment] patch=%s count-grid: available=%s, segments=%d, elapsed=%.3fs",
            patch.patchId,
            bool(count_raster),
            len(patch_segments),
            time.perf_counter() - raster_started,
        )
        if count_raster:
            segments_2d_path = os.path.join(patch_figure_dir, SECTION_SEGMENTS_2D_FILE_NAME)
            _write_section_segments_2d_geojson(segments_2d_path, patch.patchId, patch_segments, count_raster)
            section_segments_2d_paths.append(segments_2d_path)
            manifest_path = os.path.join(patch_figure_dir, "manifest.json")
            _write_patch_figure_manifest(
                manifest_path,
                patch.patchId,
                {
                    "sectionSegmentsObj": SECTION_SEGMENTS_OBJ_FILE_NAME,
                    "sectionSegments2d": SECTION_SEGMENTS_2D_FILE_NAME,
                },
            )
            patch_figure_data_manifests.append(manifest_path)
            logger.info(
                "[building-alignment] patch=%s alignment-figure-data: dir=%s",
                patch.patchId,
                patch_figure_dir,
            )
            align_started = time.perf_counter()
            first_alignment = align_patch_first_pass(
                patch,
                count_raster,
            )
            logger.info(
                "[building-alignment] patch=%s raster-alignment: alignedGroups=%d elapsed=%.3fs",
                patch.patchId,
                sum(1 for group in first_alignment.group_previews if group.applied),
                time.perf_counter() - align_started,
            )
            if first_alignment.member_features:
                alignment_items.append(first_alignment)
        else:
            failed_alignment = failed_alignment_preview(patch, "missing_section_raster")
            alignment_items.append(failed_alignment)

        logger.info(
            "[building-alignment] patch=%s total elapsed=%.3fs",
            patch.patchId,
            time.perf_counter() - patch_started,
        )

    aligned_buildings = build_aligned_buildings_geojson(alignment_items)
    secondary_started = time.perf_counter()
    corrected_features, secondary_summary = apply_secondary_correction(
        processed_patches,
        aligned_buildings["features"],
    )
    aligned_buildings["features"] = corrected_features
    logger.info(
        "[building-alignment] secondary-correction: eligibleFeatures=%d smallFeatures=%d candidates=%d strongCorrected=%d trendCorrected=%d elapsed=%.3fs",
        secondary_summary.get("secondaryEligibleFeatureCount", 0),
        secondary_summary.get("secondarySmallFeatureCount", 0),
        secondary_summary.get("secondaryCandidateGroupCount", 0),
        secondary_summary.get("secondaryStrongCorrectedGroupCount", 0),
        secondary_summary.get("secondaryTrendCorrectedGroupCount", 0),
        time.perf_counter() - secondary_started,
    )
    aligned_buildings_path = os.path.join(building_output_dir, ALIGNED_BUILDINGS_FILE_NAME)
    with open(aligned_buildings_path, "w", encoding="utf-8") as file:
        json.dump(aligned_buildings, file, ensure_ascii=False, indent=2)

    logger.info(
        "[building-alignment] finished: patches=%d sectionSegments=%d",
        processed_patch_count,
        total_section_segment_count,
    )
    return {
        "success": True,
        "message": "building alignment completed",
        "scanStepMeters": SECTION_SCAN_STEP_M,
        "patchCount": processed_patch_count,
        "sectionSegmentCount": total_section_segment_count,
        "buildingOutputDir": building_output_dir,
        "alignedBuildingsGeojsonPath": aligned_buildings_path,
        "alignmentFigureDataDir": figure_data_dir,
        "alignmentFigurePatchDirs": patch_figure_data_dirs,
        "alignmentFigureManifestPaths": patch_figure_data_manifests,
        "sectionSegmentsObjPaths": section_segments_obj_paths,
        "sectionSegments2dPaths": section_segments_2d_paths,
    }
