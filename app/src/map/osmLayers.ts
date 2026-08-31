import type { FillLayerSpecification, LineLayerSpecification, Map as MapboxMap } from 'mapbox-gl'
import type { LayerVisibility } from '../config/layerTree'
import {
  OSM_BUILDING_FILL_LAYER_ID,
  OSM_BUILDING_LINE_LAYER_ID,
  OSM_BUILDING_SOURCE_ID,
  OSM_ELEVATED_WAY_LINE_LAYER_ID,
  OSM_ELEVATED_WAY_SOURCE_ID,
} from './layerIds'
import { mapVisibility } from './layerUtils'

type PolygonLayerConfig = {
  sourceId: string
  sourceLayer: string
  visibilityKey: keyof LayerVisibility
  fillId: string
  lineId: string
  fillColor: string
  fillOpacity: number
  lineColor: string
  lineWidth: number
}

type LineLayerConfig = {
  sourceId: string
  sourceLayer: string
  visibilityKey: keyof LayerVisibility
  lineId: string
  lineColor: string
  lineWidth: number
}

const POLYGON_LAYERS: PolygonLayerConfig[] = [
  {
    sourceId: OSM_BUILDING_SOURCE_ID,
    sourceLayer: 'osm_building',
    visibilityKey: 'osmBuildings',
    fillId: OSM_BUILDING_FILL_LAYER_ID,
    lineId: OSM_BUILDING_LINE_LAYER_ID,
    fillColor: '#1d4ed8',
    fillOpacity: 0.15,
    lineColor: '#1d4ed8',
    lineWidth: 1,
  },
]

const LINE_LAYERS: LineLayerConfig[] = [
  {
    sourceId: OSM_ELEVATED_WAY_SOURCE_ID,
    sourceLayer: 'osm_elevated_walkway',
    visibilityKey: 'osmElevatedWay',
    lineId: OSM_ELEVATED_WAY_LINE_LAYER_ID,
    lineColor: '#9333ea',
    lineWidth: 2,
  },
]

const ensureVectorSource = (map: MapboxMap, sourceId: string, sourceLayer: string) => {
  if (map.getSource(sourceId)) return
  map.addSource(sourceId, {
    type: 'vector',
    tiles: [`${window.location.origin}/api/osm/mvt/${sourceLayer}/{z}/{x}/{y}.mvt`],
    minzoom: 0,
    maxzoom: 22,
  })
}

export const ensureOsmLayers = (
  map: MapboxMap,
  visibility: LayerVisibility,
  beforeId?: string,
) => {
  POLYGON_LAYERS.forEach((config) => {
    ensureVectorSource(map, config.sourceId, config.sourceLayer)
    const layerVisibility = mapVisibility(visibility[config.visibilityKey])

    if (!map.getLayer(config.fillId)) {
      const layer: FillLayerSpecification = {
        id: config.fillId,
        type: 'fill',
        source: config.sourceId,
        'source-layer': config.sourceLayer,
        layout: { visibility: layerVisibility },
        paint: {
          'fill-color': config.fillColor,
          'fill-opacity': config.fillOpacity,
        },
      }
      map.addLayer(layer, beforeId)
    }

    if (!map.getLayer(config.lineId)) {
      const layer: LineLayerSpecification = {
        id: config.lineId,
        type: 'line',
        source: config.sourceId,
        'source-layer': config.sourceLayer,
        layout: { visibility: layerVisibility },
        paint: {
          'line-color': config.lineColor,
          'line-width': config.lineWidth,
        },
      }
      map.addLayer(layer, beforeId)
    }
  })

  LINE_LAYERS.forEach((config) => {
    ensureVectorSource(map, config.sourceId, config.sourceLayer)
    if (map.getLayer(config.lineId)) return

    const layer: LineLayerSpecification = {
      id: config.lineId,
      type: 'line',
      source: config.sourceId,
      'source-layer': config.sourceLayer,
      layout: { visibility: mapVisibility(visibility[config.visibilityKey]) },
      paint: {
        'line-color': config.lineColor,
        'line-width': config.lineWidth,
      },
    }
    map.addLayer(layer, beforeId)
  })
}
