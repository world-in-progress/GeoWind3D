import { useCallback, useEffect, useState } from 'react'
import { fetchModelConfig } from '../api/modelingApi'
import type { ConfigGroup, ModelingConfig, ModelingConfigValue } from '../types/modelingConfig'
import { normalizeWindDirection } from '../utils/mapGeometry'

export function useModelingConfig() {
  const [modelingConfig, setModelingConfig] = useState<ModelingConfig | null>(null)
  const [configGroups, setConfigGroups] = useState<ConfigGroup[]>([])
  const [configLoading, setConfigLoading] = useState(true)
  const [configError, setConfigError] = useState<string>()

  useEffect(() => {
    let active = true
    fetchModelConfig()
      .then((config) => {
        if (!active) return
        setConfigGroups(config.groups)
        setModelingConfig(config.defaults)
        setConfigError(undefined)
      })
      .catch((error) => {
        if (!active) return
        console.error('[config] failed:', error)
        setConfigError('Failed to load modeling configuration from the server.')
      })
      .finally(() => {
        if (active) setConfigLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const handleConfigChange = useCallback((key: keyof ModelingConfig, value: ModelingConfigValue) => {
    setModelingConfig((current) => {
      if (!current) return current
      return {
        ...current,
        [key]: key === 'windDirectionDeg' && typeof value === 'number'
          ? normalizeWindDirection(value)
          : value,
      }
    })
  }, [])

  return {
    modelingConfig,
    configGroups,
    configLoading,
    configError,
    handleConfigChange,
  }
}
