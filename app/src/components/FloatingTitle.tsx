export function FloatingTitle() {
  return (
    <div className='pointer-events-none flex h-[clamp(4.75rem,9.65vh,6.5rem)] w-full shrink-0 items-center overflow-hidden rounded-xl border border-slate-200/80 bg-white/92 px-[clamp(0.75rem,1.2vw,1rem)] shadow-[0_18px_44px_rgba(15,23,42,0.18)] backdrop-blur-md'>
      <div className='flex items-center gap-[clamp(0.625rem,1vw,0.875rem)]'>
        <img src='/logo.png' alt='GeoWind3D logo' className='h-[clamp(2.5rem,5.2vh,3.5rem)] w-[clamp(2.5rem,5.2vh,3.5rem)] shrink-0 object-contain' />
        <div>
          <h1 className='text-[clamp(1.25rem,2.2vh,1.5rem)] font-semibold leading-[1.15] text-slate-950'>
            GeoWind3D
          </h1>
          <div className='mt-[clamp(0.2rem,0.55vh,0.375rem)] text-[clamp(11px,1.1vh,12px)] font-medium leading-[1.35] tracking-[0.01em] text-slate-600'>
            A Reality-Based Urban Geometry Modeling System for Wind Simulation
          </div>
        </div>
      </div>
    </div>
  );
}
