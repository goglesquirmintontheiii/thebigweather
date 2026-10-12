// Ensemble plumes (Open-Meteo Ensemble API): every member as a thin line, median, mean and the
// 10–90 % band, per model.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { settings } from "../store";

export const ENS_MODELS = [
  { id: "gfs_seamless", name: "GFS ens", color: "#60a5fa", keys: ["gfs", "gefs", "ncep"] },
  { id: "ecmwf_ifs025", name: "ECMWF ens", color: "#f472b6", keys: ["ecmwf", "ifs"] },
  { id: "icon_seamless", name: "ICON ens", color: "#4ade80", keys: ["icon"] },
] as const;
type ModelId = (typeof ENS_MODELS)[number]["id"];
const VARS = [
  { id: "temperature_2m", name: "Temperature" },
  { id: "precipitation", name: "Precip" },
  { id: "wind_speed_10m", name: "Wind" },
] as const;
type VarId = (typeof VARS)[number]["id"];

export interface Ens {
  time: number[];
  tz?: string;
  /** model → variable → members (index 0 = control when present) */
  m: Partial<Record<ModelId, Partial<Record<VarId, (number | null)[][]>>>>;
}

const cache = new Map<string, { at: number; v: Ens }>();

/** Map a response key suffix (model name the API echoes) to the requested model. */
function modelFor(suffix: string | undefined): ModelId | null {
  if (!suffix) return null;
  const exact = ENS_MODELS.find((m) => m.id === suffix);
  if (exact) return exact.id;
  return ENS_MODELS.find((m) => m.keys.some((k) => suffix.includes(k)))?.id ?? null;
}

export function parseEnsemble(j: any, requested: ModelId[]): Ens {
  const h = j.hourly ?? {};
  const out: Ens = { time: (h.time ?? []).map((t: number | string) => (typeof t === "number" ? t * 1000 : Date.parse(t))), tz: j.timezone, m: {} };
  const re = /^(temperature_2m|precipitation|wind_speed_10m)(?:_member(\d+))?(?:_(.+))?$/;
  for (const [k, arr] of Object.entries(h)) {
    const m = k.match(re);
    if (!m || !Array.isArray(arr)) continue;
    const model = requested.length === 1 && !m[3] ? requested[0] : modelFor(m[3]);
    if (!model) continue;
    const v = m[1] as VarId;
    const idx = m[2] ? +m[2] : 0;
    const per = (out.m[model] ??= {});
    const list = (per[v] ??= []);
    list[idx] = arr as (number | null)[];
  }
  for (const per of Object.values(out.m)) for (const k of Object.keys(per!)) per![k as VarId] = per![k as VarId]!.filter(Boolean);
  return out;
}

export async function fetchEnsemble(lat: number, lon: number, models: ModelId[] = ENS_MODELS.map((m) => m.id)): Promise<Ens> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${models.join()}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 30 * 60_000) return c.v;
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&models=${models.join(",")}&hourly=temperature_2m,precipitation,wind_speed_10m&wind_speed_unit=ms&timeformat=unixtime&timezone=auto&forecast_days=10`;
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `Open-Meteo ${r.status}`;
    try {
      msg = (await r.json()).reason ?? msg;
    } catch {
      /* */
    }
    throw new Error(msg);
  }
  const v = parseEnsemble(await r.json(), models);
  cache.set(key, { at: Date.now(), v });
  return v;
}

function conv(v: VarId, x: number): number {
  const u = settings.value.units;
  if (v === "temperature_2m") return u.temp === "F" ? x * 1.8 + 32 : x;
  if (v === "precipitation") return u.precip === "in" ? x / 25.4 : x;
  return u.speed === "kt" ? x * 1.94384 : u.speed === "km/h" ? x * 3.6 : u.speed === "mph" ? x * 2.23694 : x;
}
function unit(v: VarId) {
  const u = settings.value.units;
  return v === "temperature_2m" ? `°${u.temp}` : v === "precipitation" ? `${u.precip} total` : u.speed;
}

/** members in display units; precipitation accumulated from the first hour */
function prep(raw: (number | null)[][], v: VarId): (number | null)[][] {
  return raw.map((mem) => {
    let acc = 0;
    return mem.map((x) => {
      if (x == null) return null;
      if (v === "precipitation") {
        acc += x;
        return conv(v, acc);
      }
      return conv(v, x);
    });
  });
}

function stats(mem: (number | null)[][], i: number) {
  const xs = mem.map((m) => m[i]).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (xs.length < 2) return null;
  const q = (f: number) => {
    const k = (xs.length - 1) * f;
    const a = Math.floor(k);
    return xs[a] + (xs[Math.min(a + 1, xs.length - 1)] - xs[a]) * (k - a);
  };
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
}

export function Ensembles({ lat, lon }: { lat: number; lon: number }) {
  const [data, setData] = useState<Ens | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [v, setV] = useState<VarId>("temperature_2m");
  const [on, setOn] = useState<Set<ModelId>>(() => new Set(ENS_MODELS.map((m) => m.id)));
  const [members, setMembers] = useState(true);
  useEffect(() => {
    let alive = true;
    setErr(null);
    fetchEnsemble(lat, lon)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [lat, lon]);
  const toggle = (id: ModelId) => {
    const s = new Set(on);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    if (s.size) setOn(s);
  };
  return (
    <section class="fcc-sec ens">
      <div class="row ens-bar">
        <div class="seg sm">
          {VARS.map((x) => (
            <button key={x.id} class={v === x.id ? "on" : ""} onClick={() => setV(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
        <div class="ens-models">
          {ENS_MODELS.map((m) => {
            const n = data?.m[m.id]?.[v]?.length ?? 0;
            return (
              <button key={m.id} class={`ens-chip ${on.has(m.id) ? "on" : ""}`} style={{ "--c": m.color } as any} disabled={!!data && !n} onClick={() => toggle(m.id)} title={n ? `${n} members` : "No data"}>
                <i /> {m.name}
                {n ? <small>{n}</small> : null}
              </button>
            );
          })}
          <label class="ens-mem">
            <input type="checkbox" checked={members} onChange={(e) => setMembers((e.target as HTMLInputElement).checked)} /> Members
          </label>
        </div>
      </div>
      {err && <div class="err-text">Ensembles unavailable: {err}</div>}
      {!data && !err && <div class="muted">Loading ensembles…</div>}
      {data && <Plume data={data} v={v} on={on} members={members} />}
      <p class="muted small">Thin lines: members · solid: median · dashed: mean · band: 10–90 %. Ensemble data: Open-Meteo.com (CC BY 4.0).</p>
    </section>
  );
}

function Plume({ data, v, on, members }: { data: Ens; v: VarId; on: Set<ModelId>; members: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setW(wrap.current.clientWidth));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  const H = 340;
  const L = 48, R = 16, T = 12, B = 30;
  const series = useMemo(
    () =>
      ENS_MODELS.filter((m) => on.has(m.id) && data.m[m.id]?.[v]?.length).map((m) => {
        const mem = prep(data.m[m.id]![v]!, v);
        const st = data.time.map((_, i) => stats(mem, i));
        return { m, mem, st };
      }),
    [data, v, on, settings.value.units],
  );
  // time range: from now (or first) to the last time any shown model has data
  const now = Date.now();
  let i0 = Math.max(0, data.time.findIndex((t) => t >= now - 3600_000));
  if (v === "precipitation") i0 = 0;
  let i1 = 0;
  for (const s of series) for (let i = s.st.length - 1; i > i1; i--) if (s.st[i]) (i1 = Math.max(i1, i)), (i = 0);
  const range = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const s of series)
      for (let i = i0; i <= i1; i++) {
        const st = s.st[i];
        if (!st) continue;
        const a = members ? Math.min(...s.mem.map((m) => m[i] ?? Infinity)) : st.p10;
        const b = members ? Math.max(...s.mem.map((m) => m[i] ?? -Infinity)) : st.p90;
        lo = Math.min(lo, a);
        hi = Math.max(hi, b);
      }
    if (!Number.isFinite(lo)) return [0, 1];
    if (v !== "temperature_2m") lo = 0;
    const pad = (hi - lo) * 0.06 || 1;
    return [v === "temperature_2m" ? lo - pad : lo, hi + pad];
  }, [series, i0, i1, members]);
  const t0 = data.time[i0], t1 = data.time[Math.max(i0 + 1, i1)];
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const Y = (y: number) => T + (1 - (y - range[0]) / (range[1] - range[0] || 1)) * (H - T - B);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = H * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${H}px`;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    // grid
    g.font = "10px system-ui, sans-serif";
    g.strokeStyle = "rgba(148,163,184,0.15)";
    g.fillStyle = "rgba(203,213,225,0.75)";
    const span = range[1] - range[0];
    const stepY = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((s) => span / s <= 7) ?? 100;
    g.textAlign = "right";
    for (let y = Math.ceil(range[0] / stepY) * stepY; y <= range[1]; y += stepY) {
      g.beginPath();
      g.moveTo(L, Y(y));
      g.lineTo(w - R, Y(y));
      g.stroke();
      g.fillText(`${+y.toFixed(2)}`, L - 5, Y(y) + 3.5);
    }
    g.textAlign = "left";
    g.fillText(unit(v), 4, T + 8);
    // days
    const tz = settings.value.utc ? "UTC" : data.tz;
    const dayOf = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: tz });
    for (let i = i0 + 1; i <= i1; i++) {
      if (dayOf(data.time[i]) === dayOf(data.time[i - 1])) continue;
      const xx = X(data.time[i]);
      g.strokeStyle = "rgba(148,163,184,0.28)";
      g.beginPath();
      g.moveTo(xx, T);
      g.lineTo(xx, H - B);
      g.stroke();
      g.fillText(new Date(data.time[i] + 12 * 3600_000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: tz }), xx + 4, H - B + 14);
    }
    g.save();
    g.beginPath();
    g.rect(L, T, w - L - R, H - T - B);
    g.clip();
    const path = (get: (i: number) => number | null | undefined) => {
      g.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const y = get(i);
        if (y == null) {
          pen = false;
          continue;
        }
        if (pen) g.lineTo(X(data.time[i]), Y(y));
        else g.moveTo(X(data.time[i]), Y(y));
        pen = true;
      }
    };
    for (const s of series) {
      // band
      g.fillStyle = s.m.color + "2a";
      g.beginPath();
      let started = false;
      const idx: number[] = [];
      for (let i = i0; i <= i1; i++) if (s.st[i]) idx.push(i);
      for (const i of idx) {
        const p = [X(data.time[i]), Y(s.st[i]!.p90)] as const;
        if (!started) g.moveTo(...p), (started = true);
        else g.lineTo(...p);
      }
      for (const i of idx.slice().reverse()) g.lineTo(X(data.time[i]), Y(s.st[i]!.p10));
      g.closePath();
      g.fill();
      if (members) {
        g.strokeStyle = s.m.color + "40";
        g.lineWidth = 0.8;
        for (const m of s.mem) {
          path((i) => m[i]);
          g.stroke();
        }
      }
    }
    for (const s of series) {
      g.strokeStyle = s.m.color;
      g.lineWidth = 2.2;
      path((i) => s.st[i]?.p50);
      g.stroke();
      g.lineWidth = 1.4;
      g.setLineDash([5, 4]);
      path((i) => s.st[i]?.mean);
      g.stroke();
      g.setLineDash([]);
    }
    if (now > t0 && now < t1) {
      g.strokeStyle = "rgba(250,204,21,0.6)";
      g.beginPath();
      g.moveTo(X(now), T);
      g.lineTo(X(now), H - B);
      g.stroke();
    }
    if (hover != null) {
      g.strokeStyle = "rgba(255,255,255,0.55)";
      g.beginPath();
      g.moveTo(X(data.time[hover]), T);
      g.lineTo(X(data.time[hover]), H - B);
      g.stroke();
    }
    g.restore();
  }, [series, w, hover, range, members]);
  const onMove = (e: MouseEvent) => {
    const r = cv.current!.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - L) / (w - L - R)) * (t1 - t0);
    let best = i0;
    for (let i = i0; i <= i1; i++) if (Math.abs(data.time[i] - t) < Math.abs(data.time[best] - t)) best = i;
    setHover(best);
  };
  const tz = settings.value.utc ? "UTC" : data.tz;
  const fmt = (x: number) => (Math.abs(x) >= 10 || v === "temperature_2m" ? Math.round(x) : x.toFixed(v === "precipitation" && settings.value.units.precip === "in" ? 2 : 1));
  return (
    <div class="ens-plot" ref={wrap}>
      <canvas ref={cv} onMouseMove={onMove as any} onMouseLeave={() => setHover(null)} />
      {hover != null && (
        <div class="ens-tip glass" style={{ left: `${Math.min(w - 190, X(data.time[hover]) + 10)}px` }}>
          <b>{new Date(data.time[hover]).toLocaleString(undefined, { weekday: "short", hour: "numeric", timeZone: tz })}</b>
          {series.map((s) =>
            s.st[hover] ? (
              <div key={s.m.id} style={{ color: s.m.color }}>
                {s.m.name}: {fmt(s.st[hover]!.p50)} <small>
                  ({fmt(s.st[hover]!.p10)}–{fmt(s.st[hover]!.p90)}) {unit(v)}
                </small>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
