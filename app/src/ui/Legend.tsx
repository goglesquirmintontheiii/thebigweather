import { useMemo } from "preact/hooks";
import { rasterize, TEX_SIZE } from "../radar/colormaps";
import { speedFactor, convertUnit } from "../util";
import { settings, update } from "../store";
import { activeLegend } from "../active";

export function Legend() {
  const L = activeLegend.value;
  void settings.value.units;
  const t = L?.table;
  const bg = useMemo(() => {
    if (!t) return "";
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
  if (!L || !t) return null;
  const top = settings.value.ui.legendTop;
  const dock = {
    class: top ? "top" : "",
    title: top ? "Click to move the legend back to the corner" : "Click to show the legend as a strip across the top",
    onClick: () => update((x) => (x.ui.legendTop = !x.ui.legendTop)),
  };
  if (t.labels) {
    return (
      <div class={`legend glass cat ${dock.class}`} title={dock.title} onClick={dock.onClick}>
        {Object.entries(t.labels)
          .filter(([k]) => +k < 15 && +k >= 0)
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
  const ticks = top ? 12 : 6;
  let unitLabel = L.units;
  const labels = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = t.min + (i / ticks) * (t.max - t.min);
    let x = v;
    if (L.grid) {
      const [cv, u] = convertUnit(v, L.units);
      x = cv;
      unitLabel = u;
    } else if (t.units === "m/s") {
      x = v * speedFactor();
      unitLabel = settings.value.units.speed;
    }
    const ax = Math.abs(x);
    const span = Math.abs(t.max - t.min) * (L.grid ? Math.abs(convertUnit(1, L.units)[0] - convertUnit(0, L.units)[0]) || 1 : 1);
    return ax >= 10 || x === 0 || span >= 30 ? Math.round(x) : ax < 0.1 ? x.toFixed(3) : x.toFixed(ax < 1 ? 2 : 1);
  });
  return (
    <div class={`legend glass ${dock.class}`} title={dock.title} onClick={dock.onClick}>
      <div class="bar" style={{ background: bg }} />
      <div class="lticks">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      <div class="lunits">{unitLabel}</div>
    </div>
  );
}
