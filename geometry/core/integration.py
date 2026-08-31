"""
Model topology integration:

Building-corridor integration: building + corridor -> structure.obj
"""

import logging
from pathlib import Path
from typing import List

import trimesh

from schemas.integration import StructureUnionRequest, StructureUnionResponse
from utils.bool_union import boolean_union
from utils.geo import count_non_manifold_edges

logger = logging.getLogger(__name__)


def _concatenate_components(components: List[trimesh.Trimesh]) -> trimesh.Trimesh | None:
    valid = [c for c in components if c is not None and len(c.faces) > 0]
    if not valid:
        return None
    if len(valid) == 1:
        return valid[0]
    return trimesh.util.concatenate(valid)


def _load_and_split(obj_path: Path, label: str) -> List[trimesh.Trimesh]:
    """Load an OBJ and split it into connected components."""
    if not obj_path.exists():
        logger.warning(f"[integration] {label} not found: {obj_path}")
        return []

    mesh = trimesh.load(str(obj_path), force="mesh", process=False)
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        logger.warning(f"[integration] {label} has no faces: {obj_path}")
        return []

    components: List[trimesh.Trimesh] = list(mesh.split(only_watertight=False))
    logger.info(
        f"[integration] loaded {label}: {len(mesh.vertices)}v, {len(mesh.faces)}f, "
        f"{len(components)} components"
    )

    watertight_count = sum(1 for c in components if c.is_watertight)
    if watertight_count < len(components):
        logger.warning(
            f"[integration] {label}: {len(components) - watertight_count}/{len(components)} "
            f"components non-watertight, may affect bool union"
        )
    return components


def structure_union(req: StructureUnionRequest) -> StructureUnionResponse:
    """Integrate buildings and corridors by loading, splitting, Boolean union, and export."""
    building_path = Path(req.building_path)
    output_path = Path(req.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    building_components = _load_and_split(building_path, "building")
    corridor_components: List[trimesh.Trimesh] = []
    if req.corridor_path:
        corridor_components = _load_and_split(Path(req.corridor_path), "corridor")

    all_components = building_components + corridor_components
    if not all_components:
        return StructureUnionResponse(
            success=False,
            message="No valid components to union (both building and corridor empty).",
        )

    logger.info(
        f"[integration] boolean union: building={len(building_components)}, "
        f"corridor={len(corridor_components)}, total={len(all_components)}"
    )

    if not building_components or not corridor_components:
        fallback = _concatenate_components(all_components)
        if fallback is None or len(fallback.faces) == 0:
            return StructureUnionResponse(
                success=False,
                message="No valid non-empty mesh available for fallback export.",
                building_components=len(building_components),
                corridor_components=len(corridor_components),
            )

        non_manifold_edges = count_non_manifold_edges(fallback)
        watertight = bool(fallback.is_watertight and non_manifold_edges == 0)
        fallback.export(str(output_path))
        logger.warning(
            f"[integration] skipped bool union because one input side is empty: "
            f"building={len(building_components)}, corridor={len(corridor_components)}, "
            f"output={output_path}"
        )
        return StructureUnionResponse(
            success=True,
            message="Bool union skipped because one input side is empty; exported fallback mesh.",
            output_path=str(output_path),
            building_components=len(building_components),
            corridor_components=len(corridor_components),
            vertex_count=int(len(fallback.vertices)),
            triangle_count=int(len(fallback.faces)),
            watertight=watertight,
            non_manifold_edges=non_manifold_edges,
        )

    merged = boolean_union(all_components)
    if merged is None or len(merged.faces) == 0:
        return StructureUnionResponse(
            success=False,
            message="Boolean union produced empty mesh.",
            building_components=len(building_components),
            corridor_components=len(corridor_components),
        )

    non_manifold_edges = count_non_manifold_edges(merged)
    watertight = bool(merged.is_watertight and non_manifold_edges == 0)

    merged.export(str(output_path))
    logger.info(
        f"[integration] exported {output_path}: {len(merged.vertices)}v, "
        f"{len(merged.faces)}f, watertight={watertight}, "
        f"non_manifold_edges={non_manifold_edges}"
    )

    return StructureUnionResponse(
        success=True,
        message="Structure union finished.",
        output_path=str(output_path),
        building_components=len(building_components),
        corridor_components=len(corridor_components),
        vertex_count=int(len(merged.vertices)),
        triangle_count=int(len(merged.faces)),
        watertight=watertight,
        non_manifold_edges=non_manifold_edges,
    )
