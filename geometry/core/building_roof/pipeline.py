"""Pipeline for patch-level roof top mesh extraction."""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Dict, List, Sequence

from core.building_roof.roof_cluster_mesh_export import (
    RoofClusterMeshObjWriter,
)
from core.building_roof.roof_plane_extraction import (
    RoofPlaneOptions,
    build_roof_plane_cluster_geojson,
    extract_patch_roof_planes,
    roof_plane_main_cluster_sampling_ranges,
)
from core.building_roof.roof_top_extraction import (
    extract_top_visible_roof_triangles,
    project_patch_geometry,
    write_roof_triangles_obj,
)
from schemas.building_roof import (
    PatchRoofExtractionItem,
    PatchRoofExtractionRequest,
    PatchRoofExtractionResponse,
)
from utils.geo import to_lonlat

logger = logging.getLogger(__name__)

DEFAULT_OUTPUT_DIR_NAME = "roof_top_patch_outputs"
ROOF_PLANE_CLUSTERS_GEOJSON_FILE_NAME = "roof_plane_clusters.geojson"


def extract_patch_roofs(req: PatchRoofExtractionRequest) -> PatchRoofExtractionResponse:
    index_path, input_dir = _resolve_input_paths(req)
    output_dir = Path(req.output_dir) if req.output_dir else input_dir.parent / DEFAULT_OUTPUT_DIR_NAME
    output_dir.mkdir(parents=True, exist_ok=True)
    building_dir = _resolve_building_dir(input_dir)
    roof_dir = building_dir / "roof"
    roof_dir.mkdir(parents=True, exist_ok=True)

    patch_refs = _load_patch_refs(index_path, input_dir)
    offset_2326 = _resolve_offset(req.offset_2326, patch_refs)
    origin_lon, origin_lat = to_lonlat.transform(float(offset_2326[0]), float(offset_2326[1]))
    roof_plane_options = _roof_plane_options_from_request(req)

    items: List[PatchRoofExtractionItem] = []
    roof_plane_results = []
    logger.info(
        "[building-roof/top] start: patches=%d, input=%s, output=%s",
        len(patch_refs),
        index_path,
        output_dir,
    )

    with RoofClusterMeshObjWriter(roof_dir, max_clusters_per_range=3) as cluster_mesh_writer:
        for patch_ref in patch_refs:
            raw = _read_json(patch_ref["path"])
            patch_id = str(raw.get("patchId") or patch_ref["patch_id"])
            patch_index = raw.get("patchIndex", patch_ref.get("patch_index"))
            mesh_triangles = raw.get("meshTriangles") or []
            buffered_geometry = raw.get("bufferedGeometry") or raw.get("geometry")
            if not buffered_geometry:
                raise ValueError(f"patch {patch_id} missing bufferedGeometry/geometry")

            output_path = output_dir / f"{_safe_obj_stem(patch_id)}.obj"
            result = extract_top_visible_roof_triangles(
                mesh_triangles,
                buffered_geometry,
                offset_2326,
                grid_size_m=float(req.grid_size_m),
                top_epsilon_m=float(req.top_epsilon_m),
                max_grid_cells=int(req.max_grid_cells),
            )
            write_roof_triangles_obj(output_path, result.top_triangles)
            patch_roof_plane_results = extract_patch_roof_planes(
                raw,
                result.top_triangles,
                offset_2326,
                roof_plane_options,
                cluster_mesh_writer=cluster_mesh_writer,
            )
            _log_roof_plane_diagnostics(patch_roof_plane_results)
            roof_plane_results.extend(patch_roof_plane_results)

            item = PatchRoofExtractionItem(
                patch_id=patch_id,
                patch_index=int(patch_index) if patch_index is not None else None,
                input_path=str(patch_ref["path"]),
                output_path=str(output_path),
                candidate_triangle_count=result.candidate_triangle_count,
                top_triangle_count=len(result.top_triangles),
                grid_cell_count=result.grid_cell_count,
                valid_grid_cell_count=result.valid_grid_cell_count,
                tree_range_count=len(raw.get("treeRanges") or []),
            )
            items.append(item)

    roof_plane_cluster_geojson_path = roof_dir / ROOF_PLANE_CLUSTERS_GEOJSON_FILE_NAME
    roof_plane_cluster_geojson_path.write_text(
        json.dumps(build_roof_plane_cluster_geojson(roof_plane_results), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    resolved_count = sum(1 for item in roof_plane_results if item.resolved)
    logger.info(
        "[building-roof/top] finished: output=%s roofPlanes=%d/%d",
        output_dir,
        resolved_count,
        len(roof_plane_results),
    )
    return PatchRoofExtractionResponse(
        success=True,
        message="Patch roof top mesh extraction finished.",
        output_dir=str(output_dir),
        offset_2326=[float(offset_2326[0]), float(offset_2326[1])],
        origin_lonlat=[float(origin_lon), float(origin_lat)],
        roof_plane_cluster_output_path=str(roof_plane_cluster_geojson_path),
        roof_cluster_mesh_output_paths=[
            str(path)
            for rank, path in enumerate(cluster_mesh_writer.output_paths, start=1)
            if cluster_mesh_writer.triangle_counts.get(rank, 0) > 0
        ],
        roof_plane_tree_range_count=len(roof_plane_results),
        roof_z_by_full_id=_roof_z_by_full_id(roof_plane_results),
        unresolved_tree_ranges=_unresolved_roof_ranges(roof_plane_results),
        main_cluster_sampling_ranges=roof_plane_main_cluster_sampling_ranges(
            roof_plane_results,
            offset_2326,
        ),
        patches=items,
    )


def _roof_z_by_full_id(results) -> Dict[str, float]:
    values: Dict[str, float] = {}
    for item in results:
        if not item.resolved or not item.full_id or item.roof_z is None:
            continue
        values[str(item.full_id)] = float(item.roof_z)
    return values


def _resolve_input_paths(req: PatchRoofExtractionRequest) -> tuple[Path, Path]:
    if req.index_path:
        index_path = Path(req.index_path)
        input_dir = Path(req.input_dir) if req.input_dir else index_path.parent
    elif req.input_dir:
        input_dir = Path(req.input_dir)
        direct_index_path = input_dir / "index.json"
        staged_index_path = input_dir / "roof" / "roof_candidate_patch_inputs" / "index.json"
        nested_index_path = input_dir / "roof_candidate_patch_inputs" / "index.json"
        if direct_index_path.exists():
            index_path = direct_index_path
        elif staged_index_path.exists():
            index_path = staged_index_path
            input_dir = staged_index_path.parent
        elif nested_index_path.exists():
            index_path = nested_index_path
            input_dir = nested_index_path.parent
        else:
            index_path = direct_index_path
    else:
        raise ValueError("input_dir or index_path is required")

    if not index_path.exists():
        raise ValueError(f"roof candidate index not found: {index_path}")
    if not input_dir.exists():
        raise ValueError(f"roof candidate input_dir not found: {input_dir}")
    return index_path, input_dir


def _unresolved_roof_ranges(results) -> List[Dict[str, Any]]:
    return [
        {
            "patch_id": item.patch_id,
            "patch_index": item.patch_index,
            "full_id": item.full_id,
            "reason": item.unresolved_reason,
        }
        for item in results
        if not item.resolved
    ]


def _log_roof_plane_diagnostics(results) -> None:
    for item in results:
        if item.resolved:
            continue
        logger.warning(
            "[building-roof/plane] unresolved tree range: patchId=%s patchIndex=%s fullId=%s reason=%s",
            item.patch_id,
            item.patch_index,
            item.full_id,
            item.unresolved_reason,
        )


def _load_patch_refs(index_path: Path, input_dir: Path) -> List[Dict[str, Any]]:
    index = _read_json(index_path)
    refs: List[Dict[str, Any]] = []
    for item in index.get("patches") or []:
        json_file_name = item.get("jsonFileName") or item.get("json_file_name")
        if not json_file_name:
            continue
        refs.append({
            "patch_id": item.get("patchId") or item.get("patch_id") or Path(json_file_name).stem,
            "patch_index": item.get("patchIndex") if "patchIndex" in item else item.get("patch_index"),
            "path": input_dir / str(json_file_name),
        })

    if not refs:
        raise ValueError(f"roof candidate index has no patches: {index_path}")
    for ref in refs:
        if not ref["path"].exists():
            raise ValueError(f"roof candidate patch json not found: {ref['path']}")
    return refs


def _resolve_offset(offset_2326: Sequence[float] | None, patch_refs: Sequence[Dict[str, Any]]) -> List[float]:
    if offset_2326 is not None:
        if len(offset_2326) < 2:
            raise ValueError("offset_2326 must contain at least two values")
        return [float(offset_2326[0]), float(offset_2326[1])]

    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")
    for patch_ref in patch_refs:
        raw = _read_json(patch_ref["path"])
        geometry = raw.get("geometry") or raw.get("bufferedGeometry")
        if not geometry:
            continue
        projected = project_patch_geometry(geometry, [0.0, 0.0])
        if projected is None or projected.is_empty:
            continue
        bounds = projected.bounds
        min_x = min(min_x, float(bounds[0]))
        min_y = min(min_y, float(bounds[1]))
        max_x = max(max_x, float(bounds[2]))
        max_y = max(max_y, float(bounds[3]))

    if not all(math.isfinite(value) for value in (min_x, min_y, max_x, max_y)):
        raise ValueError("cannot compute offset_2326 because no valid patch geometry was found")

    return [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0]


def _read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def _safe_obj_stem(patch_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in patch_id) or "patch"


def _resolve_building_dir(input_dir: Path) -> Path:
    return input_dir.parent.parent if input_dir.parent.name == "roof" else input_dir.parent


def _roof_plane_options_from_request(req: PatchRoofExtractionRequest) -> RoofPlaneOptions:
    return RoofPlaneOptions(
        min_clipped_triangle_area_m2=float(req.min_clipped_triangle_area_m2),
        min_abs_normal_z=float(req.min_abs_normal_z),
        terrain_clearance_m=float(req.terrain_clearance_m),
        eps_z_m=float(req.eps_z_m),
        min_cluster_triangle_count=int(req.min_cluster_triangle_count),
        min_cluster_area_m2=float(req.min_cluster_area_m2),
        cluster_shape_close_m=float(req.cluster_shape_close_m),
        cluster_shape_open_m=float(req.cluster_shape_open_m),
        cluster_simplify_m=float(req.cluster_simplify_m),
        min_cluster_component_area_m2=float(req.min_cluster_component_area_m2),
        min_cluster_hole_area_m2=float(req.min_cluster_hole_area_m2),
        enhanced_terrain_clearance_m=float(req.enhanced_terrain_clearance_m),
        enhanced_terrain_clearance_span_m=float(req.enhanced_terrain_clearance_span_m),
    )
