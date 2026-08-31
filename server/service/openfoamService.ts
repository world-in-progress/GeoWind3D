import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeTaskLog, type TaskLogger } from './taskService';

const TEMP_DIR = process.env.TEMP_DIR || path.join(process.cwd(), 'temp');
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'template');
const BACKGROUND_CELL_SIZE_OUTER_XY_M = 90;
const BACKGROUND_CELL_SIZE_CORE_XY_M = 35;
const BACKGROUND_CELL_SIZE_LOWER_Z_M = 25;
const BACKGROUND_CELL_SIZE_MIDDLE_Z_M = 40;
const BACKGROUND_CELL_SIZE_UPPER_Z_M = 90;
const DEFAULT_TERRAIN_Z0 = 0.2;
const DEFAULT_UREF = 4;
const DEFAULT_ZREF = 10;
const DEFAULT_TURBULENCE_INTENSITY = 0.1;

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

type DomainPlanForOpenFOAM = {
  windDirectionDeg: number;
  H: number;
  modelTopZ: number;
  modelBottomZ: number;
  domainTopZ: number;
  domainBottomZ: number;
  zFlat?: number;
  alignedDomainBounds: {
    minAlong: number;
    maxAlong: number;
    minCross: number;
    maxCross: number;
  };
};

type LocalPoint = {
  x: number;
  y: number;
};

type LocalBounds = {
  minAlong: number;
  maxAlong: number;
  minCross: number;
  maxCross: number;
};

type DomainLayout = {
  windDirectionDeg: number;
  alignedDomainBounds: LocalBounds;
  domainBottomZ: number;
  domainTopZ: number;
  zGround: number;
  modelTopZ: number;
};

type NamedRefinementRegion = {
  name: string;
  level: number;
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

type NamedRotatedRefinementBox = EdgeRotatedRefinementBox & {
  name: string;
};

function parseObjBoundingBox(objPath: string, logger?: TaskLogger): BoundingBox {
  const content = fs.readFileSync(objPath, 'utf8');
  const lines = content.split('\n');

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let vertexCount = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('v ')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const z = Number(parts[3]);
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    vertexCount++;
  }

  if (vertexCount === 0) {
    throw new Error(`No vertices found in OBJ file: ${objPath}`);
  }

  writeTaskLog(
    logger,
    'log',
    'openfoam',
    `OBJ bbox: x=[${minX.toFixed(2)}, ${maxX.toFixed(2)}], ` +
      `y=[${minY.toFixed(2)}, ${maxY.toFixed(2)}], z=[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}], vertices=${vertexCount}`,
  );
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function replacePlaceholders(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

function normalizeAngleDeg(deg: number): number {
  const normalized = deg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
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

function composePoint(alongCoord: number, crossCoord: number, windDirectionDeg: number): LocalPoint {
  const { along, cross } = getFlowBasis(windDirectionDeg);
  return {
    x: along.x * alongCoord + cross.x * crossCoord,
    y: along.y * alongCoord + cross.y * crossCoord,
  };
}

function projectPoint(x: number, y: number, windDirectionDeg: number) {
  const { along, cross } = getFlowBasis(windDirectionDeg);
  return {
    along: x * along.x + y * along.y,
    cross: x * cross.x + y * cross.y,
  };
}

function projectBoundingBoxToLocal(bbox: BoundingBox, windDirectionDeg: number): LocalBounds {
  const corners = [
    projectPoint(bbox.minX, bbox.minY, windDirectionDeg),
    projectPoint(bbox.minX, bbox.maxY, windDirectionDeg),
    projectPoint(bbox.maxX, bbox.minY, windDirectionDeg),
    projectPoint(bbox.maxX, bbox.maxY, windDirectionDeg),
  ];

  return {
    minAlong: Math.min(...corners.map((point) => point.along)),
    maxAlong: Math.max(...corners.map((point) => point.along)),
    minCross: Math.min(...corners.map((point) => point.cross)),
    maxCross: Math.max(...corners.map((point) => point.cross)),
  };
}

function readDomainPlan(taskDir?: string): DomainPlanForOpenFOAM | null {
  if (!taskDir) return null;
  const domainPlanPath = path.join(taskDir, 'domain_plan.json');
  if (!fs.existsSync(domainPlanPath)) return null;
  const raw = JSON.parse(fs.readFileSync(domainPlanPath, 'utf8')) as DomainPlanForOpenFOAM;
  if (!raw.alignedDomainBounds) {
    throw new Error(`Invalid domain plan: ${domainPlanPath}`);
  }
  console.log(`[openfoam] domain plan loaded: ${domainPlanPath}`);
  return raw;
}

function isFiniteVector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function readWalkwayEdgeRotatedBoxes(taskDir?: string): NamedRotatedRefinementBox[] {
  if (!taskDir) return [];
  const refinementBoxesPath = path.join(taskDir, 'elevated_way', 'refinement_boxes.json');
  if (!fs.existsSync(refinementBoxesPath)) return [];

  const raw = JSON.parse(fs.readFileSync(refinementBoxesPath, 'utf8')) as {
    edge_rotated_boxes?: EdgeRotatedRefinementBox[];
  };
  const boxes = (raw.edge_rotated_boxes || [])
    .filter((box) =>
      Number.isFinite(box.edge_index) &&
      Number.isFinite(box.level) &&
      isFiniteVector(box.origin, 3) &&
      isFiniteVector(box.span, 3) &&
      isFiniteVector(box.e1, 3) &&
      isFiniteVector(box.e3, 3) &&
      box.span.every((value) => value > 0),
    )
    .map((box, index) => ({
      ...box,
      name: `walkwayBox${index + 1}`,
    }));
  return boxes;
}

function formatSearchableRotatedBoxes(boxes: NamedRotatedRefinementBox[]): string {
  return boxes.map((box) => `    ${box.name}
    {
        type searchableRotatedBox;
        origin (${box.origin.map((value) => value.toFixed(2)).join(' ')});
        span (${box.span.map((value) => value.toFixed(2)).join(' ')});
        e1 (${box.e1.map((value) => value.toFixed(8)).join(' ')});
        e3 (${box.e3.map((value) => value.toFixed(8)).join(' ')});
    }`).join('\n\n');
}

function formatRefinementRegions(boxes: NamedRefinementRegion[]): string {
  return boxes.map((box) => `        ${box.name}
        {
            mode inside;
            levels ((1E15 ${box.level}));
        }`).join('\n\n');
}

function buildDomainVertices(layout: DomainLayout) {
  const { alignedDomainBounds, windDirectionDeg, domainBottomZ, domainTopZ } = layout;
  const lower = [
    composePoint(alignedDomainBounds.minAlong, alignedDomainBounds.maxCross, windDirectionDeg),
    composePoint(alignedDomainBounds.maxAlong, alignedDomainBounds.maxCross, windDirectionDeg),
    composePoint(alignedDomainBounds.maxAlong, alignedDomainBounds.minCross, windDirectionDeg),
    composePoint(alignedDomainBounds.minAlong, alignedDomainBounds.minCross, windDirectionDeg),
  ];

  return [
    { x: lower[0].x, y: lower[0].y, z: domainBottomZ },
    { x: lower[1].x, y: lower[1].y, z: domainBottomZ },
    { x: lower[2].x, y: lower[2].y, z: domainBottomZ },
    { x: lower[3].x, y: lower[3].y, z: domainBottomZ },
    { x: lower[0].x, y: lower[0].y, z: domainTopZ },
    { x: lower[1].x, y: lower[1].y, z: domainTopZ },
    { x: lower[2].x, y: lower[2].y, z: domainTopZ },
    { x: lower[3].x, y: lower[3].y, z: domainTopZ },
  ];
}

function getFallbackDomainLayout(structureBbox: BoundingBox, terrainBbox?: BoundingBox): DomainLayout {
  const combined = terrainBbox
    ? {
        minX: Math.min(structureBbox.minX, terrainBbox.minX),
        maxX: Math.max(structureBbox.maxX, terrainBbox.maxX),
        minY: Math.min(structureBbox.minY, terrainBbox.minY),
        maxY: Math.max(structureBbox.maxY, terrainBbox.maxY),
        minZ: Math.min(structureBbox.minZ, terrainBbox.minZ),
        maxZ: Math.max(structureBbox.maxZ, terrainBbox.maxZ),
      }
    : { ...structureBbox };

  const H = structureBbox.maxZ - combined.minZ;
  const padH = Math.max(H * 5, 100);
  const topZ = combined.maxZ + H * 3;
  const bottomZ = terrainBbox ? Math.floor(combined.minZ - 5) : 0;
  return {
    windDirectionDeg: 0,
    alignedDomainBounds: {
      minAlong: combined.minY - padH,
      maxAlong: combined.maxY + padH,
      minCross: combined.minX - padH,
      maxCross: combined.maxX + padH,
    },
    domainBottomZ: bottomZ,
    domainTopZ: topZ,
    zGround: combined.minZ,
    modelTopZ: combined.maxZ,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function buildHorizontalBreaks(
  domainMin: number,
  domainMax: number,
  structureMin: number,
  structureMax: number,
  disturbanceHeight: number,
) {
  const domainLength = domainMax - domainMin;
  const outerMinWidth = Math.max(domainLength * 0.18, Math.min(220, Math.max(120, disturbanceHeight * 0.5)));
  const requestedCoreMin = structureMin - disturbanceHeight;
  const requestedCoreMax = structureMax + disturbanceHeight;
  const minCoreWidth = Math.max(domainLength * 0.25, Math.min(600, Math.max(180, structureMax - structureMin + disturbanceHeight)));

  let coreMin = clamp(requestedCoreMin, domainMin + outerMinWidth, domainMax - outerMinWidth - minCoreWidth);
  let coreMax = clamp(requestedCoreMax, coreMin + minCoreWidth, domainMax - outerMinWidth);

  if (coreMax - coreMin < minCoreWidth) {
    const center = (structureMin + structureMax) / 2;
    const halfWidth = minCoreWidth / 2;
    coreMin = Math.max(domainMin + outerMinWidth, center - halfWidth);
    coreMax = Math.min(domainMax - outerMinWidth, center + halfWidth);
  }

  if (!(coreMin > domainMin && coreMax < domainMax && coreMax > coreMin)) {
    const third = domainLength / 3;
    return [domainMin, domainMin + third, domainMax - third, domainMax];
  }

  return [domainMin, coreMin, coreMax, domainMax];
}

function buildVerticalBreaks(bottomZ: number, topZ: number, zGround: number, disturbanceHeight: number) {
  const domainHeight = topZ - bottomZ;
  const lowerTop = clamp(zGround + Math.max(disturbanceHeight, 120), bottomZ + domainHeight * 0.12, bottomZ + domainHeight * 0.28);
  const middleTop = clamp(
    zGround + Math.max(disturbanceHeight * 2.5, 260),
    lowerTop + domainHeight * 0.12,
    bottomZ + domainHeight * 0.6,
  );

  if (!(lowerTop > bottomZ && middleTop > lowerTop && middleTop < topZ)) {
    const lower = bottomZ + domainHeight * 0.18;
    const middle = bottomZ + domainHeight * 0.45;
    return [bottomZ, lower, middle, topZ];
  }

  return [bottomZ, lowerTop, middleTop, topZ];
}

function segmentCellCount(span: number, targetSize: number) {
  return Math.max(1, Math.round(span / targetSize));
}

function buildSegmentedBlockMesh(
  layout: DomainLayout,
  structureBbox: BoundingBox,
) {
  const localStructureBounds = projectBoundingBoxToLocal(structureBbox, layout.windDirectionDeg);
  const disturbanceHeight = Math.max(structureBbox.maxZ - layout.zGround, 1);
  const alongBreaks = buildHorizontalBreaks(
    layout.alignedDomainBounds.minAlong,
    layout.alignedDomainBounds.maxAlong,
    localStructureBounds.minAlong,
    localStructureBounds.maxAlong,
    disturbanceHeight,
  );
  const crossBreaksAsc = buildHorizontalBreaks(
    layout.alignedDomainBounds.minCross,
    layout.alignedDomainBounds.maxCross,
    localStructureBounds.minCross,
    localStructureBounds.maxCross,
    disturbanceHeight,
  );
  const crossBreaks = [crossBreaksAsc[3], crossBreaksAsc[2], crossBreaksAsc[1], crossBreaksAsc[0]];
  const zBreaks = buildVerticalBreaks(layout.domainBottomZ, layout.domainTopZ, layout.zGround, disturbanceHeight);

  const xCounts = [
    segmentCellCount(alongBreaks[1] - alongBreaks[0], BACKGROUND_CELL_SIZE_OUTER_XY_M),
    segmentCellCount(alongBreaks[2] - alongBreaks[1], BACKGROUND_CELL_SIZE_CORE_XY_M),
    segmentCellCount(alongBreaks[3] - alongBreaks[2], BACKGROUND_CELL_SIZE_OUTER_XY_M),
  ];
  const yCounts = [
    segmentCellCount(crossBreaks[0] - crossBreaks[1], BACKGROUND_CELL_SIZE_OUTER_XY_M),
    segmentCellCount(crossBreaks[1] - crossBreaks[2], BACKGROUND_CELL_SIZE_CORE_XY_M),
    segmentCellCount(crossBreaks[2] - crossBreaks[3], BACKGROUND_CELL_SIZE_OUTER_XY_M),
  ];
  const zCounts = [
    segmentCellCount(zBreaks[1] - zBreaks[0], BACKGROUND_CELL_SIZE_LOWER_Z_M),
    segmentCellCount(zBreaks[2] - zBreaks[1], BACKGROUND_CELL_SIZE_MIDDLE_Z_M),
    segmentCellCount(zBreaks[3] - zBreaks[2], BACKGROUND_CELL_SIZE_UPPER_Z_M),
  ];

  const vertices: { x: number; y: number; z: number }[] = [];
  for (let k = 0; k < zBreaks.length; k += 1) {
    for (let j = 0; j < crossBreaks.length; j += 1) {
      for (let i = 0; i < alongBreaks.length; i += 1) {
        const point = composePoint(alongBreaks[i], crossBreaks[j], layout.windDirectionDeg);
        vertices.push({ x: point.x, y: point.y, z: zBreaks[k] });
      }
    }
  }

  const indexOf = (i: number, j: number, k: number) => k * 16 + j * 4 + i;
  const blockLines: string[] = [];
  let totalCells = 0;
  for (let k = 0; k < 3; k += 1) {
    for (let j = 0; j < 3; j += 1) {
      for (let i = 0; i < 3; i += 1) {
        totalCells += xCounts[i] * yCounts[j] * zCounts[k];
        blockLines.push(
          `    hex (${indexOf(i, j, k)} ${indexOf(i + 1, j, k)} ${indexOf(i + 1, j + 1, k)} ${indexOf(i, j + 1, k)} ` +
            `${indexOf(i, j, k + 1)} ${indexOf(i + 1, j, k + 1)} ${indexOf(i + 1, j + 1, k + 1)} ${indexOf(i, j + 1, k + 1)}) ` +
            `(${xCounts[i]} ${yCounts[j]} ${zCounts[k]}) simpleGrading (1 1 1)`,
        );
      }
    }
  }

  const inletFaces: string[] = [];
  const outletFaces: string[] = [];
  const sideFaces: string[] = [];
  const topFaces: string[] = [];
  const groundFaces: string[] = [];

  for (let k = 0; k < 3; k += 1) {
    for (let j = 0; j < 3; j += 1) {
      inletFaces.push(`            (${indexOf(0, j, k)} ${indexOf(0, j + 1, k)} ${indexOf(0, j + 1, k + 1)} ${indexOf(0, j, k + 1)})`);
      outletFaces.push(
        `            (${indexOf(3, j, k)} ${indexOf(3, j, k + 1)} ${indexOf(3, j + 1, k + 1)} ${indexOf(3, j + 1, k)})`,
      );
    }
  }

  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < 3; i += 1) {
      sideFaces.push(`            (${indexOf(i, 0, k)} ${indexOf(i + 1, 0, k)} ${indexOf(i + 1, 0, k + 1)} ${indexOf(i, 0, k + 1)})`);
      sideFaces.push(
        `            (${indexOf(i, 3, k)} ${indexOf(i, 3, k + 1)} ${indexOf(i + 1, 3, k + 1)} ${indexOf(i + 1, 3, k)})`,
      );
    }
  }

  for (let j = 0; j < 3; j += 1) {
    for (let i = 0; i < 3; i += 1) {
      groundFaces.push(`            (${indexOf(i, j, 0)} ${indexOf(i + 1, j, 0)} ${indexOf(i + 1, j + 1, 0)} ${indexOf(i, j + 1, 0)})`);
      topFaces.push(`            (${indexOf(i, j, 3)} ${indexOf(i, j + 1, 3)} ${indexOf(i + 1, j + 1, 3)} ${indexOf(i + 1, j, 3)})`);
    }
  }

  const blockMeshDict = `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | Version:  v2106                                 |
|   \\\\  /    A nd           | Website:  www.openfoam.com                      |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

scale   1;

vertices
(
${vertices.map((vertex) => `    (${vertex.x.toFixed(2)} ${vertex.y.toFixed(2)} ${vertex.z.toFixed(2)})`).join('\n')}
);

blocks
(
${blockLines.join('\n')}
);

edges
(
);

boundary
(
    inlet
    {
        type patch;
        faces
        (
${inletFaces.join('\n')}
        );
    }

    outlet
    {
        type patch;
        faces
        (
${outletFaces.join('\n')}
        );
    }

    sides
    {
        type symmetry;
        faces
        (
${sideFaces.join('\n')}
        );
    }

    top
    {
        type symmetry;
        faces
        (
${topFaces.join('\n')}
        );
    }

    ground
    {
        type wall;
        faces
        (
${groundFaces.join('\n')}
        );
    }
);

mergePatchPairs
(
);


// ************************************************************************* //`;

  return {
    blockMeshDict,
    totalCells,
    alongBreaks,
    crossBreaks: [...crossBreaks].reverse(),
    zBreaks,
    xCounts,
    yCounts,
    zCounts,
  };
}

export function generateOpenFOAMCase(
  structureObjPath: string,
  terrainObjPath?: string,
  taskDir?: string,
  options?: {
    includeWalkwayRefinement?: boolean;
  },
  logger?: TaskLogger,
): { casePath: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(4).toString('hex');
  const caseName = `case_${timestamp}_${random}`;
  const casePath = path.join(TEMP_DIR, 'OpenFOAM', caseName);

  fs.cpSync(TEMPLATE_DIR, casePath, { recursive: true });
  console.log(`[openfoam] template copied to ${casePath}`);

  const triSurfaceDir = path.join(casePath, 'constant', 'triSurface');
  fs.mkdirSync(triSurfaceDir, { recursive: true });
  const destStructureObj = path.join(triSurfaceDir, 'structure.obj');
  fs.copyFileSync(structureObjPath, destStructureObj);
  console.log(`[openfoam] structure OBJ copied to ${destStructureObj}`);

  const hasTerrain = !!terrainObjPath && fs.existsSync(terrainObjPath);
  const destTerrainObj = path.join(triSurfaceDir, 'terrain.obj');
  if (hasTerrain) {
    fs.copyFileSync(terrainObjPath, destTerrainObj);
    console.log(`[openfoam] terrain OBJ copied to ${destTerrainObj}`);
  }

  const structureBbox = parseObjBoundingBox(destStructureObj, logger);
  const terrainBbox = hasTerrain ? parseObjBoundingBox(destTerrainObj, logger) : undefined;
  const domainPlan = readDomainPlan(taskDir);

  let alongLength: number;
  let crossLength: number;
  let verticalLength: number;
  let locationInMesh: { x: number; y: number; z: number };
  let zGround: number;
  let flowDir: { x: number; y: number; z: number };
  let layout: DomainLayout;

  if (domainPlan) {
    layout = {
      windDirectionDeg: domainPlan.windDirectionDeg,
      alignedDomainBounds: domainPlan.alignedDomainBounds,
      domainBottomZ: domainPlan.domainBottomZ,
      domainTopZ: domainPlan.domainTopZ,
      zGround: domainPlan.zFlat ?? domainPlan.modelBottomZ,
      modelTopZ: domainPlan.modelTopZ,
    };
    const { alignedDomainBounds } = domainPlan;
    alongLength = alignedDomainBounds.maxAlong - alignedDomainBounds.minAlong;
    crossLength = alignedDomainBounds.maxCross - alignedDomainBounds.minCross;
    verticalLength = domainPlan.domainTopZ - domainPlan.domainBottomZ;
    const inwardAlong = Math.max(10, Math.min(20, alongLength * 0.05));
    const inwardCross = Math.max(10, Math.min(20, crossLength * 0.05));
    const locationLocal = composePoint(
      alignedDomainBounds.minAlong + inwardAlong,
      alignedDomainBounds.minCross + inwardCross,
      domainPlan.windDirectionDeg,
    );
    const locationZ = Math.min(
      domainPlan.domainTopZ - 5,
      Math.max(domainPlan.modelTopZ + 5, (domainPlan.zFlat ?? domainPlan.modelBottomZ) + 20),
    );
    locationInMesh = {
      x: locationLocal.x,
      y: locationLocal.y,
      z: locationZ,
    };
    zGround = layout.zGround;
    const windRadians = (normalizeAngleDeg(domainPlan.windDirectionDeg) * Math.PI) / 180;
    flowDir = {
      x: Number(Math.sin(windRadians).toFixed(8)),
      y: Number(Math.cos(windRadians).toFixed(8)),
      z: 0,
    };
    writeTaskLog(
      logger,
      'log',
      'openfoam',
      `domain plan applied: H=${domainPlan.H.toFixed(2)}, ` +
        `wind=${domainPlan.windDirectionDeg.toFixed(1)}deg, topZ=${domainPlan.domainTopZ.toFixed(2)}, ` +
        `bottomZ=${domainPlan.domainBottomZ.toFixed(2)}`,
    );
  } else {
    layout = getFallbackDomainLayout(structureBbox, terrainBbox);
    alongLength = layout.alignedDomainBounds.maxAlong - layout.alignedDomainBounds.minAlong;
    crossLength = layout.alignedDomainBounds.maxCross - layout.alignedDomainBounds.minCross;
    verticalLength = layout.domainTopZ - layout.domainBottomZ;
    const vertices = buildDomainVertices(layout);
    locationInMesh = {
      x: vertices[0].x + Math.max(10, Math.min(20, alongLength * 0.05)),
      y: vertices[0].y + Math.max(10, Math.min(20, crossLength * 0.05)),
      z: Math.min(vertices[4].z - 5, Math.max(structureBbox.maxZ + 5, layout.zGround + 20)),
    };
    zGround = layout.zGround;
    flowDir = { x: 0, y: 1, z: 0 };
    console.warn('[openfoam] domain_plan.json not found, falling back to legacy bounding-box domain.');
  }

  const blockMesh = buildSegmentedBlockMesh(layout, structureBbox);
  const inletVelocity = {
    x: flowDir.x * DEFAULT_UREF,
    y: flowDir.y * DEFAULT_UREF,
    z: 0,
  };
  const kInlet = 1.5 * (DEFAULT_TURBULENCE_INTENSITY * DEFAULT_UREF) ** 2;
  const epsilonLengthScale = Math.max(DEFAULT_ZREF, 1);
  const epsilonInlet = (0.09 ** 0.75) * (kInlet ** 1.5) / epsilonLengthScale;

  writeTaskLog(
    logger,
    'log',
    'openfoam',
    `blockMesh lengths: along=${alongLength.toFixed(2)}m, cross=${crossLength.toFixed(2)}m, z=${verticalLength.toFixed(2)}m, ` +
      `outerXY=${BACKGROUND_CELL_SIZE_OUTER_XY_M}m, coreXY=${BACKGROUND_CELL_SIZE_CORE_XY_M}m, ` +
      `lowerZ=${BACKGROUND_CELL_SIZE_LOWER_Z_M}m, middleZ=${BACKGROUND_CELL_SIZE_MIDDLE_Z_M}m, upperZ=${BACKGROUND_CELL_SIZE_UPPER_Z_M}m, ` +
      `cells=${blockMesh.xCounts.join('/')} x ${blockMesh.yCounts.join('/')} x ${blockMesh.zCounts.join('/')}, total=${blockMesh.totalCells}`,
  );

  const includeWalkwayRefinement = options?.includeWalkwayRefinement ?? true;
  const walkwayBoxes = includeWalkwayRefinement ? readWalkwayEdgeRotatedBoxes(taskDir) : [];
  const extraGeometry = formatSearchableRotatedBoxes(walkwayBoxes);
  const extraRefinementRegions = formatRefinementRegions(walkwayBoxes);

  writeTaskLog(
    logger,
    'log',
    'openfoam',
    'downstream refinement boxes: disabled; core research-area resolution is handled by segmented blockMesh',
  );
  const vars: Record<string, string> = {
    structureObj: 'structure.obj',
    structureEMesh: 'structure.eMesh',
    terrainObj: hasTerrain ? 'terrain.obj' : 'structure.obj',
    terrainEMesh: hasTerrain ? 'terrain.eMesh' : 'structure.eMesh',
    locationInMeshX: locationInMesh.x.toFixed(2),
    locationInMeshY: locationInMesh.y.toFixed(2),
    locationInMeshZ: locationInMesh.z.toFixed(2),
    windDirX: flowDir.x.toFixed(8),
    windDirY: flowDir.y.toFixed(8),
    windDirZ: flowDir.z.toFixed(8),
    Uref: DEFAULT_UREF.toFixed(4),
    Zref: DEFAULT_ZREF.toFixed(4),
    terrainZ0: DEFAULT_TERRAIN_Z0.toFixed(4),
    zGround: zGround.toFixed(4),
    UinletX: inletVelocity.x.toFixed(8),
    UinletY: inletVelocity.y.toFixed(8),
    UinletZ: inletVelocity.z.toFixed(8),
    kInlet: kInlet.toFixed(8),
    epsilonInlet: epsilonInlet.toFixed(8),
    extraGeometry,
    extraRefinementRegions,
  };

  const configFiles = [
    path.join(casePath, '0', 'U'),
    path.join(casePath, '0', 'k'),
    path.join(casePath, '0', 'epsilon'),
    path.join(casePath, '0', 'nut'),
    path.join(casePath, '0', 'p'),
    path.join(casePath, 'constant', 'turbulenceProperties'),
    path.join(casePath, 'system', 'snappyHexMeshDict'),
    path.join(casePath, 'system', 'surfaceFeatureExtractDict'),
  ];

  for (const filePath of configFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const replaced = replacePlaceholders(content, vars);
    fs.writeFileSync(filePath, replaced, 'utf8');

    const remaining = replaced.match(/\{\{[^}]+\}\}/g);
    if (remaining) {
      writeTaskLog(
        logger,
        'warn',
        'openfoam',
        `WARNING: unreplaced placeholders in ${path.basename(filePath)}: ${remaining.join(', ')}`,
      );
    }
  }

  fs.writeFileSync(path.join(casePath, 'system', 'blockMeshDict'), blockMesh.blockMeshDict, 'utf8');
  writeTaskLog(
    logger,
    'log',
    'openfoam',
    `segmented blockMesh generated: alongBreaks=${blockMesh.alongBreaks.map((value) => value.toFixed(2)).join(',')}, ` +
      `crossBreaks=${blockMesh.crossBreaks.map((value) => value.toFixed(2)).join(',')}, ` +
      `zBreaks=${blockMesh.zBreaks.map((value) => value.toFixed(2)).join(',')}`,
  );

  writeTaskLog(
    logger,
    'log',
    'openfoam',
    `ABL config: flowDir=(${vars.windDirX}, ${vars.windDirY}, ${vars.windDirZ}), ` +
      `Uref=${vars.Uref}, Zref=${vars.Zref}, terrainZ0=${vars.terrainZ0}, zGround=${vars.zGround}`,
  );
  console.log(`[openfoam] case directory ready: ${casePath}`);
  return { casePath };
}
