import type { ConfigGroup, ModelingConfig, ModelingConfigValue } from '../types/modelingConfig';

type ModelSetupPanelProps = {
  groups: ConfigGroup[];
  values: ModelingConfig | null;
  selectedAreaReady: boolean;
  running: boolean;
  configLoading: boolean;
  onChange: (key: keyof ModelingConfig, value: ModelingConfigValue) => void;
  onDrawArea: () => void;
  onUploadGeoJson: () => void;
  onRun: () => void;
};

function FieldHelp({ description }: { description: string }) {
  return (
    <span className='group relative inline-flex'>
      <button
        type='button'
        className='flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-300 bg-white text-[9px] font-semibold leading-none text-slate-500 transition-colors hover:border-slate-500 hover:text-slate-800 focus:border-slate-700 focus:text-slate-900 focus:outline-none'
        aria-label={description}
      >
        ?
      </button>
      <span className='pointer-events-none absolute left-1/2 top-6 z-50 w-64 -translate-x-1/2 rounded-md border border-slate-200 bg-slate-950 px-3 py-2 text-xs font-normal leading-5 text-white opacity-0 shadow-xl transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'>
        {description}
      </span>
    </span>
  );
}

function formatOptionLabel(option: number | string): string {
  if (typeof option === 'number') return String(option);
  if (option === 'roof_mesh') return '3D Image Data';
  if (option === 'osm') return 'OSM Attributes';
  return option
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ConfigInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ConfigGroup['fields'][number];
  value: ModelingConfigValue;
  disabled?: boolean;
  onChange: (value: ModelingConfigValue) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <button
        type='button'
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${value ? 'bg-slate-800' : 'bg-slate-300'} disabled:cursor-not-allowed disabled:opacity-50`}
        aria-pressed={Boolean(value)}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'left-[1.125rem]' : 'left-0.5'}`}
        />
      </button>
    );
  }

  if (field.type === 'select') {
    const hasStringOptions = (field.options ?? []).some((option) => typeof option === 'string');
    return (
      <select
        disabled={disabled}
        value={String(value)}
        onChange={(event) => onChange(hasStringOptions ? event.target.value : Number(event.target.value))}
        className='h-7 w-full cursor-pointer rounded border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100'
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {formatOptionLabel(option)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className='flex items-center gap-2'>
      <input
        disabled={disabled}
        type='number'
        min={field.min}
        max={field.max}
        step={field.step}
        value={Number(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className='h-7 w-full cursor-text rounded border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100'
      />
      {field.unit ? <span className='w-8 text-[11px] text-slate-500'>{field.unit}</span> : null}
    </div>
  );
}

export function ModelSetupPanel({
  groups,
  values,
  selectedAreaReady,
  running,
  configLoading,
  onChange,
  onDrawArea,
  onUploadGeoJson,
  onRun,
}: ModelSetupPanelProps) {
  const studyGroup = groups.find((group) => group.id === 'study-area');
  const modelingGroups = groups.filter((group) => group.id !== 'study-area');

  return (
    <section className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white/95 shadow-xl backdrop-blur'>
      <div className='border-b border-slate-200 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.375rem,1vh,0.625rem)]'>
        <h2 className='text-base font-semibold text-slate-950'>Workflow Setup</h2>
      </div>

      <div className='flex-1 overflow-y-auto px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.375rem,1vh,0.625rem)]'>
        {configLoading || !values ? (
          <div className='rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500'>
            Loading modeling configuration...
          </div>
        ) : (
          <>
            <details className='mb-2 rounded-md border border-slate-200 bg-white' open>
              <summary className='cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-800'>
                Scene Setup
              </summary>
              <div className='border-t border-slate-100 px-3 py-2'>
                <div className='mb-1.5 flex items-center justify-between gap-3'>
                  <div className='text-xs font-medium text-slate-800'>Study Area</div>
                  <div className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${selectedAreaReady ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                    {selectedAreaReady ? 'Ready' : 'Required'}
                  </div>
                </div>
                <div className='rounded-md border border-slate-200 bg-slate-50 p-2.5'>
                  <div className='grid grid-cols-2 gap-2'>
                    <button
                      type='button'
                      onClick={onDrawArea}
                      className='flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-slate-700 bg-slate-700 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:border-slate-800 hover:bg-slate-800'
                    >
                      Draw on Map
                    </button>
                    <button
                      type='button'
                      onClick={onUploadGeoJson}
                      className='flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-slate-700 bg-slate-700 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:border-slate-800 hover:bg-slate-800'
                    >
                      Import GeoJSON
                    </button>
                  </div>
                  <div className='mt-2 text-[11px] leading-4 text-slate-500'>
                    {selectedAreaReady ? 'The selected polygon will be used as the modeling domain.' : 'Draw a polygon on the map or import a GeoJSON polygon.'}
                  </div>
                </div>

                {(studyGroup?.fields ?? []).map((field) => (
                  <div key={field.key} className='grid min-h-[clamp(2rem,4.2vh,2.5rem)] grid-cols-[1fr_132px] items-center gap-3 border-b border-slate-100 py-[clamp(0.25rem,0.8vh,0.375rem)] last:border-b-0'>
                    <div className='flex min-h-7 items-center'>
                      <div className='flex items-center gap-1.5'>
                        <label className='text-xs font-medium text-slate-800'>{field.label}</label>
                        <FieldHelp description={field.description} />
                      </div>
                    </div>
                    <div className='flex items-center justify-end'>
                      <ConfigInput
                        field={field}
                        value={values[field.key]}
                        disabled={running}
                        onChange={(value) => onChange(field.key, value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </details>

            {modelingGroups.map((group) => (
              <details key={group.id} className='mb-2 rounded-md border border-slate-200 bg-white'>
                <summary className='cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-800'>
                  {group.title}
                </summary>
                <div className='border-t border-slate-100 px-3 py-1.5'>
                  {group.fields.map((field) => (
                    <div key={field.key} className='grid min-h-[clamp(2rem,4.2vh,2.5rem)] grid-cols-[1fr_132px] items-center gap-3 border-b border-slate-100 py-[clamp(0.25rem,0.8vh,0.375rem)] last:border-b-0'>
                      <div className='flex min-h-7 items-center'>
                        <div className='flex items-center gap-1.5'>
                          <label className='text-xs font-medium text-slate-800'>{field.label}</label>
                          <FieldHelp description={field.description} />
                        </div>
                      </div>
                      <div className='flex items-center justify-end'>
                        <ConfigInput
                          field={field}
                          value={values[field.key]}
                          disabled={running || (field.key !== 'enableBridge' && group.id === 'elevated-walkway' && !values.enableBridge)}
                          onChange={(value) => onChange(field.key, value)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </>
        )}
      </div>

      <div className='border-t border-slate-200 bg-white px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.375rem,1vh,0.625rem)]'>
        <button
          type='button'
          disabled={!selectedAreaReady || running || !values}
          onClick={onRun}
          className='w-full cursor-pointer rounded bg-blue-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300'
        >
          {running ? 'Running Workflow...' : 'Run Modeling Workflow'}
        </button>
      </div>
    </section>
  );
}
