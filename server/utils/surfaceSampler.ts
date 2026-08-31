import RBush from 'rbush';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { booleanIntersects } from '@turf/boolean-intersects';
import { lineString, multiPolygon, polygon } from '@turf/helpers';
import { ensureIndexedTileMesh, getTriangleRecord, LoadedIndexedTileMesh, TriangleRecord } from './indexedTileMesh';
import { getGeometryBbox } from './geoUtils';
import { getOctantLatLonBox, octantBoxToRTreeBBox } from './octantTile';

export type QueryBbox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export interface SurfaceSampler {
  sampleHeightAtPoint(lon: number, lat: number): number | null;
  queryTrianglesByGeometry(geometry: Polygon | MultiPolygon): TriangleRecord[];
  clearCache(): void;
}

type TileCatalogItem = QueryBbox & {
  tileId: string;
  objPath: string;
};

const DEFAULT_LRU_CAPACITY = 64;
const POINT_QUERY_PADDING_DEG = 1e-7;

function rayIntersectTriangleZ(
  lon: number,
  lat: number,
  tri: TriangleRecord,
): number | null {
  const [v0, v1, v2] = tri.geo;
  const [x0, y0, z0] = v0;
  const [x1, y1, z1] = v1;
  const [x2, y2, z2] = v2;

  const e1x = x1 - x0;
  const e1y = y1 - y0;
  const e2x = x2 - x0;
  const e2y = y2 - y0;
  const det = e1x * e2y - e1y * e2x;
  if (Math.abs(det) < 1e-15) return null;

  const invDet = 1 / det;
  const dx = lon - x0;
  const dy = lat - y0;
  const u = (dx * e2y - dy * e2x) * invDet;
  if (u < 0 || u > 1) return null;
  const v = (e1x * dy - e1y * dx) * invDet;
  if (v < 0 || u + v > 1) return null;

  return (1 - u - v) * z0 + u * z1 + v * z2;
}

function toQueryBbox(geometry: Polygon | MultiPolygon): QueryBbox {
  const bbox = getGeometryBbox(geometry);
  return {
    minX: bbox.minLon,
    minY: bbox.minLat,
    maxX: bbox.maxLon,
    maxY: bbox.maxLat,
  };
}

function toTurfPolygonalFeature(geometry: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return geometry.type === 'Polygon'
    ? polygon(geometry.coordinates)
    : multiPolygon(geometry.coordinates);
}

function signedArea2D(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function unique2D(points: [number, number][]): [number, number][] {
  const unique: [number, number][] = [];
  for (const point of points) {
    if (!unique.some((item) => item[0] === point[0] && item[1] === point[1])) {
      unique.push(point);
    }
  }
  return unique;
}

function triangleProjectionIntersectsGeometry(
  tri: TriangleRecord,
  geometryFeature: Feature<Polygon | MultiPolygon>,
): boolean {
  const pts = tri.geo.map((vertex) => [vertex[0], vertex[1]] as [number, number]);
  const unique = unique2D(pts);

  if (unique.length >= 3 && Math.abs(signedArea2D(unique)) > 1e-18) {
    const ring = [...pts, pts[0]];
    try {
      if (booleanIntersects(polygon([ring]), geometryFeature)) {
        return true;
      }
    } catch {
      // Degenerate projected triangles are handled by edge intersection below.
    }
  }

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (booleanIntersects(lineString([a, b]), geometryFeature)) {
      return true;
    }
  }

  return false;
}

export class LazyRTreeSurfaceSampler implements SurfaceSampler {
  private readonly tileCatalog = new RBush<TileCatalogItem>();
  private readonly tilesById = new Map<string, TileCatalogItem>();
  private readonly tileCache = new Map<string, LoadedIndexedTileMesh>();
  private readonly lruCapacity: number;

  constructor(
    objPathMap: Record<string, string>,
    private readonly transform: number[],
    options?: { lruCapacity?: number },
  ) {
    this.lruCapacity = options?.lruCapacity ?? DEFAULT_LRU_CAPACITY;

    const catalogItems: TileCatalogItem[] = [];
    for (const [tileId, objPath] of Object.entries(objPathMap)) {
      try {
        const bbox = octantBoxToRTreeBBox(getOctantLatLonBox(tileId));
        const item = { ...bbox, tileId, objPath };
        catalogItems.push(item);
        this.tilesById.set(tileId, item);
      } catch (error) {
        console.warn(`[surface-sampler] skip invalid tile id ${tileId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    this.tileCatalog.load(catalogItems);
  }

  getTileCount(): number {
    return this.tilesById.size;
  }

  getCachedTileCount(): number {
    return this.tileCache.size;
  }

  clearCache(): void {
    this.tileCache.clear();
  }

  private loadTile(tile: TileCatalogItem): LoadedIndexedTileMesh {
    const cached = this.tileCache.get(tile.tileId);
    if (cached) {
      this.tileCache.delete(tile.tileId);
      this.tileCache.set(tile.tileId, cached);
      return cached;
    }

    const loaded = ensureIndexedTileMesh(tile.tileId, tile.objPath, this.transform);
    this.tileCache.set(tile.tileId, loaded);
    while (this.tileCache.size > this.lruCapacity) {
      const oldestKey = this.tileCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.tileCache.delete(oldestKey);
    }
    return loaded;
  }

  sampleHeightAtPoint(lon: number, lat: number): number | null {
    const bbox = {
      minX: lon - POINT_QUERY_PADDING_DEG,
      minY: lat - POINT_QUERY_PADDING_DEG,
      maxX: lon + POINT_QUERY_PADDING_DEG,
      maxY: lat + POINT_QUERY_PADDING_DEG,
    };
    const tiles = this.tileCatalog.search(bbox);
    if (tiles.length === 0) return null;

    let maxZ: number | null = null;
    for (const tileItem of tiles) {
      const tile = this.loadTile(tileItem);
      const candidates = tile.rtree.search(bbox);
      for (const candidate of candidates) {
        const tri = getTriangleRecord(tile, candidate.faceIndex);
        if (!tri) continue;
        const z = rayIntersectTriangleZ(lon, lat, tri);
        if (z !== null && (maxZ === null || z > maxZ)) {
          maxZ = z;
        }
      }
    }
    return maxZ;
  }

  private queryTrianglesByBbox(bbox: QueryBbox): TriangleRecord[] {
    const results: TriangleRecord[] = [];
    const tiles = this.tileCatalog.search(bbox);
    for (const tileItem of tiles) {
      const tile = this.loadTile(tileItem);
      const candidates = tile.rtree.search(bbox);
      for (const candidate of candidates) {
        const tri = getTriangleRecord(tile, candidate.faceIndex);
        if (tri) results.push(tri);
      }
    }
    return results;
  }

  queryTrianglesByGeometry(geometry: Polygon | MultiPolygon): TriangleRecord[] {
    const bbox = toQueryBbox(geometry);
    const geometryFeature = toTurfPolygonalFeature(geometry);
    return this.queryTrianglesByBbox(bbox)
      .filter((tri) => triangleProjectionIntersectsGeometry(tri, geometryFeature));
  }
}
