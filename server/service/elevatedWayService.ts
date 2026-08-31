
/**
 * Corridor service for feature queries, elevation and width sampling, building
 * filtering, graph construction, and 3D surface generation.
 */
import fs from 'fs';
import path from 'path';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import { Pool } from 'pg';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBuffer from '@turf/buffer';
import { polygon as turfPolygon, multiPolygon as turfMultiPolygon, point as turfPoint } from '@turf/helpers';
import { formatMs, minimumAreaRect, type Point2D } from '../utils/geoUtils';
import type { BuildingPatch } from '../types/buildingPatch';
import { writeTaskLog, type TaskLogger } from './taskService';
import type { SurfaceSampler } from '../utils/surfaceSampler';

const DB_NAME = process.env.POSTGRES_DB || 'citywind';
const DB_SCHEMA = process.env.POSTGRES_SCHEMA || 'public';
const DB_PORT = Number(process.env.POSTGRES_PORT || 5433);
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');
const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000';

const pool = new Pool({
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: DB_PORT,
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: DB_NAME,
});


// Elevation-sampling interval along corridor centerlines, in metres.
const SAMPLE_INTERVAL_M = 1;
// Extreme-slope safeguard for non-step corridor edges, in degrees.
const SUSPICIOUS_SLOPE_THRESHOLD_DEG = 45;


// Width-probing parameters for locating both edges from the centerline.
const WIDTH_SAMPLE_COUNT = 20;
const WIDTH_STEP_M = 0.3;
const WIDTH_MIN_RADIUS_M = 1;
const WIDTH_DROP_THRESHOLD = 2;


// Samples inside a buffered building patch are marked invalid.
const BUILDING_BUFFER_M = 1.0;
const MIN_VALID_SAMPLES_PER_FEATURE = 5;


const CORRIDOR_HEIGHT_DEFAULTS = {
  floor: 0.5,
  cover: 0.3,
  interior: 3.0,
} as const;

const EDGE_REFINEMENT_LEVEL = 5;
const EDGE_REFINEMENT_XY_PADDING_M = 2;
const EDGE_REFINEMENT_BOTTOM_PADDING_M = 5;
const EDGE_REFINEMENT_TOP_PADDING_M = 2;
const EDGE_HEIGHT_EVALUATION_SAMPLE_INTERVAL_M = 1;
const EDGE_HEIGHT_EVALUATION_ENDPOINT_MARGIN_M = 0.5;
const EDGE_HEIGHT_EVALUATION_SHORT_EDGE_M = 1;
const EDGE_HEIGHT_EVALUATION_CSV = 'edge_height_error_samples.csv';

type RawLineFeature = {
  id: string;
  geojson: {
    type: 'LineString';
    coordinates: number[][];
  };
  osm_type: string;
  bridge: string;  // covered / uncovered; internal viaduct handling remains in geometry service
};

type SampledFeature = {
  id: string;
  geometry: { type: 'LineString'; coordinates: number[][] };
  z_values: number[];
  bridge: string;
  osm_type: string;
};

function normalizeCorridorBridgeType(rawBridge: string | null | undefined): string {
  const bridge = String(rawBridge || '').trim().toLowerCase();
  return bridge === 'covered' ? 'covered' : 'uncovered';
}

function resolveCorridorHeights(options?: {
  heightFloor?: number;
  heightCover?: number;
  heightInterior?: number;
}) {
  return {
    heightFloor: options?.heightFloor ?? CORRIDOR_HEIGHT_DEFAULTS.floor,
    heightCover: options?.heightCover ?? CORRIDOR_HEIGHT_DEFAULTS.cover,
    heightInterior: options?.heightInterior ?? CORRIDOR_HEIGHT_DEFAULTS.interior,
  };
}


/**
 * Query elevated walkway features from the unified OSM table.
 * When a study area is provided, retain only features fully covered by it.
 */
async function queryElevatedWays(bound?: Feature<Polygon>, logger?: TaskLogger): Promise<RawLineFeature[]> {
  const start = Date.now();
  const params: unknown[] = [];
  let spatialFilter = '';

  if (bound) {
    params.push(JSON.stringify(bound.geometry));
    spatialFilter = `
      WHERE ST_CoveredBy(
        CASE WHEN ST_SRID(geom) = 0 THEN ST_SetSRID(geom, 4326) ELSE geom END,
        ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)
      )
    `;
  }

  const sql = `
    SELECT
      full_id,
      osm_type,
      bridge,
      ST_AsGeoJSON(
        CASE WHEN ST_SRID(geom) = 0 THEN ST_SetSRID(geom, 4326) ELSE geom END
      )::json AS geojson
    FROM ${DB_SCHEMA}.osm_elevated_walkway
    ${spatialFilter}
  `;
  const result = await pool.query(sql, params);
  const features: RawLineFeature[] = [];

  for (const row of result.rows) {
    const geom = row.geojson;
    const bridge = normalizeCorridorBridgeType(row.bridge);
    const osmType = String(row.osm_type);
    const fullId = String(row.full_id);
    if (geom.type === 'LineString') {
      features.push({ id: fullId, geojson: geom, osm_type: osmType, bridge });
    } else if (geom.type === 'MultiLineString') {
      for (const coordinates of geom.coordinates) {
        features.push({
          id: fullId,
          geojson: { type: 'LineString', coordinates },
          osm_type: osmType,
          bridge,
        });
      }
    }
  }

  writeTaskLog(
    logger,
    'log',
    'elevated_way',
    `queried ${result.rows.length} database features, expanded to ${features.length} lines | elapsed=${formatMs(Date.now() - start)}`,
  );
  return features;
}


/**
 * Convert shared building patches into buffered polygon rings used to reject
 * corridor samples that fall inside building areas.
 */
function buildBuildingPatchPolygonsBuffered(
  buildingPatches: BuildingPatch[],
  bufferM: number = BUILDING_BUFFER_M,
): number[][][][] {
  const allPolygons: number[][][][] = [];

  for (const patch of buildingPatches) {
    const geometry = patch.geometry;
    const feature = geometry.type === 'Polygon'
      ? turfPolygon(geometry.coordinates)
      : turfMultiPolygon(geometry.coordinates);
    const buffered = turfBuffer(feature, bufferM, { units: 'meters' });
    if (!buffered?.geometry) continue;

    const geom = buffered.geometry;
    if (geom.type === 'Polygon') {
      allPolygons.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        allPolygons.push(poly);
      }
    }
  }

  return allPolygons;
}


/**
 * Approximate spherical distance between two lon/lat points, in metres.
 */
function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Insert fixed-interval samples along a corridor line and ray-sample each
 * elevation. Preserve original vertices and return matching coordinates and Z values.
 */
function sampleLineHeight(
  coords: number[][],
  sampler: SurfaceSampler,
  intervalM: number = SAMPLE_INTERVAL_M,
): { sampledCoords: number[][]; zValues: number[] } {
  if (coords.length < 2) {
    return { sampledCoords: coords, zValues: coords.map(() => 0) };
  }

  const sampledCoords: number[][] = [];
  const zValues: number[] = [];

  // Insert intermediate samples along every line segment.
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];

    sampledCoords.push([lon, lat]);
    const z = sampler.sampleHeightAtPoint(lon, lat);
    zValues.push(z ?? 0);

    if (i < coords.length - 1) {
      const [lon2, lat2] = coords[i + 1];
      const segDist = haversineDistance(lon, lat, lon2, lat2);

      if (segDist > intervalM) {
        const nSamples = Math.floor(segDist / intervalM);
        for (let s = 1; s <= nSamples; s++) {
          const t = s / (nSamples + 1);
          const sLon = lon + t * (lon2 - lon);
          const sLat = lat + t * (lat2 - lat);
          sampledCoords.push([sLon, sLat]);
          const sz = sampler.sampleHeightAtPoint(sLon, sLat);
          zValues.push(sz ?? 0);
        }
      }
    }
  }

  return { sampledCoords, zValues };
}


/**
 * Estimate a normal direction from the neighboring vertices around a line vertex.
 */
function getNormalAtIndex(
  coords: number[][],
  idx: number,
): [number, number] {
  const prev = idx > 0 ? coords[idx - 1] : coords[idx];
  const next = idx < coords.length - 1 ? coords[idx + 1] : coords[idx];
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-15) return [0, 1]; // Use a stable default for degenerate geometry.
  return [-dy / len, dx / len];
}

/**
 * Probe along a normal and return the distance from the centerline to an elevation discontinuity.
 */
function probeEdgeDistance(
  lon: number,
  lat: number,
  normalLon: number,
  normalLat: number,
  centerZ: number,
  sampler: SurfaceSampler,
  refLat: number,
  maxSearchMeters: number,
): number | null {
  const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerDegLat = 110540;
  // Convert the metre-based step to longitude and latitude increments.
  const stepLon = WIDTH_STEP_M * normalLon / mPerDegLon;
  const stepLat = WIDTH_STEP_M * normalLat / mPerDegLat;
  const maxSteps = Math.ceil(maxSearchMeters / WIDTH_STEP_M);

  for (let s = 1; s <= maxSteps; s++) {
    const pLon = lon + stepLon * s;
    const pLat = lat + stepLat * s;
    const z = sampler.sampleHeightAtPoint(pLon, pLat);
    if (z === null || z <= 0) {
      // Missing elevation also indicates that the edge has been reached.
      return s * WIDTH_STEP_M;
    }
    if (Math.abs(centerZ - z) > WIDTH_DROP_THRESHOLD) {
      return s * WIDTH_STEP_M;
    }
  }
  return null;
}

/**
 * Select a stable minimum valid width from one-sided probes. Filter outliers
 * with IQR and fall back to the default half-width when no result is valid.
 */
function computeSideWidth(samples: (number | null)[], defaultHalfWidth: number): number {
  const valid = samples.filter((v): v is number => v !== null && v >= WIDTH_MIN_RADIUS_M);
  if (valid.length === 0) return defaultHalfWidth;

  const sorted = [...valid].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  const inliers = valid.filter((v) => v >= lowerBound && v <= upperBound);
  if (inliers.length === 0) return defaultHalfWidth;

  return Math.min(...inliers);
}

type EdgeForWidth = {
  edge_index: number;
  coords_wgs84: number[][];
  original_z: number[];
  component: number;
  node_start: [number, number];
  node_end: [number, number];
  bridge: string;
};

type EdgeWithWidth = {
  edge_index: number;
  coords_wgs84: number[][];
  width_left: number;
  width_right: number;
  component: number;
  bridge: string;
};

/** Coordinate key for matching graph nodes. */
function nodeKey(coord: number[]): string {
  return `${coord[0].toFixed(7)},${coord[1].toFixed(7)}`;
}

/**
 * Sample the width of one edge using only trusted samples with original_z > 0,
 * and report whether the result is reliable.
 */
function sampleSingleEdgeWidth(
  edge: EdgeForWidth,
  sampler: SurfaceSampler,
  options: {
    defaultHalfWidth: number;
    maxSearchMeters: number;
  },
): { left: number; right: number; reliable: boolean } {
  const coords = edge.coords_wgs84;
  const origZ = edge.original_z;
  if (coords.length < 2) return { left: options.defaultHalfWidth, right: options.defaultHalfWidth, reliable: false };

  const validIndices: number[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (i < origZ.length && origZ[i] > 0) {
      validIndices.push(i);
    }
  }

  if (validIndices.length < 2) {
    return { left: options.defaultHalfWidth, right: options.defaultHalfWidth, reliable: false };
  }

  // Select at most WIDTH_SAMPLE_COUNT evenly distributed trusted positions.
  const step = Math.max(1, Math.floor(validIndices.length / WIDTH_SAMPLE_COUNT));
  const sampleIndices: number[] = [];
  for (let i = 0; i < validIndices.length && sampleIndices.length < WIDTH_SAMPLE_COUNT; i += step) {
    sampleIndices.push(validIndices[i]);
  }

  if (sampleIndices.length === 0) {
    return { left: options.defaultHalfWidth, right: options.defaultHalfWidth, reliable: false };
  }

  const midIdx = Math.floor(coords.length / 2);
  const refLat = coords[midIdx][1];

  const leftSamples: (number | null)[] = [];
  const rightSamples: (number | null)[] = [];

  for (const idx of sampleIndices) {
    const [lon, lat] = coords[idx];
    // Use the original mesh elevation as the centerline reference, not fitted Z.
    const centerZ = origZ[idx];
    if (centerZ <= 0) continue;

    const [nLon, nLat] = getNormalAtIndex(coords, idx);
    leftSamples.push(probeEdgeDistance(lon, lat, nLon, nLat, centerZ, sampler, refLat, options.maxSearchMeters));
    rightSamples.push(probeEdgeDistance(lon, lat, -nLon, -nLat, centerZ, sampler, refLat, options.maxSearchMeters));
  }

  const leftWidth = computeSideWidth(leftSamples, options.defaultHalfWidth);
  const rightWidth = computeSideWidth(rightSamples, options.defaultHalfWidth);

  // Mark an edge unreliable when samples are sparse or both sides use defaults.
  const reliable =
    sampleIndices.length >= 3 &&
    leftWidth !== options.defaultHalfWidth &&
    rightWidth !== options.defaultHalfWidth;

  return { left: leftWidth, right: rightWidth, reliable };
}

/**
 * Sample every edge and propagate widths from reliable edges to unreliable neighbors.
 */
function sampleEdgeWidths(
  edgesForWidth: EdgeForWidth[],
  sampler: SurfaceSampler,
  options: {
    defaultHalfWidth: number;
    maxSearchMeters: number;
  },
): EdgeWithWidth[] {
  const n = edgesForWidth.length;
  if (n === 0) return [];

  // Sample each edge independently first.
  const widths: { left: number; right: number; reliable: boolean }[] = [];
  for (const edge of edgesForWidth) {
    widths.push(sampleSingleEdgeWidth(edge, sampler, options));
  }

  // Build edge adjacency from shared nodes.
  const nodeToEdges = new Map<string, number[]>();
  // Use BFS to find the nearest reliable neighbor for each unreliable edge.
  for (let i = 0; i < n; i++) {
    const e = edgesForWidth[i];
    const startKey = nodeKey(e.node_start);
    const endKey = nodeKey(e.node_end);
    if (!nodeToEdges.has(startKey)) nodeToEdges.set(startKey, []);
    if (!nodeToEdges.has(endKey)) nodeToEdges.set(endKey, []);
    nodeToEdges.get(startKey)!.push(i);
    nodeToEdges.get(endKey)!.push(i);
  }

  for (let i = 0; i < n; i++) {
    if (widths[i].reliable) continue;

    const visited = new Set<number>([i]);
    const queue: number[] = [i];
    let found = false;

    while (queue.length > 0 && !found) {
      const curr = queue.shift()!;
      const e = edgesForWidth[curr];
      const neighborEdgeIds = new Set<number>();
      for (const nk of [nodeKey(e.node_start), nodeKey(e.node_end)]) {
        for (const eid of (nodeToEdges.get(nk) || [])) {
          if (!visited.has(eid)) neighborEdgeIds.add(eid);
        }
      }

      for (const nid of neighborEdgeIds) {
        visited.add(nid);
        if (widths[nid].reliable) {
          widths[i].left = widths[nid].left;
          widths[i].right = widths[nid].right;
          found = true;
          break;
        }
        queue.push(nid);
      }
    }
  }

  return edgesForWidth.map((edge, i) => ({
    edge_index: edge.edge_index,
    coords_wgs84: edge.coords_wgs84,
    width_left: widths[i].left,
    width_right: widths[i].right,
    component: edge.component,
    bridge: edge.bridge,
  }));
}

type EdgeZ = {
  edge_index: number;
  coords: number[][];
  z_values: number[];
  component: number;
  bridge: string;
};

type EdgeHeightEvaluationCandidate = {
  edgeId: number;
  x: number;
  y: number;
  zModel: number;
};

type EdgeHeightEvaluationSample = {
  sampleId: string;
  edgeId: number;
  zModel: number;
  zMesh: number;
  absError: number;
};

type EdgeHeightEvaluationStats = {
  candidates: number;
  buildingFiltered: number;
  meshInvalid: number;
  written: number;
};

type EdgeRotatedRefinementBox = {
  edge_index: number;
  component: number;
  bridge: string;
  origin: [number, number, number];
  span: [number, number, number];
  e1: [number, number, number];
  e3: [number, number, number];
  level: number;
};

function readProjectedExterior(feature: any, offset: [number, number]): Point2D[] {
  const raw = feature?.properties?.projected_exterior;
  if (!Array.isArray(raw)) return [];

  const points: Point2D[] = [];
  for (const coord of raw) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const x = Number(coord[0]);
    const y = Number(coord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: x - offset[0], y: y - offset[1] });
  }
  return points;
}

function buildEdgeRotatedRefinementBoxes(
  stripsGeojson: any,
  edgesZ: EdgeZ[],
  offset: [number, number],
  heights: {
    heightFloor: number;
    heightCover: number;
    heightInterior: number;
  },
): EdgeRotatedRefinementBox[] {
  const edgeMap = new Map<number, EdgeZ>();
  for (const edge of edgesZ) {
    if (Number.isFinite(edge.edge_index)) {
      edgeMap.set(edge.edge_index, edge);
    }
  }

  const features = Array.isArray(stripsGeojson?.features) ? stripsGeojson.features : [];
  const boxes: EdgeRotatedRefinementBox[] = [];

  for (const feature of features) {
    const edgeIndex = Number(feature?.properties?.edge_index);
    if (!Number.isFinite(edgeIndex)) continue;

    const edge = edgeMap.get(edgeIndex);
    if (!edge) continue;

    const points = readProjectedExterior(feature, offset);
    const rect = minimumAreaRect(points);
    if (!rect) continue;

    const validZ = edge.z_values.filter((z) => Number.isFinite(z));
    if (validZ.length === 0) continue;

    const baseMin = Math.min(...validZ);
    const baseMax = Math.max(...validZ);
    const entityTopOffset = edge.bridge === 'viaduct'
      ? heights.heightFloor
      : heights.heightFloor + heights.heightInterior + heights.heightCover;
    const zMin = baseMin - EDGE_REFINEMENT_BOTTOM_PADDING_M;
    const zMax = baseMax + entityTopOffset + EDGE_REFINEMENT_TOP_PADDING_M;
    const spanZ = zMax - zMin;
    if (!(spanZ > 0)) continue;

    const spanX = rect.spanX + 2 * EDGE_REFINEMENT_XY_PADDING_M;
    const spanY = rect.spanY + 2 * EDGE_REFINEMENT_XY_PADDING_M;
    const e1 = rect.e1;
    const e2 = { x: -e1.y, y: e1.x };
    const originX = rect.center.x - 0.5 * spanX * e1.x - 0.5 * spanY * e2.x;
    const originY = rect.center.y - 0.5 * spanX * e1.y - 0.5 * spanY * e2.y;

    boxes.push({
      edge_index: edgeIndex,
      component: edge.component,
      bridge: edge.bridge,
      origin: [originX, originY, zMin],
      span: [spanX, spanY, spanZ],
      e1: [e1.x, e1.y, 0],
      e3: [0, 0, 1],
      level: EDGE_REFINEMENT_LEVEL,
    });
  }

  return boxes;
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function writeCsv(filePath: string, headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const content = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ].join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function buildRawBuildingFootprints(buildingPatches: BuildingPatch[]): Feature<Polygon | MultiPolygon>[] {
  const footprints: Feature<Polygon | MultiPolygon>[] = [];
  for (const patch of buildingPatches) {
    const geometry = patch.geometry;
    if (geometry.type === 'Polygon') {
      footprints.push(turfPolygon(geometry.coordinates));
    } else if (geometry.type === 'MultiPolygon') {
      footprints.push(turfMultiPolygon(geometry.coordinates));
    }
  }
  return footprints;
}

function isInsideAnyBuildingFootprint(
  lon: number,
  lat: number,
  footprints: Feature<Polygon | MultiPolygon>[],
): boolean {
  const pt = turfPoint([lon, lat]);
  return footprints.some((footprint) => booleanPointInPolygon(pt, footprint));
}

function edgeTopOffset(
  edge: EdgeZ,
  heights: {
    heightFloor: number;
    heightCover: number;
    heightInterior: number;
  },
): number {
  return edge.bridge === 'viaduct'
    ? heights.heightFloor
    : heights.heightFloor + heights.heightInterior + heights.heightCover;
}

function projectedDistance(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function edgeSampleDistances(totalLength: number): number[] {
  if (!(totalLength > 0)) return [];
  if (totalLength <= EDGE_HEIGHT_EVALUATION_SHORT_EDGE_M) {
    return [totalLength / 2];
  }

  const distances: number[] = [];
  const maxDistance = totalLength - EDGE_HEIGHT_EVALUATION_ENDPOINT_MARGIN_M;
  for (
    let distance = EDGE_HEIGHT_EVALUATION_ENDPOINT_MARGIN_M;
    distance <= maxDistance + 1e-9;
    distance += EDGE_HEIGHT_EVALUATION_SAMPLE_INTERVAL_M
  ) {
    distances.push(distance);
  }

  return distances.length > 0 ? distances : [totalLength / 2];
}

function interpolateEdgeAtDistance(
  edge: EdgeZ,
  distance: number,
  topOffset: number,
): EdgeHeightEvaluationCandidate | null {
  const coords = edge.coords;
  if (coords.length < 2) return null;

  let remaining = distance;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const segmentLength = projectedDistance(p0, p1);
    if (!(segmentLength > 0)) continue;

    const isTargetSegment = remaining <= segmentLength || i === coords.length - 2;
    if (!isTargetSegment) {
      remaining -= segmentLength;
      continue;
    }

    const t = Math.min(1, Math.max(0, remaining / segmentLength));
    const z0 = Number.isFinite(edge.z_values[i]) ? edge.z_values[i] : 0;
    const z1 = Number.isFinite(edge.z_values[i + 1]) ? edge.z_values[i + 1] : z0;
    const zBase = z0 * (1 - t) + z1 * t;
    const zModel = zBase + topOffset;
    if (!Number.isFinite(zModel)) return null;

    return {
      edgeId: edge.edge_index,
      x: p0[0] + (p1[0] - p0[0]) * t,
      y: p0[1] + (p1[1] - p0[1]) * t,
      zModel,
    };
  }

  return null;
}

function buildEdgeHeightEvaluationCandidates(
  edgesZ: EdgeZ[],
  heights: {
    heightFloor: number;
    heightCover: number;
    heightInterior: number;
  },
): EdgeHeightEvaluationCandidate[] {
  const candidates: EdgeHeightEvaluationCandidate[] = [];
  for (const edge of edgesZ) {
    if (!Number.isFinite(edge.edge_index) || edge.coords.length < 2) continue;

    const totalLength = edge.coords.reduce((sum, coord, index) => {
      if (index === 0) return sum;
      return sum + projectedDistance(edge.coords[index - 1], coord);
    }, 0);

    const topOffset = edgeTopOffset(edge, heights);
    for (const distance of edgeSampleDistances(totalLength)) {
      const candidate = interpolateEdgeAtDistance(edge, distance, topOffset);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

async function projectPointsToWgs84(points: Array<{ x: number; y: number }>): Promise<Array<[number, number]>> {
  if (points.length === 0) return [];
  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/corridor/project_points_to_wgs84`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: points.map((point) => [point.x, point.y]),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Python corridor/project_points_to_wgs84 failed (${resp.status}): ${errText}`);
  }

  const result = await resp.json() as {
    success: boolean;
    message: string;
    points: number[][];
  };
  if (!result.success) {
    throw new Error(`Python corridor/project_points_to_wgs84 failed: ${result.message}`);
  }
  if (!Array.isArray(result.points) || result.points.length !== points.length) {
    throw new Error(
      `Python corridor/project_points_to_wgs84 returned ${result.points?.length ?? 0} points for ${points.length} inputs`,
    );
  }

  return result.points.map((point) => [point[0], point[1]]);
}

async function writeEdgeHeightEvaluationCsv(
  taskDir: string,
  edgesZ: EdgeZ[],
  sampler: SurfaceSampler,
  buildingPatches: BuildingPatch[],
  heights: {
    heightFloor: number;
    heightCover: number;
    heightInterior: number;
  },
): Promise<EdgeHeightEvaluationStats> {
  const candidates = buildEdgeHeightEvaluationCandidates(edgesZ, heights);
  const lonLatPoints = await projectPointsToWgs84(candidates.map((candidate) => ({
    x: candidate.x,
    y: candidate.y,
  })));
  const buildingFootprints = buildRawBuildingFootprints(buildingPatches);

  const samples: EdgeHeightEvaluationSample[] = [];
  let buildingFiltered = 0;
  let meshInvalid = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const [lon, lat] = lonLatPoints[i];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      meshInvalid++;
      continue;
    }
    if (isInsideAnyBuildingFootprint(lon, lat, buildingFootprints)) {
      buildingFiltered++;
      continue;
    }

    const zMesh = sampler.sampleHeightAtPoint(lon, lat);
    if (zMesh === null || !Number.isFinite(zMesh) || zMesh <= 0) {
      meshInvalid++;
      continue;
    }

    const sampleIndex = samples.length + 1;
    const zModel = candidate.zModel;
    samples.push({
      sampleId: `ew_s${String(sampleIndex).padStart(6, '0')}`,
      edgeId: candidate.edgeId,
      zModel,
      zMesh,
      absError: Math.abs(zModel - zMesh),
    });
  }

  const ewDir = path.join(taskDir, 'elevated_way');
  fs.mkdirSync(ewDir, { recursive: true });
  writeCsv(
    path.join(ewDir, EDGE_HEIGHT_EVALUATION_CSV),
    ['sample_id', 'edge_id', 'z_model', 'z_mesh', 'abs_error'],
    samples.map((sample) => [
      sample.sampleId,
      sample.edgeId,
      sample.zModel,
      sample.zMesh,
      sample.absError,
    ]),
  );

  return {
    candidates: candidates.length,
    buildingFiltered,
    meshInvalid,
    written: samples.length,
  };
}


type BuildGraphResult = {
  geojson: any;
  /** 2D footprints merged by connected component. */
  footprintsGeojson: any;
  /** Per-strip footprints before union, primarily for diagnostics. */
  stripsGeojson: any;
  /** 3D edge-centerline data for corridor-surface construction. */
  edgesZ: { edge_index: number; coords: number[][]; z_values: number[]; component: number; bridge: string }[];
  /** 3D graph-node data for surface construction and node platforms. */
  nodesZ: { coord: number[]; z: number; component: number; degree: number }[];
  /** Valid elevation samples for frontend visualization. */
  samplePoints: [number, number, number][];
  /** 3D corridor-surface model information. */
  surface: {
    objUrl: string;
    placement: {
      coords: [number, number];
      rotation: { x: number; y: number; z: number };
      scale: number;
      mercatorZScale: number;
      anchor: string;
    };
  } | null;
  stats: {
    component_count: number;
    node_count: number;
    edge_count: number;
    feature_count: number;
    total_outliers: number;
    building_outliers: number;
  };
};

/**
 * Main corridor-graph entry point. Reuse building patches to filter samples,
 * then invoke Python to construct the graph and footprints.
 */
export async function buildElevatedWayGraph(
  sampler: SurfaceSampler,
  bound?: Feature<Polygon>,
  buildingPatches: BuildingPatch[] = [],
  options?: {
    snapTolerance?: number;
    crossingZThreshold?: number;
    outlierSigma?: number;
    taskDir?: string;
    heightFloor?: number;
    heightCover?: number;
    heightInterior?: number;
    suspiciousSlopeThresholdDeg?: number;
    sampleInterval?: number;
    defaultHalfWidth?: number;
    maxWidthSearch?: number;
    logger?: TaskLogger;
  },
): Promise<BuildGraphResult> {
  const logger = options?.logger;
  const totalStart = Date.now();
  const snapTolerance = options?.snapTolerance ?? 0.5;
  const crossingZThreshold = options?.crossingZThreshold ?? 3.0;
  const suspiciousSlopeThresholdDeg = options?.suspiciousSlopeThresholdDeg ?? SUSPICIOUS_SLOPE_THRESHOLD_DEG;

  // Step 1: query corridor lines.
  const rawFeatures = await queryElevatedWays(bound, logger);
  if (rawFeatures.length === 0) {
    writeTaskLog(logger, 'log', 'elevated_way', 'no features found');
    const empty = { type: 'FeatureCollection', features: [] };
    return {
      geojson: empty,
      footprintsGeojson: empty,
      stripsGeojson: empty,
      edgesZ: [],
      nodesZ: [],
      samplePoints: [],
      surface: null,
      stats: { component_count: 0, node_count: 0, edge_count: 0, feature_count: 0, total_outliers: 0, building_outliers: 0 },
    };
  }

  // Step 2: build filters from shared building patches.
  const buildingPolygons = buildBuildingPatchPolygonsBuffered(buildingPatches, BUILDING_BUFFER_M);
  writeTaskLog(logger, 'log', 'elevated_way', `buffered ${buildingPolygons.length} building patches for outlier filtering`);

  // Step 3: sample line elevations and invalidate samples inside buildings.
  const sampledFeatures: SampledFeature[] = [];
  let totalBuildingOutliers = 0;
  let discardedCount = 0;
  const sampleStart = Date.now();

  // Prebuild Turf polygons outside the inner sampling loop.
  const turfBldgPolygons = buildingPolygons.map((rings) => turfPolygon(rings));

  for (const feat of rawFeatures) {
    const { sampledCoords, zValues } = sampleLineHeight(
      feat.geojson.coordinates,
      sampler,
      options?.sampleInterval ?? SAMPLE_INTERVAL_M,
    );

    // Z=0 marks an invalid elevation that fitting and width sampling both skip.
    const finalZ = [...zValues];
    let buildingCount = 0;
    for (let i = 0; i < sampledCoords.length; i++) {
      if (finalZ[i] <= 0) continue; // This point is already invalid.
      const pt = turfPoint(sampledCoords[i]);
      for (const bldgPoly of turfBldgPolygons) {
        if (booleanPointInPolygon(pt, bldgPoly)) {
          finalZ[i] = 0;
          buildingCount++;
          break;
        }
      }
    }
    totalBuildingOutliers += buildingCount;

    // Lines with too few valid samples cannot participate in Z fitting.
    const validCount = finalZ.filter((z) => z > 0).length;
    if (validCount < MIN_VALID_SAMPLES_PER_FEATURE) {
      discardedCount++;
      continue;
    }

    sampledFeatures.push({
      id: feat.id,
      geometry: { type: 'LineString', coordinates: sampledCoords },
      z_values: finalZ,
      bridge: feat.bridge,
      osm_type: feat.osm_type,
    });
  }

  // Return only valid samples for frontend visualization.
  const samplePoints: [number, number, number][] = [];
  for (const feat of sampledFeatures) {
    const coords = feat.geometry.coordinates;
    const zVals = feat.z_values;
    for (let i = 0; i < coords.length; i++) {
      if ((zVals[i] ?? 0) > 0) {
        samplePoints.push([coords[i][0], coords[i][1], zVals[i]]);
      }
    }
  }

  writeTaskLog(
    logger,
    'log',
    'elevated_way',
    `height sampling done: ${sampledFeatures.length} features (${discardedCount} discarded), ` +
    `${samplePoints.length} sample points | building_removed=${totalBuildingOutliers} | elapsed=${formatMs(Date.now() - sampleStart)}`
  );

  // Step 4: invoke Python corridor-graph construction.
  const graphStart = Date.now();
  const { heightFloor, heightCover, heightInterior } = resolveCorridorHeights(options);

  const requestBody = {
    features: sampledFeatures.map((f) => ({
      id: f.id,
      geometry: f.geometry,
      z_values: f.z_values,
      bridge: f.bridge,
      osm_type: f.osm_type,
    })),
    snap_tolerance: snapTolerance,
    crossing_z_threshold: crossingZThreshold,
    height_floor: heightFloor,
    height_cover: heightCover,
    height_interior: heightInterior,
    suspicious_slope_threshold_deg: suspiciousSlopeThresholdDeg,
  };

  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/corridor/build_graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Python corridor/build_graph failed (${resp.status}): ${errText}`);
  }

  const graphResult = await resp.json() as {
    success: boolean;
    message: string;
    geojson: any;
    edges_for_width: {
      edge_index: number;
      coords_wgs84: number[][];
      original_z: number[];
      component: number;
      node_start: [number, number];
      node_end: [number, number];
      bridge: string;
    }[];
    edges_z: { edge_index: number; coords: number[][]; z_values: number[]; component: number; bridge: string }[];
    nodes_z: { coord: number[]; z: number; component: number; degree: number }[];
    component_count: number;
    node_count: number;
    edge_count: number;
  };

  if (!graphResult.success) {
    throw new Error(`Python corridor/build_graph failed: ${graphResult.message}`);
  }

  writeTaskLog(
    logger,
    'log',
    'elevated_way',
    `graph built: ${graphResult.component_count} components, ` +
    `${graphResult.node_count} nodes, ${graphResult.edge_count} edges | elapsed=${formatMs(Date.now() - graphStart)}`
  );

  if (options?.taskDir) {
    const ewDir = path.join(options.taskDir, 'elevated_way');
    fs.mkdirSync(ewDir, { recursive: true });
    const geojsonPath = path.join(ewDir, 'graph.geojson');
    fs.writeFileSync(geojsonPath, JSON.stringify(graphResult.geojson, null, 2));
    console.log(`[elevated_way] graph GeoJSON saved: ${geojsonPath}`);

    const evalStart = Date.now();
    const evalStats = await writeEdgeHeightEvaluationCsv(
      options.taskDir,
      graphResult.edges_z || [],
      sampler,
      buildingPatches,
      { heightFloor, heightCover, heightInterior },
    );
    writeTaskLog(
      logger,
      'log',
      'elevated_way',
      `edge height evaluation saved: candidates=${evalStats.candidates}, ` +
      `building_filtered=${evalStats.buildingFiltered}, mesh_invalid=${evalStats.meshInvalid}, ` +
      `written=${evalStats.written} | elapsed=${formatMs(Date.now() - evalStart)}`
    );
  }

  // Step 5: sample and propagate edge widths.
  const widthStart = Date.now();
  const edgesForWidth = graphResult.edges_for_width || [];
  const edgesWithWidths = sampleEdgeWidths(edgesForWidth, sampler, {
    defaultHalfWidth: options?.defaultHalfWidth ?? 2.5,
    maxSearchMeters: options?.maxWidthSearch ?? 10,
  });
  writeTaskLog(logger, 'log', 'elevated_way', `per-edge width sampling done: ${edgesWithWidths.length} edges | elapsed=${formatMs(Date.now() - widthStart)}`);

  // Step 6: invoke Python footprint generation.
  const footprintsStart = Date.now();
  const fpResp = await fetch(`${GEOMETRY_SERVICE_URL}/corridor/build_footprints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edges: edgesWithWidths }),
  });

  if (!fpResp.ok) {
    const errText = await fpResp.text();
    throw new Error(`Python corridor/build_footprints failed (${fpResp.status}): ${errText}`);
  }

  const fpResult = await fpResp.json() as {
    success: boolean;
    message: string;
    footprints_geojson: any;
    strips_geojson: any;
  };

  if (!fpResult.success) {
    throw new Error(`Python corridor/build_footprints failed: ${fpResult.message}`);
  }

  writeTaskLog(logger, 'log', 'elevated_way', `footprints built | elapsed=${formatMs(Date.now() - footprintsStart)}`);

  if (options?.taskDir) {
    const ewDir = path.join(options.taskDir, 'elevated_way');
    fs.mkdirSync(ewDir, { recursive: true });
    const stripsPath = path.join(ewDir, 'strips.geojson');
    fs.writeFileSync(stripsPath, JSON.stringify(fpResult.strips_geojson, null, 2));
    console.log(`[elevated_way] strips GeoJSON saved: ${stripsPath}`);
  }

  writeTaskLog(logger, 'log', 'elevated_way', `total elapsed=${formatMs(Date.now() - totalStart)}`);

  return {
    geojson: graphResult.geojson,
    footprintsGeojson: fpResult.footprints_geojson,
    stripsGeojson: fpResult.strips_geojson,
    edgesZ: graphResult.edges_z || [],
    nodesZ: graphResult.nodes_z || [],
    samplePoints,
    surface: null,
    stats: {
      component_count: graphResult.component_count,
      node_count: graphResult.node_count,
      edge_count: graphResult.edge_count,
      feature_count: sampledFeatures.length,
      total_outliers: totalBuildingOutliers,
      building_outliers: totalBuildingOutliers,
    },
  };
}

/**
 * Build the 3D corridor-surface model using the shared projection origin from the building-patch stage.
 */
export async function buildElevatedWaySurface(
  graphResult: BuildGraphResult,
  origin: {
    lonlat: [number, number];
    offset_2326?: [number, number];
    mercatorZScale: number;
  },
  taskDir: string,
  options?: {
    heightFloor?: number;
    heightCover?: number;
    heightInterior?: number;
    logger?: TaskLogger;
  },
): Promise<BuildGraphResult['surface']> {
  const logger = options?.logger;
  const footprints = graphResult.footprintsGeojson;
  const edgesZ = graphResult.edgesZ || [];
  const nodesZ = graphResult.nodesZ || [];

  if (!footprints?.features?.length || !edgesZ.length) {
    writeTaskLog(logger, 'log', 'elevated_way', 'surface skipped: no footprints or edge Z data');
    return null;
  }

  writeTaskLog(logger, 'log', 'elevated_way', 'building corridor surface...');
  const surfaceStart = Date.now();
  const { heightFloor, heightCover, heightInterior } = resolveCorridorHeights(options);

  const ewDir = path.join(taskDir, 'elevated_way');
  fs.mkdirSync(ewDir, { recursive: true });
  const surfaceObjPath = path.join(ewDir, 'elevated_walkway.obj');

  const requestBody = {
    footprints_geojson: footprints,
    edges_z: edgesZ,
    nodes_z: nodesZ,
    output_path: surfaceObjPath,
    offset_2326: origin.offset_2326 || [0, 0],
    height_floor: heightFloor,
    height_cover: heightCover,
    height_interior: heightInterior,
  };

  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/corridor/build_surface`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Python corridor/build_surface failed (${resp.status}): ${errText}`);
  }

  const result = await resp.json() as {
    success: boolean;
    message: string;
    vertex_count: number;
    triangle_count: number;
    origin_lonlat: [number, number] | null;
  };

  if (!result.success) {
    throw new Error(`Python corridor/build_surface failed: ${result.message}`);
  }

  writeTaskLog(
    logger,
    'log',
    'elevated_way',
    `surface built: ${result.vertex_count} verts, ${result.triangle_count} tris | ` +
    `elapsed=${formatMs(Date.now() - surfaceStart)}`
  );

  const refinementBoxesPath = path.join(ewDir, 'refinement_boxes.json');
  const edgeRotatedBoxes = buildEdgeRotatedRefinementBoxes(
    graphResult.stripsGeojson,
    edgesZ,
    origin.offset_2326 || [0, 0],
    { heightFloor, heightCover, heightInterior },
  );
  fs.writeFileSync(refinementBoxesPath, JSON.stringify({
    edge_rotated_boxes: edgeRotatedBoxes,
  }, null, 2));
  console.log(`[elevated_way] edge rotated refinement boxes saved: ${edgeRotatedBoxes.length} -> ${refinementBoxesPath}`);
  writeTaskLog(logger, 'log', 'elevated_way', `edge rotated refinement boxes: ${edgeRotatedBoxes.length}`);

  // Build the frontend-accessible OBJ URL.
  const tempRoot = path.resolve(TEMP_DIR);
  const relativePath = path.relative(tempRoot, surfaceObjPath).replace(/\\/g, '/');
  const objUrl = `/outputs/${relativePath}`;

  return {
    objUrl,
    placement: {
      coords: origin.lonlat,
      rotation: { x: 0, y: 0, z: 180 },
      scale: 1,
      mercatorZScale: origin.mercatorZScale,
      anchor: 'none',
    },
  };
}
