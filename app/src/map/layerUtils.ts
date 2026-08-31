import type { Map as MapboxMap } from 'mapbox-gl'

export const mapVisibility = (visible: boolean) => (visible ? 'visible' : 'none')

export const getDrawLayerIds = (map: MapboxMap) => {
  const layers = map.getStyle()?.layers ?? []
  return layers.filter((layer) => layer.id.startsWith('gl-draw-')).map((layer) => layer.id)
}

export const getBeforeDrawLayerId = (map: MapboxMap) => getDrawLayerIds(map)[0]

export const bringDrawLayersToTop = (map: MapboxMap) => {
  getDrawLayerIds(map).forEach((layerId) => {
    if (map.getLayer(layerId)) map.moveLayer(layerId)
  })
}

export const setLayerVisibility = (map: MapboxMap, layerId: string, visible: boolean) => {
  if (!map.getLayer(layerId)) return
  map.setLayoutProperty(layerId, 'visibility', mapVisibility(visible))
}

export const removeLayers = (map: MapboxMap, layerIds: readonly string[]) => {
  layerIds.forEach((layerId) => {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  })
}

export const removeSources = (map: MapboxMap, sourceIds: readonly string[]) => {
  sourceIds.forEach((sourceId) => {
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  })
}

