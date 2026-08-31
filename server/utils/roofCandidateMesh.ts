import fs from 'fs';
import type { TriangleRecord } from './indexedTileMesh';

export type RoofCandidateMeshTriangle = {
  tileId: string;
  faceIndex: number;
  local: TriangleRecord['local'];
  geo: TriangleRecord['geo'];
  normalZ: number;
  areaM2: number;
  zMin: number;
  zMax: number;
  zMean: number;
};

export type RoofCandidateMeshSummary = {
  queriedTriangleCount: number;
  normalFilteredTriangleCount: number;
  degenerateTriangleCount: number;
  candidateTriangleCount: number;
};

export type RoofCandidateMeshOptions = {
  minNonVerticalAbsNormalZ?: number;
  minProjectedAreaM2?: number;
};

// Roof candidates should retain sloped roofs; this threshold only removes near-vertical facade faces.
const DEFAULT_MIN_NON_VERTICAL_ABS_NORMAL_Z = 0.25;
const DEFAULT_MIN_PROJECTED_AREA_M2 = 0.02;
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON_AT_EQUATOR = 111320;

type Vec3 = [number, number, number];

type TriangleRoofMetrics = {
  normalZ: number;
  areaM2: number;
  zMin: number;
  zMax: number;
  zMean: number;
};

function toMetricVertex(vertex: [number, number, number], refLon: number, refLat: number): Vec3 {
  const metersPerDegLon = Math.max(
    1e-9,
    METERS_PER_DEG_LON_AT_EQUATOR * Math.cos(refLat * Math.PI / 180),
  );
  return [
    (vertex[0] - refLon) * metersPerDegLon,
    (vertex[1] - refLat) * METERS_PER_DEG_LAT,
    vertex[2],
  ];
}

function objVertexKey(vertex: [number, number, number]): string {
  return `${vertex[0]},${vertex[1]},${vertex[2]}`;
}

function computeObjAnchor(triangles: RoofCandidateMeshTriangle[]): [number, number, number] {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const triangle of triangles) {
    for (const vertex of triangle.geo) {
      if (!vertex.every(Number.isFinite)) continue;
      minLon = Math.min(minLon, vertex[0]);
      minLat = Math.min(minLat, vertex[1]);
      maxLon = Math.max(maxLon, vertex[0]);
      maxLat = Math.max(maxLat, vertex[1]);
    }
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return [0, 0, 0];
  return [
    (minLon + maxLon) / 2,
    (minLat + maxLat) / 2,
    0,
  ];
}

function writeStreamLine(stream: fs.WriteStream, line: string): Promise<void> | null {
  if (stream.write(`${line}\n`)) return null;
  return new Promise((resolve) => stream.once('drain', resolve));
}

async function writeLine(stream: fs.WriteStream, line: string): Promise<void> {
  const pending = writeStreamLine(stream, line);
  if (pending) await pending;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function projectedAreaM2(points: Vec3[]): number {
  const [a, b, c] = points;
  return Math.abs(
    (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  ) / 2;
}

function analyzeTriangle(triangle: TriangleRecord): TriangleRoofMetrics | null {
  const refLon = (triangle.geo[0][0] + triangle.geo[1][0] + triangle.geo[2][0]) / 3;
  const refLat = (triangle.geo[0][1] + triangle.geo[1][1] + triangle.geo[2][1]) / 3;
  const metric = triangle.geo.map((vertex) => toMetricVertex(vertex, refLon, refLat));
  const normal = cross(subtract(metric[1], metric[0]), subtract(metric[2], metric[0]));
  const normalLength = norm(normal);
  if (!Number.isFinite(normalLength) || normalLength <= 0) return null;

  const zValues = triangle.geo.map((vertex) => vertex[2]);
  if (!zValues.every(Number.isFinite)) return null;

  return {
    normalZ: normal[2] / normalLength,
    areaM2: projectedAreaM2(metric),
    zMin: Math.min(...zValues),
    zMax: Math.max(...zValues),
    zMean: zValues.reduce((sum, z) => sum + z, 0) / zValues.length,
  };
}

export function extractRoofCandidateMeshTriangles(
  triangles: TriangleRecord[],
  options: RoofCandidateMeshOptions = {},
): {
  triangles: RoofCandidateMeshTriangle[];
  summary: RoofCandidateMeshSummary;
} {
  const minNonVerticalAbsNormalZ = options.minNonVerticalAbsNormalZ ?? DEFAULT_MIN_NON_VERTICAL_ABS_NORMAL_Z;
  const minProjectedAreaM2 = options.minProjectedAreaM2 ?? DEFAULT_MIN_PROJECTED_AREA_M2;

  const candidates: RoofCandidateMeshTriangle[] = [];
  let normalFilteredTriangleCount = 0;
  let degenerateTriangleCount = 0;

  for (const triangle of triangles) {
    const metrics = analyzeTriangle(triangle);
    if (!metrics || metrics.areaM2 < minProjectedAreaM2) {
      degenerateTriangleCount++;
      continue;
    }
    if (Math.abs(metrics.normalZ) < minNonVerticalAbsNormalZ) {
      normalFilteredTriangleCount++;
      continue;
    }
    candidates.push({
      tileId: triangle.tileId,
      faceIndex: triangle.faceIndex,
      local: triangle.local,
      geo: triangle.geo,
      ...metrics,
    });
  }

  return {
    triangles: candidates,
    summary: {
      queriedTriangleCount: triangles.length,
      normalFilteredTriangleCount,
      degenerateTriangleCount,
      candidateTriangleCount: candidates.length,
    },
  };
}

export async function writeRoofCandidateMeshObj(
  outputPath: string,
  triangles: RoofCandidateMeshTriangle[],
): Promise<void> {
  const stream = fs.createWriteStream(outputPath, {
    flags: 'w',
    encoding: 'utf8',
  });
  const closeStream = () => new Promise<void>((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });

  const [anchorLon, anchorLat, anchorZ] = computeObjAnchor(triangles);
  const vertexIndexByKey = new Map<string, number>();
  let nextVertexIndex = 1;

  await writeLine(stream, '# CityWind roof candidate mesh');
  await writeLine(stream, `# triangle_count ${triangles.length}`);
  await writeLine(stream, `# anchor_lon_lat_z ${anchorLon} ${anchorLat} ${anchorZ}`);
  await writeLine(stream, '# vertices are local tangent-plane meters; z keeps sampled absolute elevation');

  for (const triangle of triangles) {
    const faceIndices: number[] = [];
    for (const geoVertex of triangle.geo) {
      const key = objVertexKey(geoVertex);
      let vertexIndex = vertexIndexByKey.get(key);
      if (!vertexIndex) {
        vertexIndex = nextVertexIndex++;
        vertexIndexByKey.set(key, vertexIndex);
        const [x, y, z] = toMetricVertex(geoVertex, anchorLon, anchorLat);
        await writeLine(stream, `v ${x.toFixed(6)} ${y.toFixed(6)} ${(z - anchorZ).toFixed(6)}`);
      }
      faceIndices.push(vertexIndex);
    }
    await writeLine(stream, `f ${faceIndices[0]} ${faceIndices[1]} ${faceIndices[2]}`);
  }

  await closeStream();
}
