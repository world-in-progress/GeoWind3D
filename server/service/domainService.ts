import type { Feature, Polygon } from 'geojson';
import type { BuildingPatch } from '../types/buildingPatch';

const DOMAIN_UPSTREAM_FACTOR = 5;
const DOMAIN_DOWNSTREAM_FACTOR = 15;
const DOMAIN_SIDE_FACTOR = 5;
const DOMAIN_TOP_FACTOR = 6;
const DOMAIN_BOTTOM_PADDING_M = 5;

type LocalPoint = {
  x: number;
  y: number;
};

export type DomainPlan = {
  windDirectionDeg: number;
  modelTopZ: number;
  modelBottomZ: number;
  H: number;
  domainTopZ: number;
  domainBottomZ: number;
  upstreamDistance: number;
  downstreamDistance: number;
  sideDistance: number;
  alignedStudyBounds: {
    minAlong: number;
    maxAlong: number;
    minCross: number;
    maxCross: number;
  };
  alignedDomainBounds: {
    minAlong: number;
    maxAlong: number;
    minCross: number;
    maxCross: number;
  };
  domainBoundary: { lon: number; lat: number }[];
};

function normalizeAngleDeg(deg: number): number {
  const normalized = deg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function metersPerDegree(originLat: number) {
  const latRad = (originLat * Math.PI) / 180;
  return {
    lon: Math.max(111320 * Math.cos(latRad), 1e-6),
    lat: 110540,
  };
}

function toLocalMeters(
  lon: number,
  lat: number,
  originLonLat: [number, number],
): LocalPoint {
  const scale = metersPerDegree(originLonLat[1]);
  return {
    x: (lon - originLonLat[0]) * scale.lon,
    y: (lat - originLonLat[1]) * scale.lat,
  };
}

function toLonLat(
  point: LocalPoint,
  originLonLat: [number, number],
): { lon: number; lat: number } {
  const scale = metersPerDegree(originLonLat[1]);
  return {
    lon: originLonLat[0] + point.x / scale.lon,
    lat: originLonLat[1] + point.y / scale.lat,
  };
}

function getFlowBasis(windDirectionDeg: number) {
  const radians = (normalizeAngleDeg(windDirectionDeg) * Math.PI) / 180;
  const along = {
    x: Math.sin(radians),
    y: Math.cos(radians),
  };
  const cross = {
    x: Math.cos(radians),
    y: -Math.sin(radians),
  };
  return { along, cross };
}

function projectPoint(point: LocalPoint, axis: LocalPoint): number {
  return point.x * axis.x + point.y * axis.y;
}

function getStudyAreaBounds(
  bound: Feature<Polygon>,
  originLonLat: [number, number],
  windDirectionDeg: number,
) {
  const { along, cross } = getFlowBasis(windDirectionDeg);
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minCross = Infinity;
  let maxCross = -Infinity;

  for (const [lon, lat] of bound.geometry.coordinates[0]) {
    const point = toLocalMeters(lon, lat, originLonLat);
    const alongCoord = projectPoint(point, along);
    const crossCoord = projectPoint(point, cross);
    minAlong = Math.min(minAlong, alongCoord);
    maxAlong = Math.max(maxAlong, alongCoord);
    minCross = Math.min(minCross, crossCoord);
    maxCross = Math.max(maxCross, crossCoord);
  }

  return { minAlong, maxAlong, minCross, maxCross };
}

function composePoint(
  alongCoord: number,
  crossCoord: number,
  windDirectionDeg: number,
): LocalPoint {
  const { along, cross } = getFlowBasis(windDirectionDeg);
  return {
    x: along.x * alongCoord + cross.x * crossCoord,
    y: along.y * alongCoord + cross.y * crossCoord,
  };
}

function toBoundaryRing(
  bounds: {
    minAlong: number;
    maxAlong: number;
    minCross: number;
    maxCross: number;
  },
  originLonLat: [number, number],
  windDirectionDeg: number,
) {
  const corners = [
    composePoint(bounds.minAlong, bounds.minCross, windDirectionDeg),
    composePoint(bounds.maxAlong, bounds.minCross, windDirectionDeg),
    composePoint(bounds.maxAlong, bounds.maxCross, windDirectionDeg),
    composePoint(bounds.minAlong, bounds.maxCross, windDirectionDeg),
  ];

  const ring = corners.map((point) => toLonLat(point, originLonLat));
  ring.push({ ...ring[0] });
  return ring;
}

function getModelTopZ(buildingPatches: BuildingPatch[], terrainHeights: number[]): number {
  const buildingTopZ = buildingPatches.reduce((maxZ, patch) => {
    const memberTopZ = patch.members.reduce((patchMaxZ, member) => {
      if (typeof member.roofZ !== 'number' || !Number.isFinite(member.roofZ)) {
        return patchMaxZ;
      }
      return Math.max(patchMaxZ, member.roofZ);
    }, -Infinity);
    return Math.max(maxZ, memberTopZ);
  }, -Infinity);

  const terrainTopZ = terrainHeights.reduce((maxZ, z) => Math.max(maxZ, z), -Infinity);
  const modelTopZ = Math.max(buildingTopZ, terrainTopZ);
  if (!Number.isFinite(modelTopZ)) {
    throw new Error('Failed to determine modelTopZ for domain planning.');
  }
  return modelTopZ;
}

function getModelBottomZ(terrainHeights: number[]): number {
  const modelBottomZ = terrainHeights.reduce((minZ, z) => Math.min(minZ, z), Infinity);
  if (!Number.isFinite(modelBottomZ)) {
    throw new Error('Failed to determine modelBottomZ for domain planning.');
  }
  return modelBottomZ;
}

export function buildDomainPlan(params: {
  bound: Feature<Polygon>;
  buildingPatches: BuildingPatch[];
  terrainHeights: number[];
  originLonLat: [number, number];
  windDirectionDeg: number;
}) : DomainPlan {
  const windDirectionDeg = normalizeAngleDeg(params.windDirectionDeg);
  const modelTopZ = getModelTopZ(params.buildingPatches, params.terrainHeights);
  const modelBottomZ = getModelBottomZ(params.terrainHeights);
  const H = modelTopZ;

  const alignedStudyBounds = getStudyAreaBounds(
    params.bound,
    params.originLonLat,
    windDirectionDeg,
  );

  const upstreamDistance = DOMAIN_UPSTREAM_FACTOR * H;
  const downstreamDistance = DOMAIN_DOWNSTREAM_FACTOR * H;
  const sideDistance = DOMAIN_SIDE_FACTOR * H;
  const domainTopZ = DOMAIN_TOP_FACTOR * H;
  const domainBottomZ = modelBottomZ - DOMAIN_BOTTOM_PADDING_M;

  const alignedDomainBounds = {
    minAlong: alignedStudyBounds.minAlong - upstreamDistance,
    maxAlong: alignedStudyBounds.maxAlong + downstreamDistance,
    minCross: alignedStudyBounds.minCross - sideDistance,
    maxCross: alignedStudyBounds.maxCross + sideDistance,
  };

  const domainBoundary = toBoundaryRing(
    alignedDomainBounds,
    params.originLonLat,
    windDirectionDeg,
  );

  return {
    windDirectionDeg,
    modelTopZ,
    modelBottomZ,
    H,
    domainTopZ,
    domainBottomZ,
    upstreamDistance,
    downstreamDistance,
    sideDistance,
    alignedStudyBounds,
    alignedDomainBounds,
    domainBoundary: domainBoundary.map((point) => ({ lon: point.lon, lat: point.lat })),
  };
}
