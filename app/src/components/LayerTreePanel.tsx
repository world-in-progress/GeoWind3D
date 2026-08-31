import { LAYER_TREE_GROUPS, type LayerVisibility } from '../config/layerTree';

type LayerTreePanelProps = {
  visibility: LayerVisibility;
  workflowCompleted: boolean;
  onToggle: (key: keyof LayerVisibility) => void;
};

export function LayerTreePanel({ visibility, workflowCompleted, onToggle }: LayerTreePanelProps) {
  return (
    <section className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white/95 shadow-xl backdrop-blur'>
      <div className='border-b border-slate-200 px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.375rem,1vh,0.625rem)]'>
        <h2 className='text-base font-semibold text-slate-950'>Layer Tree</h2>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto px-[clamp(0.75rem,1.2vw,1rem)] py-[clamp(0.375rem,1.1vh,0.75rem)]'>
        {LAYER_TREE_GROUPS.map((group) => (
          <details key={group.id} className='mb-2 rounded-md border border-slate-200 bg-white' open>
            <summary className='cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-800'>
              {group.title}
            </summary>
            <div className='border-t border-slate-100 py-0.5'>
              {group.items.map((item) => {
                const disabled = (item.phase === 'intermediate' || item.phase === 'final') && !workflowCompleted;
                return (
                  <label
                    key={item.key}
                    className={`flex min-h-[clamp(1.5rem,3.65vh,1.75rem)] items-center justify-between gap-3 px-3 py-[clamp(0.125rem,0.5vh,0.25rem)] text-xs ${
                      disabled ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer text-slate-700'
                    }`}
                  >
                    <span className='truncate'>{item.label}</span>
                    <input
                      type='checkbox'
                      checked={visibility[item.key]}
                      disabled={disabled}
                      onChange={() => onToggle(item.key)}
                      className='h-3.5 w-3.5 shrink-0 cursor-pointer accent-slate-800 disabled:cursor-not-allowed'
                    />
                  </label>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
