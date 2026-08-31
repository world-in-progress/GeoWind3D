import { useCallback, useEffect, useRef, useState } from 'react'
import { FloatingTitle } from './components/FloatingTitle'
import { LayerTreePanel } from './components/LayerTreePanel'
import { ModelSetupPanel } from './components/ModelSetupPanel'
import { RunMonitorPanel } from './components/RunMonitorPanel'
import { FeatureInspectorPanel } from './components/FeatureInspectorPanel'
import { useMap } from './hooks/useMap'
import { useMapLayers } from './hooks/useMapLayers'
import { useModelingConfig } from './hooks/useModelingConfig'
import { useModelingWorkflow } from './hooks/useModelingWorkflow'
import type { ModelingWorkflowResult } from './types/modelingResult'
import 'mapbox-gl/dist/mapbox-gl.css'
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css'

export default function App() {
  const geojsonInput = useRef<HTMLInputElement>(null)
  const [cleanMode, setCleanMode] = useState(false)
  const {
    mapContainer,
    map,
    mapReady,
    selectedArea,
    inspectorTouched,
    inspectedFeatures,
    startDrawMode,
    handleGeoJsonUpload,
    finalizeStudyArea,
  } = useMap()
  const {
    modelingConfig,
    configGroups,
    configLoading,
    configError,
    handleConfigChange,
  } = useModelingConfig()
  const {
    layerVisibility,
    handleLayerToggle,
    clearWorkflowLayers,
    renderWorkflowResult,
  } = useMapLayers({
    map,
    mapReady,
    selectedArea,
    windDirectionDeg: modelingConfig?.windDirectionDeg ?? 0,
  })

  const handleWorkflowCompleted = useCallback((
    area: GeoJSON.Feature<GeoJSON.Polygon>,
    result: ModelingWorkflowResult,
  ) => {
    renderWorkflowResult(result)
    finalizeStudyArea(area)
  }, [finalizeStudyArea, renderWorkflowResult])

  const {
    workflowCompleted,
    activeTaskId,
    taskStatus,
    taskLogs,
    taskStartedAt,
    taskCompletedAt,
    taskElapsedMs,
    reportError,
    run,
  } = useModelingWorkflow({
    beforeRun: clearWorkflowLayers,
    onCompleted: handleWorkflowCompleted,
  })

  useEffect(() => {
    if (configError) reportError(configError)
  }, [configError, reportError])

  const handleConfirmArea = useCallback(() => {
    if (!selectedArea) {
      reportError('Please draw or upload a study area before running the workflow.')
      return
    }
    if (!modelingConfig) {
      reportError('Modeling configuration is not available.')
      return
    }
    void run(selectedArea, modelingConfig)
  }, [selectedArea, modelingConfig, reportError, run])

  return (
    <div className='relative h-screen w-screen overflow-hidden bg-slate-950'>
      <div ref={mapContainer} className='h-full w-full' />
      {!cleanMode && (
        <>
          <div className='absolute bottom-[clamp(0.75rem,2.2vh,1.5rem)] left-[clamp(0.75rem,1.75vw,2rem)] top-[clamp(0.75rem,2.2vh,1.5rem)] z-20 flex w-[clamp(20rem,28vw,26rem)] flex-col gap-[clamp(0.5rem,1.5vh,1rem)]'>
            <FloatingTitle />
            <ModelSetupPanel
              groups={configGroups}
              values={modelingConfig}
              selectedAreaReady={Boolean(selectedArea)}
              running={taskStatus === 'queued' || taskStatus === 'running'}
              configLoading={configLoading}
              onChange={handleConfigChange}
              onDrawArea={startDrawMode}
              onUploadGeoJson={() => geojsonInput.current?.click()}
              onRun={handleConfirmArea}
            />
            <LayerTreePanel
              visibility={layerVisibility}
              workflowCompleted={workflowCompleted}
              onToggle={handleLayerToggle}
            />
          </div>
          <div className='absolute bottom-[clamp(3.5rem,7.4vh,5rem)] right-[clamp(0.75rem,1.75vw,2rem)] top-[clamp(3.5rem,8.9vh,6rem)] z-20 flex w-[clamp(20rem,28vw,26rem)] flex-col gap-[clamp(0.5rem,1.5vh,1rem)]'>
            <RunMonitorPanel
              className='min-h-0 flex-[1.05]'
              taskId={activeTaskId}
              status={taskStatus}
              logs={taskLogs}
              startedAt={taskStartedAt}
              completedAt={taskCompletedAt}
              elapsedMs={taskElapsedMs}
            />
            <FeatureInspectorPanel
              inspected={inspectorTouched}
              features={inspectedFeatures}
            />
          </div>
        </>
      )}
      <button
        type='button'
        aria-label={cleanMode ? 'Exit clean mode' : 'Enter clean mode'}
        title={cleanMode ? 'Exit clean mode' : 'Clean mode'}
        onClick={() => setCleanMode((value) => !value)}
        className='absolute bottom-6 right-6 z-30 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-white/50 bg-white/85 text-slate-800 shadow-lg shadow-slate-950/15 backdrop-blur transition hover:-translate-y-0.5 hover:bg-white hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-slate-900/20'
      >
        {cleanMode ? (
          <svg aria-hidden='true' viewBox='0 0 24 24' className='h-4.5 w-4.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
            <path d='M8 3v5H3' />
            <path d='M16 3v5h5' />
            <path d='M8 21v-5H3' />
            <path d='M16 21v-5h5' />
          </svg>
        ) : (
          <svg aria-hidden='true' viewBox='0 0 24 24' className='h-4.5 w-4.5' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
            <path d='M4 9V4h5' />
            <path d='M20 9V4h-5' />
            <path d='M4 15v5h5' />
            <path d='M20 15v5h-5' />
          </svg>
        )}
      </button>
      <input
        ref={geojsonInput}
        type='file'
        accept='.geojson,.json,application/geo+json,application/json'
        className='hidden'
        onChange={handleGeoJsonUpload}
      />
    </div>
  )
}
