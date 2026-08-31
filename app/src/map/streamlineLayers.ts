import type { Map as MapboxMap } from 'mapbox-gl'
import type { LayerVisibility } from '../config/layerTree'
import { createStreamlineLayer, type StreamlineLayerController } from '../utils/streamlineLayer'
import { STREAMLINE_SPEED_RANGE } from './layerIds'
import { bringDrawLayersToTop, getBeforeDrawLayerId } from './layerUtils'

const STREAMLINE_CONFIGS = [
  { key: 'streamline', id: 'streamline-layer', dataUrl: '/data/streamline.json' },
] as const satisfies ReadonlyArray<{
  key: keyof LayerVisibility
  id: string
  dataUrl: string
}>

export const STREAMLINE_LAYER_IDS = Object.fromEntries(
  STREAMLINE_CONFIGS.map(({ key, id }) => [key, id]),
) as Record<(typeof STREAMLINE_CONFIGS)[number]['key'], string>

export class StreamlineLayerManager {
  private readonly controllers = new Map<string, StreamlineLayerController>()

  ensureLayers(map: MapboxMap, visibility: LayerVisibility) {
    const beforeId = getBeforeDrawLayerId(map)
    STREAMLINE_CONFIGS.forEach((config) => {
      const existing = this.controllers.get(config.id)
      if (map.getLayer(config.id)) {
        existing?.setVisible(visibility[config.key])
        return
      }

      const layer = createStreamlineLayer({
        id: config.id,
        dataUrl: config.dataUrl,
        visible: visibility[config.key],
        speedRange: STREAMLINE_SPEED_RANGE,
      })
      this.controllers.set(config.id, layer)
      map.addLayer(layer, beforeId)
    })
    this.bringToFront(map)
  }

  setVisibility(visibility: LayerVisibility) {
    STREAMLINE_CONFIGS.forEach((config) => {
      this.controllers.get(config.id)?.setVisible(visibility[config.key])
    })
  }

  bringToFront(map: MapboxMap) {
    const beforeId = getBeforeDrawLayerId(map)
    STREAMLINE_CONFIGS.forEach(({ id }) => {
      if (!map.getLayer(id)) return
      map.moveLayer(id, beforeId)
    })
    bringDrawLayersToTop(map)
  }

  clear() {
    this.controllers.clear()
  }
}
