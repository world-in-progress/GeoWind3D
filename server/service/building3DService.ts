import fs from 'fs';
import path from 'path';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfBuffer from '@turf/buffer';
import { multiPolygon as turfMultiPolygon, point as turfPoint, polygon as turfPolygon } from '@turf/helpers';
import type {
  BuildingPatch,
  BuildingPatchBaseHeights,
  BuildingPatchBasePlane,
  BuildingPatchGeometry,
  BuildingPatchMember,
  BuildingOsmType,
} from '../types/buildingPatch';
import type { BuildingPatchBuildResult } from './building2DService';
import {
  bufferGeometryMitreMeters,
  queryExcludedBuildingFeatures,
} from './building2DService';
import { writeTaskLog, type TaskLogger } from './taskService';
import type { SurfaceSampler } from '../utils/surfaceSampler';
import type { ModelingConfig } from '../config/modelingConfig';
import type { TriangleRecord } from '../utils/indexedTileMesh';
import { approximateMetricArea, formatMs, getGeometryBbox, getGeometryInteriorPoint } from '../utils/geoUtils';
import {
  buildBuildingMemberTreeRanges,
  dedupeBuildingMembers,
  type BuildingMemberTreeRange,
} from '../utils/buildingMemberTree';
import {
  extractRoofCandidateMeshTriangles,
  writeRoofCandidateMeshObj,
  type RoofCandidateMeshSummary,
  type RoofCandidateMeshTriangle,
} from '../utils/roofCandidateMesh';

export { queryExcludedBuildingFeatures };

const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');
const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000';
const ROOF_CANDIDATE_PATCH_BUFFER_M = 1;
const BUILDING_ROOF_DIR_NAME = 'roof';
const ROOF_CANDIDATE_PATCH_INPUT_DIR_NAME = 'roof_candidate_patch_inputs';
const OSM_FLOOR_HEIGHT_M = 3.5;
const OSM_DEFAULT_BUILDING_HEIGHT_M = 10.5;
const MIN_ROOF_ABOVE_BASE_M = 0.1;
const MODEL_ROOF_ABOVE_BASE_M = 0.5;
const COMPOUND_BASE_SLAB_THICKNESS_M = 0.1;
const REFERENCE_ROOF_SAMPLE_STEP_M = 1;
const REFERENCE_ROOF_MIN_SAMPLE_POINTS = 10;
const REFERENCE_ROOF_MIN_SAMPLE_STEP_M = 0.1;
const REFERENCE_ROOF_INNER_BUFFER_AREA_FACTOR = 0.08;
const REFERENCE_ROOF_INNER_BUFFER_MIN_M = 0.2;
const REFERENCE_ROOF_INNER_BUFFER_MAX_M = 2.0;
const REFERENCE_ROOF_INNER_BUFFER_MIN_RETAINED_RATIO = 0.4;

type ConverterModelResponse = {
  success: boolean;
  message: string;
  output_path?: string;
  watertight: boolean;
  non_manifold_edges: number;
  components: number;
  origin_lonlat?: [number, number];
  offset_2326?: [number, number];
};

type PatchRoofExtractionResponse = {
  success: boolean;
  message?: string;
  output_dir?: string | null;
  offset_2326?: [number, number] | null;
  origin_lonlat?: [number, number] | null;
  roof_plane_cluster_output_path?: string | null;
  roof_cluster_mesh_output_paths?: string[];
  roof_plane_tree_range_count?: number;
  roof_z_by_full_id?: Record<string, number>;
  unresolved_tree_ranges?: Array<{
    patch_id: string;
    patch_index?: number | null;
    full_id?: string | null;
    reason?: string | null;
  }>;
  main_cluster_sampling_ranges?: Array<{
    patch_id: string;
    patch_index?: number | null;
    full_id?: string | null;
    osm_type?: BuildingOsmType | string | null;
    tree_level?: number | null;
    geometry?: BuildingPatchGeometry | null;
    tree_range_area?: number | null;
    main_cluster_area?: number | null;
    main_cluster_area_ratio?: number | null;
  }>;
  patches?: Array<{
    patch_id: string;
    candidate_triangle_count: number;
    top_triangle_count: number;
    grid_cell_count: number;
    valid_grid_cell_count: number;
    tree_range_count?: number;
  }>;
};

type ReorganizedPatchWithTree = {
  id: string;
  geometry: BuildingPatchGeometry;
  members: BuildingPatchMember[];
  basePlane?: BuildingPatchBasePlane | null;
  treeRanges: BuildingMemberTreeRange[];
};

type RoofCandidatePatchInput = {
  schemaVersion: 1;
  patchId: string;
  patchIndex: number;
  geometry: BuildingPatchGeometry;
  bufferedGeometry: BuildingPatchGeometry;
  basePlane: BuildingPatchBasePlane | null;
  treeRanges: Array<{
    fullId: string;
    osmType: BuildingPatchMember['osmType'];
    treeLevel: number;
    parentFullId: string | null;
    memberGeometry: BuildingPatchGeometry;
    samplingGeometry: BuildingPatchGeometry;
  }>;
  meshTriangles: RoofCandidateMeshTriangle[];
  summary: RoofCandidateMeshSummary & {
    patchBufferMeters: number;
  };
};

type OsmRelativeHeight = {
  height: number;
  source: 'osm_height' | 'osm_levels' | 'osm_default';
};

type CompoundBuildingRequestItem = {
  mode: 'compound';
  patch_id: string;
  base_geometry: BuildingPatchGeometry;
  base_heights: BuildingPatchBaseHeights | null;
  base_plane: BuildingPatchBasePlane | null;
  members: {
    full_id: string;
    osm_type: BuildingOsmType;
    level: number;
    geometry: BuildingPatchGeometry;
    height: number;
    height_source?: string | null;
    osm_height?: string | null;
    osm_building_levels?: string | null;
  }[];
};

type CompoundBuildingRequestMember = CompoundBuildingRequestItem['members'][number];

type AdaptedCompoundMember = {
  patchId: string;
  fullId: string;
  osmType: BuildingOsmType;
  roofZ: number | null;
  modelRoofZ: number;
  reason: string;
};

type TreeRangeSamplingReference = {
  patchId: string;
  fullId: string;
  osmType: BuildingOsmType;
  treeLevel: number;
  geometry: BuildingPatchGeometry;
};

function safePatchFileName(patchId: string) {
  return patchId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function bufferPatchGeometry(
  geometry: BuildingPatchGeometry,
  distanceMeters: number = ROOF_CANDIDATE_PATCH_BUFFER_M,
): Promise<BuildingPatchGeometry | null> {
  return bufferGeometryMitreMeters(geometry, distanceMeters);
}

function buildTreeRangesForModeling(patches: BuildingPatch[]): ReorganizedPatchWithTree[] {
  const result: ReorganizedPatchWithTree[] = [];
  for (const patch of patches) {
    let members = dedupeBuildingMembers(patch.members);
    let treeRanges = buildBuildingMemberTreeRanges(members);

    while (members.length > treeRanges.length) {
      const rangeMemberIds = new Set(treeRanges.map((range) => range.fullId));
      const nextMembers = members.filter((member) => rangeMemberIds.has(member.fullId));
      if (nextMembers.length === members.length) break;
      members = nextMembers;
      treeRanges = buildBuildingMemberTreeRanges(members);
    }

    if (members.length === 0) continue;
    patch.members = members.map((member) => ({ ...member }));
    result.push({
      id: patch.id,
      geometry: patch.geometry,
      members: patch.members,
      basePlane: patch.basePlane ?? null,
      treeRanges,
    });
  }
  return result;
}

function buildTreeRangeGeojson(patches: ReorganizedPatchWithTree[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: patches.flatMap((patch, patchIndex) =>
      patch.treeRanges.map((range) => ({
        type: 'Feature' as const,
        properties: {
          patchIndex,
          patchId: patch.id,
          fullId: range.fullId,
          osmType: range.osmType,
          treeLevel: range.treeLevel,
          parentFullId: range.parentFullId,
          rangeArea: range.area,
        },
        geometry: range.samplingGeometry,
      }))
    ),
  };
}

function parsePositiveNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveOsmRelativeHeight(member: BuildingPatchMember): OsmRelativeHeight {
  const explicitHeight = parsePositiveNumber(member.osmHeight ?? null);
  if (explicitHeight !== null) {
    return { height: explicitHeight, source: 'osm_height' };
  }
  const levels = parsePositiveNumber(member.osmBuildingLevels ?? null);
  if (levels !== null) {
    return { height: levels * OSM_FLOOR_HEIGHT_M, source: 'osm_levels' };
  }
  return { height: OSM_DEFAULT_BUILDING_HEIGHT_M, source: 'osm_default' };
}

function applyOsmHeightsToMembers(patches: BuildingPatch[]): void {
  for (const patch of patches) {
    const baseHeightEvaluator = fitApproximateBaseHeightPlane(patch.geometry, patch.baseHeights);
    for (const member of patch.members) {
      const baseZ = memberBaseGroundMinZ(member, baseHeightEvaluator);
      if (!Number.isFinite(baseZ)) continue;
      const relativeHeight = resolveOsmRelativeHeight(member);
      member.osmRelativeHeight = relativeHeight.height;
      member.heightTerrainZ = baseZ;
      member.roofZ = baseZ + relativeHeight.height;
      member.heightSource = relativeHeight.source;
    }
  }
}

function applyRoofPlanesToMembers(
  patches: BuildingPatch[],
  roofExtractionResult: PatchRoofExtractionResponse,
): void {
  const roofByFullId = roofExtractionResult.roof_z_by_full_id ?? {};
  for (const patch of patches) {
    for (const member of patch.members) {
      const roofZ = roofByFullId[member.fullId];
      member.roofZ = typeof roofZ === 'number' && Number.isFinite(roofZ) ? roofZ : null;
      member.heightSource = member.roofZ === null ? null : 'roof_mesh';
    }
  }
}

function treeRangeKey(patchId: string, fullId: string): string {
  return `${patchId}\u0000${fullId}`;
}

function buildTreeRangeSamplingMap(
  roofPatches: ReorganizedPatchWithTree[],
): Map<string, TreeRangeSamplingReference> {
  const map = new Map<string, TreeRangeSamplingReference>();
  for (const patch of roofPatches) {
    for (const range of patch.treeRanges) {
      map.set(treeRangeKey(patch.id, range.fullId), {
        patchId: patch.id,
        fullId: range.fullId,
        osmType: range.osmType,
        treeLevel: range.treeLevel,
        geometry: range.samplingGeometry,
      });
    }
  }
  return map;
}

function isPointInsideGeometry(lon: number, lat: number, geometry: BuildingPatchGeometry): boolean {
  const pt = turfPoint([lon, lat]);
  if (geometry.type === 'Polygon') {
    return booleanPointInPolygon(pt, turfPolygon(geometry.coordinates));
  }
  return booleanPointInPolygon(pt, turfMultiPolygon(geometry.coordinates));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bufferGeometryMeters(
  geometry: BuildingPatchGeometry,
  distanceMeters: number,
): BuildingPatchGeometry | null {
  try {
    const feature = geometry.type === 'Polygon'
      ? turfPolygon(geometry.coordinates)
      : turfMultiPolygon(geometry.coordinates);
    const buffered = turfBuffer(feature, distanceMeters, { units: 'meters' });
    const bufferedGeometry = buffered?.geometry;
    if (!bufferedGeometry || (bufferedGeometry.type !== 'Polygon' && bufferedGeometry.type !== 'MultiPolygon')) {
      return null;
    }
    if (approximateMetricArea(bufferedGeometry) <= 0) {
      return null;
    }
    return bufferedGeometry;
  } catch {
    return null;
  }
}

function adaptiveInnerBufferGeometry(geometry: BuildingPatchGeometry): BuildingPatchGeometry {
  const originalArea = approximateMetricArea(geometry);
  if (!Number.isFinite(originalArea) || originalArea <= 0) {
    return geometry;
  }

  let distance = clamp(
    REFERENCE_ROOF_INNER_BUFFER_AREA_FACTOR * Math.sqrt(originalArea),
    REFERENCE_ROOF_INNER_BUFFER_MIN_M,
    REFERENCE_ROOF_INNER_BUFFER_MAX_M,
  );

  while (distance >= REFERENCE_ROOF_MIN_SAMPLE_STEP_M) {
    const buffered = bufferGeometryMeters(geometry, -distance);
    if (buffered) {
      const retainedArea = approximateMetricArea(buffered);
      if (
        Number.isFinite(retainedArea) &&
        retainedArea / originalArea >= REFERENCE_ROOF_INNER_BUFFER_MIN_RETAINED_RATIO
      ) {
        return buffered;
      }
    }
    distance /= 2;
  }

  return geometry;
}

function generateUniformInteriorSamplePoints(
  geometry: BuildingPatchGeometry,
  stepMeters = REFERENCE_ROOF_SAMPLE_STEP_M,
): [number, number][] {
  const samplingGeometry = adaptiveInnerBufferGeometry(geometry);
  const bbox = getGeometryBbox(samplingGeometry);
  if (
    !Number.isFinite(bbox.minLon) ||
    !Number.isFinite(bbox.minLat) ||
    !Number.isFinite(bbox.maxLon) ||
    !Number.isFinite(bbox.maxLat)
  ) {
    return [];
  }

  const collectPoints = (currentStepMeters: number): [number, number][] => {
    const refLat = (bbox.minLat + bbox.maxLat) / 2;
    const metersPerDegLon = Math.max(1e-9, 111320 * Math.cos(refLat * Math.PI / 180));
    const metersPerDegLat = 110540;
    const lonStep = currentStepMeters / metersPerDegLon;
    const latStep = currentStepMeters / metersPerDegLat;
    const points: [number, number][] = [];

    // Use cell centers so narrow roof ranges are sampled from their interior rather than only from edges.
    for (let lat = bbox.minLat + latStep / 2; lat <= bbox.maxLat; lat += latStep) {
      for (let lon = bbox.minLon + lonStep / 2; lon <= bbox.maxLon; lon += lonStep) {
        if (isPointInsideGeometry(lon, lat, samplingGeometry)) {
          points.push([lon, lat]);
        }
      }
    }

    return points;
  };

  let currentStepMeters = stepMeters;
  let points = collectPoints(currentStepMeters);
  while (
    points.length > 0 &&
    points.length < REFERENCE_ROOF_MIN_SAMPLE_POINTS &&
    currentStepMeters > REFERENCE_ROOF_MIN_SAMPLE_STEP_M
  ) {
    currentStepMeters = Math.max(REFERENCE_ROOF_MIN_SAMPLE_STEP_M, currentStepMeters / 2);
    const denserPoints = collectPoints(currentStepMeters);
    if (denserPoints.length <= points.length) break;
    points = denserPoints;
  }

  if (points.length === 0) {
    const fallback = getGeometryInteriorPoint(samplingGeometry) ?? getGeometryInteriorPoint(geometry);
    if (fallback && isPointInsideGeometry(fallback[0], fallback[1], geometry)) {
      points.push(fallback);
    }
  }

  return points;
}

function sampleReferenceHeightByUniformMedian(
  geometry: BuildingPatchGeometry,
  sampler: SurfaceSampler,
): {
  lon: number | null;
  lat: number | null;
  referenceRoofZ: number | null;
  status: string;
} {
  const points = generateUniformInteriorSamplePoints(geometry);
  if (points.length === 0) {
    return { lon: null, lat: null, referenceRoofZ: null, status: 'missing_sample_points' };
  }

  const sampled = points
    .map(([lon, lat]) => ({ lon, lat, z: sampler.sampleHeightAtPoint(lon, lat) }))
    .filter((sample): sample is { lon: number; lat: number; z: number } =>
      sample.z !== null && Number.isFinite(sample.z)
    );
  if (sampled.length === 0) {
    const [lon, lat] = points[0];
    return { lon, lat, referenceRoofZ: null, status: 'sample_failed' };
  }

  const referenceRoofZ = median(sampled.map((sample) => sample.z));
  if (referenceRoofZ === null || !Number.isFinite(referenceRoofZ)) {
    const [lon, lat] = points[0];
    return { lon, lat, referenceRoofZ: null, status: 'sample_failed' };
  }

  const medianSample = sampled
    .map((sample) => ({ ...sample, distance: Math.abs(sample.z - referenceRoofZ) }))
    .sort((a, b) => a.distance - b.distance)[0];

  return {
    lon: medianSample.lon,
    lat: medianSample.lat,
    referenceRoofZ,
    status: 'ok',
  };
}

function sampleTreeRangeReferenceHeight(
  range: TreeRangeSamplingReference | undefined,
  sampler: SurfaceSampler,
): {
  lon: number | null;
  lat: number | null;
  referenceRoofZ: number | null;
  status: string;
} {
  if (!range) {
    return { lon: null, lat: null, referenceRoofZ: null, status: 'missing_tree_range' };
  }
  return sampleReferenceHeightByUniformMedian(range.geometry, sampler);
}

type MainClusterReferenceSample = {
  fullId: string | null;
  referenceRoofZ: number | null;
  sampleLon: number | null;
  sampleLat: number | null;
  treeRangeArea: number | null;
  mainClusterArea: number | null;
  mainClusterAreaRatio: number | null;
  status: string;
};

function sampleMainClusterReferenceHeight(
  range: NonNullable<PatchRoofExtractionResponse['main_cluster_sampling_ranges']>[number],
  sampler: SurfaceSampler,
): MainClusterReferenceSample {
  const base = {
    fullId: range.full_id ?? null,
    treeRangeArea: typeof range.tree_range_area === 'number' && Number.isFinite(range.tree_range_area)
      ? range.tree_range_area
      : null,
    mainClusterArea: typeof range.main_cluster_area === 'number' && Number.isFinite(range.main_cluster_area)
      ? range.main_cluster_area
      : null,
    mainClusterAreaRatio: typeof range.main_cluster_area_ratio === 'number' && Number.isFinite(range.main_cluster_area_ratio)
      ? range.main_cluster_area_ratio
      : null,
  };
  const geometry = range.geometry;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    return { ...base, referenceRoofZ: null, sampleLon: null, sampleLat: null, status: 'missing_main_cluster_geometry' };
  }

  const sample = sampleReferenceHeightByUniformMedian(geometry, sampler);

  return {
    ...base,
    referenceRoofZ: sample.referenceRoofZ,
    sampleLon: sample.lon,
    sampleLat: sample.lat,
    status: sample.status,
  };
}

function sampleUnresolvedRoofMembers(
  patches: BuildingPatch[],
  samplingMap: Map<string, TreeRangeSamplingReference>,
  roofExtractionResult: PatchRoofExtractionResponse,
  sampler: SurfaceSampler,
  logger?: TaskLogger,
): void {
  const unresolvedIds = new Set((roofExtractionResult.unresolved_tree_ranges ?? []).map((range) => range.full_id));
  for (const patch of patches) {
    for (const member of patch.members) {
      if (!unresolvedIds.has(member.fullId)) continue;
      if (typeof member.roofZ === 'number' && Number.isFinite(member.roofZ) && member.roofZ > 0) continue;
      const sample = sampleTreeRangeReferenceHeight(samplingMap.get(treeRangeKey(patch.id, member.fullId)), sampler);
      if (sample.referenceRoofZ !== null && sample.referenceRoofZ > 0) {
        member.roofZ = sample.referenceRoofZ;
        member.heightSource = 'roof_fallback_median_sample';
        continue;
      }
      writeTaskLog(
        logger,
        'warn',
        'roof',
        `roof fallback height sampling failed: patchId=${patch.id}, fullId=${member.fullId}, reason=${sample.status}`,
      );
    }
  }
}

type ReferenceRoofHeightSample = {
  fullId: string;
  roofZ: number | null;
  lon: number | null;
  lat: number | null;
};

function buildReferenceRoofHeightSamples(
  patches: BuildingPatch[],
  samplingMap: Map<string, TreeRangeSamplingReference>,
  sampler: SurfaceSampler,
): ReferenceRoofHeightSample[] {
  return patches.flatMap((patch) =>
    patch.members.map((member) => {
      const range = samplingMap.get(treeRangeKey(patch.id, member.fullId));
      const sample = sampleTreeRangeReferenceHeight(range, sampler);
      return {
        fullId: member.fullId,
        roofZ: sample.referenceRoofZ,
        lon: sample.lon,
        lat: sample.lat,
      };
    })
  );
}

function buildReferenceRoofHeightPointGeojson(samples: ReferenceRoofHeightSample[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: samples
      .filter((sample) =>
        sample.roofZ !== null &&
        sample.lon !== null &&
        sample.lat !== null &&
        Number.isFinite(sample.roofZ) &&
        Number.isFinite(sample.lon) &&
        Number.isFinite(sample.lat)
      )
      .map((sample) => ({
        type: 'Feature' as const,
        properties: {
          fullId: sample.fullId,
          roofZ: sample.roofZ,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [sample.lon as number, sample.lat as number],
        },
      })),
  };
}

function writeReferenceRoofHeightOutputs(
  buildingDir: string,
  patches: BuildingPatch[],
  samplingMap: Map<string, TreeRangeSamplingReference>,
  sampler: SurfaceSampler,
): void {
  const samples = buildReferenceRoofHeightSamples(patches, samplingMap, sampler);
  const referencePath = path.join(buildingDir, 'member_height_reference.csv');
  writeCsv(
    referencePath,
    ['fullId', 'roofZ'],
    samples.map((sample) => [sample.fullId, sample.roofZ]),
  );
  const referencePointsPath = path.join(buildingDir, 'member_height_reference_points.geojson');
  fs.writeFileSync(
    referencePointsPath,
    JSON.stringify(buildReferenceRoofHeightPointGeojson(samples), null, 2),
    'utf8',
  );
  console.log(`[buildings] member height reference saved: ${referencePath}`);
}

function writeMainClusterReferenceRoofHeightOutput(
  buildingDir: string,
  roofExtractionResult: PatchRoofExtractionResponse,
  sampler: SurfaceSampler,
): void {
  const ranges = roofExtractionResult.main_cluster_sampling_ranges ?? [];
  const samples = ranges.map((range) => sampleMainClusterReferenceHeight(range, sampler));
  const referencePath = path.join(buildingDir, 'member_height_reference_main_cluster.csv');
  writeCsv(
    referencePath,
    [
      'fullId',
      'roofZ',
      'treeRangeArea',
      'mainClusterArea',
      'mainClusterAreaRatio',
      'status',
    ],
    samples.map((sample) => [
      sample.fullId,
      sample.referenceRoofZ,
      sample.treeRangeArea,
      sample.mainClusterArea,
      sample.mainClusterAreaRatio,
      sample.status,
    ]),
  );
  console.log(`[buildings] member main-cluster height reference saved: ${referencePath}`);
}

function buildRoofCandidatePatchInput(
  patch: ReorganizedPatchWithTree,
  patchIndex: number,
  bufferedGeometry: BuildingPatchGeometry,
  triangles: TriangleRecord[],
): RoofCandidatePatchInput {
  const roofCandidates = extractRoofCandidateMeshTriangles(triangles);
  return {
    schemaVersion: 1,
    patchId: patch.id,
    patchIndex,
    geometry: patch.geometry,
    bufferedGeometry,
    basePlane: patch.basePlane ?? null,
    treeRanges: patch.treeRanges.map((range) => ({
      fullId: range.fullId,
      osmType: range.osmType,
      treeLevel: range.treeLevel,
      parentFullId: range.parentFullId,
      memberGeometry: range.geometry,
      samplingGeometry: range.samplingGeometry,
    })),
    meshTriangles: roofCandidates.triangles,
    summary: {
      patchBufferMeters: ROOF_CANDIDATE_PATCH_BUFFER_M,
      ...roofCandidates.summary,
    },
  };
}

async function writeRoofCandidatePatchInputs(
  patches: ReorganizedPatchWithTree[],
  buildingDir: string,
  sampler: SurfaceSampler,
  logger?: TaskLogger,
): Promise<void> {
  const roofInputDir = path.join(buildingDir, BUILDING_ROOF_DIR_NAME, ROOF_CANDIDATE_PATCH_INPUT_DIR_NAME);
  fs.mkdirSync(roofInputDir, { recursive: true });
  const indexItems: Array<{
    patchId: string;
    patchIndex: number;
    jsonFileName: string;
    objFileName: string;
  }> = [];
  let totalCandidateTriangles = 0;

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex++) {
    const patch = patches[patchIndex];
    const bufferedGeometry = await bufferPatchGeometry(patch.geometry, ROOF_CANDIDATE_PATCH_BUFFER_M) ?? patch.geometry;
    if (bufferedGeometry === patch.geometry) {
      writeTaskLog(logger, 'warn', 'roof', `roof candidate patch ${patch.id}: 1m buffer failed, using original geometry`);
    }

    const triangles = sampler.queryTrianglesByGeometry(bufferedGeometry);
    const patchInput = buildRoofCandidatePatchInput(
      patch,
      patchIndex,
      bufferedGeometry,
      triangles,
    );
    totalCandidateTriangles += patchInput.meshTriangles.length;

    const baseFileName = safePatchFileName(patch.id);
    const jsonFileName = `${baseFileName}.json`;
    const objFileName = `${baseFileName}.obj`;
    fs.writeFileSync(path.join(roofInputDir, jsonFileName), JSON.stringify(patchInput), 'utf8');
    await writeRoofCandidateMeshObj(path.join(roofInputDir, objFileName), patchInput.meshTriangles);
    indexItems.push({ patchId: patch.id, patchIndex, jsonFileName, objFileName });
  }

  fs.writeFileSync(
    path.join(roofInputDir, 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      patchBufferMeters: ROOF_CANDIDATE_PATCH_BUFFER_M,
      patches: indexItems,
    }, null, 2),
    'utf8',
  );
  writeTaskLog(
    logger,
    'log',
    'roof',
    `roof candidate patch inputs written: patches=${patches.length}, candidates=${totalCandidateTriangles}`,
  );
}

function postJsonWithoutTimeout<T>(urlString: string, payload: unknown): Promise<T> {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? require('https') as typeof import('https') : require('http') as typeof import('http');
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}, body=${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(0);
    req.write(body);
    req.end();
  });
}

async function runPythonPatchRoofExtraction(
  buildingDir: string,
  offset2326: [number, number],
  logger?: TaskLogger,
): Promise<PatchRoofExtractionResponse> {
  const startedAt = Date.now();
  writeTaskLog(logger, 'log', 'roof', 'calling Python patch roof top extraction');
  const result = await postJsonWithoutTimeout<PatchRoofExtractionResponse>(
    `${GEOMETRY_SERVICE_URL}/buildings/extract_patch_roofs`,
    { input_dir: buildingDir, offset_2326: offset2326 },
  );
  if (!result.success) {
    throw new Error(`patch roof extraction api returned success=false: ${result.message}`);
  }

  const patches = result.patches ?? [];
  const candidateTriangleCount = patches.reduce((sum, patch) => sum + patch.candidate_triangle_count, 0);
  const topTriangleCount = patches.reduce((sum, patch) => sum + patch.top_triangle_count, 0);
  const roofPlaneTreeRangeCount = result.roof_plane_tree_range_count ??
    patches.reduce((sum, patch) => sum + (patch.tree_range_count ?? 0), 0);
  const roofHeightCount = Object.keys(result.roof_z_by_full_id ?? {}).length;
  const unresolvedCount = result.unresolved_tree_ranges?.length ?? 0;
  writeTaskLog(
    logger,
    'log',
    'roof',
    `patch roof top extraction finished: patches=${patches.length}, ` +
      `topTriangles=${topTriangleCount}/${candidateTriangleCount}, ` +
      `roofHeights=${roofHeightCount}/${roofPlaneTreeRangeCount}, ` +
      `unresolved=${unresolvedCount}, ` +
      `elapsed=${formatMs(Date.now() - startedAt)}`,
  );
  return result;
}

async function applyRoofAttributionForModeling(
  patchBuildResult: BuildingPatchBuildResult,
  sampler: SurfaceSampler,
  taskDir: string,
  heightSource: ModelingConfig['buildingHeightSource'],
  logger?: TaskLogger,
): Promise<string[]> {
  const buildingDir = path.join(taskDir, 'building');
  fs.mkdirSync(buildingDir, { recursive: true });
  const roofPatches = buildTreeRangesForModeling(patchBuildResult.buildingPatches);
  const treeRangeSamplingMap = buildTreeRangeSamplingMap(roofPatches);
  const treeRangesGeojsonPath = path.join(buildingDir, 'tree_ranges.geojson');
  fs.writeFileSync(treeRangesGeojsonPath, JSON.stringify(buildTreeRangeGeojson(roofPatches), null, 2), 'utf8');

  if (heightSource === 'osm') {
    applyOsmHeightsToMembers(patchBuildResult.buildingPatches);
    writeReferenceRoofHeightOutputs(buildingDir, patchBuildResult.buildingPatches, treeRangeSamplingMap, sampler);
    writeTaskLog(logger, 'log', 'height', 'building height source: OSM attributes; roof mesh extraction skipped');
    return [];
  }

  await writeRoofCandidatePatchInputs(roofPatches, buildingDir, sampler, logger);
  const roofExtractionResult = await runPythonPatchRoofExtraction(buildingDir, patchBuildResult.origin.offset_2326, logger);
  applyRoofPlanesToMembers(patchBuildResult.buildingPatches, roofExtractionResult);
  sampleUnresolvedRoofMembers(patchBuildResult.buildingPatches, treeRangeSamplingMap, roofExtractionResult, sampler, logger);
  writeReferenceRoofHeightOutputs(buildingDir, patchBuildResult.buildingPatches, treeRangeSamplingMap, sampler);
  writeMainClusterReferenceRoofHeightOutput(buildingDir, roofExtractionResult, sampler);
  writeTaskLog(logger, 'log', 'height', 'building height source: roof mesh clusters');
  return roofExtractionResult.roof_cluster_mesh_output_paths ?? [];
}

function collectGeometryVertices(geometry: BuildingPatchGeometry): [number, number][] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const vertices: [number, number][] = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const end = ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1
        : ring.length;
      for (let i = 0; i < end; i++) {
        vertices.push([ring[i][0], ring[i][1]]);
      }
    }
  }
  return vertices;
}

function fitApproximateBaseHeightPlane(
  geometry: BuildingPatchGeometry,
  baseHeights: BuildingPatchBaseHeights | null,
): ((lon: number, lat: number) => number) | null {
  if (!baseHeights) return null;
  const samples: Array<[number, number, number]> = [];
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (let polyIndex = 0; polyIndex < polygons.length; polyIndex++) {
    const polygon = polygons[polyIndex];
    const polyBase = baseHeights[polyIndex];
    if (!polyBase) continue;
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex];
      const ringBase = polyBase[ringIndex];
      if (!ringBase) continue;
      const count = Math.min(
        ringBase.length,
        ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
          ? ring.length - 1
          : ring.length,
      );
      for (let i = 0; i < count; i++) {
        const z = ringBase[i];
        if (Number.isFinite(z)) samples.push([ring[i][0], ring[i][1], z]);
      }
    }
  }
  if (samples.length < 3) return null;

  const lon0 = samples.reduce((sum, item) => sum + item[0], 0) / samples.length;
  const lat0 = samples.reduce((sum, item) => sum + item[1], 0) / samples.length;
  const mPerDegLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const mPerDegLat = 110540;
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0;
  let sxz = 0, syz = 0, sz = 0;
  for (const [lon, lat, z] of samples) {
    const x = (lon - lon0) * mPerDegLon;
    const y = (lat - lat0) * mPerDegLat;
    sxx += x * x; sxy += x * y; sx += x;
    syy += y * y; sy += y; n += 1;
    sxz += x * z; syz += y * z; sz += z;
  }

  const det =
    sxx * (syy * n - sy * sy) -
    sxy * (sxy * n - sy * sx) +
    sx * (sxy * sy - syy * sx);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;

  const detA =
    sxz * (syy * n - sy * sy) -
    sxy * (syz * n - sy * sz) +
    sx * (syz * sy - syy * sz);
  const detB =
    sxx * (syz * n - sy * sz) -
    sxz * (sxy * n - sy * sx) +
    sx * (sxy * sz - syz * sx);
  const detC =
    sxx * (syy * sz - syz * sy) -
    sxy * (sxy * sz - syz * sx) +
    sxz * (sxy * sy - syy * sx);
  const a = detA / det;
  const b = detB / det;
  const c = detC / det;
  if (![a, b, c].every(Number.isFinite)) return null;
  return (lon, lat) => a * ((lon - lon0) * mPerDegLon) + b * ((lat - lat0) * mPerDegLat) + c;
}

function memberBaseTopMaxZ(
  member: BuildingPatchMember,
  evaluator: ((lon: number, lat: number) => number) | null,
): number {
  const vertices = collectGeometryVertices(member.geometry);
  if (!evaluator || vertices.length === 0) return COMPOUND_BASE_SLAB_THICKNESS_M;
  const values = vertices
    .map(([lon, lat]) => evaluator(lon, lat) + COMPOUND_BASE_SLAB_THICKNESS_M)
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : COMPOUND_BASE_SLAB_THICKNESS_M;
}

function memberBaseGroundMinZ(
  member: BuildingPatchMember,
  evaluator: ((lon: number, lat: number) => number) | null,
): number {
  const vertices = collectGeometryVertices(member.geometry);
  if (!evaluator || vertices.length === 0) return 0;
  const values = vertices
    .map(([lon, lat]) => evaluator(lon, lat))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : 0;
}

function buildRoofAttributedCompoundBuildingRequestItems(
  patches: BuildingPatch[],
): {
  items: CompoundBuildingRequestItem[];
  adaptedMembers: AdaptedCompoundMember[];
  skippedPatchIds: string[];
} {
  const items: CompoundBuildingRequestItem[] = [];
  const adaptedMembers: AdaptedCompoundMember[] = [];
  const skippedPatchIds: string[] = [];

  for (const patch of patches) {
    const baseHeightEvaluator = fitApproximateBaseHeightPlane(patch.geometry, patch.baseHeights);
    const members: CompoundBuildingRequestMember[] = [];
    for (const member of patch.members) {
      const localBaseTopMaxZ = memberBaseTopMaxZ(member, baseHeightEvaluator);
      const minRoofZ = localBaseTopMaxZ + MIN_ROOF_ABOVE_BASE_M;
      const fallbackModelRoofZ = localBaseTopMaxZ + MODEL_ROOF_ABOVE_BASE_M;
      const roofZ = member.roofZ;
      const hasValidRoofZ = typeof roofZ === 'number' && Number.isFinite(roofZ) && roofZ > 0;
      let modelRoofZ = hasValidRoofZ ? roofZ : fallbackModelRoofZ;
      let adaptedReason: string | null = null;

      if (!hasValidRoofZ) {
        adaptedReason = 'invalid_roof_z';
      } else if (roofZ <= minRoofZ) {
        modelRoofZ = fallbackModelRoofZ;
        adaptedReason = 'roof_z_not_above_terrain_base';
      }

      if (!Number.isFinite(modelRoofZ) || modelRoofZ <= 0) {
        adaptedMembers.push({
          patchId: patch.id,
          fullId: member.fullId,
          osmType: member.osmType,
          roofZ: hasValidRoofZ ? roofZ : null,
          modelRoofZ,
          reason: adaptedReason ?? 'invalid_model_roof_z',
        });
        continue;
      }

      if (adaptedReason) {
        adaptedMembers.push({
          patchId: patch.id,
          fullId: member.fullId,
          osmType: member.osmType,
          roofZ: hasValidRoofZ ? roofZ : null,
          modelRoofZ,
          reason: adaptedReason,
        });
      }

      members.push({
        full_id: member.fullId,
        osm_type: member.osmType,
        level: 0,
        geometry: member.geometry,
        height: modelRoofZ,
        height_source: member.heightSource ?? null,
        osm_height: member.osmHeight ?? null,
        osm_building_levels: member.osmBuildingLevels ?? null,
      });
    }

    if (members.length === 0) {
      skippedPatchIds.push(patch.id);
      continue;
    }

    items.push({
      mode: 'compound',
      patch_id: patch.id,
      base_geometry: patch.geometry,
      base_heights: patch.baseHeights,
      base_plane: patch.basePlane ?? null,
      members,
    });
  }

  return { items, adaptedMembers, skippedPatchIds };
}

export function applyBaseHeightsToPatches(
  buildingPatches: BuildingPatch[],
  buildingBaseHeights: number[][][][] | null | undefined,
  buildingBasePlanes?: BuildingPatchBasePlane[] | null,
): void {
  if (!buildingBaseHeights && !buildingBasePlanes) return;

  if (buildingBaseHeights && buildingBaseHeights.length !== buildingPatches.length) {
    console.warn(
      `[patch] building_base_heights count mismatch: patches=${buildingPatches.length}, ` +
      `base_heights=${buildingBaseHeights.length}`
    );
  }
  if (buildingBasePlanes && buildingBasePlanes.length !== buildingPatches.length) {
    console.warn(
      `[patch] building_base_planes count mismatch: patches=${buildingPatches.length}, ` +
      `base_planes=${buildingBasePlanes.length}`
    );
  }

  for (let i = 0; i < buildingPatches.length; i++) {
    if (buildingBaseHeights) {
      buildingPatches[i].baseHeights = (buildingBaseHeights[i] as BuildingPatchBaseHeights | undefined) ?? null;
    }
    if (buildingBasePlanes) {
      buildingPatches[i].basePlane = (buildingBasePlanes[i] as BuildingPatchBasePlane | undefined) ?? null;
    }
  }
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath: string, headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const content = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ].join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function buildRoofHeightRows(
  patches: BuildingPatch[],
): Array<[string, string, BuildingOsmType, number | null, string]> {
  return patches.flatMap((patch) =>
    patch.members.map((member) => [
      patch.id,
      member.fullId,
      member.osmType,
      member.roofZ ?? null,
      member.heightSource ?? 'unknown',
    ] as [string, string, BuildingOsmType, number | null, string])
  );
}

function createBuildingObjPath(taskDir: string): string {
  const buildingDir = path.join(taskDir, 'building');
  fs.mkdirSync(buildingDir, { recursive: true });
  return path.join(buildingDir, 'building.obj');
}

export async function runBuildingModeling(
  patchBuildResult: BuildingPatchBuildResult,
  sampler: SurfaceSampler,
  taskDir: string,
  options: Pick<ModelingConfig, 'buildingHeightSource'>,
  logger?: TaskLogger,
) {
  writeTaskLog(logger, 'log', 'model', 'building modeling start');
  const totalStart = Date.now();

  const { buildingPatches, origin } = patchBuildResult;
  const outObjPath = createBuildingObjPath(taskDir);
  const roofClusterMeshOutputPaths = await applyRoofAttributionForModeling(
    patchBuildResult,
    sampler,
    taskDir,
    options.buildingHeightSource,
    logger,
  );

  const attributedMemberCount = buildingPatches.reduce(
    (sum, patch) => sum + patch.members.filter((member) =>
      typeof member.roofZ === 'number' && Number.isFinite(member.roofZ)
    ).length,
    0,
  );
  const totalMemberCount = buildingPatches.reduce((sum, patch) => sum + patch.members.length, 0);
  writeTaskLog(
    logger,
    'log',
    'height',
    `member heights attributed in memory: members=${attributedMemberCount}/${totalMemberCount}`,
  );

  const { items, adaptedMembers, skippedPatchIds } = buildRoofAttributedCompoundBuildingRequestItems(buildingPatches);
  const compoundPatches = items;
  for (const adapted of adaptedMembers) {
    console.warn(
      `adapt building member roof for extrusion: patchId=${adapted.patchId}, fullId=${adapted.fullId}, ` +
      `osmType=${adapted.osmType}, roofZ=${adapted.roofZ ?? 'null'}, ` +
      `modelRoofZ=${Number.isFinite(adapted.modelRoofZ) ? adapted.modelRoofZ.toFixed(2) : adapted.modelRoofZ}, ` +
      `reason=${adapted.reason}`,
    );
  }
  for (const patchId of skippedPatchIds) {
    writeTaskLog(logger, 'warn', 'model', `skip building patch with no valid roof-attributed members: patchId=${patchId}`);
  }
  if (compoundPatches.length === 0) {
    throw new Error('No valid roof-attributed compound building patches for modeling.');
  }
  writeTaskLog(
    logger,
    'log',
    'model',
    `roof-attributed compound building input ready: compound_patches=${compoundPatches.length}, ` +
    `adaptedMembers=${adaptedMembers.length}, skippedPatches=${skippedPatchIds.length}`,
  );

  const buildingDir = path.join(taskDir, 'building');
  fs.mkdirSync(buildingDir, { recursive: true });
  const roofHeightResultsPath = path.join(buildingDir, 'member_height_results.csv');
  writeCsv(
    roofHeightResultsPath,
    ['patch_id', 'full_id', 'osm_type', 'roof_z', 'height_source'],
    buildRoofHeightRows(buildingPatches)
  );
  console.log(`[buildings] member height results saved: ${roofHeightResultsPath}`);

  console.log(
    `[buildings] calling python building modeling service (${compoundPatches.length} compound patch(es))...`
  );
  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/buildings/extrude_model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      output_path: outObjPath,
      compound_patches: compoundPatches,
      offset_2326: origin.offset_2326,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`building modeling api failed: HTTP ${resp.status}, body=${text}`);
  }

  const converterResult = (await resp.json()) as ConverterModelResponse;
  if (!converterResult.success) {
    throw new Error(`building modeling failed: ${converterResult.message}`);
  }

  console.log(`[timing] python building modeling | elapsed=${formatMs(Date.now() - totalStart)}`);
  writeTaskLog(
    logger,
    'log',
    'quality',
    `watertight=${converterResult.watertight}, non_manifold_edges=${converterResult.non_manifold_edges}, components=${converterResult.components}`
  );

  const tempRoot = path.resolve(TEMP_DIR);
  const relativePath = path.relative(tempRoot, outObjPath).replace(/\\/g, '/');
  const modelUrl = `/outputs/${relativePath}`;
  return {
    building: {
      objUrl: modelUrl,
      placement: {
        coords: origin.lonlat,
        rotation: { x: 0, y: 0, z: 180 },
        scale: 1,
        mercatorZScale: origin.mercatorZScale,
        anchor: 'none',
      },
      localCRS: 'epsg2326-local-offset',
      upAxis: 'Z',
    },
    quality: {
      watertight: converterResult.watertight,
      nonManifoldEdges: converterResult.non_manifold_edges,
      components: converterResult.components
    },
    buildingObjPath: outObjPath,
    roofClusterMeshOutputPaths,
  };
}
