import type { GeneratedModelPayload } from './modelPayload'

export type ElevationPoint = [number, number, number]

export type ModelingWorkflowResult = {
  building?: GeneratedModelPayload
  tileScopes?: Record<string, number[][]>
  sampling?: {
    roofClusterMeshes?: GeneratedModelPayload[]
  }
  buildingPatches?: GeoJSON.FeatureCollection
  terrain?: GeneratedModelPayload
  terrainSampling?: {
    points?: ElevationPoint[]
  }
  elevatedWay?: {
    samplePoints?: ElevationPoint[]
    footprintsGeojson?: GeoJSON.FeatureCollection
    geojson?: GeoJSON.FeatureCollection
    surface?: GeneratedModelPayload
  }
}

