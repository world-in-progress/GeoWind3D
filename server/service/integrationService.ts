/**
 * Model-topology integration service.
 *
 * Calls the Python /integration/structure endpoint to Boolean-union watertight
 * building and corridor models into structure.obj for later terrain integration.
 *
 * The OBJ is an intermediate geometry artifact and is not displayed by the frontend.
 */

import fs from 'fs';
import path from 'path';
import { formatMs } from '../utils/geoUtils';
import { writeTaskLog, type TaskLogger } from './taskService';

const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000';
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');

type StructureUnionResponse = {
  success: boolean;
  message: string;
  output_path?: string;
  building_components: number;
  corridor_components: number;
  vertex_count: number;
  triangle_count: number;
  watertight: boolean;
  non_manifold_edges: number;
};

export type StructureUnionResult = {
  objPath: string;
  objUrl: string;
  buildingComponents: number;
  corridorComponents: number;
  vertexCount: number;
  triangleCount: number;
  watertight: boolean;
  nonManifoldEdges: number;
};

/**
 * Boolean-union building.obj and corridor.obj through the Python service.
 * corridorObjPath may be null when the study area contains no corridor output.
 */
export async function runStructureUnion(
  buildingObjPath: string,
  corridorObjPath: string | null,
  taskDir: string,
  logger?: TaskLogger,
): Promise<StructureUnionResult> {
  writeTaskLog(logger, 'log', 'integration', 'structure union start');
  const totalStart = Date.now();

  const integrationDir = path.join(taskDir, 'integration');
  fs.mkdirSync(integrationDir, { recursive: true });
  const outputPath = path.join(integrationDir, 'structure.obj');

  // When no corridor OBJ exists, the Python side splits and unions only the
  // building components, which is equivalent to merging overlapping buildings.
  const corridorExists = corridorObjPath !== null && fs.existsSync(corridorObjPath);
  if (corridorObjPath && !corridorExists) {
    console.warn(
      `[integration] corridor obj missing: ${corridorObjPath}, proceeding with buildings only`,
    );
  }

  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/integration/structure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      building_path: buildingObjPath,
      corridor_path: corridorExists ? corridorObjPath : null,
      output_path: outputPath,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`structure union api failed: HTTP ${resp.status}, body=${text}`);
  }

  const result = (await resp.json()) as StructureUnionResponse;
  if (!result.success) {
    throw new Error(`structure union failed: ${result.message}`);
  }

  writeTaskLog(
    logger,
    'log',
    'integration',
    `structure union done: building_components=${result.building_components}, ` +
    `corridor_components=${result.corridor_components}, ` +
    `verts=${result.vertex_count}, tris=${result.triangle_count}, ` +
    `watertight=${result.watertight}, non_manifold_edges=${result.non_manifold_edges}`,
  );
  writeTaskLog(logger, 'log', 'timing', `structure union | elapsed=${formatMs(Date.now() - totalStart)}`);

  const tempRoot = path.resolve(TEMP_DIR);
  const relativePath = path.relative(tempRoot, outputPath).replace(/\\/g, '/');

  return {
    objPath: outputPath,
    objUrl: `/outputs/${relativePath}`,
    buildingComponents: result.building_components,
    corridorComponents: result.corridor_components,
    vertexCount: result.vertex_count,
    triangleCount: result.triangle_count,
    watertight: result.watertight,
    nonManifoldEdges: result.non_manifold_edges,
  };
}
