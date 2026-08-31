"""Calculate an EPSG:2326 offset origin from building-patch geometry."""

import logging

from shapely.geometry import shape

from schemas.origin import ComputeOriginRequest, ComputeOriginResponse
from utils.geo import extract_polygonal_geometry, to_local_projected_geometry, to_lonlat

logger = logging.getLogger(__name__)


def compute_origin(req: ComputeOriginRequest) -> ComputeOriginResponse:
    """
    Project a list of building-patch GeoJSON geometries to EPSG:2326 and use
    the center of their combined bounding box as the local-coordinate offset.
    """
    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")
    count = 0

    for patch_geojson in req.patches:
        try:
            raw_geom = shape(patch_geojson)
            if raw_geom.is_empty:
                continue
            if not raw_geom.is_valid:
                raw_geom = raw_geom.buffer(0)
                if raw_geom.is_empty:
                    continue

            polygonal = extract_polygonal_geometry(raw_geom)
            if polygonal is None:
                continue

            projected = to_local_projected_geometry(polygonal)
            bounds = projected.bounds  # (minx, miny, maxx, maxy)
            min_x = min(min_x, float(bounds[0]))
            min_y = min(min_y, float(bounds[1]))
            max_x = max(max_x, float(bounds[2]))
            max_y = max(max_y, float(bounds[3]))
            count += 1
        except Exception as exc:
            logger.warning(f"[origin] failed processing patch: {exc}")

    if count == 0:
        return ComputeOriginResponse(
            success=False,
            offset_2326=[0, 0],
            origin_lonlat=[0, 0],
        )

    offset_x = float((min_x + max_x) * 0.5)
    offset_y = float((min_y + max_y) * 0.5)
    origin_lon, origin_lat = to_lonlat.transform(offset_x, offset_y)

    logger.info(
        f"[origin] computed from {count} patches: "
        f"offset_2326=[{offset_x:.2f}, {offset_y:.2f}], "
        f"origin_lonlat=[{origin_lon:.6f}, {origin_lat:.6f}]"
    )

    return ComputeOriginResponse(
        success=True,
        offset_2326=[offset_x, offset_y],
        origin_lonlat=[float(origin_lon), float(origin_lat)],
    )
