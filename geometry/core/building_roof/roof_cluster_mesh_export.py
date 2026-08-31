"""Export clustered roof-range mesh diagnostics as rank-separated OBJ models."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Sequence, TextIO


CLUSTER_MESH_RANK_OBJ_FILE_NAMES = [
    "roof_plane_clusters_rank_1.obj",
    "roof_plane_clusters_rank_2.obj",
    "roof_plane_clusters_rank_3.obj",
]


class RoofClusterMeshObjWriter:
    """Streaming writer for the top roof-height cluster ranks.

    Threebox's current OBJ wrapper keeps only the first OBJLoader child. To keep
    the frontend path simple, each rank is exported as one single-object OBJ.
    """

    def __init__(
        self,
        output_dir: str | Path,
        *,
        max_clusters_per_range: int = 3,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.max_clusters_per_range = max(1, min(int(max_clusters_per_range), len(CLUSTER_MESH_RANK_OBJ_FILE_NAMES)))
        self.output_paths = [
            self.output_dir / file_name
            for file_name in CLUSTER_MESH_RANK_OBJ_FILE_NAMES[: self.max_clusters_per_range]
        ]
        self._files: Dict[int, TextIO] = {}
        self._vertex_indices: Dict[int, int] = {}
        self._cluster_counts: Dict[int, int] = {}
        self._triangle_counts: Dict[int, int] = {}

    @property
    def cluster_counts(self) -> Dict[int, int]:
        return dict(self._cluster_counts)

    @property
    def triangle_counts(self) -> Dict[int, int]:
        return dict(self._triangle_counts)

    def __enter__(self) -> "RoofClusterMeshObjWriter":
        self.output_dir.mkdir(parents=True, exist_ok=True)
        for rank, output_path in enumerate(self.output_paths, start=1):
            file = output_path.open("w", encoding="utf-8")
            file.write(f"# CityWind roof plane cluster mesh rank {rank}\n")
            file.write(f"o roof_cluster_rank_{rank}\n")
            self._files[rank] = file
            self._vertex_indices[rank] = 1
            self._cluster_counts[rank] = 0
            self._triangle_counts[rank] = 0
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        for rank, file in self._files.items():
            file.write(f"# cluster_count {self._cluster_counts.get(rank, 0)}\n")
            file.write(f"# triangle_count {self._triangle_counts.get(rank, 0)}\n")
            file.close()
        self._files.clear()

    def write_tree_range_clusters(
        self,
        *,
        patch_id: str,
        patch_index: int | None,
        tree_range: dict[str, Any],
        clusters: Sequence[Any],
        main_cluster_id: int | None,
    ) -> None:
        ordered = sorted(
            clusters,
            key=lambda cluster: (
                float(getattr(cluster, "visible_area", 0.0) or 0.0),
                float(getattr(cluster, "cleaned_area", 0.0) or 0.0),
                len(getattr(cluster, "triangles", []) or []),
            ),
            reverse=True,
        )[: self.max_clusters_per_range]

        for index, cluster in enumerate(ordered, start=1):
            file = self._files.get(index)
            if file is None:
                continue
            triangles = list(getattr(cluster, "triangles", []) or [])
            if not triangles:
                continue

            cluster_id = int(getattr(cluster, "cluster_id", index - 1))
            is_main = cluster_id == main_cluster_id
            file.write(
                f"# patch={patch_id} patchIndex={patch_index} "
                f"fullId={tree_range.get('fullId')} clusterId={cluster_id} isMain={str(is_main).lower()}\n"
            )
            for triangle in triangles:
                vertices = getattr(triangle, "vertices", None)
                if vertices is None or len(vertices) != 3:
                    continue
                face_indices = []
                for vertex in vertices:
                    x, y, z = float(vertex[0]), float(vertex[1]), float(vertex[2])
                    file.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")
                    face_indices.append(self._vertex_indices[index])
                    self._vertex_indices[index] += 1
                file.write(f"f {face_indices[0]} {face_indices[1]} {face_indices[2]}\n")
                self._triangle_counts[index] += 1

            self._cluster_counts[index] += 1
