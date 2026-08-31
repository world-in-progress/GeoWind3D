import axios from 'axios';
import type { ModelingConfig, ModelConfigResponse } from '../types/modelingConfig';
import type { ModelingWorkflowResult } from '../types/modelingResult';

export const http = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function fetchModelConfig(): Promise<ModelConfigResponse> {
  const response = await http.get<ModelConfigResponse>('/model/config');
  return response.data;
}

export async function fetchExcludedBuildings(): Promise<GeoJSON.FeatureCollection> {
  const response = await http.get<{ success: boolean; data: GeoJSON.FeatureCollection }>('/buildings/excluded');
  return response.data.data;
}

export type HeightSampleDebugResult = {
  lon: number;
  lat: number;
  height: number | null;
  level: number;
  tileCount: number;
  triangleCount: number;
  elapsedMs: number;
};

export async function sampleDebugHeight(lon: number, lat: number): Promise<HeightSampleDebugResult> {
  const response = await http.post<{ success: boolean; data: HeightSampleDebugResult }>('/debug/height-sample', {
    lon,
    lat,
  });
  return response.data.data;
}

export type TaskLogEntry = {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  meta?: unknown;
};

export type TaskEvent =
  | { type: 'status'; taskId: string; status: 'queued' | 'running' | 'completed' | 'failed'; startedAt?: string; completedAt?: string; elapsedMs?: number }
  | { type: 'log'; taskId: string; log: TaskLogEntry }
  | { type: 'complete'; taskId: string; status: 'completed'; completedAt: string; elapsedMs: number; result: ModelingWorkflowResult }
  | { type: 'error'; taskId: string; status: 'failed'; completedAt: string; elapsedMs: number; message: string };

export async function createModelTask(payload: {
  bound: GeoJSON.Feature<GeoJSON.Polygon>;
  config: ModelingConfig;
}): Promise<{ success: boolean; taskId: string }> {
  const response = await http.post('/model/tasks', {
    bound: payload.bound,
    tileLevel: payload.config.tileLevel,
    windDirectionDeg: payload.config.windDirectionDeg,
    config: payload.config,
  });
  return response.data;
}

export function subscribeTaskEvents(
  taskId: string,
  handlers: {
    onEvent: (event: TaskEvent) => void;
    onError?: (event: Event) => void;
  },
) {
  const source = new EventSource(`/api/model/tasks/${taskId}/events`);
  const handleMessage = (event: MessageEvent) => {
    handlers.onEvent(JSON.parse(event.data) as TaskEvent);
  };
  ['status', 'log', 'complete', 'task-error'].forEach((eventName) => {
    source.addEventListener(eventName, handleMessage as EventListener);
  });
  source.onerror = (event) => {
    handlers.onError?.(event);
  };
  return () => source.close();
}

export function getOpenFOAMDownloadUrl(taskId: string) {
  return `/api/model/tasks/${taskId}/openfoam.zip`;
}
