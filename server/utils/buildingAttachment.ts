import type { MultiPolygon, Polygon } from 'geojson';
import type { BuildingPatchMember } from '../types/buildingPatch';
import { getGeometryBbox } from './geoUtils';

const jsts = require('jsts');

export const STRICT_ATTACHMENT_MIN_SHARED_LENGTH_M = 0.01;
const VERTEX_TOUCH_COORD_PRECISION = 12;

type BuildingGeometry = Polygon | MultiPolygon;

type Bbox = ReturnType<typeof getGeometryBbox>;

type GeoJsonGeometryLike = {
  type?: string;
  coordinates?: unknown;
  geometries?: GeoJsonGeometryLike[];
};

export type BuildingAttachmentEdge = {
  memberAId: string;
  memberBId: string;
  sharedBoundaryLengthMeters: number;
};

export type BuildingAttachmentGroup = {
  groupIndex: number;
  memberIds: string[];
};

export type BuildingAttachmentMemberSummary = {
  memberId: string;
  groupIndex: number;
  groupSize: number;
  attachedMemberIds: string[];
};

export type BuildingAttachmentAnalysis = {
  groups: BuildingAttachmentGroup[];
  edges: BuildingAttachmentEdge[];
  members: BuildingAttachmentMemberSummary[];
};

function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

function readJstsGeometry(geometry: BuildingGeometry): unknown | null {
  try {
    const reader = new jsts.io.GeoJSONReader();
    const parsed = reader.read(geometry);
    return parsed && !parsed.isEmpty?.() ? parsed : null;
  } catch {
    return null;
  }
}

function writeJstsGeometry(geometry: unknown): GeoJsonGeometryLike | null {
  try {
    const writer = new jsts.io.GeoJSONWriter();
    return writer.write(geometry) as GeoJsonGeometryLike;
  } catch {
    return null;
  }
}

function boundaryIntersectionGeometry(a: BuildingGeometry, b: BuildingGeometry): GeoJsonGeometryLike | null {
  const geomA = readJstsGeometry(a);
  const geomB = readJstsGeometry(b);
  if (!geomA || !geomB) return null;

  try {
    const boundaryA = (geomA as { getBoundary: () => unknown }).getBoundary();
    const boundaryB = (geomB as { getBoundary: () => unknown }).getBoundary();
    const intersection = (boundaryA as { intersection: (other: unknown) => unknown }).intersection(boundaryB);
    if (!intersection || (intersection as { isEmpty?: () => boolean }).isEmpty?.()) return null;
    return writeJstsGeometry(intersection);
  } catch {
    return null;
  }
}

function haversineMeters(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const lon1 = a[0] * Math.PI / 180;
  const lat1 = a[1] * Math.PI / 180;
  const lon2 = b[0] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dlon = lon2 - lon1;
  const dlat = lat2 - lat1;
  const sinDlat = Math.sin(dlat / 2);
  const sinDlon = Math.sin(dlon / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function geometryContainsLinearPart(geometry: GeoJsonGeometryLike | null): boolean {
  if (!geometry) return false;
  switch (geometry.type) {
    case 'LineString':
    case 'MultiLineString':
      return true;
    case 'GeometryCollection':
      return Array.isArray(geometry.geometries) && geometry.geometries.some(geometryContainsLinearPart);
    default:
      return false;
  }
}

function lineStringLengthMeters(coords: unknown): number {
  if (!Array.isArray(coords)) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    if (Array.isArray(a) && Array.isArray(b)) {
      total += haversineMeters(a as number[], b as number[]);
    }
  }
  return total;
}

function linearGeometryLengthMeters(geometry: GeoJsonGeometryLike | null): number {
  if (!geometry) return 0;
  switch (geometry.type) {
    case 'LineString':
      return lineStringLengthMeters(geometry.coordinates);
    case 'MultiLineString':
      return Array.isArray(geometry.coordinates)
        ? geometry.coordinates.reduce((sum, coords) => sum + lineStringLengthMeters(coords), 0)
        : 0;
    case 'GeometryCollection':
      return Array.isArray(geometry.geometries)
        ? geometry.geometries.reduce((sum, geom) => sum + linearGeometryLengthMeters(geom), 0)
        : 0;
    default:
      return 0;
  }
}

export function sharedBoundaryLengthMeters(a: BuildingGeometry, b: BuildingGeometry): number {
  return linearGeometryLengthMeters(boundaryIntersectionGeometry(a, b));
}

function vertexKey(coord: number[]): string | null {
  if (coord.length < 2) return null;
  const lon = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return `${lon.toFixed(VERTEX_TOUCH_COORD_PRECISION)},${lat.toFixed(VERTEX_TOUCH_COORD_PRECISION)}`;
}

function addRingVertexKeys(keys: Set<string>, ring: unknown): void {
  if (!Array.isArray(ring)) return;
  const count = ring.length > 1 ? ring.length - 1 : ring.length;
  for (let i = 0; i < count; i++) {
    const key = Array.isArray(ring[i]) ? vertexKey(ring[i] as number[]) : null;
    if (key) keys.add(key);
  }
}

function geometryVertexKeys(geometry: BuildingGeometry): Set<string> {
  const keys = new Set<string>();
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) {
      addRingVertexKeys(keys, ring);
    }
    return keys;
  }

  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      addRingVertexKeys(keys, ring);
    }
  }
  return keys;
}

function hasSharedVertex(a: BuildingGeometry, b: BuildingGeometry): boolean {
  const aKeys = geometryVertexKeys(a);
  if (aKeys.size === 0) return false;
  for (const key of geometryVertexKeys(b)) {
    if (aKeys.has(key)) return true;
  }
  return false;
}

export function hasStrictVertexTouch(a: BuildingGeometry, b: BuildingGeometry): boolean {
  const boundaryIntersection = boundaryIntersectionGeometry(a, b);
  if (!boundaryIntersection || geometryContainsLinearPart(boundaryIntersection)) return false;
  return hasSharedVertex(a, b);
}

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_value, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index];
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

export function analyzeBuildingAttachments(
  members: BuildingPatchMember[],
  options?: { minSharedLengthMeters?: number },
): BuildingAttachmentAnalysis {
  const minSharedLengthMeters = options?.minSharedLengthMeters ?? STRICT_ATTACHMENT_MIN_SHARED_LENGTH_M;
  const uf = new UnionFind(members.length);
  const edges: BuildingAttachmentEdge[] = [];
  const adjacency = new Map<string, Set<string>>();
  const geometries = members.map((member) => ({
    member,
    bbox: getGeometryBbox(member.geometry),
  }));

  for (const { member } of geometries) {
    adjacency.set(member.fullId, new Set());
  }

  for (let i = 0; i < geometries.length; i++) {
    for (let j = i + 1; j < geometries.length; j++) {
      if (!bboxIntersects(geometries[i].bbox, geometries[j].bbox)) continue;

      const sharedLength = sharedBoundaryLengthMeters(geometries[i].member.geometry, geometries[j].member.geometry);
      const isAttached = sharedLength >= minSharedLengthMeters ||
        hasStrictVertexTouch(geometries[i].member.geometry, geometries[j].member.geometry);
      if (!isAttached) continue;

      const aId = geometries[i].member.fullId;
      const bId = geometries[j].member.fullId;
      uf.union(i, j);
      adjacency.get(aId)?.add(bId);
      adjacency.get(bId)?.add(aId);
      edges.push({
        memberAId: aId,
        memberBId: bId,
        sharedBoundaryLengthMeters: sharedLength,
      });
    }
  }

  const componentMembers = new Map<number, string[]>();
  const componentOrder: number[] = [];
  for (let i = 0; i < members.length; i++) {
    const root = uf.find(i);
    if (!componentMembers.has(root)) {
      componentMembers.set(root, []);
      componentOrder.push(root);
    }
    componentMembers.get(root)?.push(members[i].fullId);
  }

  const groupIndexByMemberId = new Map<string, number>();
  const groups = componentOrder.map((root, groupIndex) => {
    const memberIds = componentMembers.get(root) ?? [];
    for (const memberId of memberIds) {
      groupIndexByMemberId.set(memberId, groupIndex);
    }
    return { groupIndex, memberIds };
  });

  return {
    groups,
    edges,
    members: members.map((member) => {
      const attachedMemberIds = Array.from(adjacency.get(member.fullId) ?? []).sort();
      const groupIndex = groupIndexByMemberId.get(member.fullId) ?? -1;
      const groupSize = groups[groupIndex]?.memberIds.length ?? 1;
      return {
        memberId: member.fullId,
        groupIndex,
        groupSize,
        attachedMemberIds,
      };
    }),
  };
}
