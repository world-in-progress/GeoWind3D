/**
 * Shared geometry utilities independent of application-specific workflows.
 */

import type { Polygon, MultiPolygon } from 'geojson';
import polylabel from 'polylabel';

export type Bbox = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

export type Point2D = {
  x: number;
  y: number;
};

export type MinimumAreaRect = {
  center: Point2D;
  e1: Point2D;
  spanX: number;
  spanY: number;
};

/** Ensure that a ring is closed. */
export function closeRing(ring: number[][]): number[][] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, [first[0], first[1]]];
  }
  return ring;
}

/** Normalize a ring by removing consecutive duplicates and ensuring closure. */
export function normalizeRing(ring: number[][]): number[][] {
  const closed = closeRing(ring);
  const cleaned = closed.filter((p, idx) => idx === 0 || p[0] !== closed[idx - 1][0] || p[1] !== closed[idx - 1][1]);
  if (cleaned.length >= 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      cleaned.push([first[0], first[1]]);
    }
  }
  return cleaned;
}

/** Calculate a ring bounding box. */
export function getRingBbox(ring: number[][]): Bbox {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Calculate the bounding box of a Polygon or MultiPolygon. */
export function getGeometryBbox(geometry: Polygon | MultiPolygon): Bbox {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Determine whether a Polygon or MultiPolygon is degenerate. */
export function isEmptyGeometry(geom: Polygon | MultiPolygon): boolean {
  if (geom.type === 'Polygon') {
    return !geom.coordinates[0] || geom.coordinates[0].length < 4;
  }
  // A MultiPolygon is empty only when every component is empty.
  return geom.coordinates.every(
    (poly) => !poly[0] || poly[0].length < 4
  );
}

/** Select an interior sample point as far from the polygon boundary as practical. */
export function getInteriorPoint(rings: number[][][]): [number, number] | null {
  const validRings = rings.map(normalizeRing).filter((r) => r.length >= 4);
  if (validRings.length === 0) return null;

  const [lon, lat] = polylabel(validRings, 1e-7);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

/** Format milliseconds as a human-readable duration. */
function signedProjectedRingArea(ring: number[][], lon0: number, lat0: number): number {
  const metersPerDegLat = 110540;
  const metersPerDegLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  let area = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    const x1 = (lon1 - lon0) * metersPerDegLon;
    const y1 = (lat1 - lat0) * metersPerDegLat;
    const x2 = (lon2 - lon0) * metersPerDegLon;
    const y2 = (lat2 - lat0) * metersPerDegLat;
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
}

/** Approximate Polygon/MultiPolygon area in square meters for local sampling density decisions. */
export function approximateMetricArea(geometry: Polygon | MultiPolygon): number {
  const bbox = getGeometryBbox(geometry);
  const lon0 = (bbox.minLon + bbox.maxLon) / 2;
  const lat0 = (bbox.minLat + bbox.maxLat) / 2;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let area = 0;

  for (const rings of polygons) {
    if (!rings[0]) continue;
    let polygonArea = Math.abs(signedProjectedRingArea(rings[0], lon0, lat0));
    for (let i = 1; i < rings.length; i++) {
      polygonArea -= Math.abs(signedProjectedRingArea(rings[i], lon0, lat0));
    }
    area += Math.max(0, polygonArea);
  }

  return area;
}

export function getGeometryInteriorPoint(geometry: Polygon | MultiPolygon): [number, number] | null {
  if (geometry.type === 'Polygon') return getInteriorPoint(geometry.coordinates);

  const largest = geometry.coordinates
    .map((coordinates) => ({
      coordinates,
      area: approximateMetricArea({ type: 'Polygon', coordinates }),
    }))
    .sort((a, b) => b.area - a.area)[0];

  return largest ? getInteriorPoint(largest.coordinates) : null;
}

function cross2(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points: Point2D[]): Point2D[] {
  const sorted = [...points]
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, index, arr) =>
      index === 0 || point.x !== arr[index - 1].x || point.y !== arr[index - 1].y,
    );

  if (sorted.length <= 2) return sorted;

  const lower: Point2D[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Compute the minimum-area XY rectangle enclosing a point set. */
export function minimumAreaRect(points: Point2D[]): MinimumAreaRect | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;

  let best:
    | {
      area: number;
      center: Point2D;
      e1: Point2D;
      e2: Point2D;
      span1: number;
      span2: number;
    }
    | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-9) continue;

    const e1 = { x: dx / len, y: dy / len };
    const e2 = { x: -e1.y, y: e1.x };
    let min1 = Infinity;
    let max1 = -Infinity;
    let min2 = Infinity;
    let max2 = -Infinity;

    for (const point of hull) {
      const p1 = point.x * e1.x + point.y * e1.y;
      const p2 = point.x * e2.x + point.y * e2.y;
      min1 = Math.min(min1, p1);
      max1 = Math.max(max1, p1);
      min2 = Math.min(min2, p2);
      max2 = Math.max(max2, p2);
    }

    const span1 = max1 - min1;
    const span2 = max2 - min2;
    const area = span1 * span2;
    if (!best || area < best.area) {
      const mid1 = (min1 + max1) / 2;
      const mid2 = (min2 + max2) / 2;
      best = {
        area,
        center: {
          x: e1.x * mid1 + e2.x * mid2,
          y: e1.y * mid1 + e2.y * mid2,
        },
        e1,
        e2,
        span1,
        span2,
      };
    }
  }

  if (!best) return null;

  if (best.span2 > best.span1) {
    return {
      center: best.center,
      e1: best.e2,
      spanX: best.span2,
      spanY: best.span1,
    };
  }

  return {
    center: best.center,
    e1: best.e1,
    spanX: best.span1,
    spanY: best.span2,
  };
}

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s (${ms}ms)`;
}
