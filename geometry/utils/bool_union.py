"""
3D Boolean-operation utilities.

Uses manifold3d to perform Boolean union and difference operations on watertight
trimesh meshes for corridor modeling, structure integration, and terrain clipping.

Always use process=False when converting back to trimesh. Distance-based vertex
merging in trimesh can otherwise damage the manifold topology guaranteed by manifold3d.
"""

import logging

import manifold3d
import numpy as np
import trimesh
from utils.geo import count_non_manifold_edges

logger = logging.getLogger(__name__)


def trimesh_to_manifold(mesh: trimesh.Trimesh) -> manifold3d.Manifold:
    """Convert a watertight trimesh mesh to a manifold3d Manifold."""
    m3d_mesh = manifold3d.Mesh(
        vert_properties=np.array(mesh.vertices, dtype=np.float32),
        tri_verts=np.array(mesh.faces, dtype=np.uint32),
    )
    return manifold3d.Manifold(m3d_mesh)


def manifold_to_trimesh(m: manifold3d.Manifold) -> trimesh.Trimesh:
    """
    manifold3d Manifold → trimesh。

    Preserve the topology produced by manifold3d with process=False and avoid
    distance-based merging that could introduce non-manifold geometry.
    """
    m3d_mesh = m.to_mesh()
    mesh = trimesh.Trimesh(
        vertices=m3d_mesh.vert_properties[:, :3],
        faces=m3d_mesh.tri_verts,
        process=False,
    )
    trimesh.repair.fix_normals(mesh)
    return mesh


def boolean_union(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh | None:
    """
    Perform a Boolean union over multiple watertight trimesh meshes.

    Args:
        meshes: A list containing at least one watertight Trimesh.

    Returns:
        The merged Trimesh, or None when the input is empty.
    """
    valid = [m for m in meshes if m is not None and len(m.faces) > 0]
    if not valid:
        return None
    if len(valid) == 1:
        return valid[0]

    result = trimesh_to_manifold(valid[0])
    for i, mesh in enumerate(valid[1:], start=1):
        try:
            result = result + trimesh_to_manifold(mesh)
        except Exception as e:
            logger.warning(f"[bool_union] union failed at mesh {i}: {e}, skipping")
            continue

    merged = manifold_to_trimesh(result)
    non_manifold = count_non_manifold_edges(merged) > 0
    message = (
        f"[bool_union] union {len(valid)} meshes -> "
        f"{len(merged.vertices)}v, {len(merged.faces)}f, "
        f"watertight={merged.is_watertight}, non_manifold={non_manifold}"
    )
    if len(merged.vertices) == 0 or len(merged.faces) == 0:
        logger.warning(f"{message}, status=empty_result")
    elif not merged.is_watertight or non_manifold:
        logger.warning(f"{message}, status=topology_error")
    return merged


def boolean_difference(
    minuend: trimesh.Trimesh,
    subtrahend: trimesh.Trimesh,
) -> trimesh.Trimesh | None:
    """
    Compute the Boolean difference between two watertight meshes: minuend - subtrahend.
    """
    if minuend is None or len(minuend.faces) == 0:
        return None
    if subtrahend is None or len(subtrahend.faces) == 0:
        return minuend

    try:
        result = trimesh_to_manifold(minuend) - trimesh_to_manifold(subtrahend)
    except Exception as exc:
        logger.warning(f"[bool_union] difference failed: {exc}")
        return None

    diff = manifold_to_trimesh(result)
    non_manifold = count_non_manifold_edges(diff) > 0
    message = (
        f"[bool_union] difference -> {len(diff.vertices)}v, {len(diff.faces)}f, "
        f"watertight={diff.is_watertight}, non_manifold={non_manifold}"
    )
    if len(diff.vertices) == 0 or len(diff.faces) == 0:
        logger.warning(f"{message}, status=empty_result")
    elif not diff.is_watertight or non_manifold:
        logger.warning(f"{message}, status=topology_error")
    else:
        logger.info(message)
    return diff
