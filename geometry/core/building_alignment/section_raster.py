"""Raster diagnostics for building patch section segments."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Sequence, Tuple

import numpy as np
from shapely.geometry import shape

from schemas.building_alignment import AlignmentPatchRequestItem
from utils.geo import to_local_projected

SECTION_RASTER_PIXEL_SIZE_M = 2.0
SECTION_RASTER_PADDING_CELLS = 4


@dataclass(frozen=True)
class RasterGrid:
    patch_id: str
    grid: np.ndarray
    width: int
    height: int
    pixel_size_meters: float
    segment_count: int
    height_count: int
    bbox_2326: Tuple[float, float, float, float]


def _geometry_bbox_2326(geometry: dict) -> Tuple[float, float, float, float] | None:
    geom = shape(geometry)
    if geom.is_empty:
        return None
    xs: List[float] = []
    ys: List[float] = []
    for x, y in np.asarray(geom.exterior.coords if geom.geom_type == "Polygon" else []).reshape(-1, 2):
        px, py = to_local_projected.transform(float(x), float(y))
        xs.append(float(px))
        ys.append(float(py))
    if geom.geom_type == "MultiPolygon":
        for poly in geom.geoms:
            for x, y in poly.exterior.coords:
                px, py = to_local_projected.transform(float(x), float(y))
                xs.append(float(px))
                ys.append(float(py))
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _segments_bbox(segments) -> Tuple[float, float, float, float] | None:
    if not segments:
        return None
    xs: List[float] = []
    ys: List[float] = []
    for segment in segments:
        xs.extend([segment.start_xy[0], segment.end_xy[0]])
        ys.extend([segment.start_xy[1], segment.end_xy[1]])
    return min(xs), min(ys), max(xs), max(ys)


def _raster_bounds(patch: AlignmentPatchRequestItem, segments) -> Tuple[float, float, float, float] | None:
    bbox = None
    if patch.bufferedGeometry:
        bbox = _geometry_bbox_2326(patch.bufferedGeometry)
    if bbox is None:
        bbox = _geometry_bbox_2326(patch.geometry)
    if bbox is None:
        bbox = _segments_bbox(segments)
    if bbox is None:
        return None
    min_x, min_y, max_x, max_y = bbox
    padding_m = SECTION_RASTER_PIXEL_SIZE_M * SECTION_RASTER_PADDING_CELLS
    return (
        min_x - padding_m,
        min_y - padding_m,
        max_x + padding_m,
        max_y + padding_m,
    )


def _segment_touched_cells(
    grid_shape: Tuple[int, int],
    bounds: Tuple[float, float, float, float],
    segment,
) -> set[Tuple[int, int]]:
    min_x, _min_y, _max_x, max_y = bounds
    pixel = SECTION_RASTER_PIXEL_SIZE_M
    x0, y0 = segment.start_xy
    x1, y1 = segment.end_xy
    length = math.hypot(x1 - x0, y1 - y0)
    if length <= 0:
        return set()
    sample_count = max(2, int(math.ceil(length / (pixel * 0.25))) + 1)
    touched: set[Tuple[int, int]] = set()
    for i in range(sample_count):
        t = i / (sample_count - 1)
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * t
        col = int(math.floor((x - min_x) / pixel))
        row = int(math.floor((max_y - y) / pixel))
        if 0 <= row < grid_shape[0] and 0 <= col < grid_shape[1]:
            touched.add((row, col))
    return touched


def _height_key(z: float) -> int:
    return int(round(float(z) * 10_000_000))


def _burn_cells(grid: np.ndarray, touched: set[Tuple[int, int]]) -> None:
    for row, col in touched:
        grid[row, col] += 1


def _burn_height_layers(
    grid: np.ndarray,
    bounds: Tuple[float, float, float, float],
    segments: Sequence,
) -> None:
    current_key: int | None = None
    current_touched: set[Tuple[int, int]] = set()

    for segment in sorted(segments, key=lambda item: _height_key(item.z)):
        key = _height_key(segment.z)
        if current_key is None:
            current_key = key
        elif key != current_key:
            _burn_cells(grid, current_touched)
            current_touched = set()
            current_key = key

        current_touched.update(_segment_touched_cells(grid.shape, bounds, segment))

    if current_touched:
        _burn_cells(grid, current_touched)


def build_patch_section_count_grid(
    patch: AlignmentPatchRequestItem,
    segments,
    height_count: int,
) -> RasterGrid | None:
    bounds = _raster_bounds(patch, segments)
    if bounds is None:
        return None
    min_x, min_y, max_x, max_y = bounds
    pixel = SECTION_RASTER_PIXEL_SIZE_M
    width = max(1, int(math.ceil((max_x - min_x) / pixel)))
    height = max(1, int(math.ceil((max_y - min_y) / pixel)))
    grid = np.zeros((height, width), dtype=np.uint32)
    _burn_height_layers(grid, bounds, segments)

    return RasterGrid(
        patch_id=patch.patchId,
        grid=grid,
        width=width,
        height=height,
        pixel_size_meters=pixel,
        segment_count=len(segments),
        height_count=height_count,
        bbox_2326=bounds,
    )
