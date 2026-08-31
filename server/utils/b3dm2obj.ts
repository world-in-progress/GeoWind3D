import fs from 'fs'
import path from 'path'
import { ContentOps } from '3d-tiles-tools'
import { writeTaskLog, type TaskLogger } from '../service/taskService'

type GltfPipelineResult = {
  gltf: unknown
  separateResources?: Record<string, Buffer>
}

type GltfPipelineModule = {
  glbToGltf: (glb: Buffer, options?: Record<string, unknown>) => Promise<GltfPipelineResult>
}

const { glbToGltf } = require('gltf-pipeline') as GltfPipelineModule
const DEFAULT_CONCURRENCY = 4
const GEOMETRY_SERVICE_URL = process.env.GEOMETRY_SERVICE_URL || 'http://localhost:8000'
const TEXTURE_PATCH_VERSION = 1
const TEXTURE_PATCH_MARKER = `texture_patch.v${TEXTURE_PATCH_VERSION}.json`

type BatchConvertItem = {
  input_path: string
  output_path: string
}

type BatchConvertResponse = {
  success: boolean
  message: string
  output_paths: string[]
  failed_items: Array<{
    input_path: string
    output_path: string
    error: string
  }>
}

type TaskIntermediate = {
  gltfPath: string
  resources: string[]
  gltf: unknown
}

export type B3dmToObjTask = {
  b3dmPath: string
  outputDir: string
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function safeJoin(baseDir: string, relativePath: string) {
  const targetPath = path.resolve(baseDir, relativePath)
  const normalizedBase = path.resolve(baseDir) + path.sep
  if (!targetPath.startsWith(normalizedBase)) {
    throw new Error(`Unsafe resource path: ${relativePath}`)
  }
  return targetPath
}

function cleanupFiles(paths: string[]) {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
}

function hasTextureResource(dir: string) {
  if (!fs.existsSync(dir)) {
    return false
  }
  return fs
    .readdirSync(dir)
    .some(file => ['.jpg', '.jpeg', '.png'].includes(path.extname(file).toLowerCase()))
}

function texturePatchMarkerPath(dir: string) {
  return path.join(dir, TEXTURE_PATCH_MARKER)
}

function patchObjMaterialTextures(objPath: string, gltf: unknown, resources: string[]) {
  function isTextureResource(filePath: string) {
    return ['.jpg', '.jpeg', '.png'].includes(path.extname(filePath).toLowerCase())
  }

  function resourcePathForUri(outputDir: string, uri: unknown) {
    if (typeof uri !== 'string' || uri.length === 0 || uri.startsWith('data:')) {
      return null
    }
    return safeJoin(outputDir, uri)
  }

  function findObjMaterialLibraries(targetObjPath: string) {
    if (!fs.existsSync(targetObjPath)) {
      return []
    }

    const objDir = path.dirname(targetObjPath)
    const mtlPaths: string[] = []
    const content = fs.readFileSync(targetObjPath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('mtllib ')) {
        continue
      }
      const mtlName = trimmed.slice('mtllib '.length).trim()
      if (mtlName.length > 0) {
        mtlPaths.push(path.resolve(objDir, mtlName))
      }
    }
    return mtlPaths
  }

  const parsed = gltf as {
    images?: Array<{ uri?: unknown }>
    textures?: Array<{ source?: unknown }>
    materials?: Array<{
      name?: unknown
      pbrMetallicRoughness?: {
        baseColorTexture?: { index?: unknown }
      }
    }>
    meshes?: Array<{
      name?: unknown
      primitives?: Array<{ material?: unknown }>
    }>
  }

  const outputDir = path.dirname(objPath)
  const materialTextures: Record<string, string> = {}
  const meshMaterials: Record<string, string> = {}
  const materials = Array.isArray(parsed.materials) ? parsed.materials : []
  const textures = Array.isArray(parsed.textures) ? parsed.textures : []
  const images = Array.isArray(parsed.images) ? parsed.images : []
  const meshes = Array.isArray(parsed.meshes) ? parsed.meshes : []

  for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
    const material = materials[materialIndex]
    const materialName = typeof material.name === 'string' && material.name.length > 0
      ? material.name
      : `material_${materialIndex}`
    const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index
    if (typeof textureIndex !== 'number') {
      continue
    }

    const imageIndex = textures[textureIndex]?.source
    if (typeof imageIndex !== 'number') {
      continue
    }

    const imagePath = resourcePathForUri(outputDir, images[imageIndex]?.uri)
    if (imagePath && isTextureResource(imagePath)) {
      materialTextures[materialName] = path.relative(outputDir, imagePath).replace(/\\/g, '/')
    }
  }

  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const mesh = meshes[meshIndex]
    const meshName = typeof mesh.name === 'string' && mesh.name.length > 0
      ? mesh.name
      : `mesh_${meshIndex}`
    const materialIndex = mesh.primitives?.[0]?.material
    if (typeof materialIndex !== 'number') {
      continue
    }
    const material = materials[materialIndex]
    const materialName = typeof material?.name === 'string' && material.name.length > 0
      ? material.name
      : `material_${materialIndex}`
    meshMaterials[meshName] = materialName
  }

  if (Object.keys(materialTextures).length === 0) {
    return resources.filter(resource => !isTextureResource(resource))
  }

  if (Object.keys(meshMaterials).length > 0 && fs.existsSync(objPath)) {
    const lines = fs.readFileSync(objPath, 'utf8').split(/\r?\n/)
    const patched: string[] = []
    let currentObject: string | null = null
    let changed = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('o ')) {
        currentObject = trimmed.slice(2).trim()
        patched.push(line)
      } else if (trimmed.startsWith('usemtl ') && currentObject && meshMaterials[currentObject]) {
        const expectedMaterial = meshMaterials[currentObject]
        if (trimmed !== `usemtl ${expectedMaterial}`) {
          changed = true
        }
        patched.push(`usemtl ${expectedMaterial}`)
      } else {
        patched.push(line)
      }
    }

    if (changed) {
      fs.writeFileSync(objPath, patched.join('\n'), 'utf8')
    }
  }

  for (const mtlPath of findObjMaterialLibraries(objPath)) {
    if (!fs.existsSync(mtlPath)) {
      continue
    }

    const patched: string[] = []
    for (const [materialName, texturePath] of Object.entries(materialTextures)) {
      patched.push(
        `newmtl ${materialName}`,
        'Ka 0.40000000 0.40000000 0.40000000',
        'Kd 1.00000000 1.00000000 1.00000000',
        'Ks 0.40000000 0.40000000 0.40000000',
        'Ns 1.00000000',
        `map_Kd ${texturePath}`,
        '',
      )
    }

    fs.writeFileSync(mtlPath, patched.join('\n'), 'utf8')
  }

  fs.writeFileSync(
    texturePatchMarkerPath(outputDir),
    JSON.stringify({
      version: TEXTURE_PATCH_VERSION,
      patchedAt: new Date().toISOString(),
      materialCount: Object.keys(materialTextures).length,
      meshMaterialCount: Object.keys(meshMaterials).length,
    }, null, 2),
    'utf8',
  )

  return resources.filter(resource => !isTextureResource(resource))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const current = cursor
      cursor += 1
      if (current >= items.length) {
        return
      }
      results[current] = await mapper(items[current], current)
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

async function prepareGltf(task: B3dmToObjTask): Promise<{
  batchItem: BatchConvertItem | null
  intermediate: TaskIntermediate | null
  existingObjPath: string | null
}> {
  const filename = path.basename(task.b3dmPath, '.b3dm')
  const objPath = path.join(task.outputDir, `${filename}.obj`)

  if (
    fs.existsSync(objPath) &&
    hasTextureResource(task.outputDir) &&
    fs.existsSync(texturePatchMarkerPath(task.outputDir))
  ) {
    return { batchItem: null, intermediate: null, existingObjPath: objPath }
  }

  ensureDir(task.outputDir)

  const b3dmBuffer = fs.readFileSync(task.b3dmPath)
  const glbBuffer = ContentOps.b3dmToGlbBuffer(b3dmBuffer)
  const gltfResult = await glbToGltf(glbBuffer, {
    separate: true,
    name: `${filename}.gltf`,
  })

  const gltfPath = path.join(task.outputDir, `${filename}.gltf`)
  fs.writeFileSync(gltfPath, JSON.stringify(gltfResult.gltf))

  const writtenResources: string[] = []
  const separateResources = gltfResult.separateResources || {}
  for (const [relativePath, data] of Object.entries(separateResources)) {
    const resourcePath = safeJoin(task.outputDir, relativePath)
    ensureDir(path.dirname(resourcePath))
    fs.writeFileSync(resourcePath, data)
    writtenResources.push(resourcePath)
  }

  return {
    batchItem: {
      input_path: gltfPath,
      output_path: objPath,
    },
    intermediate: {
      gltfPath,
      resources: writtenResources,
      gltf: gltfResult.gltf,
    },
    existingObjPath: null,
  }
}

async function b3dm2obj(tasks: B3dmToObjTask[], concurrency = DEFAULT_CONCURRENCY, logger?: TaskLogger) {
  if (tasks.length === 0) {
    return []
  }

  writeTaskLog(logger, 'log', 'b3dm2obj', `preparing ${tasks.length} task(s), concurrency=${concurrency}`)
  const preparedResults = await mapWithConcurrency(tasks, concurrency, async task => {
    try {
      return await prepareGltf(task)
    } catch (error) {
      console.error(`failed to prepare gltf for ${task.b3dmPath}`, error)
      return { batchItem: null, intermediate: null, existingObjPath: null }
    }
  })

  const existingObjPaths = preparedResults
    .map(item => item.existingObjPath)
    .filter((item): item is string => Boolean(item))

  const batchItems = preparedResults
    .map(item => item.batchItem)
    .filter((item): item is BatchConvertItem => Boolean(item))

  writeTaskLog(logger, 'log', 'b3dm2obj', `prepared done: cached=${existingObjPaths.length}, to_convert=${batchItems.length}`)

  if (batchItems.length === 0) {
    writeTaskLog(logger, 'log', 'b3dm2obj', 'all tasks hit cache, skip converter')
    return existingObjPaths
  }

  console.log(`[b3dm2obj] sending batch convert request: ${batchItems.length} item(s)`)
  const resp = await fetch(`${GEOMETRY_SERVICE_URL}/convert/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items: batchItems }),
  })

  if (!resp.ok) {
    throw new Error(`converter batch api failed: HTTP ${resp.status}`)
  }

  const data = (await resp.json()) as BatchConvertResponse
  const failedOutputs = new Set((data.failed_items || []).map(item => path.resolve(item.output_path)))
  writeTaskLog(logger, 'log', 'b3dm2obj', `batch done: success=${data.output_paths?.length || 0}, failed=${data.failed_items?.length || 0}`)

  const outPaths = [...existingObjPaths]
  for (const outputPath of data.output_paths || []) {
    const resolved = path.resolve(outputPath)
    if (!failedOutputs.has(resolved) && fs.existsSync(resolved)) {
      outPaths.push(resolved)
    }
  }

  // Keep intermediates for failed conversions for debugging.
  for (const item of preparedResults) {
    if (!item.batchItem || !item.intermediate) {
      continue
    }
    const outputPath = path.resolve(item.batchItem.output_path)
    if (!failedOutputs.has(outputPath)) {
      const cleanupResources = patchObjMaterialTextures(
        outputPath,
        item.intermediate.gltf,
        item.intermediate.resources,
      )
      cleanupFiles([
        item.intermediate.gltfPath,
        ...cleanupResources,
      ])
    }
  }

  return outPaths
}

export default b3dm2obj
