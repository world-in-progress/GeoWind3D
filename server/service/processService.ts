import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { Feature, Polygon } from 'geojson'
import { polygon } from '@turf/helpers'
import { booleanIntersects } from '@turf/boolean-intersects'
import {
  getIntersectingHorizontalOctantPaths,
  getOctantLatLonBox,
  normalizeOctantHorizontalPath,
  octantBoxToScope,
} from '../utils/octantTile'
import { formatMs, getGeometryBbox } from '../utils/geoUtils'
import b3dm2obj from '../utils/b3dm2obj'
import { merge_obj } from '../utils/meshUtils'
import { writeTaskLog, type TaskLogger } from './taskService'

const dataSource = process.env.TILE_DATA_DIR || ''
const tempDir = process.env.TEMP_DIR || ''

function isString(value: string | undefined): value is string {
  return typeof value === 'string'
}

function getDatasetCacheKey(sourceDir: string) {
  const resolvedSource = path.resolve(sourceDir)
  const tilesetPath = path.join(resolvedSource, 'tileset.json')
  let fingerprint = resolvedSource

  if (fs.existsSync(tilesetPath)) {
    const stat = fs.statSync(tilesetPath)
    fingerprint = `${resolvedSource}|${stat.size}|${stat.mtimeMs}`
  }

  return crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)
}

function getWorkDir(sourceDir: string, level: number) {
  const datasetKey = getDatasetCacheKey(sourceDir)
  return path.join(tempDir, datasetKey, `L${level}`)
}

function createMergedObjFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = crypto.randomBytes(4).toString('hex')
  return `model_merged_${timestamp}_${suffix}.obj`
}

async function processData(bound: Feature<Polygon>, level: number): Promise<any> {
  const artifacts = await processDataWithArtifacts(bound, level)
  return artifacts.targetTiles
}

async function processDataWithArtifacts(
  bound: Feature<Polygon>,
  level: number,
  options?: { mergeOutput?: boolean; logger?: TaskLogger }
): Promise<any> {
  writeTaskLog(options?.logger, 'log', 'process', 'process started')
  const totalStart = Date.now()

  const mergeOutput = options?.mergeOutput ?? true
  const workDir = getWorkDir(dataSource, level)
  fs.mkdirSync(workDir, { recursive: true })

  const rootSpatial = getRootSpatial(dataSource)
  const targetTiles = filterTileByOctant(dataSource, bound, level, options?.logger)

  const tileIds = targetTiles.tileIds
  const objPathMap = await generateObjs(dataSource, workDir, level, tileIds, options?.logger)

  const objFilePaths = tileIds.map(name => objPathMap[name]).filter(isString)
  writeTaskLog(options?.logger, 'log', 'process', `generated ${objFilePaths.length} tile obj files`)

  let mergedObjPath: string | null = null
  if (mergeOutput) {
    mergedObjPath = path.join(workDir, createMergedObjFilename())
    writeTaskLog(options?.logger, 'log', 'process', 'start merging obj files...')
    await merge_obj(mergedObjPath, objFilePaths)
  }

  writeTaskLog(options?.logger, 'log', 'process', `mesh preparation finished | total=${formatMs(Date.now() - totalStart)}`)

  return {
    targetTiles,
    mergedObjPath,
    objFilePaths,
    objPathMap,
    rootSpatial,
    workDir,
  }
}

async function generateObjs(dataSource: string, workDir: string, level: number, filenames: string[], logger?: TaskLogger) {
  const tasks = filenames.map(filename => ({
    b3dmPath: path.join(dataSource, level.toString(), filename + '.b3dm'),
    outputDir: path.join(workDir, filename),
  }))

  const objPaths = await b3dm2obj(tasks, undefined, logger)
  const map: Record<string, string> = {}
  for (const objPath of objPaths) {
    if (!fs.existsSync(objPath)) {
      continue
    }
    const filename = path.basename(objPath, '.obj')
    map[filename] = objPath
  }

  return map
}

function buildAvailableHorizontalTileMap(levelDir: string) {
  const map = new Map<string, string[]>()
  const prefixes = new Set<string>()
  const files = fs.readdirSync(levelDir)
  for (const file of files) {
    if (!file.endsWith('.b3dm')) {
      continue
    }
    const tileId = path.basename(file, '.b3dm')
    const horizontalPath = normalizeOctantHorizontalPath(tileId)
    for (let i = 2; i <= horizontalPath.length; i++) {
      prefixes.add(horizontalPath.slice(0, i))
    }
    const ids = map.get(horizontalPath)
    if (ids) {
      ids.push(tileId)
    } else {
      map.set(horizontalPath, [tileId])
    }
  }
  return { map, prefixes }
}

function filterTileByOctant(dataSource: string, bound: Feature<Polygon>, level = 20, logger?: TaskLogger) {
  const startedAt = Date.now()
  const tileScopes: Record<string, number[][]> = {}
  const levelDir = path.join(dataSource, level.toString())
  const { map: available, prefixes: availablePrefixes } = buildAvailableHorizontalTileMap(levelDir)
  const bbox = getGeometryBbox(bound.geometry)
  const horizontalPaths = getIntersectingHorizontalOctantPaths(bbox, level, {
    hasPrefix: (pathPrefix) => availablePrefixes.has(pathPrefix),
  }).filter((horizontalPath) => available.has(horizontalPath))

  for (const horizontalPath of horizontalPaths) {
    const tileIds = available.get(horizontalPath) ?? []
    for (const tileId of tileIds) {
      const box = getOctantLatLonBox(tileId)
      const scope = octantBoxToScope(box)
      const tilePoly = polygon([[scope[0], scope[1], scope[2], scope[3], scope[0]]])

      if (booleanIntersects(bound, tilePoly)) {
        tileScopes[tileId] = scope
      }
    }
  }

  writeTaskLog(
    logger,
    'log',
    'process',
    `octant tile filter finished: candidates=${horizontalPaths.length}, tiles=${Object.keys(tileScopes).length}, elapsed=${formatMs(Date.now() - startedAt)}`,
  )
  return {
    tileIds: Object.keys(tileScopes),
    tileScopes,
  }
}

function getRootSpatial(dataSource: string) {
  const tileset = fs.readFileSync(path.join(dataSource, 'tileset.json'), 'utf8')
  const parsed = JSON.parse(tileset)
  const transform = parsed.root.transform as number[]
  const tilesetCenter = parsed.root.boundingVolume.box.slice(0, 3)

  return {
    transform,
    tilesetCenter,
  }
}

export {
  processData,
  processDataWithArtifacts,
}
