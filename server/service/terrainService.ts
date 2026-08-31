/**
 * Terrain sampling and construction service.
 * Samples a uniform grid, filters building buffers and local outliers, then invokes the Python CDT builder.
 */

import fs from 'fs';
import path from 'path';
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import buffer from '@turf/buffer';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon as turfPolygon } from '@turf/helpers';
import { formatMs } from '../utils/geoUtils';
import type { BuildingPatch, BuildingPatchBasePlane } from '../types/buildingPatch';
import { buildDomainPlan } from './domainService';
import type { ModelingConfig } from '../config/modelingConfig';
import { writeTaskLog, type TaskLogger } from './taskService';
import type { SurfaceSampler } from '../utils/surfaceSampler';

const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');
const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000';
const TERRAIN_TRANSITION_BUFFER_MIN_M = 30;
const TERRAIN_TRANSITION_BUFFER_SCALE = 2;
const TERRAIN_TRANSITION_RING_STEP_M = 8;
const TERRAIN_DOMAIN_BOUNDARY_STEP_M = 20;
const TERRAIN_CONTROL_RING_COUNT = 3;
const TERRAIN_FLAT_ANCHOR_SPACING_MIN_M = 40;
const TERRAIN_FLAT_HEIGHT_BAND_M = 12;
const TERRAIN_DISPLAY_BUFFER_METERS = 0;
const BUILDING_NEAR_TERRAIN_BUFFER_M = 6;

type TerrainPoint = {
  lon: number;
  lat: number;
  z: number;
};

type TerrainBuildResponse = {
  success: boolean;
  message: string;
  output_path?: string;
  vertex_count: number;
  triangle_count: number;
  origin_lonlat?: [number, number];
  building_base_heights?: number[][][][];
  building_base_planes?: BuildingPatchBasePlane[];
};

type TerrainBoundaryPoint = {
  lon: number;
  lat: number;
};

type TransitionControlRing = {
  t: number;
  points: TerrainBoundaryPoint[];
};

/** Buffered-patch geometry and bounding box for fast point-in-building tests. */
type BufferedPatch = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  geometry: Polygon | MultiPolygon;
};

type LocalTriangleMesh = {
  vertices: [number, number, number][];
  faces: [number, number, number][];
};

/**
 * Buffer a Polygon or MultiPolygon and extract its bounding box.
 */
function bufferPatchWithBbox(
  geometry: Polygon | MultiPolygon,
  distanceMeters: number,
): BufferedPatch | null {
  try {
    const feature = { type: 'Feature' as const, properties: {}, geometry };
    const buffered = buffer(feature, distanceMeters, { units: 'meters' });
    if (!buffered?.geometry) return null;
    const g = buffered.geometry;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;

    // Calculate the bounding box.
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const rings = g.type === 'Polygon'
      ? [g.coordinates[0]]
      : g.coordinates.map((poly) => poly[0]);
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return { minLon, minLat, maxLon, maxLat, geometry: g as Polygon | MultiPolygon };
  } catch {
    return null;
  }
}

/**
 * Test whether a point lies in any buffered patch using bounding-box prefiltering and an exact test.
 */
function isInsideAnyPatch(lon: number, lat: number, bufferedPatches: BufferedPatch[]): boolean {
  const pt = turfPoint([lon, lat]);
  for (const bp of bufferedPatches) {
    // Bounding-box prefilter.
    if (lon < bp.minLon || lon > bp.maxLon || lat < bp.minLat || lat > bp.maxLat) continue;
    // Exact geometry test.
    if (bp.geometry.type === 'Polygon') {
      if (booleanPointInPolygon(pt, turfPolygon(bp.geometry.coordinates))) return true;
    } else {
      for (const polyCoords of bp.geometry.coordinates) {
        if (booleanPointInPolygon(pt, turfPolygon(polyCoords))) return true;
      }
    }
  }
  return false;
}

/**
 * Build buffered building patches and bounding boxes shared by grid and boundary sampling.
 */
function buildBufferedPatches(
  patches: (Polygon | MultiPolygon)[],
  bufferDist: number,
): BufferedPatch[] {
  const bufferedPatches: BufferedPatch[] = [];
  for (const patch of patches) {
    const bp = bufferPatchWithBbox(patch, bufferDist);
    if (bp) bufferedPatches.push(bp);
  }
  return bufferedPatches;
}

/**
 * Extract unbuffered geometries and bounding boxes from corridor footprints,
 * reusing BufferedPatch for point-in-polygon tests.
 */
function extractCorridorRegions(
  footprints: FeatureCollection | null | undefined,
): BufferedPatch[] {
  const regions: BufferedPatch[] = [];
  if (!footprints?.features?.length) return regions;
  for (const feature of footprints.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;

    // The exterior ring alone defines the bounding box.
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const outerRings = g.type === 'Polygon'
      ? [(g as Polygon).coordinates[0]]
      : (g as MultiPolygon).coordinates.map((poly) => poly[0]);
    for (const ring of outerRings) {
      if (!ring) continue;
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (!isFinite(minLon)) continue;
    regions.push({ minLon, minLat, maxLon, maxLat, geometry: g as Polygon | MultiPolygon });
  }
  return regions;
}

/**
 * Extract downward-facing triangles from a local corridor OBJ as hard
 * constraints for lowering terrain; no topology is inferred from them.
 */
function extractCorridorBottomMesh(objPath: string): LocalTriangleMesh | null {
  if (!fs.existsSync(objPath)) return null;

  const content = fs.readFileSync(objPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];

  const parseFaceIndex = (token: string): number | null => {
    const raw = Number(token.split('/')[0]);
    if (!Number.isInteger(raw) || raw <= 0) return null;
    return raw - 1;
  };

  const pushTriangleIfDownward = (ia: number, ib: number, ic: number) => {
    const a = vertices[ia];
    const b = vertices[ib];
    const c = vertices[ic];
    if (!a || !b || !c) return;

    // Only the normal's Z component matters; near-zero side faces are filtered out.
    const nz =
      (b[0] - a[0]) * (c[1] - a[1]) -
      (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(nz) < 1e-9) return;
    if (nz >= -1e-9) return;
    faces.push([ia, ib, ic]);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
      vertices.push([x, y, z]);
      continue;
    }

    if (!line.startsWith('f ')) continue;
    const indices = line
      .split(/\s+/)
      .slice(1)
      .map(parseFaceIndex);
    if (indices.length < 3 || indices.some((idx) => idx === null)) continue;

    const face = indices as number[];
    for (let i = 1; i < face.length - 1; i++) {
      pushTriangleIfDownward(face[0], face[i], face[i + 1]);
    }
  }

  if (vertices.length === 0 || faces.length === 0) return null;
  return { vertices, faces };
}

/**
 * Sample terrain heights on a uniform study-area grid after filtering building
 * buffers. Points inside corridor footprints are omitted because rays would hit
 * the corridor roof; the Python LinearNDInterpolator fills those elevations from
 * surrounding terrain consistently with all other unknown Z values.
 */
function generateGridPoints(
  bound: Feature<Polygon>,
  buildingFootprints: BufferedPatch[],
  corridorRegions: BufferedPatch[],
  sampler: SurfaceSampler,
  refLat: number,
  gridStepMeters: number,
): {
  points: TerrainPoint[];
  gridStep: number;
  stats: {
    total: number;
    outsideBound: number;
    insideBuilding: number;
    insideCorridor: number;
    nullZ: number;
    valid: number;
  };
} {
  const GRID_STEP = gridStepMeters;

  // Approximate longitude/latitude-to-metre factors.
  const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerDegLat = 110540;
  const degLonStep = GRID_STEP / mPerDegLon;
  const degLatStep = GRID_STEP / mPerDegLat;

  // Study-area bounding box.
  const coords = bound.geometry.coordinates[0];
  let bMinLon = Infinity, bMinLat = Infinity, bMaxLon = -Infinity, bMaxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < bMinLon) bMinLon = lon;
    if (lat < bMinLat) bMinLat = lat;
    if (lon > bMaxLon) bMaxLon = lon;
    if (lat > bMaxLat) bMaxLat = lat;
  }

  // Study-area polygon for point-in-polygon tests.
  const boundPoly = turfPolygon(bound.geometry.coordinates);

  // Traverse the sampling grid.
  const points: TerrainPoint[] = [];
  let total = 0;
  let outsideBound = 0;
  let insideBuilding = 0;
  let insideCorridor = 0;
  let nullZ = 0;

  for (let lat = bMinLat; lat <= bMaxLat; lat += degLatStep) {
    for (let lon = bMinLon; lon <= bMaxLon; lon += degLonStep) {
      total++;

      // Study-area test.
      if (!booleanPointInPolygon(turfPoint([lon, lat]), boundPoly)) {
        outsideBound++;
        continue;
      }

      // Building-buffer test.
      if (isInsideAnyPatch(lon, lat, buildingFootprints)) {
        insideBuilding++;
        continue;
      }

      // Omit points beneath corridor footprints; CDT interpolation supplies their Z values.
      if (corridorRegions.length > 0 && isInsideAnyPatch(lon, lat, corridorRegions)) {
        insideCorridor++;
        continue;
      }

      // Sample elevation by ray intersection.
      const z = sampler.sampleHeightAtPoint(lon, lat);
      if (z === null || z <= 0) {
        nullZ++;
        continue;
      }

      points.push({ lon, lat, z });
    }
  }

  return {
    points,
    gridStep: GRID_STEP,
    stats: { total, outsideBound, insideBuilding, insideCorridor, nullZ, valid: points.length },
  };
}

/**
 * Filter local outliers by comparing each Z value with the median inside radius R.
 * Values above the median plus a threshold are treated as vegetation or unmodeled roofs.
 */
function filterOutliersByLocalMedian(
  points: TerrainPoint[],
  _gridStepMeters: number,
  refLat: number,
  options: {
    outlierRadius: number;
    outlierThreshold: number;
    outlierMaxIterations: number;
  },
  logger?: TaskLogger,
): { filtered: TerrainPoint[]; correctedCount: number; iterations: number } {
  const RADIUS_M = options.outlierRadius;
  const THRESHOLD = options.outlierThreshold;
  const MIN_NEIGHBORS = 3;

  const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerDegLat = 110540;
  const cellSize = RADIUS_M;
  const radiusSq = RADIUS_M * RADIUS_M;

  let filtered = points.map((pt) => ({ ...pt }));
  let correctedCount = 0;
  let iterations = 0;

  while (true) {
    iterations++;
    if (iterations > options.outlierMaxIterations) break;

    const index = new Map<string, number[]>();
    for (let i = 0; i < filtered.length; i++) {
      const cx = Math.floor(filtered[i].lon * mPerDegLon / cellSize);
      const cy = Math.floor(filtered[i].lat * mPerDegLat / cellSize);
      const key = `${cx},${cy}`;
      const list = index.get(key);
      if (list) list.push(i);
      else index.set(key, [i]);
    }

    const removeSet = new Set<number>();

    for (let i = 0; i < filtered.length; i++) {
      const px = filtered[i].lon * mPerDegLon;
      const py = filtered[i].lat * mPerDegLat;
      const cx = Math.floor(px / cellSize);
      const cy = Math.floor(py / cellSize);

      const neighborZ: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbors = index.get(`${cx + dx},${cy + dy}`);
          if (!neighbors) continue;
          for (const j of neighbors) {
            if (j === i) continue;
            const nx = filtered[j].lon * mPerDegLon;
            const ny = filtered[j].lat * mPerDegLat;
            const distSq = (px - nx) ** 2 + (py - ny) ** 2;
            if (distSq <= radiusSq) {
              neighborZ.push(filtered[j].z);
            }
          }
        }
      }

      if (neighborZ.length < MIN_NEIGHBORS) continue;

      neighborZ.sort((a, b) => a - b);
      const mid = neighborZ.length >> 1;
      const median = neighborZ.length % 2 === 0
        ? (neighborZ[mid - 1] + neighborZ[mid]) / 2
        : neighborZ[mid];

      if (filtered[i].z > median + THRESHOLD) {
        removeSet.add(i);
      }
    }

    if (removeSet.size === 0) break;

    console.log(
      `[terrain] outlier filtering iteration ${iterations}: ` +
      `removed=${removeSet.size}, remaining=${filtered.length - removeSet.size}`,
    );
    correctedCount += removeSet.size;
    filtered = filtered.filter((_, idx) => !removeSet.has(idx));
  }

  return { filtered, correctedCount, iterations };
}

/**
 * Generate lon/lat samples along a polygon ring at uniform accumulated-distance intervals.
 */
function walkRing(ring: number[][], stepMeters: number, refLat: number): { lon: number; lat: number }[] {
  const points: { lon: number; lat: number }[] = [];
  if (ring.length < 2) return points;

  const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerDegLat = 110540;

  const segLengths: number[] = [];
  const cumDist: number[] = [0];
  for (let i = 0; i < ring.length - 1; i++) {
    const dLon = ring[i + 1][0] - ring[i][0];
    const dLat = ring[i + 1][1] - ring[i][1];
    const segLen = Math.sqrt((dLon * mPerDegLon) ** 2 + (dLat * mPerDegLat) ** 2);
    segLengths.push(segLen);
    cumDist.push(cumDist[i] + segLen);
  }

  const totalLength = cumDist[cumDist.length - 1];
  if (totalLength < 0.01) return points;

  const numSteps = Math.max(1, Math.floor(totalLength / stepMeters));
  const actualStep = totalLength / numSteps;

  let segIdx = 0;
  for (let s = 0; s < numSteps; s++) {
    const targetDist = s * actualStep;
    while (segIdx < segLengths.length - 1 && cumDist[segIdx + 1] < targetDist) {
      segIdx++;
    }
    const distInSeg = targetDist - cumDist[segIdx];
    const segLen = segLengths[segIdx];
    const t = segLen > 0 ? distInSeg / segLen : 0;
    const lon = ring[segIdx][0] + (ring[segIdx + 1][0] - ring[segIdx][0]) * t;
    const lat = ring[segIdx][1] + (ring[segIdx + 1][1] - ring[segIdx][1]) * t;
    points.push({ lon, lat });
  }

  return points;
}

/**
 * Generate the transition band:
 */
function getTransitionBufferDistance(H: number): number {
  return TERRAIN_TRANSITION_BUFFER_SCALE * Math.max(TERRAIN_TRANSITION_BUFFER_MIN_M, H);
}

function generateTransitionBoundary(
  bound: Feature<Polygon>,
  refLat: number,
  bufferDist: number,
  logger?: TaskLogger,
): { lon: number; lat: number }[] {
  const outerBound = buffer(bound, bufferDist, { units: 'meters' });
  if (!outerBound?.geometry || outerBound.geometry.type !== 'Polygon') {
    writeTaskLog(logger, 'warn', 'terrain', 'transition boundary buffer failed, falling back to study area boundary');
    const ring = bound.geometry.coordinates[0];
    return walkRing(ring, TERRAIN_TRANSITION_RING_STEP_M, refLat);
  }

  const points: { lon: number; lat: number }[] = [];
  const outerRing = outerBound.geometry.coordinates[0];
  const ringPts = walkRing(outerRing, TERRAIN_TRANSITION_RING_STEP_M, refLat);
  points.push(...ringPts);

  writeTaskLog(logger, 'log', 'terrain', `transition boundary: buffer=${bufferDist.toFixed(2)}m, vertices=${points.length}`);
  return points;
}

function generateDisplayTerrainBoundary(
  bound: Feature<Polygon>,
  refLat: number,
  bufferDist: number,
  logger?: TaskLogger,
): TerrainBoundaryPoint[] {
  const boundaryFeature = bufferDist > 0
    ? buffer(bound, bufferDist, { units: 'meters' })
    : bound;

  if (!boundaryFeature?.geometry || boundaryFeature.geometry.type !== 'Polygon') {
    writeTaskLog(logger, 'warn', 'terrain', 'display boundary buffer failed, falling back to study area boundary');
    return walkRing(bound.geometry.coordinates[0], TERRAIN_TRANSITION_RING_STEP_M, refLat);
  }

  const ring = boundaryFeature.geometry.coordinates[0];
  const points = walkRing(ring, TERRAIN_TRANSITION_RING_STEP_M, refLat);
  writeTaskLog(logger, 'log', 'terrain', `display terrain boundary: buffer=${bufferDist.toFixed(2)}m, vertices=${points.length}`);
  return points;
}

function densifyBoundaryRing(
  ring: TerrainBoundaryPoint[],
  refLat: number,
  stepMeters: number,
): TerrainBoundaryPoint[] {
  const coords = ring.map((point) => [point.lon, point.lat]);
  return walkRing(coords, stepMeters, refLat);
}

function generateTransitionControlRings(
  bound: Feature<Polygon>,
  refLat: number,
  transitionBufferDistance: number,
  logger?: TaskLogger,
): TransitionControlRing[] {
  const rings: TransitionControlRing[] = [];

  for (let index = 1; index <= TERRAIN_CONTROL_RING_COUNT; index++) {
    const t = index / (TERRAIN_CONTROL_RING_COUNT + 1);
    const boundary = generateTransitionBoundary(
      bound,
      refLat,
      transitionBufferDistance * t,
      logger,
    );
    rings.push({ t, points: boundary });
  }

  return rings;
}

function getFlatAnchorSpacing(H: number): number {
  return Math.max(TERRAIN_FLAT_ANCHOR_SPACING_MIN_M, H);
}

function generateFlatAnchorPoints(
  domainBoundary: TerrainBoundaryPoint[],
  transitionBoundary: TerrainBoundaryPoint[],
  refLat: number,
  spacingMeters: number,
): TerrainBoundaryPoint[] {
  if (domainBoundary.length < 3 || transitionBoundary.length < 3) {
    return [];
  }

  const domainPolygon = turfPolygon([[...domainBoundary, domainBoundary[0]].map((point) => [point.lon, point.lat])]);
  const transitionPolygon = turfPolygon([[...transitionBoundary, transitionBoundary[0]].map((point) => [point.lon, point.lat])]);

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const point of domainBoundary) {
    minLon = Math.min(minLon, point.lon);
    minLat = Math.min(minLat, point.lat);
    maxLon = Math.max(maxLon, point.lon);
    maxLat = Math.max(maxLat, point.lat);
  }

  const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const mPerDegLat = 110540;
  const degLonStep = spacingMeters / mPerDegLon;
  const degLatStep = spacingMeters / mPerDegLat;

  const points: TerrainBoundaryPoint[] = [];
  for (let lat = minLat + degLatStep * 0.5; lat < maxLat; lat += degLatStep) {
    for (let lon = minLon + degLonStep * 0.5; lon < maxLon; lon += degLonStep) {
      const pt = turfPoint([lon, lat]);
      if (!booleanPointInPolygon(pt, domainPolygon)) continue;
      if (booleanPointInPolygon(pt, transitionPolygon)) continue;
      points.push({ lon, lat });
    }
  }

  return points;
}

function computeFlatHeight(
  bound: Feature<Polygon>,
  terrainPoints: TerrainPoint[],
): number {
  if (terrainPoints.length === 0) return 0;

  const innerBound = buffer(bound, -TERRAIN_FLAT_HEIGHT_BAND_M, { units: 'meters' });
  const innerPoly = innerBound?.geometry && innerBound.geometry.type === 'Polygon'
    ? turfPolygon(innerBound.geometry.coordinates)
    : null;

  const boundaryBand = terrainPoints.filter((point) => {
    if (!innerPoly) return true;
    return !booleanPointInPolygon(turfPoint([point.lon, point.lat]), innerPoly);
  });
  const samples = boundaryBand.length > 0 ? boundaryBand : terrainPoints;
  const sortedZ = samples.map((point) => point.z).sort((a, b) => a - b);
  const mid = Math.floor(sortedZ.length / 2);
  return sortedZ.length % 2 === 0
    ? (sortedZ[mid - 1] + sortedZ[mid]) / 2
    : sortedZ[mid];
}

/**
 * Main terrain-generation entry point. Receives building patches, the shared
 * origin, and the shared SurfaceSampler from the route orchestration layer.
 */
export async function runTerrainGeneration(
  bound: Feature<Polygon>,
  sampler: SurfaceSampler,
  buildingPatches: BuildingPatch[],
  boundaryBuildings: (Polygon | MultiPolygon)[],
  buildingOrigin: {
    lonlat: [number, number];
    offset_2326?: [number, number];
    mercatorZScale: number;
  },
  workDir: string,
  corridorFootprints?: FeatureCollection | null,
  corridorSurfaceObjPath?: string | null,
  windDirectionDeg = 0,
  options?: Pick<
    ModelingConfig,
    'gridStep' | 'buildingBufferDist' | 'outlierThreshold' | 'outlierRadius' | 'outlierMaxIterations' | 'terrainBuffer'
  >,
  logger?: TaskLogger,
) {
  writeTaskLog(logger, 'log', 'terrain', '====== terrain generation start ======');
  writeTaskLog(logger, 'log', 'terrain', `building patches: ${buildingPatches.length}, boundary buildings: ${boundaryBuildings.length}, refLat: ${buildingOrigin.lonlat[1].toFixed(6)}`);
  const totalStart = Date.now();

  const refLat = buildingOrigin.lonlat[1];

  // Build shared buffers from patches and cross-boundary buildings.
  const NEAR_TERRAIN_BUFFER_DIST = options?.buildingBufferDist ?? BUILDING_NEAR_TERRAIN_BUFFER_M;
  const allBuildingsForFilter = [
    ...buildingPatches.map((patch) => patch.geometry),
    ...boundaryBuildings,
  ];
  const buildingFootprints = buildBufferedPatches(allBuildingsForFilter, 0);
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `building terrain guards: footprints=${buildingFootprints.length}, ` +
    `localPlaneBuffer=${NEAR_TERRAIN_BUFFER_DIST.toFixed(2)}m`
  );

  // Extract unbuffered corridor footprints and defer their samples to interpolation.
  const corridorRegions = extractCorridorRegions(corridorFootprints ?? null);
  writeTaskLog(logger, 'log', 'terrain', `corridor footprint regions: ${corridorRegions.length}`);

  // Perform uniform sampling, building-buffer filtering, and corridor deferral.
  writeTaskLog(logger, 'log', 'terrain', 'Grid sampling and building buffer filtering');
  const samplingStart = Date.now();

  const gridResult = generateGridPoints(
    bound,
    buildingFootprints,
    corridorRegions,
    sampler,
    refLat,
    options?.gridStep ?? 3,
  );
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `grid sampling: total=${gridResult.stats.total}, outside_bound=${gridResult.stats.outsideBound}, ` +
    `inside_building=${gridResult.stats.insideBuilding}, inside_corridor=${gridResult.stats.insideCorridor}, ` +
    `null_z=${gridResult.stats.nullZ}, valid=${gridResult.stats.valid}`
  );
  writeTaskLog(logger, 'log', 'timing', `terrain sampling | elapsed=${formatMs(Date.now() - samplingStart)}`);

  // Remove local outliers.
  writeTaskLog(logger, 'log', 'terrain', 'Local median outlier filtering');
  const outlierFilteringStart = Date.now();

  const { filtered: terrainPoints, correctedCount, iterations } = filterOutliersByLocalMedian(
    gridResult.points,
    gridResult.gridStep,
    refLat,
    {
      outlierRadius: options?.outlierRadius ?? 20,
      outlierThreshold: options?.outlierThreshold ?? 5,
      outlierMaxIterations: options?.outlierMaxIterations ?? 50,
    },
    logger,
  );
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `outlier filtering: iterations=${iterations}, corrected=${correctedCount}, remaining=${terrainPoints.length}`
  );
  writeTaskLog(logger, 'log', 'timing', `outlier filtering | elapsed=${formatMs(Date.now() - outlierFilteringStart)}`);

  if (terrainPoints.length < 3) {
    writeTaskLog(logger, 'warn', 'terrain', 'insufficient terrain points for triangulation (<3), skipping terrain generation');
    return null;
  }

  // Construct computational-domain and full-terrain boundaries.
  writeTaskLog(logger, 'log', 'terrain', 'Planning domain and terrain boundaries');
  const domainPlan = buildDomainPlan({
    bound,
    buildingPatches,
    terrainHeights: terrainPoints.map((point) => point.z),
    originLonLat: buildingOrigin.lonlat,
    windDirectionDeg,
  });
  const displayBufferDistance = Number.isFinite(TERRAIN_DISPLAY_BUFFER_METERS)
    ? Math.max(0, TERRAIN_DISPLAY_BUFFER_METERS)
    : 0;
  const terrainOpenfoamBuffer = options?.terrainBuffer ?? true;
  const transitionBufferDistance = terrainOpenfoamBuffer
    ? getTransitionBufferDistance(domainPlan.H)
    : displayBufferDistance;
  const transitionBoundary = terrainOpenfoamBuffer
    ? generateTransitionBoundary(bound, refLat, transitionBufferDistance, logger)
    : null;
  const transitionControlRings = terrainOpenfoamBuffer
    ? generateTransitionControlRings(bound, refLat, transitionBufferDistance, logger)
    : [];
  const domainBoundary = terrainOpenfoamBuffer
    ? densifyBoundaryRing(
      domainPlan.domainBoundary,
      refLat,
      TERRAIN_DOMAIN_BOUNDARY_STEP_M,
    )
    : null;
  const meshBoundary = terrainOpenfoamBuffer
    ? null
    : generateDisplayTerrainBoundary(bound, refLat, displayBufferDistance, logger);
  const flatAnchorSpacing = getFlatAnchorSpacing(domainPlan.H);
  const flatAnchorPoints = terrainOpenfoamBuffer
    ? generateFlatAnchorPoints(
      domainBoundary ?? [],
      transitionBoundary ?? [],
      refLat,
      flatAnchorSpacing,
    )
    : [];
  const zFlat = computeFlatHeight(bound, terrainPoints);
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `domain plan: H=${domainPlan.H.toFixed(2)}, ` +
    `topZ=${domainPlan.domainTopZ.toFixed(2)}, bottomZ=${domainPlan.domainBottomZ.toFixed(2)}, ` +
    `wind=${domainPlan.windDirectionDeg.toFixed(1)}deg`
  );
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `terrain controls: openfoamBuffer=${terrainOpenfoamBuffer}, transition=${transitionBoundary?.length ?? 0}, ` +
    `controlRings=${transitionControlRings.length}, domain=${domainBoundary?.length ?? 0}, ` +
    `meshBoundary=${meshBoundary?.length ?? 0}, ` +
    `flatAnchors=${flatAnchorPoints.length}, transitionBuffer=${transitionBufferDistance.toFixed(2)}, ` +
    `flatAnchorSpacing=${flatAnchorSpacing.toFixed(2)}, zFlat=${zFlat.toFixed(2)}`
  );
  const domainPlanPath = path.join(workDir, 'domain_plan.json');
  fs.writeFileSync(domainPlanPath, JSON.stringify({
    ...domainPlan,
    zFlat,
    transitionBufferDistance,
    transitionControlRings,
    transitionBoundary,
    domainBoundary,
    meshBoundary,
    terrainOpenfoamBuffer,
    displayBufferDistance,
    flatAnchorPoints,
  }, null, 2));
  console.log(`[terrain] domain plan saved: ${domainPlanPath}`);

  // Invoke the Python terrain CDT builder.
  console.log('[terrain] calling Python CDT terrain build...');
  writeTaskLog(logger, 'log', 'terrain', 'Terrain mesh construction');
  const terrainBuildStart = Date.now();

  const buildingGeometries = buildingPatches.map((patch) => ({
    geometry: { type: patch.geometry.type, coordinates: patch.geometry.coordinates },
  }));
  const patchGeoJsonList = buildingGeometries.map((item) => item.geometry);

  const terrainDir = path.join(workDir, 'terrain');
  fs.mkdirSync(terrainDir, { recursive: true });
  const terrainObjPath = path.join(terrainDir, 'terrain.obj');
  console.log(`[terrain] output path: ${terrainObjPath}`);

  // Store large payloads in temporary files and send only their paths over HTTP.
  const inputDataPath = path.join(terrainDir, 'terrain_input.json');
  // Individual building geometry used by Python to calculate base-vertex Z values.
  const corridorBottomMesh = corridorSurfaceObjPath
    ? extractCorridorBottomMesh(corridorSurfaceObjPath)
    : null;

  if (corridorBottomMesh) {
    writeTaskLog(
      logger,
      'log',
      'terrain',
      `corridor bottom mesh: vertices=${corridorBottomMesh.vertices.length}, ` +
      `faces=${corridorBottomMesh.faces.length}`
    );
  } else {
    writeTaskLog(logger, 'log', 'terrain', 'corridor bottom mesh: none');
  }

  fs.writeFileSync(inputDataPath, JSON.stringify({
    terrain_points: terrainPoints,
    study_boundary: bound.geometry,
    building_patches: patchGeoJsonList,
    transition_control_rings: transitionControlRings,
    transition_boundary: transitionBoundary,
    domain_boundary: domainBoundary,
    mesh_boundary: meshBoundary,
    flat_anchor_points: flatAnchorPoints,
    z_flat: zFlat,
    transition_buffer_distance: transitionBufferDistance,
    terrain_openfoam_buffer: terrainOpenfoamBuffer,
    display_buffer_distance: displayBufferDistance,
    building_base_plane_buffer_m: NEAR_TERRAIN_BUFFER_DIST,
    building_geometries: buildingGeometries,
    corridor_bottom_mesh: corridorBottomMesh,
  }));

  const requestBody = {
    output_path: terrainObjPath,
    input_data_path: inputDataPath,
    offset_2326: buildingOrigin.offset_2326 || [0, 0],
  };

  console.log(
    `[terrain] ` +
    `request payload: terrain_points=${terrainPoints.length}, ` +
    `building_patches=${patchGeoJsonList.length}, transition_boundary=${transitionBoundary?.length ?? 0}, ` +
    `transition_control_rings=${transitionControlRings.length}, domain_boundary=${domainBoundary?.length ?? 0}, ` +
    `mesh_boundary=${meshBoundary?.length ?? 0}, openfoam_buffer=${terrainOpenfoamBuffer}, ` +
    `flat_anchor_points=${flatAnchorPoints.length}, transition_buffer=${transitionBufferDistance.toFixed(2)}, z_flat=${zFlat.toFixed(2)}, ` +
    `corridor_faces=${corridorBottomMesh?.faces.length ?? 0}, ` +
    `offset_2326=[${(buildingOrigin.offset_2326 || [0, 0]).map(v => v.toFixed(2)).join(', ')}]`
  );

  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/terrain/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`terrain build api failed: HTTP ${resp.status}, body=${text}`);
  }

  const terrainResult = (await resp.json()) as TerrainBuildResponse;
  console.log(`[timing] python CDT terrain build | elapsed=${formatMs(Date.now() - terrainBuildStart)}`);
  writeTaskLog(
    logger,
    'log',
    'terrain',
    `CDT result: vertices=${terrainResult.vertex_count}, triangles=${terrainResult.triangle_count}`
  );

  // Build the output URL.
  const tempRoot = path.resolve(TEMP_DIR);
  const relativePath = path.relative(tempRoot, terrainObjPath).replace(/\\/g, '/');
  const terrainObjUrl = `/outputs/${relativePath}`;

  console.log(`[terrain] terrain obj url: ${terrainObjUrl}`);
  writeTaskLog(logger, 'log', 'timing', `terrain generation total | elapsed=${formatMs(Date.now() - totalStart)}`);
  writeTaskLog(logger, 'log', 'terrain', '====== terrain generation complete ======');

  return {
    terrain: {
      objUrl: terrainObjUrl,
      placement: {
        coords: buildingOrigin.lonlat,
        rotation: { x: 0, y: 0, z: 180 },
        scale: 1,
        mercatorZScale: buildingOrigin.mercatorZScale,
        anchor: 'none',
      },
    },
    sampling: {
      points: terrainPoints.map((p) => [p.lon, p.lat, p.z] as [number, number, number]),
    },
    terrainObjPath,
    domain: domainPlan,
    // Per-building base-vertex Z values returned by the terrain CDT for building modeling.
    buildingBaseHeights: terrainResult.building_base_heights || null,
    buildingBasePlanes: terrainResult.building_base_planes || null,
  };
}
