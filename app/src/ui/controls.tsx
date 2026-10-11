// Small shared form controls.

export function Slider({ label, value, min, max, step = 1, fmt, set, live = true, hint }: { label: string; value: number; min: number; max: number; step?: number; fmt?: (v: number) => string; set: (v: number) => void; live?: boolean; hint?: string }) {
  const h = (e: Event) => set(+(e.target as HTMLInputElement).value);
  return (
    <div class="row" title={hint}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} {...(live ? { onInput: h } : { onChange: h })} />
      <span class="val">{fmt ? fmt(value) : value}</span>
    </div>
  );
}

export const smoothLabel = (v: number) => (v <= 0 ? "Off" : v < 0.35 ? "Light" : v < 0.65 ? "Medium" : v < 0.9 ? "Strong" : "Max");

export function Select<T extends string>({ label, value, options, set }: { label: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <div class="row">
      <span>{label}</span>
      <select value={value} onChange={(e) => set((e.target as HTMLSelectElement).value as T)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
