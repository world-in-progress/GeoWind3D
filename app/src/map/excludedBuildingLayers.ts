import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl'
import {
  EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID,
  EXCLUDED_BUILDINGS_LINE_LAYER_ID,
  EXCLUDED_BUILDINGS_SOURCE_ID,
} from './layerIds'
import { mapVisibility } from './layerUtils'

export const renderExcludedBuildingsLayer = (
  map: MapboxMap,
  geojson: GeoJSON.FeatureCollection,
  visible: boolean,
  beforeId?: string,
) => {
  const source = map.getSource(EXCLUDED_BUILDINGS_SOURCE_ID) as GeoJSONSource | undefined
  if (source) {
    source.setData(geojson)
  } else {
    map.addSource(EXCLUDED_BUILDINGS_SOURCE_ID, { type: 'geojson', data: geojson })
  }

  if (!map.getLayer(EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID)) {
    map.addLayer({
      id: EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID,
      type: 'fill',
      source: EXCLUDED_BUILDINGS_SOURCE_ID,
      layout: { visibility: mapVisibility(visible) },
      paint: { 'fill-color': '#ffffff', 'fill-opacity': 0 },
    }, beforeId)
  }

  if (!map.getLayer(EXCLUDED_BUILDINGS_LINE_LAYER_ID)) {
    map.addLayer({
      id: EXCLUDED_BUILDINGS_LINE_LAYER_ID,
      type: 'line',
      source: EXCLUDED_BUILDINGS_SOURCE_ID,
      layout: {
        visibility: mapVisibility(visible),
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#ffffff',
        'line-width': 3,
        'line-opacity': 0.95,
      },
    }, beforeId)
  }
}

