import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl'
import type { InspectedMapFeature } from '../components/FeatureInspectorPanel'
import {
  BUILDING_PATCHES_FILL_LAYER_ID,
  EW_FOOTPRINTS_FILL_LAYER_ID,
  EW_GRAPH_EDGE_LAYER_ID,
  EW_GRAPH_NODE_LAYER_ID,
  EW_SAMPLE_POINTS_LAYER_ID,
  EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID,
  INPUT_AREA_LINE_LAYER_ID,
  OSM_BUILDING_FILL_LAYER_ID,
  OSM_ELEVATED_WAY_LINE_LAYER_ID,
  SELECTED_TILE_FILL_LAYER_ID,
  TERRAIN_SAMPLE_POINTS_LAYER_ID,
  WIND_ARROW_HEAD_LAYER_ID,
  WIND_ARROW_LINE_LAYER_ID,
} from '../map/layerIds'

type QueryableLayer = {
  layerId: string
  logicalLayer: string
}

const QUERYABLE_LAYERS: QueryableLayer[] = [
  { layerId: OSM_BUILDING_FILL_LAYER_ID, logicalLayer: 'OSM Buildings' },
  { layerId: EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID, logicalLayer: 'Excluded Buildings' },
  { layerId: OSM_ELEVATED_WAY_LINE_LAYER_ID, logicalLayer: 'OSM Elevated Walkways' },
  { layerId: SELECTED_TILE_FILL_LAYER_ID, logicalLayer: 'Selected Tile Bounds' },
  { layerId: BUILDING_PATCHES_FILL_LAYER_ID, logicalLayer: 'Aligned Building Clusters' },
  { layerId: TERRAIN_SAMPLE_POINTS_LAYER_ID, logicalLayer: 'Terrain Sample Points' },
  { layerId: EW_SAMPLE_POINTS_LAYER_ID, logicalLayer: 'Walkway Sample Points' },
  { layerId: EW_FOOTPRINTS_FILL_LAYER_ID, logicalLayer: 'Walkway Footprints' },
  { layerId: EW_GRAPH_EDGE_LAYER_ID, logicalLayer: 'Walkway Graph Edges' },
  { layerId: EW_GRAPH_NODE_LAYER_ID, logicalLayer: 'Walkway Graph Nodes' },
  { layerId: WIND_ARROW_LINE_LAYER_ID, logicalLayer: 'Wind Direction' },
  { layerId: WIND_ARROW_HEAD_LAYER_ID, logicalLayer: 'Wind Direction' },
  { layerId: INPUT_AREA_LINE_LAYER_ID, logicalLayer: 'Study Area' },
]

const normalizeOsmProperties = (
  sourceLayer: string | undefined,
  properties: Record<string, unknown>,
): Record<string, unknown> => {
  if (sourceLayer === 'osm_building') {
    return {
      full_id: properties.full_id ?? null,
      osm_type: properties.osm_type ?? null,
      height: properties.height ?? null,
      'building:levels': properties['building:levels'] ?? null,
    }
  }
  if (sourceLayer === 'osm_elevated_walkway') {
    return {
      full_id: properties.full_id ?? null,
      osm_type: properties.osm_type ?? null,
      bridge: properties.bridge ?? null,
    }
  }
  return properties
}

export const inspectMapFeatures = (map: MapboxMap, event: MapMouseEvent): InspectedMapFeature[] => {
  const queryableLayers = QUERYABLE_LAYERS.filter(({ layerId }) => (
    map.getLayer(layerId) && map.getLayoutProperty(layerId, 'visibility') !== 'none'
  ))
  if (queryableLayers.length === 0) return []

  const tolerancePx = 6
  const queryBox: [[number, number], [number, number]] = [
    [event.point.x - tolerancePx, event.point.y - tolerancePx],
    [event.point.x + tolerancePx, event.point.y + tolerancePx],
  ]
  const layerLookup = new Map(queryableLayers.map((layer) => [layer.layerId, layer.logicalLayer]))
  const features = map.queryRenderedFeatures(queryBox, {
    layers: queryableLayers.map((layer) => layer.layerId),
  })
  const seen = new Set<string>()

  return features.flatMap((feature, index) => {
    const layerId = feature.layer?.id
    const logicalLayer = layerId ? layerLookup.get(layerId) : undefined
    if (!layerId || !logicalLayer) return []

    const source = typeof feature.source === 'string' ? feature.source : undefined
    const sourceLayer = typeof feature.sourceLayer === 'string' ? feature.sourceLayer : undefined
    const rawProperties = { ...(feature.properties ?? {}) } as Record<string, unknown>
    const properties = normalizeOsmProperties(sourceLayer, rawProperties)
    const featureId = typeof feature.id === 'string' || typeof feature.id === 'number' ? feature.id : undefined
    const dedupeKey = [logicalLayer, source ?? '', sourceLayer ?? '', featureId ?? '', JSON.stringify(properties)].join('|')
    if (seen.has(dedupeKey)) return []
    seen.add(dedupeKey)

    return [{
      key: `${dedupeKey}|${index}`,
      logicalLayer,
      layerId,
      source,
      sourceLayer,
      featureId,
      properties,
      geometryType: feature.geometry?.type,
    }]
  })
}
