import type { Map as MapboxMap } from 'mapbox-gl'
import { getPolygonCentroid, getWindArrowEnd, normalizeWindDirection } from '../utils/mapGeometry'
import {
  INPUT_AREA_LINE_LAYER_ID,
  INPUT_AREA_SOURCE_ID,
  SELECTED_TILE_FILL_LAYER_ID,
  SELECTED_TILE_LAYER_IDS,
  SELECTED_TILE_LINE_LAYER_ID,
  SELECTED_TILE_SOURCE_ID,
  SELECTED_TILE_SOURCE_IDS,
  WIND_ARROW_HEAD_LAYER_ID,
  WIND_ARROW_HEAD_SOURCE_ID,
  WIND_ARROW_LINE_LAYER_ID,
  WIND_ARROW_LINE_SOURCE_ID,
} from './layerIds'
import { mapVisibility, removeLayers, removeSources } from './layerUtils'

export const clearInputAreaLayer = (map: MapboxMap) => {
  removeLayers(map, [INPUT_AREA_LINE_LAYER_ID])
  removeSources(map, [INPUT_AREA_SOURCE_ID])
}

export const renderInputAreaLayer = (
  map: MapboxMap,
  area: GeoJSON.Feature<GeoJSON.Polygon>,
  visible: boolean,
  beforeId?: string,
) => {
  clearInputAreaLayer(map)
  map.addSource(INPUT_AREA_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [area] },
  })
  map.addLayer({
    id: INPUT_AREA_LINE_LAYER_ID,
    type: 'line',
    source: INPUT_AREA_SOURCE_ID,
    layout: {
      visibility: mapVisibility(visible),
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#ff0000',
      'line-width': 4,
      'line-dasharray': [2, 3.6],
    },
  }, beforeId)
}

export const clearSelectedTileBounds = (map: MapboxMap) => {
  removeLayers(map, SELECTED_TILE_LAYER_IDS)
  removeSources(map, SELECTED_TILE_SOURCE_IDS)
}

export const renderSelectedTileBounds = (
  map: MapboxMap,
  tileScopes: Record<string, number[][]>,
  visible: boolean,
  beforeId?: string,
) => {
  clearSelectedTileBounds(map)
  const features = Object.entries(tileScopes).map(([name, scope]) => ({
    type: 'Feature' as const,
    properties: { name },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[scope[0], scope[1], scope[2], scope[3], scope[0]]],
    },
  }))

  map.addSource(SELECTED_TILE_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  })
  map.addLayer({
    id: SELECTED_TILE_FILL_LAYER_ID,
    type: 'fill',
    source: SELECTED_TILE_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
  }, beforeId)
  map.addLayer({
    id: SELECTED_TILE_LINE_LAYER_ID,
    type: 'line',
    source: SELECTED_TILE_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: {
      'line-color': '#f59e0b',
      'line-width': 2.5,
      'line-opacity': 0.55,
    },
  }, beforeId)
}

export const clearWindDirectionLayers = (map: MapboxMap) => {
  removeLayers(map, [WIND_ARROW_LINE_LAYER_ID, WIND_ARROW_HEAD_LAYER_ID])
  removeSources(map, [WIND_ARROW_LINE_SOURCE_ID, WIND_ARROW_HEAD_SOURCE_ID])
}

export const renderWindDirectionIndicator = (
  map: MapboxMap,
  area: GeoJSON.Feature<GeoJSON.Polygon> | null,
  directionDeg: number,
  visible: boolean,
  beforeId?: string,
) => {
  clearWindDirectionLayers(map)
  if (!area) return

  const centroid = getPolygonCentroid(area.geometry)
  if (!centroid) return

  const end = getWindArrowEnd(centroid, directionDeg)
  const normalizedDeg = normalizeWindDirection(directionDeg)
  map.addSource(WIND_ARROW_LINE_SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [centroid, end] },
      }],
    },
  })
  map.addSource(WIND_ARROW_HEAD_SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { rotation: normalizedDeg },
        geometry: { type: 'Point', coordinates: end },
      }],
    },
  })
  map.addLayer({
    id: WIND_ARROW_LINE_LAYER_ID,
    type: 'line',
    source: WIND_ARROW_LINE_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: {
      'line-color': '#facc15',
      'line-width': 12,
      'line-opacity': 0.98,
    },
  }, beforeId)
  map.addLayer({
    id: WIND_ARROW_HEAD_LAYER_ID,
    type: 'symbol',
    source: WIND_ARROW_HEAD_SOURCE_ID,
    layout: {
      visibility: mapVisibility(visible),
      'text-field': '▲',
      'text-size': 80,
      'text-rotation-alignment': 'map',
      'text-rotate': ['get', 'rotation'],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#facc15', 'text-halo-width': 0 },
  }, beforeId)
}

