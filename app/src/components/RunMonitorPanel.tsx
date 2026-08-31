import { useEffect, useRef } from 'react';
import { getOpenFOAMDownloadUrl, type TaskLogEntry } from '../api/modelingApi';

type RunMonitorPanelProps = {
  taskId?: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  logs: TaskLogEntry[];
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  className?: string;
};

function formatTime(value?: string) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatElapsed(value?: number) {
  if (value === undefined) return '--';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function RunMonitorPanel({
  taskId,
  status,
  logs,
  startedAt,
  completedAt,
  elapsedMs,
  className,
}: RunMonitorPanelProps) {
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = logScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [logs, status]);

  const statusTone = {
    idle: 'bg-slate-100 text-slate-600',
    queued: 'bg-slate-100 text-slate-700',
    running: 'bg-blue-100 text-blue-800',
    completed: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-red-100 text-red-800',
  }[status];
  const rootClassName = className ?? 'absolute right-6 top-24 z-20 h-[min(32.5rem,calc(100vh-10rem))] w-[clamp(20rem,28vw,26rem)] xl:right-8 xl:top-32';

  return (
    <section className={`${rootClassName} flex flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white/95 shadow-xl backdrop-blur`}>
      <div className='shrink-0 border-b border-slate-200 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.5rem,1.1vh,0.75rem)]'>
        <div className='flex items-center justify-between gap-3'>
          <h2 className='text-base font-semibold text-slate-950'>Workflow Monitor</h2>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusTone}`}>
            {status}
          </span>
        </div>
        <div className='mt-2 grid grid-cols-3 gap-2 text-xs text-slate-500'>
          <div>
            <span className='block font-medium text-slate-700'>Started</span>
            {formatTime(startedAt)}
          </div>
          <div>
            <span className='block font-medium text-slate-700'>Finished</span>
            {formatTime(completedAt)}
          </div>
          <div>
            <span className='block font-medium text-slate-700'>Elapsed</span>
            {formatElapsed(elapsedMs)}
          </div>
        </div>
      </div>

      <div className='min-h-0 flex-1 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.5rem,1.1vh,0.75rem)]'>
        <div
          ref={logScrollRef}
          className='h-full overflow-y-auto rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-700'
        >
          {logs.length === 0 ? (
            <div className='flex h-full items-center justify-center text-sm font-medium text-slate-500'>
              No output yet
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={`${log.timestamp}-${index}`}
                className={log.level === 'error' ? 'text-red-700' : log.level === 'warn' ? 'text-amber-700' : 'text-slate-700'}
              >
                <span className='mr-2 inline-flex rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600'>
                  {log.scope}
                </span>
                <span>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className='flex shrink-0 justify-end border-t border-slate-200 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.5rem,1.1vh,0.75rem)]'>
        <a
          href={taskId && status === 'completed' ? getOpenFOAMDownloadUrl(taskId) : undefined}
          className={`shrink-0 rounded-md px-3 py-2 text-sm font-semibold ${
            taskId && status === 'completed'
              ? 'bg-slate-800 text-white hover:bg-slate-900'
              : 'pointer-events-none bg-slate-200 text-slate-400'
          }`}
        >
          Download OpenFOAM Case
        </a>
      </div>
    </section>
  );
}

