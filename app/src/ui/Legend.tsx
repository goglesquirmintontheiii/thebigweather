import { useMemo } from "preact/hooks";
import { activeTable, displaySweep } from "../radar/controller";
import { rasterize, TEX_SIZE } from "../radar/colormaps";
import { speedFactor } from "../util";
import { settings } from "../store";

export function Legend() {
  const t = activeTable.value;
  void settings.value.units.speed;
  const sweep = displaySweep.value;
  const bg = useMemo(() => {
    const r = rasterize(t);
    const stops: string[] = [];
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const k = Math.min(TEX_SIZE - 1, Math.floor((i / n) * (TEX_SIZE - 1)));
      const a = r[k * 4 + 3] / 255;
      stops.push(`rgba(${r[k * 4]},${r[k * 4 + 1]},${r[k * 4 + 2]},${Math.max(a, 0.15)}) ${((i / n) * 100).toFixed(1)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(",")})`;
  }, [t]);
  if (!sweep) return null;
  if (t.labels) {
    return (
      <div class="legend glass cat">
        {Object.entries(t.labels)
          .filter(([k]) => +k < 15)
          .map(([k, name]) => {
            const s = t.stops.find((x) => x.v === +k);
            return (
              <span key={k} class="cat-item">
                <i style={{ background: s ? `rgb(${s.c[0]},${s.c[1]},${s.c[2]})` : "#888" }} />
                {name}
              </span>
            );
          })}
      </div>
    );
  }
  const speed = t.units === "m/s";
  const f = speed ? speedFactor() : 1;
  const ticks = 6;
  const labels = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = t.min + (i / ticks) * (t.max - t.min);
    const x = v * f;
    return Math.abs(x) >= 10 || x === 0 ? Math.round(x) : x.toFixed(t.units === "" ? 2 : 1);
  });
  return (
    <div class="legend glass">
      <div class="bar" style={{ background: bg }} />
      <div class="lticks">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      <div class="lunits">{speed ? settings.value.units.speed : t.units}</div>
    </div>
  );
}
