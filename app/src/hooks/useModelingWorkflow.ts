import { useCallback, useEffect, useRef, useState } from 'react'
import { createModelTask, subscribeTaskEvents, type TaskLogEntry } from '../api/modelingApi'
import type { ModelingConfig } from '../types/modelingConfig'
import type { ModelingWorkflowResult } from '../types/modelingResult'
import { normalizeWindDirection } from '../utils/mapGeometry'

export type ModelingTaskStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed'

type UseModelingWorkflowOptions = {
  beforeRun: () => void
  onCompleted: (
    area: GeoJSON.Feature<GeoJSON.Polygon>,
    result: ModelingWorkflowResult,
  ) => void
}

export function useModelingWorkflow({ beforeRun, onCompleted }: UseModelingWorkflowOptions) {
  const [workflowCompleted, setWorkflowCompleted] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string>()
  const [taskStatus, setTaskStatus] = useState<ModelingTaskStatus>('idle')
  const [taskLogs, setTaskLogs] = useState<TaskLogEntry[]>([])
  const [taskStartedAt, setTaskStartedAt] = useState<string>()
  const [taskCompletedAt, setTaskCompletedAt] = useState<string>()
  const [taskElapsedMs, setTaskElapsedMs] = useState<number>()
  const [taskError, setTaskError] = useState<string>()
  const closeEventsRef = useRef<(() => void) | null>(null)
  const callbacksRef = useRef({ beforeRun, onCompleted })

  useEffect(() => {
    callbacksRef.current = { beforeRun, onCompleted }
  }, [beforeRun, onCompleted])

  useEffect(() => () => closeEventsRef.current?.(), [])

  const reportError = useCallback((message: string) => {
    setTaskStatus('failed')
    setTaskError(message)
  }, [])

  const run = useCallback(async (
    area: GeoJSON.Feature<GeoJSON.Polygon>,
    config: ModelingConfig,
  ) => {
    closeEventsRef.current?.()
    closeEventsRef.current = null
    setWorkflowCompleted(false)
    setActiveTaskId(undefined)
    setTaskStatus('queued')
    setTaskLogs([])
    setTaskStartedAt(undefined)
    setTaskCompletedAt(undefined)
    setTaskElapsedMs(undefined)
    setTaskError(undefined)
    callbacksRef.current.beforeRun()

    try {
      const task = await createModelTask({
        bound: area,
        config: {
          ...config,
          windDirectionDeg: normalizeWindDirection(config.windDirectionDeg),
        },
      })
      setActiveTaskId(task.taskId)

      const closeEvents = subscribeTaskEvents(task.taskId, {
        onEvent: (event) => {
          if (event.type === 'status') {
            setTaskStatus(event.status)
            setTaskStartedAt(event.startedAt)
            setTaskCompletedAt(event.completedAt)
            setTaskElapsedMs(event.elapsedMs)
            return
          }
          if (event.type === 'log') {
            setTaskLogs((current) => [...current, event.log].slice(-300))
            return
          }
          if (event.type === 'complete') {
            setTaskStatus('completed')
            setTaskCompletedAt(event.completedAt)
            setTaskElapsedMs(event.elapsedMs)
            setWorkflowCompleted(true)
            callbacksRef.current.onCompleted(area, event.result)
            closeEvents()
            closeEventsRef.current = null
            return
          }

          setTaskStatus('failed')
          setTaskCompletedAt(event.completedAt)
          setTaskElapsedMs(event.elapsedMs)
          setTaskError(event.message)
          closeEvents()
          closeEventsRef.current = null
        },
        onError: () => {
          setTaskError('Lost connection to the task event stream.')
        },
      })
      closeEventsRef.current = closeEvents
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown workflow error.'
      console.error('[workflow] failed:', error)
      reportError(message)
    }
  }, [reportError])

  return {
    workflowCompleted,
    activeTaskId,
    taskStatus,
    taskLogs,
    taskStartedAt,
    taskCompletedAt,
    taskElapsedMs,
    taskError,
    reportError,
    run,
  }
}

