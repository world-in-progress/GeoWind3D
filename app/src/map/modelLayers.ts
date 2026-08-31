import type { Map as MapboxMap } from 'mapbox-gl'
import type { LayerVisibility } from '../config/layerTree'
import type { GeneratedModelPayload, ModelTransformMetadata } from '../types/modelPayload'
import {
  BUILDING_MODEL_LAYER_ID,
  ELEVATED_WALKWAY_MODEL_LAYER_ID,
  EXAMPLE_BUILDING_MODEL_LAYER_ID,
  EXAMPLE_TERRAIN_MODEL_LAYER_ID,
  EXAMPLE_WALKWAY_MODEL_LAYER_ID,
  ROOF_CLUSTER_MESH_LAYER_IDS,
  TERRAIN_MODEL_LAYER_ID,
  TILES_3D_LAYER_ID,
} from './layerIds'
import { getBeforeDrawLayerId } from './layerUtils'
import {
  clearObjModelLayer,
  loadObjModelLayer,
  loadThreeboxTilesLayer,
  type ObjLayerOptions,
} from './threeboxLayers'

type ModelLayerContext = {
  map: MapboxMap
  visibility: LayerVisibility
  onLayerAdded: () => void
  isActive?: () => boolean
}

const GENERATED_MODEL_STYLE: ObjLayerOptions = {
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
}

const loadModel = (
  context: ModelLayerContext,
  model: GeneratedModelPayload,
  layerId: string,
  color: string,
  opacity: number,
  visibilityKey: keyof LayerVisibility,
  options: ObjLayerOptions = GENERATED_MODEL_STYLE,
) => {
  loadObjModelLayer(
    context.map,
    model,
    layerId,
    color,
    opacity,
    context.visibility[visibilityKey],
    getBeforeDrawLayerId(context.map),
    options,
    context.onLayerAdded,
  )
}

const loadExampleModel = async (
  context: ModelLayerContext,
  objUrl: string,
  layerId: string,
  color: string,
  visibilityKey: keyof LayerVisibility,
) => {
  try {
    const response = await fetch('/data/model_transform.json')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const metadata = (await response.json()) as ModelTransformMetadata
    if (context.isActive && !context.isActive()) return
    const originLonLat = metadata.coordinateSpace?.origin_lonlat
    const mercatorZScale = metadata.coordinateSpace?.mercatorZScale
    if (
      !Array.isArray(originLonLat) ||
      originLonLat.length !== 2 ||
      originLonLat.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new Error('coordinateSpace.origin_lonlat is missing or invalid')
    }

    loadModel(context, {
      objUrl,
      placement: {
        coords: [originLonLat[0], originLonLat[1]],
        rotation: { x: 0, y: 0, z: 180 },
        scale: 1,
        mercatorZScale: typeof mercatorZScale === 'number' && Number.isFinite(mercatorZScale)
          ? mercatorZScale
          : 1,
        anchor: 'none',
      },
    }, layerId, color, 1, visibilityKey)
  } catch (error) {
    console.error(`Failed to load visualization example model: ${objUrl}`, error)
  }
}

export const loadBaseTilesLayer = (context: ModelLayerContext) => {
  loadThreeboxTilesLayer(
    context.map,
    '/3dtiles/3857/tileset.json',
    TILES_3D_LAYER_ID,
    getBeforeDrawLayerId(context.map),
    context.onLayerAdded,
  )
}

export const loadExampleModelLayers = (context: ModelLayerContext) => Promise.all([
  loadExampleModel(
    context,
    '/data/building.obj',
    EXAMPLE_BUILDING_MODEL_LAYER_ID,
    '#a5a5a5',
    'visualizationExampleModel',
  ),
  loadExampleModel(
    context,
    '/data/terrain.obj',
    EXAMPLE_TERRAIN_MODEL_LAYER_ID,
    '#f4efe1',
    'visualizationExampleTerrainModel',
  ),
  loadExampleModel(
    context,
    '/data/elevated_walkway.obj',
    EXAMPLE_WALKWAY_MODEL_LAYER_ID,
    '#ffb521',
    'visualizationExampleWalkwayModel',
  ),
])

export const loadBuildingModelLayer = (context: ModelLayerContext, model: GeneratedModelPayload) => {
  loadModel(context, model, BUILDING_MODEL_LAYER_ID, '#a5a5a5', 1, 'generatedObjModel')
}

export const loadTerrainModelLayer = (context: ModelLayerContext, model: GeneratedModelPayload) => {
  loadModel(context, model, TERRAIN_MODEL_LAYER_ID, '#f4efe1', 1, 'terrainModel')
}

export const loadElevatedWalkwayModelLayer = (context: ModelLayerContext, model: GeneratedModelPayload) => {
  loadModel(context, model, ELEVATED_WALKWAY_MODEL_LAYER_ID, '#ffb521', 1, 'corridorSurface')
}

export const loadRoofClusterMeshLayers = (context: ModelLayerContext, models: GeneratedModelPayload[]) => {
  const fallbackColors = ['#42d9ff', '#ff66a8', '#ffd84d']
  models.slice(0, ROOF_CLUSTER_MESH_LAYER_IDS.length).forEach((model, index) => {
    loadModel(
      context,
      model,
      ROOF_CLUSTER_MESH_LAYER_IDS[index],
      model.color ?? fallbackColors[index] ?? '#d9f99d',
      0.96,
      'roofClusterMesh',
      {
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        emissiveStrength: 0.32,
        emissiveIntensity: 0.75,
        specularColor: '#b8d8e0',
        shininess: 28,
      },
    )
  })
}

export const clearGeneratedModelLayers = (map: MapboxMap) => {
  [
    BUILDING_MODEL_LAYER_ID,
    TERRAIN_MODEL_LAYER_ID,
    ELEVATED_WALKWAY_MODEL_LAYER_ID,
    ...ROOF_CLUSTER_MESH_LAYER_IDS,
  ].forEach((layerId) => clearObjModelLayer(map, layerId))
}
