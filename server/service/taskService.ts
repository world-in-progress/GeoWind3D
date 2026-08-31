import { EventEmitter } from 'events';
import type { Response } from 'express';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TaskLogLevel = 'info' | 'warn' | 'error';

export type TaskLogEntry = {
  timestamp: string;
  level: TaskLogLevel;
  scope: string;
  message: string;
  meta?: unknown;
};

export type TaskRecord = {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  logs: TaskLogEntry[];
  result?: unknown;
  error?: string;
  openfoamCasePath?: string | null;
};

export type TaskEvent =
  | { type: 'status'; taskId: string; status: TaskStatus; startedAt?: string; completedAt?: string; elapsedMs?: number }
  | { type: 'log'; taskId: string; log: TaskLogEntry }
  | { type: 'complete'; taskId: string; status: 'completed'; completedAt: string; elapsedMs: number; result: unknown }
  | { type: 'error'; taskId: string; status: 'failed'; completedAt: string; elapsedMs: number; message: string };

export type TaskLogger = {
  log(scope: string, message: string, meta?: unknown): void;
  warn(scope: string, message: string, meta?: unknown): void;
  error(scope: string, message: string, meta?: unknown): void;
};

export type TaskLogMethod = 'log' | 'warn' | 'error';

const tasks = new Map<string, TaskRecord>();
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function nowIso() {
  return new Date().toISOString();
}

function emitTaskEvent(taskId: string, event: TaskEvent) {
  emitter.emit(taskId, event);
}

function writeSse(res: Response, event: TaskEvent) {
  const eventName = event.type === 'error' ? 'task-error' : event.type;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function elapsedFrom(record: TaskRecord) {
  const start = record.startedAt ? Date.parse(record.startedAt) : Date.parse(record.createdAt);
  return Date.now() - start;
}

function consoleWrite(level: TaskLogLevel, scope: string, message: string, meta?: unknown) {
  const prefix = `[${scope}] ${message}`;
  if (level === 'error') {
    meta === undefined ? console.error(prefix) : console.error(prefix, meta);
  } else if (level === 'warn') {
    meta === undefined ? console.warn(prefix) : console.warn(prefix, meta);
  } else {
    meta === undefined ? console.log(prefix) : console.log(prefix, meta);
  }
}

export function writeTaskLog(
  logger: TaskLogger | undefined,
  method: TaskLogMethod,
  scope: string,
  message: string,
  meta?: unknown,
) {
  if (logger) {
    logger[method](scope, message, meta);
    return;
  }
  const level: TaskLogLevel = method === 'error' ? 'error' : method === 'warn' ? 'warn' : 'info';
  consoleWrite(level, scope, message, meta);
}

export function createTask(taskId: string): TaskRecord {
  const record: TaskRecord = {
    taskId,
    status: 'queued',
    createdAt: nowIso(),
    logs: [],
  };
  tasks.set(taskId, record);
  return record;
}

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export function createTaskLogger(taskId: string): TaskLogger {
  const write = (level: TaskLogLevel, scope: string, message: string, meta?: unknown) => {
    const record = tasks.get(taskId);
    const entry: TaskLogEntry = {
      timestamp: nowIso(),
      level,
      scope,
      message,
      meta,
    };
    if (record) {
      record.logs.push(entry);
    }
    consoleWrite(level, scope, message, meta);
    emitTaskEvent(taskId, { type: 'log', taskId, log: entry });
  };

  return {
    log: (scope, message, meta) => write('info', scope, message, meta),
    warn: (scope, message, meta) => write('warn', scope, message, meta),
    error: (scope, message, meta) => write('error', scope, message, meta),
  };
}

export function markTaskRunning(taskId: string) {
  const record = tasks.get(taskId);
  if (!record) return;
  record.status = 'running';
  record.startedAt = nowIso();
  emitTaskEvent(taskId, { type: 'status', taskId, status: 'running', startedAt: record.startedAt });
}

export function markTaskCompleted(taskId: string, result: unknown, openfoamCasePath?: string | null) {
  const record = tasks.get(taskId);
  if (!record) return;
  record.status = 'completed';
  record.completedAt = nowIso();
  record.elapsedMs = elapsedFrom(record);
  record.result = result;
  record.openfoamCasePath = openfoamCasePath ?? null;
  emitTaskEvent(taskId, {
    type: 'complete',
    taskId,
    status: 'completed',
    completedAt: record.completedAt,
    elapsedMs: record.elapsedMs,
    result,
  });
}

export function markTaskFailed(taskId: string, message: string) {
  const record = tasks.get(taskId);
  if (!record) return;
  record.status = 'failed';
  record.completedAt = nowIso();
  record.elapsedMs = elapsedFrom(record);
  record.error = message;
  emitTaskEvent(taskId, {
    type: 'error',
    taskId,
    status: 'failed',
    completedAt: record.completedAt,
    elapsedMs: record.elapsedMs,
    message,
  });
}

export function subscribeTaskEvents(taskId: string, res: Response): boolean {
  const record = tasks.get(taskId);
  if (!record) return false;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  writeSse(res, {
    type: 'status',
    taskId,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    elapsedMs: record.elapsedMs,
  });
  record.logs.forEach((log) => writeSse(res, { type: 'log', taskId, log }));
  if (record.status === 'completed' && record.result !== undefined && record.completedAt && record.elapsedMs !== undefined) {
    writeSse(res, { type: 'complete', taskId, status: 'completed', completedAt: record.completedAt, elapsedMs: record.elapsedMs, result: record.result });
  }
  if (record.status === 'failed' && record.error && record.completedAt && record.elapsedMs !== undefined) {
    writeSse(res, { type: 'error', taskId, status: 'failed', completedAt: record.completedAt, elapsedMs: record.elapsedMs, message: record.error });
  }

  const listener = (event: TaskEvent) => writeSse(res, event);
  emitter.on(taskId, listener);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    emitter.off(taskId, listener);
  });

  return true;
}
