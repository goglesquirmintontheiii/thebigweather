// data 0.6: a small reusable time-series chart (canvas) and the "Compare models" meteogram: one
// line per model (Open-Meteo multi-model API) for temperature, precipitation, wind, pressure and
// cloud at a point.

import { themeLight } from "../theme";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { settings, update } from "../store";
import { registerChart, newChartId } from "../export/svg"; // data 0.8
import { exportCanvas } from "../export/export"; // data 0.8

// ---------- generic chart ----------

export interface LSeries {
  id: string;
  name: string;
  color: string;
  v: (number | null | undefined)[];
  bar?: boolean;
  dash?: boolean;
  width?: number;
  /** drawn but left out of the hover list */
  quiet?: boolean;
}
export interface LBand {
  lo: (number | null | undefined)[];
  hi: (number | null | undefined)[];
  color: string;
  name?: string;
}

const tzOpt = (tz?: string) => (settings.value.utc ? "UTC" : tz);

export function LineChart({
  t,
  series,
  h = 130,
  unit = "",
  tz,
  fixed,
  band,
  title,
  fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)),
  daily = false,
  zero = false,
  marks,
}: {
  t: number[];
  series: LSeries[];
  h?: number;
  unit?: string;
  tz?: string;
  fixed?: [number, number];
  band?: LBand;
  title?: string;
  fmt?: (v: number) => string;
  /** one value per day (day ticks, no hours) */
  daily?: boolean;
  /** include 0 in the y range */
  zero?: boolean;
  /** shaded time spans (night, darkness) */
  marks?: { t0: number; t1: number; color: string }[];
}) {
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const chartId = useRef(newChartId()); // data 0.8: SVG export
  const [w, setW] = useState(700);
  const [hov, setHov] = useState<number | null>(null);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setW(wrap.current.clientWidth));
    ro.observe(wrap.current!);
    (document as any).fonts?.ready?.then(() => setFontTick((k) => k + 1)); // redraw once the UI font is in
    return () => ro.disconnect();
  }, []);
  const L = 40;
  const R = 10;
  const top = title ? 18 : 8;
  const bottom = h - 16;
  const n = t.length;
  const t0 = t[0] ?? 0;
  const t1 = t[n - 1] ?? 1;
  const x = (tt: number) => L + (t1 > t0 ? ((tt - t0) / (t1 - t0)) * (w - L - R) : 0);
  const range = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const add = (v: any) => {
      if (v == null || !Number.isFinite(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    for (const s of series) s.v.forEach(add);
    if (band) (band.lo.forEach(add), band.hi.forEach(add));
    if (fixed) return fixed;
    if (!Number.isFinite(lo)) return [0, 1] as [number, number];
    if (zero) (lo = Math.min(0, lo), (hi = Math.max(0, hi)));
    const pad = Math.max((hi - lo) * 0.08, 0.5);
    return [zero && lo === 0 ? 0 : lo - pad, hi + pad] as [number, number];
  }, [series, band, fixed, zero]);
  const y = (v: number) => bottom - ((v - range[0]) / (range[1] - range[0] || 1)) * (bottom - top);
  useEffect(() => {
    const c = cv.current;
    if (!c || n < 1) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = "10px Inter, system-ui, sans-serif";
    const lt = themeLight.value; // light theme: dark text and grid
    const ink = (a: number) => (lt ? `rgba(15,23,42,${a})` : `rgba(255,255,255,${a})`);
    for (const m of marks ?? []) {
      g.fillStyle = m.color;
      const a = Math.max(L, x(m.t0));
      const b = Math.min(w - R, x(m.t1));
      if (b > a) g.fillRect(a, top, b - a, bottom - top);
    }
    // y grid
    const span = range[1] - range[0];
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    const stp = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
    g.textAlign = "right";
    for (let v = Math.ceil(range[0] / stp) * stp; v <= range[1] + 1e-9; v += stp) {
      g.strokeStyle = ink(lt ? 0.1 : 0.07);
      g.beginPath();
      g.moveTo(L, y(v));
      g.lineTo(w - R, y(v));
      g.stroke();
      g.fillStyle = lt ? "#5b6675" : "#8b97a6";
      g.fillText(fmt(v), L - 4, y(v) + 3);
    }
    // x: day separators
    g.textAlign = "left";
    let lastKey = "";
    const every = daily ? Math.max(1, Math.ceil(n / ((w - L) / 46))) : 1;
    t.forEach((tt, i) => {
      const k = new Date(tt).toLocaleDateString("en-CA", { timeZone: tzOpt(tz) });
      if (daily) {
        if (i % every) return;
        g.fillStyle = lt ? "#5b6675" : "#8b97a6";
        g.fillText(new Date(tt).toLocaleDateString(undefined, { month: "numeric", day: "numeric", timeZone: tzOpt(tz) }), x(tt) - 8, h - 4);
        return;
      }
      if (k !== lastKey) {
        lastKey = k;
        if (i > 0) {
          g.strokeStyle = ink(lt ? 0.2 : 0.14);
          g.beginPath();
          g.moveTo(x(tt), top);
          g.lineTo(x(tt), bottom);
          g.stroke();
        }
        g.fillStyle = lt ? "#4b5563" : "#9aa6b5";
        g.fillText(new Date(tt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: tzOpt(tz) }), x(tt) + 3, h - 4);
      }
    });
    if (title) {
      g.fillStyle = lt ? "#1f2937" : "#c4cdd8";
      g.font = "600 10.5px Inter, system-ui, sans-serif";
      g.fillText(`${title}${unit ? ` (${unit})` : ""}`, L, 11);
      g.font = "10px Inter, system-ui, sans-serif";
    }
    if (band) {
      g.fillStyle = band.color;
      g.beginPath();
      let open = false;
      const pts: [number, number][] = [];
      t.forEach((tt, i) => {
        const a = band.hi[i];
        if (a == null) return;
        pts.push([x(tt), y(a)]);
      });
      for (let i = n - 1; i >= 0; i--) {
        const b = band.lo[i];
        if (b == null) continue;
        pts.push([x(t[i]), y(b)]);
      }
      for (const [px, py] of pts) open ? g.lineTo(px, py) : (g.moveTo(px, py), (open = true));
      g.closePath();
      g.fill();
    }
    const bw = Math.max(1.5, ((w - L - R) / Math.max(1, n)) * 0.7);
    for (const s of series) {
      g.strokeStyle = g.fillStyle = s.color;
      g.lineWidth = s.width ?? 1.6;
      g.setLineDash(s.dash ? [4, 3] : []);
      if (s.bar) {
        const nb = series.filter((q) => q.bar).length;
        const k = series.filter((q) => q.bar).indexOf(s);
        s.v.forEach((v, i) => {
          if (v == null || !(v > 0)) return;
          const bx = x(t[i]) - bw / 2 + (k * bw) / nb;
          g.fillRect(bx, y(v), bw / nb, y(Math.max(range[0], 0)) - y(v));
        });
        continue;
      }
      g.beginPath();
      let pen = false;
      s.v.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) return (pen = false);
        pen ? g.lineTo(x(t[i]), y(v)) : (g.moveTo(x(t[i]), y(v)), (pen = true));
      });
      g.stroke();
      if (n < 3)
        s.v.forEach((v, i) => {
          if (v == null) return;
          g.beginPath();
          g.arc(x(t[i]), y(v), 2.5, 0, Math.PI * 2);
          g.fill();
        });
    }
    g.setLineDash([]);
    registerChart(chartId.current, { title: title ?? "", unit, t, series, band, range, w, h, tz, utc: settings.value.utc, fmt, el: c }); // data 0.8
    if (hov != null && t[hov] != null) {
      g.strokeStyle = ink(0.5);
      g.beginPath();
      g.moveTo(x(t[hov]), top);
      g.lineTo(x(t[hov]), bottom);
      g.stroke();
    }
  }, [w, h, t, series, band, range, hov, title, marks, fontTick, themeLight.value]);
  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < L || n < 1) return setHov(null);
    const tt = t0 + ((px - L) / (w - L - R)) * (t1 - t0);
    let bi = 0;
    for (let i = 0; i < n; i++) if (Math.abs(t[i] - tt) < Math.abs(t[bi] - tt)) bi = i;
    setHov(bi);
  };
  const hx = hov != null ? x(t[hov]) : 0;
  return (
    <div class="d6-chart" ref={wrap} onPointerMove={onMove as any} onPointerLeave={() => setHov(null)}>
      <canvas ref={cv} style={{ width: `${w}px`, height: `${h}px` }} />
      {/* data 0.8: save this chart */}
      <div class="p8-chart-dl">
        {(["png", "svg"] as const).map((f) => (
          <button key={f} title={`Save chart as ${f.toUpperCase()}`} onClick={() => exportCanvas({ id: `chart:${chartId.current}`, name: title || "chart", svg: true, canvas: () => cv.current }, f)}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>
      {hov != null && (
        <div class="d6-tip glass" style={{ left: `${Math.min(hx + 10, w - 170)}px` }}>
          <b>{new Date(t[hov]).toLocaleString(undefined, daily ? { weekday: "short", month: "short", day: "numeric", timeZone: tzOpt(tz) } : { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tzOpt(tz) })}</b>
          {band && band.lo[hov] != null && (
            <div>
              <i style={{ background: band.color }} />
              {band.name ?? "Range"} <b>{fmt(band.lo[hov]!)}–{fmt(band.hi[hov]!)}</b>
            </div>
          )}
          {series
            .filter((s) => !s.quiet && s.v[hov] != null)
            .map((s) => (
              <div key={s.id}>
                <i style={{ background: s.color }} />
                {s.name} <b>{fmt(s.v[hov]!)}{unit && unit !== "%" ? "" : unit}</b>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------- multi-model meteogram ----------

export const CM_MODELS = [
  { id: "gfs_seamless", name: "GFS", color: "#60a5fa", on: true },
  { id: "ecmwf_ifs025", name: "ECMWF", color: "#f472b6", on: true },
  { id: "icon_seamless", name: "ICON", color: "#4ade80", on: true },
  { id: "gem_seamless", name: "GEM", color: "#f87171", on: true },
  { id: "ukmo_seamless", name: "UKMO", color: "#a78bfa", on: true },
  { id: "jma_seamless", name: "JMA", color: "#facc15", on: true },
  { id: "meteofrance_seamless", name: "Météo-France", color: "#22d3ee", on: true },
  { id: "gfs_hrrr", name: "HRRR", color: "#fb923c", on: true },
  { id: "ecmwf_aifs025_single", name: "ECMWF AIFS", color: "#e879f9", on: false },
  { id: "kma_seamless", name: "KMA", color: "#94a3b8", on: false },
  { id: "cma_grapes_global", name: "CMA", color: "#fca5a5", on: false },
  { id: "bom_access_global", name: "BOM", color: "#bef264", on: false },
];
const CM_VARS = "temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,pressure_msl,cloud_cover";
type CmVar = "temperature_2m" | "precipitation" | "wind_speed_10m" | "wind_gusts_10m" | "pressure_msl" | "cloud_cover";
export interface MultiModel {
  t: number[];
  tz?: string;
  /** model → variable → values (metric: °C, mm, m/s, hPa, %) */
  m: Record<string, Partial<Record<CmVar, (number | null)[]>>>;
  failed: string[];
}

/** parse an Open-Meteo response with one or several models (keys "<var>_<model>") */
export function parseMulti(j: any, models: string[]): MultiModel {
  const hz = j?.hourly ?? {};
  const out: MultiModel = { t: (hz.time ?? []).map((v: any) => (typeof v === "number" ? v * 1000 : Date.parse(v))), tz: j?.timezone, m: {}, failed: [] };
  for (const [k, arr] of Object.entries(hz)) {
    if (k === "time" || !Array.isArray(arr)) continue;
    const v = CM_VARS.split(",").find((x) => k === x || k.startsWith(`${x}_`)) as CmVar | undefined;
    if (!v) continue;
    const suffix = k === v ? "" : k.slice(v.length + 1);
    const model = suffix ? models.find((m) => m === suffix) : models.length === 1 ? models[0] : undefined;
    if (!model) continue;
    // a model with no data here comes back as all nulls
    if (!(arr as any[]).some((x) => x != null)) continue;
    ((out.m[model] ??= {}) as any)[v] = arr;
  }
  out.failed = models.filter((m) => !out.m[m]);
  return out;
}

const mmCache = new Map<string, { at: number; v: MultiModel }>();
export async function fetchMulti(lat: number, lon: number, models: string[], days: number): Promise<MultiModel> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${models.join()},${days}`;
  const c = mmCache.get(key);
  if (c && Date.now() - c.at < 20 * 60_000) return c.v;
  const url = (ms: string[]) => `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=${CM_VARS}&models=${ms.join(",")}&wind_speed_unit=ms&timeformat=unixtime&timezone=auto&forecast_days=${days}`;
  let v: MultiModel;
  const r = await fetch(url(models));
  if (r.ok) v = parseMulti(await r.json(), models);
  else {
    // one unknown / unavailable model fails the whole request: ask per model instead
    const parts = await Promise.all(models.map((m) => fetch(url([m])).then((x) => (x.ok ? x.json() : null)).catch(() => null)));
    v = { t: [], m: {}, failed: [] };
    parts.forEach((p, i) => {
      if (!p) return v.failed.push(models[i]);
      const one = parseMulti(p, [models[i]]);
      if (!v.t.length) ((v.t = one.t), (v.tz = one.tz));
      Object.assign(v.m, one.m);
      if (!one.m[models[i]]) v.failed.push(models[i]);
    });
    if (!v.t.length) throw new Error(`Open-Meteo ${r.status}`);
  }
  mmCache.set(key, { at: Date.now(), v });
  return v;
}

const U = () => settings.value.units;
const cT = (c: number | null) => (c == null ? null : U().temp === "F" ? c * 1.8 + 32 : c);
const cS = (ms: number | null) => (ms == null ? null : U().speed === "kt" ? ms * 1.94384 : U().speed === "mph" ? ms * 2.23694 : U().speed === "km/h" ? ms * 3.6 : ms);
const cP = (mm: number | null) => (mm == null ? null : U().precip === "in" ? mm / 25.4 : mm);
const inHg = () => U().precip === "in";
const cPr = (h: number | null) => (h == null ? null : inHg() ? h * 0.02953 : h);

export function ModelCompare({ lat, lon }: { lat: number; lon: number }) {
  const saved = settings.value.data6?.models;
  const on = new Set(saved ?? CM_MODELS.filter((m) => m.on).map((m) => m.id));
  const [days, setDays] = useState<3 | 7 | 10>(7);
  const [mm, setMm] = useState<MultiModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const all = CM_MODELS.map((m) => m.id);
  useEffect(() => {
    setBusy(true);
    setErr(null);
    fetchMulti(lat, lon, all, days)
      .then(setMm)
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  }, [lat, lon, days]);
  const toggle = (id: string) =>
    update((s) => {
      const cur = new Set(s.data6?.models ?? CM_MODELS.filter((m) => m.on).map((m) => m.id));
      cur.has(id) ? cur.delete(id) : cur.add(id);
      s.data6 = { ...(s.data6 ?? ({} as any)), models: [...cur] };
    });
  const vis = CM_MODELS.filter((m) => on.has(m.id) && mm?.m[m.id]);
  const ser = (v: CmVar, conv: (x: number | null) => number | null, cum = false): LSeries[] =>
    vis.map((m) => {
      const raw = mm!.m[m.id][v] ?? [];
      let acc = 0;
      return { id: m.id, name: m.name, color: m.color, v: raw.map((x) => (cum ? (x == null ? null : conv((acc += x))) : conv(x))) };
    });
  const p = U().precip;
  return (
    <div class="d6-mc">
      <div class="d6-mc-bar">
        <div class="d6-chips">
          {CM_MODELS.map((m) => {
            const bad = mm && !mm.m[m.id];
            return (
              <button key={m.id} class={`chip ${on.has(m.id) ? "on" : ""} ${bad ? "off" : ""}`} title={bad ? "No data for this point" : m.id} onClick={() => toggle(m.id)}>
                <i style={{ background: m.color }} />
                {m.name}
              </button>
            );
          })}
        </div>
        <div class="seg sm">
          {([3, 7, 10] as const).map((d) => (
            <button key={d} class={days === d ? "on" : ""} onClick={() => setDays(d)}>
              {d} d
            </button>
          ))}
        </div>
      </div>
      {err && <div class="err-text">{err}</div>}
      {busy && !mm && <div class="muted">Loading models…</div>}
      {mm && (
        <>
          <ConfidenceLines mm={mm} models={vis.map((m) => m.id)} />
          <LineChart t={mm.t} series={ser("temperature_2m", cT)} band={spreadBand(mm, vis.map((m) => m.id), "temperature_2m", cT)} title="Temperature" unit={`°${U().temp}`} tz={mm.tz} h={170} />
          <LineChart t={mm.t} series={ser("precipitation", cP, true)} title="Total precipitation" unit={p} tz={mm.tz} zero fmt={(v) => v.toFixed(p === "in" ? 2 : 1)} />
          <LineChart t={mm.t} series={ser("wind_speed_10m", cS)} band={spreadBand(mm, vis.map((m) => m.id), "wind_speed_10m", cS)} title="Wind" unit={U().speed} tz={mm.tz} zero />
          <LineChart t={mm.t} series={ser("wind_gusts_10m", cS)} title="Gusts" unit={U().speed} tz={mm.tz} zero />
          <LineChart t={mm.t} series={ser("pressure_msl", cPr)} title="Pressure" unit={inHg() ? "inHg" : "hPa"} tz={mm.tz} fmt={(v) => (inHg() ? v.toFixed(2) : v.toFixed(0))} />
          <LineChart t={mm.t} series={ser("cloud_cover", (x) => x)} title="Cloud cover" unit="%" tz={mm.tz} fixed={[0, 100]} />
          <p class="muted small">
            Open-Meteo.com (CC BY 4.0), each model at its native resolution. Short-range models (HRRR, Météo-France AROME) end sooner.
            {mm.failed.length > 0 && ` No data here: ${mm.failed.map((id) => CM_MODELS.find((m) => m.id === id)?.name ?? id).join(", ")}.`}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- data 0.8: model spread bands and plain-language confidence ---------- */
/** min–max across models at each hour (needs ≥ 2 models with a value) */
export function spreadBand(mm: MultiModel, ids: string[], v: CmVar, conv: (x: number | null) => number | null): LBand | undefined {
  if (ids.length < 2) return undefined;
  const lo: (number | null)[] = [], hi: (number | null)[] = [];
  for (let i = 0; i < mm.t.length; i++) {
    const xs = ids.map((id) => mm.m[id]?.[v]?.[i]).filter((x): x is number => x != null && Number.isFinite(x));
    if (xs.length < 2) (lo.push(null), hi.push(null));
    else (lo.push(conv(Math.min(...xs))), hi.push(conv(Math.max(...xs))));
  }
  return { lo, hi, color: "rgba(148,163,184,0.22)", name: "Model spread" };
}

export type ConfLevel = "high" | "medium" | "low";
export interface DayConf {
  key: string;
  t: number;
  level: ConfLevel;
  text: string;
  n: number;
}
const hourFmt = (t: number, tz?: string) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", timeZone: tzOpt(tz) });
/** per local day: agreement of highs / lows, rain yes-no, rain timing and gusts across models */
export function dayConfidence(mm: MultiModel, ids: string[], maxDays = 7): DayConf[] {
  const tz = mm.tz;
  const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: tzOpt(tz) });
  const days = new Map<string, number[]>();
  mm.t.forEach((t, i) => {
    const k = dayKey(t);
    if (!days.has(k)) days.set(k, []);
    days.get(k)!.push(i);
  });
  const F = U().temp === "F";
  const dT = (c: number) => (F ? c * 1.8 : c);
  const tu = `°${U().temp}`;
  const out: DayConf[] = [];
  const now = Date.now();
  for (const [k, idx] of days) {
    if (idx.length < 12 || mm.t[idx[idx.length - 1]] < now) continue;
    const per = ids
      .map((id) => {
        const m = mm.m[id];
        const tv = idx.map((i) => m?.temperature_2m?.[i]).filter((x): x is number => x != null);
        const pv = idx.map((i) => m?.precipitation?.[i] ?? null);
        const gv = idx.map((i) => m?.wind_gusts_10m?.[i]).filter((x): x is number => x != null);
        if (tv.length < idx.length * 0.6) return null;
        const tot = pv.reduce((a: number, x) => a + (x ?? 0), 0);
        const first = pv.findIndex((x) => (x ?? 0) >= 0.3);
        return { hi: Math.max(...tv), lo: Math.min(...tv), tot, first: first >= 0 ? mm.t[idx[first]] : null, gust: gv.length ? Math.max(...gv) : null };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (per.length < 2) continue;
    const sp = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const hiS = dT(sp(per.map((p) => p.hi)));
    const loS = dT(sp(per.map((p) => p.lo)));
    const tS = Math.max(hiS, loS);
    const wet = per.filter((p) => p.tot >= 1);
    const fw = wet.length / per.length;
    const firsts = wet.map((p) => p.first).filter((x): x is number => x != null);
    const timeS = firsts.length >= 2 ? (Math.max(...firsts) - Math.min(...firsts)) / 3600e3 : 0;
    const gusts = per.map((p) => p.gust).filter((x): x is number => x != null);
    const gS = gusts.length >= 2 ? sp(gusts) * speedFactorMs() : 0;
    const tLvl: ConfLevel = tS <= (F ? 4 : 2.2) ? "high" : tS <= (F ? 8 : 4.5) ? "medium" : "low";
    const rLvl: ConfLevel = fw <= 0.15 || (fw >= 0.85 && timeS <= 4) ? "high" : fw <= 0.3 || fw >= 0.7 ? "medium" : "low";
    const order = { high: 0, medium: 1, low: 2 } as const;
    const level: ConfLevel = order[tLvl] >= order[rLvl] ? tLvl : rLvl;
    const r1 = (x: number) => Math.round(x);
    const hiTxt = `${r1(Math.min(...per.map((p) => cT(p.hi)!)))}–${r1(Math.max(...per.map((p) => cT(p.hi)!)))}${tu}`;
    let text: string;
    const rainTxt = fw <= 0.15 ? "all models dry" : fw >= 0.85 ? "all models bring rain" : `${wet.length} of ${per.length} models bring rain`;
    if (level === "high") text = `High confidence: models agree within ${Math.max(1, r1(tS))}${tu}; ${rainTxt}.`;
    else if (rLvl === "low" && tLvl !== "low") text = `Low confidence on rain: ${rainTxt}${firsts.length >= 2 && timeS > 4 ? `, starting ${hourFmt(Math.min(...firsts), tz)}–${hourFmt(Math.max(...firsts), tz)}` : ""}.`;
    else if (fw >= 0.7 && timeS > 4) text = `${level === "low" ? "Low" : "Medium"} confidence on rain timing: rain likely, but models start it anywhere from ${hourFmt(Math.min(...firsts), tz)} to ${hourFmt(Math.max(...firsts), tz)}.`;
    else if (tLvl !== "high") text = `${level === "low" ? "Low" : "Medium"} confidence on temperature: highs ${hiTxt} (${r1(tS)}${tu} spread); ${rainTxt}.`;
    else text = `Medium confidence: highs agree (${hiTxt}); ${rainTxt}.`;
    if (gS >= 15 && level !== "high") text += ` Gusts differ by ${r1(gS)} ${U().speed}.`;
    out.push({ key: k, t: mm.t[idx[0]], level, text, n: per.length });
    if (out.length >= maxDays) break;
  }
  return out;
}
function speedFactorMs() {
  return U().speed === "kt" ? 1.94384 : U().speed === "mph" ? 2.23694 : U().speed === "km/h" ? 3.6 : 1;
}
export function ConfidenceLines({ mm, models, max = 7 }: { mm: MultiModel; models: string[]; max?: number }) {
  const days = useMemo(() => dayConfidence(mm, models, max), [mm, models.join(), max, settings.value.units]);
  if (!days.length) return null;
  return (
    <div class="p8-conf">
      {days.map((d) => (
        <div key={d.key} class={`p8-conf-row ${d.level}`}>
          <b>{new Date(d.t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: tzOpt(mm.tz) })}</b>
          <span class={`p8-conf-chip ${d.level}`}>{d.level}</span>
          <span>{d.text}</span>
        </div>
      ))}
      <small class="muted">Confidence from how closely {days[0].n} models agree (highs/lows, rain or not, rain start time, gusts). Shaded band on the charts = range across models.</small>
    </div>
  );
}
/** forecast tab: per-day confidence + temperature with the model spread band and the model mean */
export function ForecastConfidence({ lat, lon }: { lat: number; lon: number }) {
  const ids = (settings.value.data6?.models ?? CM_MODELS.filter((m) => m.on).map((m) => m.id));
  const [mm, setMm] = useState<MultiModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    fetchMulti(lat, lon, CM_MODELS.map((m) => m.id), 7)
      .then(setMm)
      .catch((e) => setErr(String(e.message ?? e)));
  }, [lat, lon]);
  if (err) return <div class="muted small">Model confidence unavailable: {err}</div>;
  if (!mm) return <div class="muted small">Comparing models…</div>;
  const vis = ids.filter((id) => mm.m[id]);
  const band = spreadBand(mm, vis, "temperature_2m", cT);
  const mean = mm.t.map((_, i) => {
    const xs = vis.map((id) => mm.m[id]?.temperature_2m?.[i]).filter((x): x is number => x != null);
    return xs.length ? cT(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  });
  return (
    <>
      <ConfidenceLines mm={mm} models={vis} />
      <LineChart t={mm.t} series={[{ id: "mean", name: `Mean of ${vis.length} models`, color: "#e5e7eb", v: mean, width: 2 }]} band={band} title="Temperature · model spread" unit={`°${U().temp}`} tz={mm.tz} h={130} />
    </>
  );
}
/* ---------- end data 0.8 ---------- */
