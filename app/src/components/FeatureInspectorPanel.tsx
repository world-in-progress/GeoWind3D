export type InspectedMapFeature = {
  key: string;
  logicalLayer: string;
  layerId: string;
  source?: string;
  sourceLayer?: string;
  featureId?: string | number;
  properties: Record<string, unknown>;
  geometryType?: string;
};

type FeatureInspectorPanelProps = {
  inspected: boolean;
  features: InspectedMapFeature[];
};

function formatValue(value: unknown) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function JsonTree({
  label,
  value,
  depth = 0,
}: {
  label: string;
  value: unknown;
  depth?: number;
}) {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';

  if (!isObject) {
    return (
      <div className='flex gap-2 py-0.5 text-[11px] leading-4'>
        <span className='shrink-0 font-medium text-slate-600'>{label}</span>
        <span className='min-w-0 break-all text-slate-900'>{formatValue(value)}</span>
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `Array(${entries.length})` : `Object(${entries.length})`;

  return (
    <details className='py-0.5' open={depth < 2}>
      <summary className='cursor-pointer select-none text-[11px] font-medium leading-4 text-slate-700'>
        <span>{label}</span>
        <span className='ml-2 font-normal text-slate-400'>{summary}</span>
      </summary>
      <div className='ml-3 border-l border-slate-200 pl-2'>
        {entries.length === 0 ? (
          <div className='py-0.5 text-[11px] text-slate-400'>empty</div>
        ) : (
          entries.map(([key, child]) => (
            <JsonTree key={`${label}-${key}`} label={key} value={child} depth={depth + 1} />
          ))
        )}
      </div>
    </details>
  );
}

function groupFeatures(features: InspectedMapFeature[]) {
  const groups = new Map<string, InspectedMapFeature[]>();
  for (const feature of features) {
    const group = groups.get(feature.logicalLayer);
    if (group) {
      group.push(feature);
    } else {
      groups.set(feature.logicalLayer, [feature]);
    }
  }
  return Array.from(groups.entries());
}

function FeaturePropertiesTree({ properties }: { properties: Record<string, unknown> }) {
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return <div className='py-0.5 text-[11px] text-slate-400'>empty</div>;
  }
  return (
    <>
      {entries.map(([key, value]) => (
        <JsonTree key={key} label={key} value={value} />
      ))}
    </>
  );
}

export function FeatureInspectorPanel({ inspected, features }: FeatureInspectorPanelProps) {
  const groups = groupFeatures(features);

  return (
    <section className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white/95 shadow-xl backdrop-blur'>
      <div className='shrink-0 border-b border-slate-200 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.5rem,1.1vh,0.75rem)]'>
        <h2 className='text-base font-semibold text-slate-950'>Identify Results</h2>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.5rem,1.1vh,0.75rem)]'>
        {!inspected ? (
          <div className='flex h-full items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-sm font-medium text-slate-500'>
            Click the map to identify rendered features
          </div>
        ) : features.length === 0 ? (
          <div className='flex h-full items-center justify-center rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-sm font-medium text-slate-500'>
            No rendered vector feature at this location
          </div>
        ) : (
          <div className='space-y-2'>
            {groups.map(([logicalLayer, layerFeatures]) => (
              <details key={logicalLayer} className='rounded-md border border-slate-200 bg-white' open>
                <summary className='cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-800'>
                  {logicalLayer}
                  <span className='ml-2 font-normal text-slate-400'>{layerFeatures.length}</span>
                </summary>
                <div className='space-y-2 border-t border-slate-100 p-2'>
                  {layerFeatures.map((feature, index) => (
                    <details key={feature.key} className='rounded border border-slate-100 bg-slate-50/80' open={index === 0}>
                      <summary className='cursor-pointer select-none px-2 py-1.5 text-[11px] font-semibold text-slate-700'>
                        Feature {index + 1}
                        {feature.featureId !== undefined ? (
                          <span className='ml-2 font-normal text-slate-400'>id={String(feature.featureId)}</span>
                        ) : null}
                      </summary>
                      <div className='border-t border-slate-100 px-2 py-1.5'>
                        <FeaturePropertiesTree properties={feature.properties} />
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
