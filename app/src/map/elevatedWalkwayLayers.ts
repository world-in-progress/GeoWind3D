import type { Map as MapboxMap } from 'mapbox-gl'
import type { ElevationPoint } from '../types/modelingResult'
import {
  EW_FOOTPRINTS_FILL_LAYER_ID,
  EW_FOOTPRINTS_LINE_LAYER_ID,
  EW_FOOTPRINTS_SOURCE_ID,
  EW_GRAPH_EDGE_LAYER_ID,
  EW_GRAPH_LABEL_LAYER_ID,
  EW_GRAPH_NODE_LAYER_ID,
  EW_GRAPH_SOURCE_ID,
  EW_SAMPLE_POINTS_LAYER_ID,
  EW_SAMPLE_POINTS_SOURCE_ID,
} from './layerIds'
import { mapVisibility, removeLayers, removeSources } from './layerUtils'

export const clearElevatedWalkwaySamplingLayer = (map: MapboxMap) => {
  removeLayers(map, [EW_SAMPLE_POINTS_LAYER_ID])
  removeSources(map, [EW_SAMPLE_POINTS_SOURCE_ID])
}

export const renderElevatedWalkwaySamplingLayer = (
  map: MapboxMap,
  points: ElevationPoint[],
  visible: boolean,
  beforeId?: string,
) => {
  if (!points.length) return
  clearElevatedWalkwaySamplingLayer(map)

  const radiusMeters = 0.5
  const sideCount = 6
  const features = points.map(([lon, lat, z]) => {
    const latitudeRadians = (lat * Math.PI) / 180
    const latitudeOffset = radiusMeters / 111320
    const longitudeOffset = radiusMeters / (111320 * Math.cos(latitudeRadians))
    const ring: number[][] = []
    for (let index = 0; index <= sideCount; index += 1) {
      const angle = (index / sideCount) * 2 * Math.PI
      ring.push([
        lon + longitudeOffset * Math.cos(angle),
        lat + latitudeOffset * Math.sin(angle),
      ])
    }
    return {
      type: 'Feature' as const,
      properties: { z },
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
    }
  })

  map.addSource(EW_SAMPLE_POINTS_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  })
  map.addLayer({
    id: EW_SAMPLE_POINTS_LAYER_ID,
    type: 'fill-extrusion',
    source: EW_SAMPLE_POINTS_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: {
      'fill-extrusion-height': ['get', 'z'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.85,
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['get', 'z'],
        0, '#3b82f6',
        10, '#22c55e',
        20, '#f59e0b',
        30, '#ef4444',
      ],
    },
  }, beforeId)
}

export const clearElevatedWalkwayFootprintsLayer = (map: MapboxMap) => {
  removeLayers(map, [EW_FOOTPRINTS_FILL_LAYER_ID, EW_FOOTPRINTS_LINE_LAYER_ID])
  removeSources(map, [EW_FOOTPRINTS_SOURCE_ID])
}

export const renderElevatedWalkwayFootprintsLayer = (
  map: MapboxMap,
  geojson: GeoJSON.FeatureCollection,
  visible: boolean,
  beforeId?: string,
) => {
  if (!geojson.features.length) return
  clearElevatedWalkwayFootprintsLayer(map)
  map.addSource(EW_FOOTPRINTS_SOURCE_ID, { type: 'geojson', data: geojson })
  map.addLayer({
    id: EW_FOOTPRINTS_FILL_LAYER_ID,
    type: 'fill',
    source: EW_FOOTPRINTS_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': [
        'match', ['get', 'bridge'],
        'covered', 0.25,
        'uncovered', 0.35,
        'viaduct', 0.5,
        0.35,
      ],
    },
  }, beforeId)
  map.addLayer({
    id: EW_FOOTPRINTS_LINE_LAYER_ID,
    type: 'line',
    source: EW_FOOTPRINTS_SOURCE_ID,
    layout: { visibility: mapVisibility(visible) },
    paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 },
  }, beforeId)
}

export const clearElevatedWalkwayGraphLayer = (map: MapboxMap) => {
  removeLayers(map, [EW_GRAPH_LABEL_LAYER_ID, EW_GRAPH_NODE_LAYER_ID, EW_GRAPH_EDGE_LAYER_ID])
  removeSources(map, [EW_GRAPH_SOURCE_ID])
}

export const renderElevatedWalkwayGraphLayer = (
  map: MapboxMap,
  geojson: GeoJSON.FeatureCollection,
  visible: boolean,
  beforeId?: string,
) => {
  if (!geojson.features.length) return
  clearElevatedWalkwayGraphLayer(map)
  const visibility = mapVisibility(visible)
  map.addSource(EW_GRAPH_SOURCE_ID, { type: 'geojson', data: geojson })
  map.addLayer({
    id: EW_GRAPH_EDGE_LAYER_ID,
    type: 'line',
    source: EW_GRAPH_SOURCE_ID,
    filter: ['==', ['get', 'type'], 'edge'],
    layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9 },
  }, beforeId)
  map.addLayer({
    id: EW_GRAPH_NODE_LAYER_ID,
    type: 'circle',
    source: EW_GRAPH_SOURCE_ID,
    filter: ['==', ['get', 'type'], 'node'],
    layout: { visibility },
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': 5,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  }, beforeId)
  map.addLayer({
    id: EW_GRAPH_LABEL_LAYER_ID,
    type: 'symbol',
    source: EW_GRAPH_SOURCE_ID,
    filter: ['==', ['get', 'type'], 'node'],
    layout: {
      visibility,
      'text-field': ['concat', ['number-format', ['get', 'z'], {
        'min-fraction-digits': 1,
        'max-fraction-digits': 1,
      }], 'm'],
      'text-size': 11,
      'text-offset': [0, -1.2],
      'text-anchor': 'bottom',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  }, beforeId)
}

