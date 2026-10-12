import { useMemo, useRef, useState, useEffect } from "preact/hooks";
import { rasterize, TEX_SIZE } from "../radar/colormaps";
import { speedFactor, convertUnit, fmtGrid, fmtValue } from "../util";
import { settings, update } from "../store";
import { activeLegend } from "../active";
import { displaySweep, liveSweep } from "../radar/controller";
import { hover } from "../map/mapview";
import { shiftHeld } from "./Readouts";
import { gateDrag, radarGateKey, gridGateKey, type Gate } from "../gate";
import { Eye, EyeOff, X } from "lucide-preact";

/** legend under the mouse (`,` / `.` nudge the low filter handle) */
let legendHovered = false;

function niceStep(span: number) {
  const raw = span / 100;
  for (const s of [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 50, 100]) if (s >= raw) return s;
  return 100;
}

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
  const barRef = useRef<HTMLDivElement>(null);
  const [mx, setMx] = useState<number | null>(null);
  const ctx = useRef<any>(null);

  // `,` / `.` move the low handle while the legend is hovered
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!legendHovered || (e.key !== "," && e.key !== "." && e.key !== "<" && e.key !== ">")) return;
      const tg = e.target as HTMLElement;
      if (tg.tagName === "INPUT" || tg.tagName === "SELECT" || tg.tagName === "TEXTAREA") return;
      e.preventDefault();
      ctx.current?.nudge("lo", e.key === "," || e.key === "<" ? -1 : 1, e.shiftKey ? 5 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // ---- value <-> bar position, native <-> display units ----
  const disp = (v: number) => (L.grid ? convertUnit(v, L.units)[0] : t.units === "m/s" ? v * speedFactor() : v);
  const d0 = disp(0);
  const dk = disp(1) - d0 || 1;
  const fromDisp = (x: number) => (x - d0) / dk;
  const fmt = (v: number) => (L.grid ? fmtGrid(v, L.units, t.labels) : fmtValue(v, t.units, t.labels));
  const frac = (v: number) => Math.max(0, Math.min(1, (v - t.min) / (t.max - t.min)));
  const valAt = (f: number) => t.min + f * (t.max - t.min);
  const step = niceStep(Math.abs(disp(t.max) - disp(t.min)));
  const snap = (v: number) => fromDisp(Math.round(disp(v) / step) * step);

  const w = settings.value.weather;
  const sw = displaySweep.value ?? liveSweep.value;
  const key = w.kind === "grid" ? gridGateKey(w.id) : radarGateKey(sw?.product || t.id);
  const drag = gateDrag.value;
  const saved: Gate = settings.value.gates?.[key] ?? {};
  const g: Gate = drag && drag.key === key ? drag.g : saved;
  // velocity-like (symmetric around zero): offer |v| filtering
  const twoSided = t.min < 0 && t.max > 0 && Math.abs(t.min + t.max) < 0.25 * (t.max - t.min);
  const abs = !!g.abs && twoSided;
  const amax = Math.max(Math.abs(t.min), Math.abs(t.max));
  const active = !g.off && (g.lo !== undefined || g.hi !== undefined);

  const commit = (n: Gate) =>
    update((s) => {
      s.gates = { ...(s.gates ?? {}) };
      if (n.lo === undefined && n.hi === undefined && !n.abs && !n.off) delete s.gates[key];
      else s.gates[key] = n;
    });
  /** clamp a handle value and drop it when it's back at the end of the scale */
  const fix = (which: "lo" | "hi", v: number, cur: Gate): Gate => {
    const n = { ...cur, off: undefined };
    if (abs) {
      v = Math.min(Math.abs(v), amax);
      if (which === "lo") n.lo = v <= amax * 0.004 ? undefined : Math.min(v, n.hi ?? amax);
      else n.hi = v >= amax * 0.996 ? undefined : Math.max(v, n.lo ?? 0);
    } else if (which === "lo") n.lo = frac(v) <= 0.004 ? undefined : Math.min(v, n.hi ?? t.max);
    else n.hi = frac(v) >= 0.996 ? undefined : Math.max(v, n.lo ?? t.min);
    return n;
  };
  const nudge = (which: "lo" | "hi", dir: number, mult = 1) => {
    const cur = settings.peek().gates?.[key] ?? {};
    const base = which === "lo" ? cur.lo ?? (abs ? 0 : t.min) : cur.hi ?? (abs ? amax : t.max);
    commit(fix(which, snap(fromDisp(disp(base) + dir * step * mult * (dk < 0 ? -1 : 1))), cur));
  };
  ctx.current = { nudge };

  const fracAt = (e: PointerEvent | WheelEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const startDrag = (which: "lo" | "hi") => (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic event */
    }
    const base: Gate = { ...saved, abs: abs || undefined };
    const move = (ev: PointerEvent) => {
      gateDrag.value = { key, g: fix(which, snap(valAt(fracAt(ev))), base) };
      setMx(fracAt(ev));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const d = gateDrag.peek();
      gateDrag.value = null;
      if (d && d.key === key) commit(d.g);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    move(e);
  };
  const wheel = (which: "lo" | "hi") => (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    nudge(which, e.deltaY < 0 ? 1 : -1, e.shiftKey ? 5 : 1);
  };

  // ---- readouts ----
  const readMode = settings.value.ui.cursorValue || shiftHeld.value;
  const h = hover.value;
  const mapVal = readMode && mx === null && h && Number.isFinite(h.value) && h.value > -9000 ? h.value : null;
  const loV = g.lo ?? (abs ? 0 : t.min);
  const hiV = g.hi ?? (abs ? amax : t.max);
  const masks: [number, number][] = [];
  if (!g.off) {
    if (abs) {
      if (g.lo !== undefined) masks.push([frac(-g.lo), frac(g.lo)]);
      if (g.hi !== undefined) masks.push([0, frac(-g.hi)], [frac(g.hi), 1]);
    } else {
      if (g.lo !== undefined) masks.push([0, frac(g.lo)]);
      if (g.hi !== undefined) masks.push([frac(g.hi), 1]);
    }
  }
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  const handle = (which: "lo" | "hi", v: number, ghost = false) => (
    <div
      key={`${which}${ghost ? "g" : ""}`}
      class={`lg-h ${which} ${ghost ? "ghost" : ""} ${(which === "lo" ? g.lo : g.hi) !== undefined && !g.off ? "set" : ""}`}
      style={{ left: pct(frac(v)) }}
      title={`${which === "lo" ? "Hide values below" : "Hide values above"} (drag, scroll${which === "lo" ? ", or , / . while hovering the legend" : ""})`}
      onPointerDown={startDrag(which) as any}
      onWheel={wheel(which) as any}
      onClick={(e) => e.stopPropagation()}
    />
  );
  const gateText = abs
    ? g.hi !== undefined
      ? `|v| ${fmt(g.lo ?? 0)} – ${fmt(g.hi)}`
      : `|v| ≥ ${fmt(g.lo ?? 0)}`
    : g.lo !== undefined && g.hi !== undefined
      ? `${fmt(g.lo)} – ${fmt(g.hi)}`
      : g.lo !== undefined
        ? `≥ ${fmt(g.lo)}`
        : g.hi !== undefined
          ? `≤ ${fmt(g.hi)}`
          : "";

  return (
    <div
      class={`legend glass ${dock.class} ${readMode ? "reading" : ""}`}
      title={dock.title}
      onClick={dock.onClick}
      onPointerEnter={() => (legendHovered = true)}
      onPointerLeave={() => ((legendHovered = false), setMx(null))}
    >
      <div class={`lgate ${active ? "on" : ""} ${g.off ? "paused" : ""}`} onClick={(e) => e.stopPropagation()}>
        {(active || g.off) && gateText && (
          <>
            <button class="lg-btn" title={g.off ? "Filter paused — click to apply" : "Filter on — click to pause"} onClick={() => commit({ ...saved, off: saved.off ? undefined : true })}>
              {g.off ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
            <span class="lg-txt">{gateText}</span>
          </>
        )}
        {twoSided && (
          <button class={`lg-btn txt ${abs ? "on" : ""}`} title="Filter by |value| (hide slow speeds both ways)" onClick={() => commit({ ...saved, abs: saved.abs ? undefined : true, lo: undefined, hi: undefined })}>
            |v|
          </button>
        )}
        {(active || g.off || g.abs) && (
          <button class="lg-btn" title="Reset filter" onClick={() => commit({})}>
            <X size={11} />
          </button>
        )}
      </div>
      <div
        class="lbar"
        ref={barRef}
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => setMx(fracAt(e as any))}
        onPointerLeave={() => setMx(null)}
        title=""
      >
        <div class="bar" style={{ background: bg }} />
        {masks.map(([a, b], i) => (
          <div key={i} class="lg-mask" style={{ left: pct(Math.min(a, b)), width: pct(Math.abs(b - a)) }} />
        ))}
        {handle("lo", loV)}
        {abs && g.lo !== undefined && handle("lo", -loV, true)}
        {handle("hi", hiV)}
        {abs && g.hi !== undefined && handle("hi", -hiV, true)}
        {mapVal !== null && <div class="lg-map" style={{ left: pct(frac(mapVal)) }} />}
        {readMode && mx !== null && (
          <>
            <div class="lg-cur" style={{ left: pct(mx) }} />
            <div class="lg-tip" style={{ left: pct(Math.max(0.06, Math.min(0.94, mx))) }}>
              {fmt(snap(valAt(mx)))}
            </div>
          </>
        )}
        {!readMode && drag && drag.key === key && mx !== null && (
          <div class="lg-tip" style={{ left: pct(Math.max(0.06, Math.min(0.94, mx))) }}>
            {abs ? `|v| ${fmt(Math.abs(snap(valAt(mx))))}` : fmt(snap(valAt(mx)))}
          </div>
        )}
      </div>
      <div class="lticks">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
      <div class="lunits">{unitLabel}</div>
    </div>
  );
}
