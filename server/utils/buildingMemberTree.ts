import type { MultiPolygon, Polygon } from 'geojson';
import type {
  BuildingPatchGeometry,
  BuildingPatchMember,
} from '../types/buildingPatch';
import { getGeometryBbox } from './geoUtils';

const jsts = require('jsts');

export const COMPOUND_DUPLICATE_OVERLAP_RATIO = 0.95;
export const COMPOUND_CONTAINMENT_RATIO = 0.7;

type MemberWithMetrics = BuildingPatchMember & {
  area: number;
  geometryKey: string;
};

type TreeNode = MemberWithMetrics & {
  key: string;
  parentKey: string | null;
  childKeys: string[];
  treeLevel: number;
  subtreeGeometry: unknown | null;
  allocatedGeometry: unknown | null;
  subtreeArea: number;
};

export type PolygonTreeInput = {
  key: string;
  geometry: BuildingPatchGeometry;
  area: number;
  sortKey: string;
};

export type PolygonTreeNode<T extends PolygonTreeInput = PolygonTreeInput> = T & {
  parentKey: string | null;
  childKeys: string[];
  treeLevel: number;
};

export type BuildingMemberTreeRange = MemberWithMetrics & {
  treeLevel: number;
  parentFullId: string | null;
  samplingGeometry: BuildingPatchGeometry;
};

function bboxIntersects(a: BuildingPatchGeometry, b: BuildingPatchGeometry): boolean {
  const ba = getGeometryBbox(a);
  const bb = getGeometryBbox(b);
  return !(ba.maxLon < bb.minLon || ba.minLon > bb.maxLon || ba.maxLat < bb.minLat || ba.minLat > bb.maxLat);
}

function signedRingArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function readJstsGeometry(geometry: BuildingPatchGeometry): unknown | null {
  try {
    const reader = new jsts.io.GeoJSONReader();
    const parsed = reader.read(geometry);
    return parsed && !parsed.isEmpty?.() ? parsed : null;
  } catch {
    return null;
  }
}

function writeJstsGeometry(geometry: unknown): unknown | null {
  try {
    const writer = new jsts.io.GeoJSONWriter();
    return writer.write(geometry);
  } catch {
    return null;
  }
}

function jstsArea(geometry: unknown | null): number {
  if (!geometry || (geometry as { isEmpty?: () => boolean }).isEmpty?.()) return 0;
  const area = (geometry as { getArea?: () => number }).getArea?.() ?? 0;
  return Number.isFinite(area) ? area : 0;
}

export function polygonGeometryArea(geometry: BuildingPatchGeometry): number {
  const jstsGeometry = readJstsGeometry(geometry);
  const area = jstsArea(jstsGeometry);
  if (area > 0) return area;

  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let fallbackArea = 0;
  for (const rings of polys) {
    if (!rings[0]) continue;
    let polyArea = Math.abs(signedRingArea(rings[0]));
    for (let i = 1; i < rings.length; i++) {
      polyArea -= Math.abs(signedRingArea(rings[i]));
    }
    fallbackArea += Math.max(0, polyArea);
  }
  return fallbackArea;
}

function geometryArea(geometry: BuildingPatchGeometry): number {
  return polygonGeometryArea(geometry);
}

function intersectionJsts(a: unknown | null, b: unknown | null): unknown | null {
  if (!a || !b) return null;
  try {
    const result = (a as { intersection: (other: unknown) => unknown }).intersection(b);
    return result && !(result as { isEmpty?: () => boolean }).isEmpty?.() ? result : null;
  } catch {
    return null;
  }
}

function differenceJsts(a: unknown | null, b: unknown | null): unknown | null {
  if (!a) return null;
  if (!b) return a;
  try {
    const result = (a as { difference: (other: unknown) => unknown }).difference(b);
    return result && !(result as { isEmpty?: () => boolean }).isEmpty?.() ? result : null;
  } catch {
    return null;
  }
}

function unionTwoJsts(a: unknown | null, b: unknown | null): unknown | null {
  if (!a) return b;
  if (!b) return a;
  try {
    const result = (a as { union: (other: unknown) => unknown }).union(b);
    return result && !(result as { isEmpty?: () => boolean }).isEmpty?.() ? result : null;
  } catch {
    return a;
  }
}

function unionJstsGeometries(geometries: Array<unknown | null>): unknown | null {
  let merged: unknown | null = null;
  for (const geometry of geometries) {
    merged = unionTwoJsts(merged, geometry);
  }
  return merged;
}

function extractPolygonalGeometry(raw: unknown): BuildingPatchGeometry | null {
  if (!raw || typeof raw !== 'object') return null;
  const geom = raw as {
    type?: unknown;
    coordinates?: unknown;
    geometries?: unknown;
  };

  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
    return geom as Polygon;
  }
  if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    return geom as MultiPolygon;
  }
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    const polygons: number[][][][] = [];
    for (const child of geom.geometries) {
      const polygonal = extractPolygonalGeometry(child);
      if (!polygonal) continue;
      if (polygonal.type === 'Polygon') {
        polygons.push(polygonal.coordinates);
      } else {
        polygons.push(...polygonal.coordinates);
      }
    }
    if (polygons.length === 0) return null;
    return polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }

  return null;
}

function isEmptyPolygonalGeometry(geometry: BuildingPatchGeometry): boolean {
  return geometry.type === 'Polygon'
    ? !geometry.coordinates[0] || geometry.coordinates[0].length < 4
    : geometry.coordinates.every((poly) => !poly[0] || poly[0].length < 4);
}

function toPolygonalGeometry(geometry: unknown | null): BuildingPatchGeometry | null {
  const raw = writeJstsGeometry(geometry);
  const polygonal = extractPolygonalGeometry(raw);
  return polygonal && !isEmptyPolygonalGeometry(polygonal) ? polygonal : null;
}

export function unionPolygonGeometries(geometries: BuildingPatchGeometry[]): BuildingPatchGeometry | null {
  return toPolygonalGeometry(unionJstsGeometries(geometries.map(readJstsGeometry)));
}

function geometryKey(geometry: BuildingPatchGeometry): string {
  return JSON.stringify(geometry.coordinates, (_key, value) =>
    typeof value === 'number' ? Number(value.toFixed(8)) : value
  );
}

function compareMembers(a: MemberWithMetrics, b: MemberWithMetrics): number {
  const areaDiff = a.area - b.area;
  if (Math.abs(areaDiff) > 1e-14) return areaDiff;
  return a.fullId.localeCompare(b.fullId);
}

function intersectionArea(a: BuildingPatchGeometry, b: BuildingPatchGeometry): number {
  if (!bboxIntersects(a, b)) return 0;
  const intersection = intersectionJsts(readJstsGeometry(a), readJstsGeometry(b));
  return jstsArea(intersection);
}

function comparePolygonTreeInputs(a: PolygonTreeInput, b: PolygonTreeInput): number {
  return a.area - b.area || a.sortKey.localeCompare(b.sortKey) || a.key.localeCompare(b.key);
}

export function buildPolygonContainmentTree<T extends PolygonTreeInput>(
  inputs: T[],
): Array<PolygonTreeNode<T>> {
  const nodes = new Map<string, PolygonTreeNode<T>>(
    inputs
      .filter((input) => input.area > 0)
      .map((input) => [input.key, {
        ...input,
        parentKey: null,
        childKeys: [],
        treeLevel: 1,
      }])
  );
  const allNodes = [...nodes.values()];

  for (const child of allNodes) {
    const candidates = allNodes
      .filter((parent) => parent.key !== child.key && parent.area > child.area)
      .map((parent) => ({
        parent,
        ratio: child.area > 0 ? intersectionArea(parent.geometry, child.geometry) / child.area : 0,
      }))
      .filter(({ ratio }) => ratio >= COMPOUND_CONTAINMENT_RATIO)
      .sort((a, b) => comparePolygonTreeInputs(a.parent, b.parent));

    child.parentKey = candidates[0]?.parent.key ?? null;
  }

  for (const node of allNodes) {
    if (!node.parentKey) continue;
    nodes.get(node.parentKey)?.childKeys.push(node.key);
  }

  const assignLevels = (parentKey: string | null, level: number) => {
    const children = allNodes
      .filter((node) => node.parentKey === parentKey)
      .sort(comparePolygonTreeInputs);
    for (const child of children) {
      child.treeLevel = level;
      assignLevels(child.key, level + 1);
    }
  };
  assignLevels(null, 1);

  for (const node of allNodes) {
    node.childKeys.sort((a, b) => {
      const nodeA = nodes.get(a);
      const nodeB = nodes.get(b);
      if (!nodeA || !nodeB) return a.localeCompare(b);
      return comparePolygonTreeInputs(nodeA, nodeB);
    });
  }

  return allNodes;
}

function isDuplicate(a: MemberWithMetrics, b: MemberWithMetrics): boolean {
  if (a.geometryKey === b.geometryKey) return true;
  const overlapArea = intersectionArea(a.geometry, b.geometry);
  if (overlapArea <= 0) return false;
  return overlapArea / a.area >= COMPOUND_DUPLICATE_OVERLAP_RATIO &&
    overlapArea / b.area >= COMPOUND_DUPLICATE_OVERLAP_RATIO;
}

function dedupeMembers(members: BuildingPatchMember[]): MemberWithMetrics[] {
  const enriched = members
    .map((member) => ({
      ...member,
      area: geometryArea(member.geometry),
      geometryKey: geometryKey(member.geometry),
    }))
    .filter((member) => member.area > 0)
    .sort(compareMembers);

  const kept: MemberWithMetrics[] = [];
  for (const member of enriched) {
    if (kept.some((existing) => isDuplicate(member, existing))) continue;
    kept.push(member);
  }
  return kept;
}

export function dedupeBuildingMembers(members: BuildingPatchMember[]): BuildingPatchMember[] {
  return dedupeMembers(members).map((member) => ({
    fullId: member.fullId,
    osmType: member.osmType,
    geometry: member.geometry,
    osmHeight: member.osmHeight ?? null,
    osmBuildingLevels: member.osmBuildingLevels ?? null,
    roofZ: member.roofZ ?? null,
    heightSource: member.heightSource ?? null,
    osmRelativeHeight: member.osmRelativeHeight ?? null,
    heightTerrainZ: member.heightTerrainZ ?? null,
  }));
}

function createNodes(members: MemberWithMetrics[]): Map<string, TreeNode> {
  const tree = buildPolygonContainmentTree(
    members.map((member, index) => {
      const key = `${member.fullId}:${index}`;
      return {
        ...member,
        key,
        sortKey: `${member.area}:${member.fullId}`,
      };
    })
  );

  return new Map(
    tree.map((node) => [node.key, {
      ...node,
      subtreeGeometry: null,
      allocatedGeometry: null,
      subtreeArea: 0,
    }])
  );
}

function computeSubtreeFootprint(nodes: Map<string, TreeNode>, node: TreeNode): unknown | null {
  const childFootprints = node.childKeys.map((key) => {
    const child = nodes.get(key);
    return child ? computeSubtreeFootprint(nodes, child) : null;
  });
  const subtree = unionJstsGeometries([
    readJstsGeometry(node.geometry),
    ...childFootprints,
  ]);
  node.subtreeGeometry = subtree;
  node.subtreeArea = jstsArea(subtree);
  return subtree;
}

function allocatedSiblingOrder(nodes: Map<string, TreeNode>, childKeys: string[]): TreeNode[] {
  return childKeys
    .map((key) => nodes.get(key))
    .filter((node): node is TreeNode => Boolean(node))
    .sort((a, b) =>
      a.subtreeArea - b.subtreeArea ||
      a.fullId.localeCompare(b.fullId)
    );
}

function allocateChildren(nodes: Map<string, TreeNode>, parentKey: string | null, parentAvailable: unknown | null): void {
  const childKeys = parentKey === null
    ? [...nodes.values()].filter((node) => node.parentKey === null).map((node) => node.key)
    : nodes.get(parentKey)?.childKeys ?? [];
  let occupied: unknown | null = null;

  for (const child of allocatedSiblingOrder(nodes, childKeys)) {
    const boundedSubtree = parentAvailable
      ? intersectionJsts(child.subtreeGeometry, parentAvailable)
      : child.subtreeGeometry;
    const allocated = differenceJsts(boundedSubtree, occupied);
    child.allocatedGeometry = allocated;
    occupied = unionTwoJsts(occupied, allocated);
    allocateChildren(nodes, child.key, allocated);
  }
}

function samplingGeometryForNode(nodes: Map<string, TreeNode>, node: TreeNode): BuildingPatchGeometry | null {
  const ownAllocated = intersectionJsts(readJstsGeometry(node.geometry), node.allocatedGeometry);
  const childAllocatedMask = unionJstsGeometries(
    node.childKeys.map((key) => nodes.get(key)?.allocatedGeometry ?? null)
  );
  return toPolygonalGeometry(differenceJsts(ownAllocated, childAllocatedMask));
}

export function buildBuildingMemberTreeRanges(
  members: BuildingPatchMember[],
): BuildingMemberTreeRange[] {
  const deduped = dedupeMembers(members);
  const nodes = createNodes(deduped);

  for (const node of nodes.values()) {
    if (node.parentKey === null) computeSubtreeFootprint(nodes, node);
  }
  allocateChildren(nodes, null, null);

  const ranges: BuildingMemberTreeRange[] = [];
  for (const node of nodes.values()) {
    const samplingGeometry = samplingGeometryForNode(nodes, node);
    if (!samplingGeometry) continue;
    const parent = node.parentKey ? nodes.get(node.parentKey) : null;
    ranges.push({
      fullId: node.fullId,
      osmType: node.osmType,
      geometry: node.geometry,
      osmHeight: node.osmHeight ?? null,
      osmBuildingLevels: node.osmBuildingLevels ?? null,
      area: node.area,
      geometryKey: node.geometryKey,
      treeLevel: node.treeLevel,
      parentFullId: parent?.fullId ?? null,
      samplingGeometry,
    });
  }

  return ranges.sort((a, b) =>
    b.treeLevel - a.treeLevel ||
    a.fullId.localeCompare(b.fullId)
  );
}
