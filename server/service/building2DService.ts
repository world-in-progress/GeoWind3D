import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { Pool } from 'pg';
import { booleanIntersects } from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { multiPolygon as turfMultiPolygon, point as turfPoint, polygon as turfPolygon } from '@turf/helpers';
import type { ModelingConfig } from '../config/modelingConfig';
import type { BuildingPatch, BuildingPatchGeometry, BuildingPatchMember, BuildingOsmType } from '../types/buildingPatch';
import { writeTaskLog, type TaskLogger } from './taskService';
import type { SurfaceSampler } from '../utils/surfaceSampler';
import { approximateMetricArea, formatMs, isEmptyGeometry } from '../utils/geoUtils';
import type { TriangleRecord } from '../utils/indexedTileMesh';
import { analyzeBuildingAttachments, type BuildingAttachmentAnalysis } from '../utils/buildingAttachment';
import {
  buildPolygonContainmentTree,
  polygonGeometryArea,
  unionPolygonGeometries,
  type PolygonTreeInput,
} from '../utils/buildingMemberTree';
import excludedBuildingFullIds from '../config/excludedBuildingFullIds.json';

const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000';
const DB_NAME = process.env.POSTGRES_DB || 'citywind';
const DB_SCHEMA = process.env.POSTGRES_SCHEMA || 'public';
const DB_PORT = Number(process.env.POSTGRES_PORT || 5433);
const DB_GEOM = 'geom';
const LOCAL_BUFFER_SRID = 2326;
const MITRE_BUFFER_STYLE = 'join=mitre mitre_limit=5';
const STUDY_AREA_BUILDING_PATCH_BUFFER_M = 2;
const ALIGNMENT_PATCH_BUFFER_M = 5;
const SECTION_SCAN_PATCH_UNION_BUFFER_M = 0.1;
const BUILDING_SIMPLIFY_TOLERANCE = 0.000002;
const PATCH_TERRAIN_SAMPLE_STEP_M = 4;
const MIN_SECTION_SCAN_PATCH_AREA_M2 = 0.01;
const BUILDING_ALIGNMENT_DIR_NAME = 'alignment';
const EXCLUDED_BUILDING_FULL_IDS = Array.from(
  new Set(
    (excludedBuildingFullIds as string[])
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ),
);

export type QueriedBuildingPatch = {
  geometry: Polygon | MultiPolygon;
  memberIds: string[];
  memberCount: number;
  members: BuildingPatchMember[];
};

type ComputeOriginResponse = {
  success: boolean;
  offset_2326: [number, number];
  origin_lonlat: [number, number];
};

export type BuildingPatchBuildResult = {
  studyArea: Feature<Polygon>;
  buildingPatches: BuildingPatch[];
  boundaryBuildings: (Polygon | MultiPolygon)[];
  buildingPatchesGeojson: ReturnType<typeof buildPatchDebugGeoJson>;
  buildingPatchesGeojsonPath: string;
  origin: {
    lonlat: [number, number];
    offset_2326: [number, number];
    mercatorZScale: number;
  };
};

const pool = new Pool({
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: DB_PORT,
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: DB_NAME,
});

export type ExcludedBuildingFeatureProperties = {
  fullId: string;
};

const BUILDING_OSM_TYPES = new Set<BuildingOsmType>([
  'building',
  'building_part',
  'building_commercial',
  'building_residential',
]);

export async function queryExcludedBuildingFeatures(): Promise<
  FeatureCollection<Polygon | MultiPolygon, ExcludedBuildingFeatureProperties>
> {
  if (EXCLUDED_BUILDING_FULL_IDS.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }
  const sql = `
    WITH excluded(full_id) AS (
      SELECT unnest($1::text[])
    ),
    all_buildings AS (
      SELECT full_id, osm_type, height, "building:levels", ${DB_GEOM} AS geom
      FROM ${DB_SCHEMA}.osm_building
      WHERE ${DB_GEOM} IS NOT NULL
    ),
    matched AS (
      SELECT DISTINCT ON (b.full_id)
        b.full_id,
        ST_CollectionExtract(
          ST_MakeValid(
            CASE
              WHEN ST_SRID(b.geom) = 0 THEN ST_SetSRID(b.geom, 4326)
              ELSE b.geom
            END
          ),
          3
        ) AS geom
      FROM all_buildings b
      JOIN excluded e ON e.full_id = b.full_id
      WHERE b.geom IS NOT NULL
      ORDER BY b.full_id, b.osm_type
    )
    SELECT full_id, ST_AsGeoJSON(geom)::json AS geom
    FROM matched
    WHERE NOT ST_IsEmpty(geom)
  `;
  const result = await pool.query(sql, [EXCLUDED_BUILDING_FULL_IDS]);
  return {
    type: 'FeatureCollection',
    features: result.rows
      .map((row): Feature<Polygon | MultiPolygon, ExcludedBuildingFeatureProperties> | null => {
        const geometry = row.geom as Polygon | MultiPolygon | undefined;
        if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || isEmptyGeometry(geometry)) {
          return null;
        }
        return {
          type: 'Feature',
          properties: { fullId: String(row.full_id) },
          geometry,
        };
      })
      .filter((feature): feature is Feature<Polygon | MultiPolygon, ExcludedBuildingFeatureProperties> => Boolean(feature)),
  };
}

function parseBuildingPatchMembers(rawMembers: unknown): BuildingPatchMember[] {
  if (!Array.isArray(rawMembers)) return [];
  const members: BuildingPatchMember[] = [];
  for (const item of rawMembers) {
    if (!item || typeof item !== 'object') continue;
    const row = item as {
      fullId?: unknown;
      osmType?: unknown;
      geometry?: unknown;
      osmHeight?: unknown;
      osmBuildingLevels?: unknown;
    };
    if (typeof row.fullId !== 'string') continue;
    if (typeof row.osmType !== 'string') continue;
    if (!BUILDING_OSM_TYPES.has(row.osmType as BuildingOsmType)) continue;
    const geometry = row.geometry as Polygon | MultiPolygon | undefined;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    if (isEmptyGeometry(geometry)) continue;
    members.push({
      fullId: row.fullId,
      osmType: row.osmType as BuildingOsmType,
      geometry,
      osmHeight: row.osmHeight === null || row.osmHeight === undefined ? null : String(row.osmHeight),
      osmBuildingLevels:
        row.osmBuildingLevels === null || row.osmBuildingLevels === undefined
          ? null
          : String(row.osmBuildingLevels),
    });
  }
  return members;
}

function rowsToQueriedBuildingPatches(rows: any[]): QueriedBuildingPatch[] {
  return rows
    .map((row): QueriedBuildingPatch => ({
      geometry: row.geom,
      memberIds: Array.isArray(row.member_ids)
        ? row.member_ids.filter((id: unknown): id is string => typeof id === 'string')
        : [],
      memberCount: Number(row.member_count || 0),
      members: parseBuildingPatchMembers(row.members),
    }))
    .filter((patch) =>
      patch.geometry &&
      patch.geometry.coordinates &&
      patch.geometry.coordinates.length > 0 &&
      !isEmptyGeometry(patch.geometry)
    );
}

function bufferedUnionPatchSql(filteredCteSql: string): string {
  return `
    ${filteredCteSql},
    buffered AS (
      SELECT
        osm_type,
        full_id,
        osm_height,
        osm_building_levels,
        geom AS source_geom,
        ST_CollectionExtract(
          ST_Multi(
            ST_Transform(
              ST_Buffer(
                ST_Transform(geom, ${LOCAL_BUFFER_SRID}),
                $2,
                '${MITRE_BUFFER_STYLE}'
              ),
              4326
            )
          ),
          3
        ) AS buffered_geom
      FROM filtered
    ),
    clustered AS (
      SELECT
        osm_type,
        full_id,
        osm_height,
        osm_building_levels,
        source_geom,
        buffered_geom,
        ST_ClusterDBSCAN(buffered_geom, eps := 0, minpoints := 1) OVER () AS cluster_id
      FROM buffered
      WHERE NOT ST_IsEmpty(buffered_geom)
    ),
    merged AS (
      SELECT
        cluster_id,
        ST_CollectionExtract(
          ST_Multi(
            ST_Transform(
              ST_Buffer(
                ST_Transform(ST_UnaryUnion(ST_Collect(buffered_geom)), ${LOCAL_BUFFER_SRID}),
                -$2,
                '${MITRE_BUFFER_STYLE}'
              ),
              4326
            )
          ),
          3
        ) AS geom,
        array_agg(full_id ORDER BY full_id) AS member_ids,
        jsonb_agg(
          jsonb_build_object(
            'osmType', osm_type,
            'fullId', full_id,
            'osmHeight', osm_height,
            'osmBuildingLevels', osm_building_levels,
            'geometry', ST_AsGeoJSON(source_geom)::jsonb
          )
          ORDER BY osm_type, full_id
        ) AS members,
        count(*)::int AS member_count
      FROM clustered
      GROUP BY cluster_id
    ),
    simplified AS (
      SELECT
        cluster_id,
        member_ids,
        members,
        member_count,
        ST_SimplifyPreserveTopology(geom, $3) AS geom
      FROM merged
    )
    SELECT
      ST_AsGeoJSON(geom)::json AS geom,
      member_ids,
      members,
      member_count
    FROM simplified
    WHERE NOT ST_IsEmpty(geom)
    ORDER BY cluster_id
  `;
}

export async function clusterBuildingPatchMembersBufferedUnion(
  members: BuildingPatchMember[],
  options: {
    preUnionBufferMeters: number;
    simplifyTolerance: number;
  },
): Promise<QueriedBuildingPatch[]> {
  if (members.length === 0) return [];
  const sql = bufferedUnionPatchSql(`
    WITH input_members AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS item(
        "osmType" text,
        "fullId" text,
        "osmHeight" text,
        "osmBuildingLevels" text,
        "geometry" jsonb
      )
    ),
    filtered AS (
      SELECT
        "osmType" AS osm_type,
        "fullId" AS full_id,
        "osmHeight" AS osm_height,
        "osmBuildingLevels" AS osm_building_levels,
        ST_CollectionExtract(
          ST_MakeValid(
            ST_SetSRID(ST_GeomFromGeoJSON("geometry"::text), 4326)
          ),
          3
        ) AS geom
      FROM input_members
      WHERE
        "fullId" IS NOT NULL
        AND "osmType" IS NOT NULL
        AND "geometry" IS NOT NULL
    )
  `);
  const result = await pool.query(sql, [
    JSON.stringify(members),
    options.preUnionBufferMeters,
    options.simplifyTolerance,
  ]);
  return rowsToQueriedBuildingPatches(result.rows);
}

export async function closePatchGeometryMeters(
  geometry: Polygon | MultiPolygon,
  distanceMeters: number,
  simplifyTolerance: number,
): Promise<Polygon | MultiPolygon | null> {
  if (distanceMeters <= 0) return geometry;

  const sql = `
    WITH input AS (
      SELECT ST_CollectionExtract(
        ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)),
        3
      ) AS geom
    ),
    closed AS (
      SELECT ST_CollectionExtract(
        ST_Multi(
          ST_Buffer(
            ST_Buffer(
              geom::geography,
              $2
            )::geometry::geography,
            -$2
          )::geometry
        ),
        3
      ) AS geom
      FROM input
    ),
    simplified AS (
      SELECT ST_CollectionExtract(
        ST_Multi(
          ST_SimplifyPreserveTopology(
            ST_MakeValid(geom),
            $3
          )
        ),
        3
      ) AS geom
      FROM closed
    )
    SELECT ST_AsGeoJSON(geom)::json AS geom
    FROM simplified
    WHERE NOT ST_IsEmpty(geom)
  `;
  const result = await pool.query(sql, [JSON.stringify(geometry), distanceMeters, simplifyTolerance]);
  const closedGeometry = result.rows[0]?.geom as Polygon | MultiPolygon | undefined;
  if (
    !closedGeometry ||
    (closedGeometry.type !== 'Polygon' && closedGeometry.type !== 'MultiPolygon') ||
    isEmptyGeometry(closedGeometry)
  ) {
    return null;
  }
  return closedGeometry;
}

export async function queryBuildingsWithinBoundBufferedUnion(
  bound: Feature<Polygon>,
  options: {
    preUnionBufferMeters: number;
    simplifyTolerance: number;
  },
) {
  const sql = bufferedUnionPatchSql(`
    WITH area AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
    ),
    all_buildings AS (
      SELECT
        osm_type,
        full_id,
        ${DB_GEOM} AS geom,
        height AS osm_height,
        "building:levels" AS osm_building_levels
      FROM ${DB_SCHEMA}.osm_building
      WHERE ${DB_GEOM} IS NOT NULL
    ),
    valid_buildings AS (
      SELECT
        t.osm_type,
        t.full_id,
        t.osm_height,
        t.osm_building_levels,
        ST_CollectionExtract(
          ST_MakeValid(
            CASE
              WHEN ST_SRID(t.geom) = 0 THEN ST_SetSRID(t.geom, 4326)
              ELSE t.geom
            END
          ),
          3
        ) AS geom
      FROM all_buildings t
      WHERE t.full_id IS NULL OR t.full_id <> ALL($4::text[])
    ),
    filtered AS (
      SELECT
        b.osm_type,
        b.full_id,
        b.osm_height,
        b.osm_building_levels,
        b.geom
      FROM valid_buildings b, area
      WHERE NOT ST_IsEmpty(b.geom) AND ST_CoveredBy(b.geom, area.geom)
    )
  `);
  const result = await pool.query(sql, [
    JSON.stringify(bound.geometry),
    options.preUnionBufferMeters,
    options.simplifyTolerance,
    EXCLUDED_BUILDING_FULL_IDS,
  ]);
  return rowsToQueriedBuildingPatches(result.rows);
}

export async function bufferGeometryMitreMeters(
  geometry: Polygon | MultiPolygon,
  distanceMeters: number,
): Promise<Polygon | MultiPolygon | null> {
  const sql = `
    WITH input AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
    ),
    buffered AS (
      SELECT ST_CollectionExtract(
        ST_Multi(
          ST_Transform(
            ST_Buffer(
              ST_Transform(geom, ${LOCAL_BUFFER_SRID}),
              $2,
              '${MITRE_BUFFER_STYLE}'
            ),
            4326
          )
        ),
        3
      ) AS geom
      FROM input
    )
    SELECT ST_AsGeoJSON(geom)::json AS geom
    FROM buffered
    WHERE NOT ST_IsEmpty(geom)
  `;
  const result = await pool.query(sql, [JSON.stringify(geometry), distanceMeters]);
  const geom = result.rows[0]?.geom as Polygon | MultiPolygon | undefined;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return null;
  return geom;
}

export async function queryBuildingsOnBoundary(bound: Feature<Polygon>) {
  const sql = `
    WITH area AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
    ),
    all_buildings AS (
      SELECT ${DB_GEOM} AS geom, full_id, osm_type, height, "building:levels"
      FROM ${DB_SCHEMA}.osm_building
      WHERE ${DB_GEOM} IS NOT NULL
    ),
    valid_buildings AS (
      SELECT
        ST_CollectionExtract(
          ST_MakeValid(
            CASE
              WHEN ST_SRID(t.geom) = 0 THEN ST_SetSRID(t.geom, 4326)
              ELSE t.geom
            END
          ),
          3
        ) AS geom,
        full_id
      FROM all_buildings t
      WHERE t.full_id IS NULL OR t.full_id <> ALL($2::text[])
    )
    SELECT ST_AsGeoJSON(b.geom)::json AS geom
    FROM valid_buildings b, area
    WHERE NOT ST_IsEmpty(b.geom)
      AND ST_Intersects(b.geom, area.geom)
      AND NOT ST_CoveredBy(b.geom, area.geom)
  `;
  const result = await pool.query(sql, [JSON.stringify(bound.geometry), EXCLUDED_BUILDING_FULL_IDS]);
  return result.rows
    .map((row) => row.geom)
    .filter((g): g is Polygon | MultiPolygon =>
      g && g.coordinates && g.coordinates.length > 0 && !isEmptyGeometry(g)
    );
}

export async function adjustStudyAreaByBuildingPatches(
  bound: Feature<Polygon>,
  buildingPatches: Pick<BuildingPatch, 'geometry'>[],
  logger?: TaskLogger,
): Promise<Feature<Polygon>> {
  if (buildingPatches.length === 0) return bound;

  const sql = `
    WITH area AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
    ),
    patch_geoms AS (
      SELECT ST_CollectionExtract(
        ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(value::text), 4326)),
        3
      ) AS geom
      FROM jsonb_array_elements($2::jsonb)
    ),
    eligible_patches AS (
      SELECT ST_Transform(
        ST_Buffer(ST_Transform(p.geom, ${LOCAL_BUFFER_SRID}), $3, '${MITRE_BUFFER_STYLE}'),
        4326
      ) AS geom
      FROM patch_geoms p, area
      WHERE NOT ST_IsEmpty(p.geom)
        AND ST_Area(ST_Intersection(ST_Transform(p.geom, 2326), ST_Transform(area.geom, 2326))) > 0.01
    ),
    all_geoms AS (
      SELECT geom FROM area
      UNION ALL
      SELECT geom FROM eligible_patches
    ),
    unioned AS (
      SELECT ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(geom))), 3) AS geom
      FROM all_geoms
    ),
    dumped AS (
      SELECT (ST_Dump(geom)).geom AS geom
      FROM unioned
    )
    SELECT
      ST_AsGeoJSON(geom)::json AS geom,
      (SELECT COUNT(*) FROM eligible_patches) AS included_patch_count,
      ST_Area(ST_Transform((SELECT geom FROM area), 2326)) AS original_area,
      ST_Area(ST_Transform(geom, 2326)) AS adjusted_area
    FROM dumped
    WHERE NOT ST_IsEmpty(geom)
    ORDER BY ST_Area(ST_Transform(geom, 2326)) DESC
    LIMIT 1
  `;

  const result = await pool.query(sql, [
    JSON.stringify(bound.geometry),
    JSON.stringify(buildingPatches.map((patch) => patch.geometry)),
    STUDY_AREA_BUILDING_PATCH_BUFFER_M,
  ]);
  const geom = result.rows[0]?.geom as Polygon | undefined;
  if (!geom || geom.type !== 'Polygon' || isEmptyGeometry(geom)) {
    writeTaskLog(logger, 'warn', 'patch', 'study area adjustment failed, using current study area');
    return bound;
  }

  const includedPatchCount = Number(result.rows[0]?.included_patch_count ?? 0);
  const originalArea = Number(result.rows[0]?.original_area ?? 0);
  const adjustedArea = Number(result.rows[0]?.adjusted_area ?? originalArea);
  writeTaskLog(
    logger,
    'log',
    'patch',
    `study area adjusted by refined buildings: patches=${includedPatchCount}, ` +
    `patchBuffer=${STUDY_AREA_BUILDING_PATCH_BUFFER_M.toFixed(2)}m, ` +
    `area=${originalArea.toFixed(2)}->${adjustedArea.toFixed(2)}m2`,
  );

  return {
    type: 'Feature',
    properties: bound.properties ?? {},
    geometry: geom,
  };
}

export async function computeBuildingOrigin(
  buildingPatches: Pick<BuildingPatch, 'geometry'>[],
  logger?: TaskLogger,
): Promise<BuildingPatchBuildResult['origin']> {
  const originStart = Date.now();
  const allGeoms = buildingPatches.map((patch) => ({
    type: patch.geometry.type,
    coordinates: patch.geometry.coordinates,
  }));
  const originResp = await fetch(`${GEOMETRY_SERVICE_URL}/compute_origin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patches: allGeoms }),
  });
  if (!originResp.ok) {
    const text = await originResp.text();
    throw new Error(`compute_origin api failed: HTTP ${originResp.status}, body=${text}`);
  }
  const originResult = (await originResp.json()) as ComputeOriginResponse;
  if (!originResult.success) {
    throw new Error('compute_origin returned success=false');
  }
  const originLonLat = originResult.origin_lonlat;
  const modelLat = originLonLat[1];
  const mercatorZScale = Math.cos(modelLat * Math.PI / 180);
  writeTaskLog(
    logger,
    'log',
    'patch',
    `origin: lonlat=[${originLonLat[0].toFixed(6)}, ${originLonLat[1].toFixed(6)}], ` +
    `offset_2326=[${originResult.offset_2326[0].toFixed(2)}, ${originResult.offset_2326[1].toFixed(2)}]`
  );
  writeTaskLog(logger, 'log', 'timing', `compute_origin | elapsed=${formatMs(Date.now() - originStart)}`);
  return {
    lonlat: originLonLat as [number, number],
    offset_2326: originResult.offset_2326 as [number, number],
    mercatorZScale,
  };
}

type AlignmentMeshTriangle = {
  tileId: string;
  faceIndex: number;
  local: TriangleRecord['local'];
  geo: TriangleRecord['geo'];
};

type AlignmentRequestMember = BuildingPatchMember & {
  attachmentGroupIndex: number;
  attachmentGroupId: string;
  attachmentGroupSize: number;
  attachedMemberIds: string[];
};

type AlignmentRequestGroupTreeNode = {
  groupIndex: number;
  groupId: string;
  parentGroupIndex: number | null;
  parentGroupId: string | null;
  childGroupIndices: number[];
  childGroupIds: string[];
  treeLevel: number;
};

type AlignmentRequestPatch = {
  patchId: string;
  geometry: BuildingPatchGeometry;
  bufferedGeometry: BuildingPatchGeometry;
  groundZ: number;
  meshTriangleCountBeforeGroundFilter: number;
  meshTriangleCountAfterGroundFilter: number;
  groundFilteredTriangleCount: number;
  attachmentGroupTree: AlignmentRequestGroupTreeNode[];
  members: AlignmentRequestMember[];
  meshTriangles: AlignmentMeshTriangle[];
};

type BuildingAlignmentPipelineResponse = {
  success: boolean;
  message: string;
  scanStepMeters: number;
  patchCount: number;
  sectionSegmentCount: number;
  buildingOutputDir?: string | null;
  alignedBuildingsGeojsonPath: string | null;
};

export type BuildingPatchRefinementResult = BuildingPatchBuildResult;

type GroundFilterResult = {
  groundZ: number;
  filteredTriangles: TriangleRecord[];
  beforeCount: number;
  afterCount: number;
  removedCount: number;
};

type AlignedBuildingFeature = Feature<Polygon | MultiPolygon> & {
  properties: {
    fullId?: string;
    osmType?: BuildingPatchMember['osmType'];
  };
};

type ReorganizedPatch = QueriedBuildingPatch;

export function buildPatchDebugGeoJson(patches: BuildingPatch[]) {
  const hueStep = 137.508;
  const toColor = (index: number) => `hsl(${Math.round((index * hueStep) % 360)} 70% 48%)`;
  return {
    type: 'FeatureCollection' as const,
    features: patches.map((patch, index) => ({
      type: 'Feature' as const,
      properties: {
        patchIndex: index,
        patchId: patch.id,
        memberCount: patch.members.length,
        color: toColor(index),
      },
      geometry: patch.geometry,
    })),
  };
}

function geometryToFeature(geometry: BuildingPatchGeometry): Feature<Polygon | MultiPolygon> {
  return geometry.type === 'Polygon'
    ? turfPolygon(geometry.coordinates)
    : turfMultiPolygon(geometry.coordinates);
}

function safeIntersects(a: BuildingPatchGeometry, b: BuildingPatchGeometry): boolean {
  try {
    return booleanIntersects(geometryToFeature(a), geometryToFeature(b));
  } catch {
    return false;
  }
}

function isPointInsideGeometry(lon: number, lat: number, geometry: BuildingPatchGeometry): boolean {
  const pt = turfPoint([lon, lat]);
  try {
    if (geometry.type === 'Polygon') {
      return booleanPointInPolygon(pt, turfPolygon(geometry.coordinates));
    }
    for (const coordinates of geometry.coordinates) {
      if (booleanPointInPolygon(pt, turfPolygon(coordinates))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function readAlignedBuildingFeatures(alignedBuildingsGeojsonPath: string): AlignedBuildingFeature[] {
  const raw = JSON.parse(fs.readFileSync(alignedBuildingsGeojsonPath, 'utf8')) as FeatureCollection;
  if (!Array.isArray(raw.features)) return [];
  return raw.features.filter((feature): feature is AlignedBuildingFeature =>
    Boolean(
      feature &&
      feature.type === 'Feature' &&
      feature.geometry &&
      (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') &&
      feature.properties &&
      typeof feature.properties.fullId === 'string' &&
      typeof feature.properties.osmType === 'string',
    )
  );
}

function buildAlignedMember(
  feature: AlignedBuildingFeature,
  sourceMemberByFullId: Map<string, BuildingPatchMember>,
): BuildingPatchMember {
  const fullId = String(feature.properties.fullId);
  const osmType = feature.properties.osmType as BuildingPatchMember['osmType'];
  const sourceMember = sourceMemberByFullId.get(fullId);
  return {
    fullId,
    osmType,
    geometry: feature.geometry,
    osmHeight: sourceMember?.osmHeight ?? null,
    osmBuildingLevels: sourceMember?.osmBuildingLevels ?? null,
  };
}

async function regroupAlignedBuildingPatches(
  alignedBuildingsGeojsonPath: string,
  sourcePatches: BuildingPatch[],
  simplifyTolerance: number,
): Promise<QueriedBuildingPatch[]> {
  const sourceMemberByFullId = new Map<string, BuildingPatchMember>();
  for (const patch of sourcePatches) {
    for (const member of patch.members) {
      if (!sourceMemberByFullId.has(member.fullId)) {
        sourceMemberByFullId.set(member.fullId, member);
      }
    }
  }

  const features = readAlignedBuildingFeatures(alignedBuildingsGeojsonPath);
  const memberByFullId = new Map<string, BuildingPatchMember>();
  for (const feature of features) {
    const member = buildAlignedMember(feature, sourceMemberByFullId);
    if (!memberByFullId.has(member.fullId)) {
      memberByFullId.set(member.fullId, member);
    }
  }
  const members = Array.from(memberByFullId.values());
  return clusterBuildingPatchMembersBufferedUnion(members, {
    preUnionBufferMeters: SECTION_SCAN_PATCH_UNION_BUFFER_M,
    simplifyTolerance,
  });
}

function buildReorganizedPatches(patches: QueriedBuildingPatch[]): ReorganizedPatch[] {
  return patches.filter((patch) => patch.members.length > 0);
}

async function closeReorganizedPatchGeometries(
  patches: ReorganizedPatch[],
  simplifyTolerance: number,
): Promise<ReorganizedPatch[]> {
  const closedPatches: ReorganizedPatch[] = [];
  for (const patch of patches) {
    const closedGeometry = await closePatchGeometryMeters(
      patch.geometry,
      SECTION_SCAN_PATCH_UNION_BUFFER_M,
      simplifyTolerance,
    );
    closedPatches.push({
      ...patch,
      geometry: closedGeometry ?? patch.geometry,
    });
  }
  return closedPatches;
}

async function completeBuildingPatchRefinement(
  bound: Feature<Polygon>,
  taskDir: string,
  reorganizedBuildingPatches: ReorganizedPatch[],
  sampler: SurfaceSampler,
  _heightSource: ModelingConfig['buildingHeightSource'],
  logger?: TaskLogger,
): Promise<BuildingPatchRefinementResult> {
  if (reorganizedBuildingPatches.length === 0) {
    throw new Error('building patch refinement produced no corrected patches');
  }

  const buildingDir = path.join(taskDir, 'building');
  const buildingPatches: BuildingPatch[] = reorganizedBuildingPatches.map((patch, patchIndex) => ({
    id: `building-patch-${patchIndex}`,
    geometry: patch.geometry,
    members: patch.members.map((member) => ({ ...member })),
    baseHeights: null,
  }));
  const origin = await computeBuildingOrigin(buildingPatches, logger);
  fs.mkdirSync(buildingDir, { recursive: true });
  const buildingPatchesGeojson = buildPatchDebugGeoJson(buildingPatches);
  const buildingPatchesGeojsonPath = path.join(buildingDir, 'building_patches.geojson');
  fs.writeFileSync(buildingPatchesGeojsonPath, JSON.stringify(buildingPatchesGeojson, null, 2), 'utf8');
  writeTaskLog(logger, 'log', 'patch', `building patches geojson saved: ${buildingPatchesGeojsonPath}`);

  const adjustedBound = await adjustStudyAreaByBuildingPatches(bound, buildingPatches, logger);

  const boundaryStart = Date.now();
  const boundaryBuildings = await queryBuildingsOnBoundary(adjustedBound);
  writeTaskLog(logger, 'log', 'patch', `boundary buildings (for terrain filtering): ${boundaryBuildings.length}`);
  writeTaskLog(logger, 'log', 'timing', `boundary building query | elapsed=${formatMs(Date.now() - boundaryStart)}`);

  return {
    studyArea: adjustedBound,
    buildingPatches,
    boundaryBuildings,
    buildingPatchesGeojson,
    buildingPatchesGeojsonPath,
    origin,
  };
}

function outerRings(geometry: BuildingPatchGeometry): number[][][] {
  return geometry.type === 'Polygon'
    ? [geometry.coordinates[0]].filter((ring): ring is number[][] => Array.isArray(ring) && ring.length >= 2)
    : geometry.coordinates
      .map((poly) => poly[0])
      .filter((ring): ring is number[][] => Array.isArray(ring) && ring.length >= 2);
}

function walkRingMeters(ring: number[][], stepMeters: number): Array<[number, number]> {
  if (ring.length < 2) return [];
  const refLat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const metersPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
  const metersPerDegLat = 110540;
  const points: Array<[number, number]> = [];

  for (let i = 0; i < ring.length - 1; i++) {
    const [lon0, lat0] = ring[i];
    const [lon1, lat1] = ring[i + 1];
    const dx = (lon1 - lon0) * metersPerDegLon;
    const dy = (lat1 - lat0) * metersPerDegLat;
    const length = Math.hypot(dx, dy);
    const count = Math.max(1, Math.floor(length / stepMeters));
    for (let j = 0; j < count; j++) {
      const t = j / count;
      points.push([
        lon0 + (lon1 - lon0) * t,
        lat0 + (lat1 - lat0) * t,
      ]);
    }
  }
  return points;
}

function estimatePatchGroundZ(
  patchGeometry: BuildingPatchGeometry,
  expandedGeometry: BuildingPatchGeometry,
  sampler: SurfaceSampler,
): number {
  const samples: number[] = [];
  for (const ring of outerRings(expandedGeometry)) {
    for (const [lon, lat] of walkRingMeters(ring, PATCH_TERRAIN_SAMPLE_STEP_M)) {
      if (isPointInsideGeometry(lon, lat, patchGeometry)) {
        continue;
      }
      const z = sampler.sampleHeightAtPoint(lon, lat);
      if (z !== null && Number.isFinite(z)) {
        samples.push(z);
      }
    }
  }

  const used = samples.sort((a, b) => a - b).slice(2);
  return used.length > 0 ? used[0] : -1e9;
}

function applyGroundFilter(
  patchGeometry: BuildingPatchGeometry,
  expandedGeometry: BuildingPatchGeometry,
  triangles: TriangleRecord[],
  sampler: SurfaceSampler,
): GroundFilterResult {
  const groundZ = estimatePatchGroundZ(patchGeometry, expandedGeometry, sampler);
  const filteredTriangles = triangles.filter((tri) =>
    Math.max(tri.geo[0][2], tri.geo[1][2], tri.geo[2][2]) >= groundZ
  );
  return {
    groundZ,
    filteredTriangles,
    beforeCount: triangles.length,
    afterCount: filteredTriangles.length,
    removedCount: triangles.length - filteredTriangles.length,
  };
}

function splitQueriedPatchParts(patches: QueriedBuildingPatch[]): QueriedBuildingPatch[] {
  const result: QueriedBuildingPatch[] = [];

  for (const patch of patches) {
    if (patch.geometry.type === 'Polygon') {
      if (approximateMetricArea(patch.geometry) <= MIN_SECTION_SCAN_PATCH_AREA_M2) {
        continue;
      }
      result.push(patch);
      continue;
    }

    for (const coordinates of patch.geometry.coordinates) {
      const geometry: Polygon = {
        type: 'Polygon',
        coordinates,
      };
      if (approximateMetricArea(geometry) <= MIN_SECTION_SCAN_PATCH_AREA_M2) {
        continue;
      }
      const members = patch.members.filter((member) => safeIntersects(member.geometry, geometry));

      // Reassign source-building membership to each polygon after splitting a MultiPolygon.
      if (members.length === 0) {
        continue;
      }

      result.push({
        geometry,
        members,
        memberIds: members.map((member) => member.fullId),
        memberCount: members.length,
      });
    }
  }

  return result;
}

async function bufferPatchGeometry(
  geometry: BuildingPatchGeometry,
  distanceMeters: number = ALIGNMENT_PATCH_BUFFER_M,
): Promise<BuildingPatchGeometry | null> {
  return bufferGeometryMitreMeters(geometry, distanceMeters);
}

function buildBufferedPatchGeojson(patches: Array<{
  patch: BuildingPatch;
  bufferedGeometry: BuildingPatchGeometry;
  meshTriangleCountBeforeGroundFilter: number;
  meshTriangleCountAfterGroundFilter: number;
  groundFilteredTriangleCount: number;
  groundZ: number;
}>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: patches.map(({
      patch,
      bufferedGeometry,
      meshTriangleCountBeforeGroundFilter,
      meshTriangleCountAfterGroundFilter,
      groundFilteredTriangleCount,
      groundZ,
    }) => ({
      type: 'Feature' as const,
      properties: {
        patchId: patch.id,
        memberIds: patch.members.map((member) => member.fullId),
        memberCount: patch.members.length,
        patchUnionBufferMeters: SECTION_SCAN_PATCH_UNION_BUFFER_M,
        meshQueryBufferMeters: ALIGNMENT_PATCH_BUFFER_M,
        groundZ,
        meshTriangleCountBeforeGroundFilter,
        meshTriangleCountAfterGroundFilter,
        groundFilteredTriangleCount,
      },
      geometry: bufferedGeometry,
    })),
  };
}

function buildAlignmentPatchMembersGeojson(
  patches: BuildingPatch[],
  attachmentAnalyses: Map<string, BuildingAttachmentAnalysis>,
): FeatureCollection {
  const features: Feature[] = [];

  for (const patch of patches) {
    const analysis = attachmentAnalyses.get(patch.id);
    const memberSummaryById = new Map(analysis?.members.map((member) => [member.memberId, member]) ?? []);
    const edgeLengthByPair = new Map<string, number>();
    for (const edge of analysis?.edges ?? []) {
      edgeLengthByPair.set(`${edge.memberAId}\u0000${edge.memberBId}`, edge.sharedBoundaryLengthMeters);
      edgeLengthByPair.set(`${edge.memberBId}\u0000${edge.memberAId}`, edge.sharedBoundaryLengthMeters);
    }

    for (const member of patch.members) {
      const summary = memberSummaryById.get(member.fullId);
      const attachedMemberIds = summary?.attachedMemberIds ?? [];
      features.push({
        type: 'Feature',
        properties: {
          patchId: patch.id,
          fullId: member.fullId,
          osmType: member.osmType,
          attachmentGroupIndex: summary?.groupIndex ?? -1,
          attachmentGroupId: summary ? `${patch.id}-attachment-group-${summary.groupIndex}` : null,
          attachmentGroupSize: summary?.groupSize ?? 1,
          attachedMemberIds,
          attachedMemberCount: attachedMemberIds.length,
          attachedSharedBoundaryLengthsMeters: attachedMemberIds.map((memberId) =>
            edgeLengthByPair.get(`${member.fullId}\u0000${memberId}`) ?? 0
          ),
          patchUnionBufferMeters: SECTION_SCAN_PATCH_UNION_BUFFER_M,
        },
        geometry: member.geometry,
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function buildAlignmentRequestMembers(
  patch: BuildingPatch,
  attachmentAnalysis: BuildingAttachmentAnalysis | undefined,
): AlignmentRequestMember[] {
  const summaryByMemberId = new Map(attachmentAnalysis?.members.map((member) => [member.memberId, member]) ?? []);
  return patch.members.map((member, fallbackIndex) => {
    const summary = summaryByMemberId.get(member.fullId);
    const groupIndex = summary?.groupIndex ?? fallbackIndex;
    return {
      ...member,
      attachmentGroupIndex: groupIndex,
      attachmentGroupId: `${patch.id}-attachment-group-${groupIndex}`,
      attachmentGroupSize: summary?.groupSize ?? 1,
      attachedMemberIds: summary?.attachedMemberIds ?? [],
    };
  });
}

type GroupTreeInput = PolygonTreeInput & {
  groupIndex: number;
  groupId: string;
};

function buildAttachmentGroupTree(
  patch: BuildingPatch,
  attachmentAnalysis: BuildingAttachmentAnalysis | undefined,
): AlignmentRequestGroupTreeNode[] {
  const groups = attachmentAnalysis?.groups ?? [];
  const memberById = new Map(patch.members.map((member) => [member.fullId, member]));
  const inputs: GroupTreeInput[] = [];

  for (const group of groups) {
    const groupMembers = group.memberIds
      .map((memberId) => memberById.get(memberId))
      .filter((member): member is BuildingPatchMember => Boolean(member));
    const geometry = unionPolygonGeometries(groupMembers.map((member) => member.geometry));
    if (!geometry) continue;

    const groupId = `${patch.id}-attachment-group-${group.groupIndex}`;
    const area = polygonGeometryArea(geometry);
    if (area <= 0) continue;
    inputs.push({
      key: groupId,
      groupIndex: group.groupIndex,
      groupId,
      geometry,
      area,
      sortKey: `${area}:${groupId}`,
    });
  }

  const nodes = buildPolygonContainmentTree(inputs);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  return nodes
    .map((node) => {
      const parent = node.parentKey ? nodeByKey.get(node.parentKey) : null;
      const children = node.childKeys
        .map((key) => nodeByKey.get(key))
        .filter((child): child is typeof node => Boolean(child));
      return {
        groupIndex: node.groupIndex,
        groupId: node.groupId,
        parentGroupIndex: parent?.groupIndex ?? null,
        parentGroupId: parent?.groupId ?? null,
        childGroupIndices: children.map((child) => child.groupIndex),
        childGroupIds: children.map((child) => child.groupId),
        treeLevel: node.treeLevel,
      };
    })
    .sort((a, b) => a.treeLevel - b.treeLevel || a.groupIndex - b.groupIndex || a.groupId.localeCompare(b.groupId));
}

function toAlignmentTriangles(triangles: TriangleRecord[]): AlignmentMeshTriangle[] {
  return triangles.map((tri) => ({
    tileId: tri.tileId,
    faceIndex: tri.faceIndex,
    local: tri.local,
    geo: tri.geo,
  }));
}

function safePatchFileName(patchId: string) {
  return patchId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function postJsonWithoutTimeout<T>(urlString: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 0,
      },
      (response) => {
        response.setEncoding('utf8');
        let responseText = '';
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode}, body=${responseText}`));
            return;
          }
          try {
            resolve(JSON.parse(responseText) as T);
          } catch (error) {
            reject(new Error(`invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      },
    );

    request.on('error', (error: NodeJS.ErrnoException) => {
      const detail = error.code ? `${error.code}: ${error.message}` : error.message;
      reject(new Error(detail));
    });
    request.end(body);
  });
}

async function runPythonBuildingAlignment(
  patchInputPaths: string[],
  buildingOutputDir: string,
): Promise<BuildingAlignmentPipelineResponse> {
  const result = await postJsonWithoutTimeout<BuildingAlignmentPipelineResponse>(
    `${GEOMETRY_SERVICE_URL}/buildings/align_patches`,
    { patchInputPaths, buildingOutputDir },
  );
  if (!result.success) {
    throw new Error(`building alignment api returned success=false: ${result.message}`);
  }
  return result;
}

export async function buildRefinedBuildingPatches(
  bound: Feature<Polygon>,
  sampler: SurfaceSampler,
  taskDir: string,
  options: Pick<ModelingConfig, 'buildingHeightSource'>,
  logger?: TaskLogger,
): Promise<BuildingPatchRefinementResult> {
  const startedAt = Date.now();
  writeTaskLog(logger, 'log', 'patch', 'building patch refinement start');
  const queriedPatches = await queryBuildingsWithinBoundBufferedUnion(bound, {
    preUnionBufferMeters: SECTION_SCAN_PATCH_UNION_BUFFER_M,
    simplifyTolerance: BUILDING_SIMPLIFY_TOLERANCE,
  });
  const splitPatches = splitQueriedPatchParts(queriedPatches);
  const rawPatches: BuildingPatch[] = splitPatches.map((patch, index) => ({
    id: `building-patch-${index}`,
    geometry: patch.geometry,
    members: patch.members,
    baseHeights: null,
  }));
  const attachmentAnalyses = new Map(
    rawPatches.map((patch) => [patch.id, analyzeBuildingAttachments(patch.members)]),
  );
  if (splitPatches.length !== queriedPatches.length) {
    writeTaskLog(
      logger,
      'log',
      'alignment',
      `alignment patches split: queried=${queriedPatches.length}, polygonPatches=${splitPatches.length}`,
    );
  }
  let totalMeshTriangles = 0;

  const buildingDir = path.join(taskDir, 'building');
  const alignmentDir = path.join(buildingDir, BUILDING_ALIGNMENT_DIR_NAME);
  fs.mkdirSync(alignmentDir, { recursive: true });
  const patchInputDir = path.join(alignmentDir, 'alignment_patch_inputs');
  fs.mkdirSync(patchInputDir, { recursive: true });
  const alignmentPatchMembersGeojsonPath = path.join(alignmentDir, 'alignment_patch_members.geojson');
  fs.writeFileSync(
    alignmentPatchMembersGeojsonPath,
    JSON.stringify(buildAlignmentPatchMembersGeojson(rawPatches, attachmentAnalyses), null, 2),
    'utf8',
  );

  const patchInputPaths: string[] = [];
  const bufferedPatchFeatures: Array<{
    patch: BuildingPatch;
    bufferedGeometry: BuildingPatchGeometry;
    meshTriangleCountBeforeGroundFilter: number;
    meshTriangleCountAfterGroundFilter: number;
    groundFilteredTriangleCount: number;
    groundZ: number;
  }> = [];
  for (const patch of rawPatches) {
    const expandedGeometry = await bufferPatchGeometry(patch.geometry) ?? patch.geometry;
    const triangles = sampler.queryTrianglesByGeometry(expandedGeometry);
    const groundFilter = applyGroundFilter(patch.geometry, expandedGeometry, triangles, sampler);
    totalMeshTriangles += groundFilter.afterCount;
    bufferedPatchFeatures.push({
      patch,
      bufferedGeometry: expandedGeometry,
      meshTriangleCountBeforeGroundFilter: groundFilter.beforeCount,
      meshTriangleCountAfterGroundFilter: groundFilter.afterCount,
      groundFilteredTriangleCount: groundFilter.removedCount,
      groundZ: groundFilter.groundZ,
    });
    console.log(
      `[alignment] align patch ${patch.id}: groundZ=${groundFilter.groundZ.toFixed(2)}, ` +
      `meshTriangles=${groundFilter.afterCount}/${groundFilter.beforeCount}, ` +
      `groundFiltered=${groundFilter.removedCount}, members=${patch.members.length}`,
    );
    const requestPatch: AlignmentRequestPatch = {
      patchId: patch.id,
      geometry: patch.geometry,
      bufferedGeometry: expandedGeometry,
      groundZ: groundFilter.groundZ,
      meshTriangleCountBeforeGroundFilter: groundFilter.beforeCount,
      meshTriangleCountAfterGroundFilter: groundFilter.afterCount,
      groundFilteredTriangleCount: groundFilter.removedCount,
      attachmentGroupTree: buildAttachmentGroupTree(patch, attachmentAnalyses.get(patch.id)),
      members: buildAlignmentRequestMembers(patch, attachmentAnalyses.get(patch.id)),
      meshTriangles: toAlignmentTriangles(groundFilter.filteredTriangles),
    };
    const patchInputPath = path.join(patchInputDir, `${safePatchFileName(patch.id)}.json`);
    fs.writeFileSync(patchInputPath, JSON.stringify(requestPatch), 'utf8');
    patchInputPaths.push(patchInputPath);
  }

  const alignmentBufferedPatchesGeojsonPath = path.join(alignmentDir, 'alignment_buffered_patches.geojson');
  fs.writeFileSync(
    alignmentBufferedPatchesGeojsonPath,
    JSON.stringify(buildBufferedPatchGeojson(bufferedPatchFeatures), null, 2),
    'utf8',
  );
  console.log(`[alignment] calling Python building alignment with ${patchInputPaths.length} patch input file(s)`);
  const buildingAlignmentResponse = await runPythonBuildingAlignment(patchInputPaths, alignmentDir);
  if (!buildingAlignmentResponse.alignedBuildingsGeojsonPath) {
    throw new Error('building alignment response missing alignedBuildingsGeojsonPath');
  }
  const alignedBuildingsGeojsonPath = path.join(buildingDir, 'aligned_buildings.geojson');
  if (path.resolve(buildingAlignmentResponse.alignedBuildingsGeojsonPath) !== path.resolve(alignedBuildingsGeojsonPath)) {
    fs.copyFileSync(buildingAlignmentResponse.alignedBuildingsGeojsonPath, alignedBuildingsGeojsonPath);
    fs.unlinkSync(buildingAlignmentResponse.alignedBuildingsGeojsonPath);
  }
  const reorganizedBuildingPatches = await closeReorganizedPatchGeometries(
    buildReorganizedPatches(await regroupAlignedBuildingPatches(
      alignedBuildingsGeojsonPath,
      rawPatches,
      BUILDING_SIMPLIFY_TOLERANCE,
    )),
    BUILDING_SIMPLIFY_TOLERANCE,
  );
  console.log(
    `[alignment] aligned building patches regrouped: patches=${reorganizedBuildingPatches.length}, ` +
    `members=${reorganizedBuildingPatches.reduce((sum, patch) => sum + patch.members.length, 0)}`,
  );
  writeTaskLog(
    logger,
    'log',
    'patch',
    `building patch refinement finished: rawPatches=${rawPatches.length}, meshTriangles=${totalMeshTriangles}, ` +
    `sectionSegments=${buildingAlignmentResponse.sectionSegmentCount}, elapsed=${formatMs(Date.now() - startedAt)}`,
  );
  return completeBuildingPatchRefinement(
    bound,
    taskDir,
    reorganizedBuildingPatches,
    sampler,
    options.buildingHeightSource,
    logger,
  );
}
