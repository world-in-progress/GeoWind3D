"""Coordinate-transformation and geometry/mesh-quality utilities."""

from typing import Any, List

import numpy as np
import trimesh
from pyproj import Transformer
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon


# Coordinate transformers shared globally.

to_local_projected = Transformer.from_crs("EPSG:4326", "EPSG:2326", always_xy=True)
to_lonlat = Transformer.from_crs("EPSG:2326", "EPSG:4326", always_xy=True)


# Geometry utilities.

def extract_polygonal_geometry(geom: Any) -> Polygon | MultiPolygon | None:
    """Extract Polygon and MultiPolygon parts from any geometry, ignoring other types."""
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if isinstance(geom, GeometryCollection):
        polygons = [g for g in geom.geoms if isinstance(g, Polygon)]
        multi_polygons = [g for g in geom.geoms if isinstance(g, MultiPolygon)]
        flattened: List[Polygon] = polygons + [p for mp in multi_polygons for p in mp.geoms]
        if len(flattened) == 0:
            return None
        if len(flattened) == 1:
            return flattened[0]
        return MultiPolygon(flattened)
    return None


def to_local_projected_geometry(geom: Polygon | MultiPolygon) -> Polygon | MultiPolygon:
    """Project a WGS84 polygon to local EPSG:2326 coordinates."""
    def transform_ring(ring: List[List[float]]) -> List[List[float]]:
        out: List[List[float]] = []
        for coord in ring:
            lon = float(coord[0])
            lat = float(coord[1])
            x, y = to_local_projected.transform(lon, lat)
            out.append([float(x), float(y)])
        return out

    if isinstance(geom, Polygon):
        shell = transform_ring(list(geom.exterior.coords))
        holes = [transform_ring(list(interior.coords)) for interior in geom.interiors]
        return Polygon(shell, holes)

    polys: List[Polygon] = []
    for p in geom.geoms:
        shell = transform_ring(list(p.exterior.coords))
        holes = [transform_ring(list(interior.coords)) for interior in p.interiors]
        polys.append(Polygon(shell, holes))
    return MultiPolygon(polys)


# Mesh-quality utilities.

def count_non_manifold_edges(mesh: trimesh.Trimesh) -> int:
    """Count non-manifold edges."""
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if faces.size == 0:
        return 0

    e1 = np.sort(faces[:, [0, 1]], axis=1)
    e2 = np.sort(faces[:, [1, 2]], axis=1)
    e3 = np.sort(faces[:, [2, 0]], axis=1)
    edges = np.vstack([e1, e2, e3])
    if edges.size == 0:
        return 0

    keys = edges[:, 0].astype(np.int64) * (mesh.vertices.shape[0] + 1) + edges[:, 1].astype(np.int64)
    _, counts = np.unique(keys, return_counts=True)
    return int(np.sum(counts != 2))


def sanitize_mesh(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Remove duplicate and degenerate faces, fix normals, and fill holes."""
    if hasattr(mesh, "remove_duplicate_faces"):
        mesh.remove_duplicate_faces()
    if hasattr(mesh, "remove_degenerate_faces"):
        mesh.remove_degenerate_faces()
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(mesh)
    trimesh.repair.fill_holes(mesh)
    return mesh
