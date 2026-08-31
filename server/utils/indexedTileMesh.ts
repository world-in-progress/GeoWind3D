import fs from 'fs';
import path from 'path';
import RBush from 'rbush';
import { getBoxCenter } from './transform2latlon';

const INDEX_VERSION = 1;
const MAGIC = Buffer.from('GWMESH1\0', 'ascii');
const HEADER_BYTES = 20;
const VERTEX_BYTES = 6 * 8;
const FACE_BYTES = 3 * 4;

export type RTreeTriangleItem = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  faceIndex: number;
};

export type LoadedIndexedTileMesh = {
  tileId: string;
  localVertices: Float64Array;
  geoVertices: Float64Array;
  faces: Uint32Array;
  rtree: RBush<RTreeTriangleItem>;
};

export type TriangleRecord = {
  tileId: string;
  faceIndex: number;
  local: [[number, number, number], [number, number, number], [number, number, number]];
  geo: [[number, number, number], [number, number, number], [number, number, number]];
};

function meshBinPath(tileDir: string, tileId: string) {
  return path.join(tileDir, `${tileId}.mesh.v${INDEX_VERSION}.bin`);
}

function rtreeJsonPath(tileDir: string, tileId: string) {
  return path.join(tileDir, `${tileId}.rtree.v${INDEX_VERSION}.json`);
}

export function getIndexedTilePaths(tileDir: string, tileId: string) {
  return {
    meshPath: meshBinPath(tileDir, tileId),
    rtreePath: rtreeJsonPath(tileDir, tileId),
  };
}

function parseFaceVertexIndex(token: string, vertexCount: number): number | null {
  const raw = Number(token.split('/')[0]);
  if (!Number.isInteger(raw) || raw === 0) return null;
  const index = raw > 0 ? raw - 1 : vertexCount + raw;
  return index >= 0 && index < vertexCount ? index : null;
}

function parseObjToMeshArrays(objPath: string, transform: number[]) {
  const localVertices: number[] = [];
  const geoVertices: number[] = [];
  const faces: number[] = [];
  const content = fs.readFileSync(objPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

      localVertices.push(x, y, z);
      const geo = getBoxCenter(transform, [x, y, z], true);
      geoVertices.push(geo[0], geo[1], geo[2]);
      continue;
    }

    if (!line.startsWith('f ')) continue;
    const tokens = line.split(/\s+/).slice(1);
    const indices = tokens.map((token) => parseFaceVertexIndex(token, localVertices.length / 3));
    if (indices.length < 3 || indices.some((index) => index === null)) continue;

    const face = indices as number[];
    for (let i = 1; i < face.length - 1; i++) {
      faces.push(face[0], face[i], face[i + 1]);
    }
  }

  return {
    localVertices: Float64Array.from(localVertices),
    geoVertices: Float64Array.from(geoVertices),
    faces: Uint32Array.from(faces),
  };
}

function createRTreeItems(geoVertices: Float64Array, faces: Uint32Array): RTreeTriangleItem[] {
  const items: RTreeTriangleItem[] = [];
  const faceCount = faces.length / 3;
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
    const ia = faces[faceIndex * 3] * 3;
    const ib = faces[faceIndex * 3 + 1] * 3;
    const ic = faces[faceIndex * 3 + 2] * 3;
    const x0 = geoVertices[ia];
    const y0 = geoVertices[ia + 1];
    const x1 = geoVertices[ib];
    const y1 = geoVertices[ib + 1];
    const x2 = geoVertices[ic];
    const y2 = geoVertices[ic + 1];
    items.push({
      minX: Math.min(x0, x1, x2),
      minY: Math.min(y0, y1, y2),
      maxX: Math.max(x0, x1, x2),
      maxY: Math.max(y0, y1, y2),
      faceIndex,
    });
  }
  return items;
}

function writeMeshBin(filePath: string, localVertices: Float64Array, geoVertices: Float64Array, faces: Uint32Array) {
  const vertexCount = localVertices.length / 3;
  const faceCount = faces.length / 3;
  const totalBytes = HEADER_BYTES + vertexCount * VERTEX_BYTES + faceCount * FACE_BYTES;
  const buffer = Buffer.allocUnsafe(totalBytes);

  MAGIC.copy(buffer, 0);
  buffer.writeUInt32LE(INDEX_VERSION, 8);
  buffer.writeUInt32LE(vertexCount, 12);
  buffer.writeUInt32LE(faceCount, 16);

  let offset = HEADER_BYTES;
  for (let i = 0; i < vertexCount; i++) {
    const vi = i * 3;
    buffer.writeDoubleLE(localVertices[vi], offset); offset += 8;
    buffer.writeDoubleLE(localVertices[vi + 1], offset); offset += 8;
    buffer.writeDoubleLE(localVertices[vi + 2], offset); offset += 8;
    buffer.writeDoubleLE(geoVertices[vi], offset); offset += 8;
    buffer.writeDoubleLE(geoVertices[vi + 1], offset); offset += 8;
    buffer.writeDoubleLE(geoVertices[vi + 2], offset); offset += 8;
  }
  for (const index of faces) {
    buffer.writeUInt32LE(index, offset);
    offset += 4;
  }

  fs.writeFileSync(filePath, buffer);
}

function readMeshBin(filePath: string) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < HEADER_BYTES || !buffer.subarray(0, 8).equals(MAGIC)) {
    throw new Error(`Invalid indexed mesh file: ${filePath}`);
  }
  const version = buffer.readUInt32LE(8);
  if (version !== INDEX_VERSION) {
    throw new Error(`Unsupported indexed mesh version ${version}: ${filePath}`);
  }
  const vertexCount = buffer.readUInt32LE(12);
  const faceCount = buffer.readUInt32LE(16);
  const expectedBytes = HEADER_BYTES + vertexCount * VERTEX_BYTES + faceCount * FACE_BYTES;
  if (buffer.length !== expectedBytes) {
    throw new Error(`Corrupt indexed mesh file: ${filePath}`);
  }

  const localVertices = new Float64Array(vertexCount * 3);
  const geoVertices = new Float64Array(vertexCount * 3);
  const faces = new Uint32Array(faceCount * 3);
  let offset = HEADER_BYTES;
  for (let i = 0; i < vertexCount; i++) {
    const vi = i * 3;
    localVertices[vi] = buffer.readDoubleLE(offset); offset += 8;
    localVertices[vi + 1] = buffer.readDoubleLE(offset); offset += 8;
    localVertices[vi + 2] = buffer.readDoubleLE(offset); offset += 8;
    geoVertices[vi] = buffer.readDoubleLE(offset); offset += 8;
    geoVertices[vi + 1] = buffer.readDoubleLE(offset); offset += 8;
    geoVertices[vi + 2] = buffer.readDoubleLE(offset); offset += 8;
  }
  for (let i = 0; i < faces.length; i++) {
    faces[i] = buffer.readUInt32LE(offset);
    offset += 4;
  }

  return { localVertices, geoVertices, faces };
}

export function ensureIndexedTileMesh(tileId: string, objPath: string, transform: number[]): LoadedIndexedTileMesh {
  const tileDir = path.dirname(objPath);
  const { meshPath, rtreePath } = getIndexedTilePaths(tileDir, tileId);

  if (!fs.existsSync(meshPath) || !fs.existsSync(rtreePath)) {
    const arrays = parseObjToMeshArrays(objPath, transform);
    const items = createRTreeItems(arrays.geoVertices, arrays.faces);
    const tree = new RBush<RTreeTriangleItem>();
    tree.load(items);
    writeMeshBin(meshPath, arrays.localVertices, arrays.geoVertices, arrays.faces);
    fs.writeFileSync(rtreePath, JSON.stringify(tree.toJSON()), 'utf8');
  }

  const arrays = readMeshBin(meshPath);
  const treeJson = JSON.parse(fs.readFileSync(rtreePath, 'utf8'));
  const rtree = new RBush<RTreeTriangleItem>();
  rtree.fromJSON(treeJson);
  return {
    tileId,
    localVertices: arrays.localVertices,
    geoVertices: arrays.geoVertices,
    faces: arrays.faces,
    rtree,
  };
}

function readVertex(vertices: Float64Array, index: number): [number, number, number] {
  const offset = index * 3;
  return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
}

export function getTriangleRecord(tile: LoadedIndexedTileMesh, faceIndex: number): TriangleRecord | null {
  const faceOffset = faceIndex * 3;
  if (faceOffset < 0 || faceOffset + 2 >= tile.faces.length) return null;
  const ia = tile.faces[faceOffset];
  const ib = tile.faces[faceOffset + 1];
  const ic = tile.faces[faceOffset + 2];
  return {
    tileId: tile.tileId,
    faceIndex,
    local: [
      readVertex(tile.localVertices, ia),
      readVertex(tile.localVertices, ib),
      readVertex(tile.localVertices, ic),
    ],
    geo: [
      readVertex(tile.geoVertices, ia),
      readVertex(tile.geoVertices, ib),
      readVertex(tile.geoVertices, ic),
    ],
  };
}
