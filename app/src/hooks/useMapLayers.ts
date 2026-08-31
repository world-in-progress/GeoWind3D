import { useCallback, useEffect, useRef, useState } from 'react'
import type { Map as MapboxMap } from 'mapbox-gl'
import { fetchExcludedBuildings } from '../api/modelingApi'
import { INITIAL_LAYER_VISIBILITY, type LayerVisibility } from '../config/layerTree'
import type { ModelingWorkflowResult } from '../types/modelingResult'
import {
  clearBuildingPatchLayer,
  clearTerrainSamplingLayer,
  renderBuildingPatchLayer,
  renderTerrainSamplingLayer,
} from '../map/buildingTerrainLayers'
import {
  clearElevatedWalkwayFootprintsLayer,
  clearElevatedWalkwayGraphLayer,
  clearElevatedWalkwaySamplingLayer,
  renderElevatedWalkwayFootprintsLayer,
  renderElevatedWalkwayGraphLayer,
  renderElevatedWalkwaySamplingLayer,
} from '../map/elevatedWalkwayLayers'
import { renderExcludedBuildingsLayer } from '../map/excludedBuildingLayers'
import { LAYER_VISIBILITY_BINDINGS } from '../map/layerVisibility'
import {
  bringDrawLayersToTop,
  getBeforeDrawLayerId,
  setLayerVisibility,
} from '../map/layerUtils'
import {
  clearGeneratedModelLayers,
  loadBaseTilesLayer,
  loadBuildingModelLayer,
  loadElevatedWalkwayModelLayer,
  loadExampleModelLayers,
  loadRoofClusterMeshLayers,
  loadTerrainModelLayer,
} from '../map/modelLayers'
import { ensureOsmLayers } from '../map/osmLayers'
import {
  clearInputAreaLayer,
  clearSelectedTileBounds,
  renderInputAreaLayer,
  renderSelectedTileBounds,
  renderWindDirectionIndicator,
} from '../map/selectionLayers'
import { StreamlineLayerManager } from '../map/streamlineLayers'

type UseMapLayersOptions = {
  map: MapboxMap | null
  mapReady: boolean
  selectedArea: GeoJSON.Feature<GeoJSON.Polygon> | null
  windDirectionDeg: number
}

export function useMapLayers({
  map,
  mapReady,
  selectedArea,
  windDirectionDeg,
}: UseMapLayersOptions) {
  const [layerVisibility, setLayerVisibilityState] = useState<LayerVisibility>(INITIAL_LAYER_VISIBILITY)
  const visibilityRef = useRef(layerVisibility)
  const streamlineManager = useRef(new StreamlineLayerManager())

  const restoreOverlayOrder = useCallback(() => {
    if (!map) return
    streamlineManager.current.bringToFront(map)
    bringDrawLayersToTop(map)
  }, [map])

  const modelLayerContext = useCallback(() => {
    if (!map) return null
    return {
      map,
      visibility: visibilityRef.current,
      onLayerAdded: restoreOverlayOrder,
    }
  }, [map, restoreOverlayOrder])

  useEffect(() => {
    if (!map || !mapReady) return
    let active = true
    const beforeId = getBeforeDrawLayerId(map)
    const context = {
      map,
      visibility: visibilityRef.current,
      onLayerAdded: restoreOverlayOrder,
      isActive: () => active,
    }

    loadBaseTilesLayer(context)
    ensureOsmLayers(map, visibilityRef.current, beforeId)
    streamlineManager.current.ensureLayers(map, visibilityRef.current)
    void loadExampleModelLayers(context)
    fetchExcludedBuildings()
      .then((geojson) => {
        if (!active) return
        renderExcludedBuildingsLayer(
          map,
          geojson,
          visibilityRef.current.excludedBuildings,
          getBeforeDrawLayerId(map),
        )
        restoreOverlayOrder()
      })
      .catch((error) => {
        if (active) console.error('[excluded-buildings] failed to load', error)
      })

    const handleDrawOrderChange = () => restoreOverlayOrder()
    map.on('draw.create', handleDrawOrderChange)
    map.on('draw.update', handleDrawOrderChange)
    map.on('draw.modechange', handleDrawOrderChange)
    restoreOverlayOrder()

    return () => {
      active = false
      map.off('draw.create', handleDrawOrderChange)
      map.off('draw.update', handleDrawOrderChange)
      map.off('draw.modechange', handleDrawOrderChange)
    }
  }, [map, mapReady, restoreOverlayOrder])

  useEffect(() => {
    visibilityRef.current = layerVisibility
    if (!map || !mapReady) return

    Object.entries(LAYER_VISIBILITY_BINDINGS).forEach(([key, layerIds]) => {
      const visible = layerVisibility[key as keyof LayerVisibility]
      layerIds.forEach((layerId) => setLayerVisibility(map, layerId, visible))
    })
    streamlineManager.current.setVisibility(layerVisibility)
  }, [layerVisibility, map, mapReady])

  useEffect(() => {
    if (!map || !mapReady || !map.isStyleLoaded()) return
    const beforeId = getBeforeDrawLayerId(map)
    if (selectedArea) {
      renderInputAreaLayer(map, selectedArea, visibilityRef.current.inputArea, beforeId)
    } else {
      clearInputAreaLayer(map)
    }
    renderWindDirectionIndicator(
      map,
      selectedArea,
      windDirectionDeg,
      visibilityRef.current.windDirection,
      beforeId,
    )
    restoreOverlayOrder()
  }, [map, mapReady, selectedArea, windDirectionDeg, restoreOverlayOrder])

  const handleLayerToggle = useCallback((layerKey: keyof LayerVisibility) => {
    setLayerVisibilityState((current) => ({
      ...current,
      [layerKey]: !current[layerKey],
    }))
  }, [])

  const clearWorkflowLayers = useCallback(() => {
    if (!map) return
    clearGeneratedModelLayers(map)
    clearSelectedTileBounds(map)
    clearBuildingPatchLayer(map)
    clearTerrainSamplingLayer(map)
    clearElevatedWalkwaySamplingLayer(map)
    clearElevatedWalkwayFootprintsLayer(map)
    clearElevatedWalkwayGraphLayer(map)
  }, [map])

  const renderWorkflowResult = useCallback((result: ModelingWorkflowResult) => {
    if (!map) return
    const visibility = visibilityRef.current
    const beforeId = getBeforeDrawLayerId(map)
    const context = modelLayerContext()
    if (!context) return

    if (result.building?.objUrl) loadBuildingModelLayer(context, result.building)
    if (result.tileScopes) {
      renderSelectedTileBounds(map, result.tileScopes, visibility.selectedTileBounds, beforeId)
    }
    if (result.sampling?.roofClusterMeshes?.length) {
      loadRoofClusterMeshLayers(context, result.sampling.roofClusterMeshes)
    }
    if (result.buildingPatches?.features.length) {
      renderBuildingPatchLayer(map, result.buildingPatches, visibility.buildingPatches, beforeId)
    }
    if (result.terrain?.objUrl) loadTerrainModelLayer(context, result.terrain)
    if (result.terrainSampling?.points?.length) {
      renderTerrainSamplingLayer(map, result.terrainSampling.points, visibility.terrainSamplePoints, beforeId)
    }
    if (result.elevatedWay?.samplePoints?.length) {
      renderElevatedWalkwaySamplingLayer(
        map,
        result.elevatedWay.samplePoints,
        visibility.elevatedWaySamplePoints,
        beforeId,
      )
    }
    if (result.elevatedWay?.footprintsGeojson?.features.length) {
      renderElevatedWalkwayFootprintsLayer(
        map,
        result.elevatedWay.footprintsGeojson,
        visibility.elevatedWayFootprints,
        beforeId,
      )
    }
    if (result.elevatedWay?.geojson?.features.length) {
      renderElevatedWalkwayGraphLayer(
        map,
        result.elevatedWay.geojson,
        visibility.elevatedWayGraph,
        beforeId,
      )
    }
    if (result.elevatedWay?.surface?.objUrl) {
      loadElevatedWalkwayModelLayer(context, result.elevatedWay.surface)
    }
    restoreOverlayOrder()
  }, [map, modelLayerContext, restoreOverlayOrder])

  return {
    layerVisibility,
    handleLayerToggle,
    clearWorkflowLayers,
    renderWorkflowResult,
  }
}
