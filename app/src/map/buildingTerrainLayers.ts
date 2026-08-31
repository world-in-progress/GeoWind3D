import type { Map as MapboxMap } from 'mapbox-gl'
import type { ElevationPoint } from '../types/modelingResult'
import {
  BUILDING_PATCHES_FILL_LAYER_ID,
  BUILDING_PATCHES_LINE_LAYER_ID,
  BUILDING_PATCHES_SOURCE_ID,
  TERRAIN_SAMPLE_POINTS_LAYER_ID,
  TERRAIN_SAMPLE_POINTS_SOURCE_ID,
} from './layerIds'
import { mapVisibility, removeLayers, removeSources } from './layerUtils'

export const clearBuildingPatchLayer = (map: MapboxMap) => {
  removeLayers(map, [BUILDING_PATCHES_FILL_LAYER_ID, BUILDING_PATCHES_LINE_LAYER_ID])
  removeSources(map, [BUILDING_PATCHES_SOURCE_ID])
}

export const renderBuildingPatchLayer = (
  map: MapboxMap,
  geojson: GeoJSON.FeatureCollection,
  visible: boolean,
  beforeId?: string,
) => {
  if (!geojson.features.length) return
  clearBuildingPatchLayer(map)
  map.addSource(BUILDING_PATCHES_SOURCE_ID, { type: 'geojson', data: geojson })
  map.addLayer({
    id: BUILDING_PATCHES_FILL_LAYER_ID,
    type: 'fill',
    source: BUILDING_PATCHES_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: { 'fill-color': '#2563eb', 'fill-opacity': 0 },
  }, beforeId)
  map.addLayer({
    id: BUILDING_PATCHES_LINE_LAYER_ID,
    type: 'line',
    source: BUILDING_PATCHES_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: { 'line-color': '#2563eb', 'line-width': 4 },
  }, beforeId)
}

export const clearTerrainSamplingLayer = (map: MapboxMap) => {
  removeLayers(map, [TERRAIN_SAMPLE_POINTS_LAYER_ID])
  removeSources(map, [TERRAIN_SAMPLE_POINTS_SOURCE_ID])
}

export const renderTerrainSamplingLayer = (
  map: MapboxMap,
  points: ElevationPoint[],
  visible: boolean,
  beforeId?: string,
) => {
  if (!points.length) return
  clearTerrainSamplingLayer(map)
  const features = points.map(([lon, lat, z]) => ({
    type: 'Feature' as const,
    properties: { z },
    geometry: { type: 'Point' as const, coordinates: [lon, lat] },
  }))
  map.addSource(TERRAIN_SAMPLE_POINTS_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  })
  map.addLayer({
    id: TERRAIN_SAMPLE_POINTS_LAYER_ID,
    type: 'circle',
    source: TERRAIN_SAMPLE_POINTS_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: {
      'circle-radius': 2,
      'circle-color': '#22c55e',
      'circle-stroke-width': 0,
    },
  }, beforeId)
}

