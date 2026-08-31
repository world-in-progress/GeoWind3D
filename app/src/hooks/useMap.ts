import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import MapboxDraw from '@mapbox/mapbox-gl-draw'
import mapboxgl from 'mapbox-gl'
import { sampleDebugHeight } from '../api/modelingApi'
import type { InspectedMapFeature } from '../components/FeatureInspectorPanel'
import { extractSinglePolygonFeature } from '../utils/geojsonArea'
import { inspectMapFeatures } from '../utils/featureInspector'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || ''

type StudyArea = GeoJSON.Feature<GeoJSON.Polygon>

export function useMap() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<mapboxgl.Map | null>(null)
  const [draw, setDraw] = useState<MapboxDraw | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [selectedArea, setSelectedArea] = useState<StudyArea | null>(null)
  const [inspectorTouched, setInspectorTouched] = useState(false)
  const [inspectedFeatures, setInspectedFeatures] = useState<InspectedMapFeature[]>([])

  useEffect(() => {
    if (!mapContainer.current) return

    const mapInstance = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [114.16579, 22.29910],
      zoom: 12,
      projection: 'mercator',
    })
    const drawInstance = new MapboxDraw({ displayControlsDefault: false })
    mapInstance.addControl(drawInstance)
    setMap(mapInstance)
    setDraw(drawInstance)

    const syncSelectedArea = () => {
      const polygon = drawInstance.getAll().features.find(
        (feature): feature is StudyArea => feature.geometry?.type === 'Polygon',
      )
      setSelectedArea(polygon ?? null)
    }

    const handleMapClick = (event: mapboxgl.MapMouseEvent) => {
      if (!event.originalEvent.ctrlKey) {
        setInspectorTouched(true)
        setInspectedFeatures(inspectMapFeatures(mapInstance, event))
        return
      }

      const { lng, lat } = event.lngLat
      sampleDebugHeight(lng, lat)
        .then((result) => {
          console.log('[height-sample]', result)
        })
        .catch((error) => {
          console.error('[height-sample] failed', { lon: lng, lat, error })
        })
    }

    const handleLoad = () => setMapReady(true)
    mapInstance.on('draw.create', syncSelectedArea)
    mapInstance.on('draw.update', syncSelectedArea)
    mapInstance.on('draw.delete', syncSelectedArea)
    mapInstance.on('click', handleMapClick)
    mapInstance.on('load', handleLoad)

    return () => {
      mapInstance.off('draw.create', syncSelectedArea)
      mapInstance.off('draw.update', syncSelectedArea)
      mapInstance.off('draw.delete', syncSelectedArea)
      mapInstance.off('click', handleMapClick)
      mapInstance.off('load', handleLoad)
      mapInstance.remove()
      setMap(null)
      setDraw(null)
      setMapReady(false)
    }
  }, [])

  const fitMapToArea = useCallback((area: StudyArea) => {
    if (!map) return
    const bounds = new mapboxgl.LngLatBounds()
    area.geometry.coordinates.flat().forEach(([longitude, latitude]) => {
      bounds.extend([longitude, latitude])
    })
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, duration: 500 })
  }, [map])

  const startDrawMode = useCallback(() => {
    if (!draw) return
    draw.deleteAll()
    setSelectedArea(null)
    draw.changeMode('draw_polygon')
  }, [draw])

  const applyStudyArea = useCallback((area: StudyArea) => {
    if (!draw) return
    draw.deleteAll()
    draw.add(area)
    draw.changeMode('simple_select')
    setSelectedArea(area)
    fitMapToArea(area)
  }, [draw, fitMapToArea])

  const handleGeoJsonUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    try {
      const area = extractSinglePolygonFeature(JSON.parse(await file.text()))
      applyStudyArea(area)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid GeoJSON file.'
      console.warn('[geojson-upload] invalid input:', error)
      window.alert(message)
    }
  }, [applyStudyArea])

  const finalizeStudyArea = useCallback((area: StudyArea) => {
    draw?.deleteAll()
    draw?.changeMode('simple_select')
    setSelectedArea(area)
  }, [draw])

  return {
    mapContainer,
    map,
    mapReady,
    selectedArea,
    inspectorTouched,
    inspectedFeatures,
    startDrawMode,
    handleGeoJsonUpload,
    finalizeStudyArea,
  }
}
