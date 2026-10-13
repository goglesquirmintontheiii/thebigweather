// Big forecast window: current conditions, multi-series chart, 14-day cards, 48 h table, alerts.
// Server forecast (NWS / Open-Meteo) for the text; Open-Meteo directly for the extra hourly fields.

import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { settings, update, openPanel, selectedAlert } from "../store";
import { mapRef } from "../map/mapview";
import { alerts } from "../alerts";
import { pointInGeometry, compass } from "../util";
import { iconFor } from "./panels/ForecastPanel";
import { CenterModal } from "./CenterModal";
import { RefreshCw, MapPin, CloudSun, Sunrise, Sunset, PanelLeft, TriangleAlert, Droplets, Wind, Gauge, Eye, Sun, Activity } from "lucide-preact";
import { Ensembles } from "./EnsemblePlume"; // intl & forecast tools
import { openSounding } from "../sounding/state";
/* ---------- data 0.6 ---------- */
import { ModelCompare } from "./Meteogram";
import { ForecastConfidence } from "./Meteogram"; // data 0.8
import { HealthTab, StarsTab } from "./OutdoorTabs";
import { ClimatePanel } from "./ClimatePanel";
/* ---------- end data 0.6 ---------- */

export const forecastOpen = signal(false);
/** Forecast / Ensembles tab (kept across reopening) */
type FccTab = "fc" | "ens" | "models" | "health" | "stars" | "climate"; // data 0.6: more tabs
export const fccTab = signal<FccTab>("fc");
/* ---------- data 0.6: open the window at a point (map right-click) ---------- */
export const fccAt = signal<{ lat: number; lon: number; n: number } | null>(null);
export function openForecastAt(lat: number, lon: number, tab: FccTab) {
  update((x) => (x.forecast.point = "center"));
  fccAt.value = { lat, lon, n: (fccAt.value?.n ?? 0) + 1 };
  fccTab.value = tab;
  forecastOpen.value = true;
}
(window as any).__tbwFcc = { openForecastAt, fccTab }; // console / screenshots
const D6_TABS: [FccTab, string][] = [
  ["models", "Models"],
  ["health", "Health"],
  ["stars", "Stars"],
  ["climate", "Climate"],
];
/* ---------- end data 0.6 ---------- */

// ---------- data ----------

/** One hour, metric (°C, mm, m/s, hPa, m). */
interface Hour {
  t: number;
  temp?: number | null;
  feels?: number | null;
  dew?: number | null;
  rh?: number | null;
  pop?: number | null;
  precip?: number | null;
  snow?: number | null;
  wind?: number | null;
  gust?: number | null;
  dir?: number | null;
  dirTxt?: string | null;
  pres?: number | null;
  cloud?: number | null;
  vis?: number | null;
  uv?: number | null;
  cape?: number | null;
  short: string;
  day: boolean;
}
interface Day {
  key: string;
  t: number;
  hi?: number | null;
  lo?: number | null;
  pop?: number | null;
  precip?: number | null;
  snow?: number | null;
  wind?: number | null;
  gust?: number | null;
  dir?: number | null;
  uv?: number | null;
  sunrise?: number | null;
  sunset?: number | null;
  short: string;
  nws?: any;
  nwsNight?: any;
}
interface Fc {
  place: string;
  source: string;
  tz?: string;
  hours: Hour[];
  days: Day[];
  current?: Hour | null;
  server?: any;
  om?: boolean;
  omErr?: string;
}

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorms",
  96: "T-storms, hail",
  99: "T-storms, hail",
};

const omCache = new Map<string, { at: number; v: any }>();
async function openMeteo(lat: number, lon: number): Promise<any> {
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const c = omCache.get(k);
  if (c && Date.now() - c.at < 600000) return c.v;
  const H = "temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,precipitation_probability,precipitation,snowfall,weather_code,pressure_msl,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cape,is_day";
  const D = "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant";
  const C = "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${C}&hourly=${H}&daily=${D}&wind_speed_unit=ms&timezone=auto&forecast_days=14&timeformat=unixtime`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const v = await r.json();
  omCache.set(k, { at: Date.now(), v });
  return v;
}

const dayKey = (ms: number, tz?: string) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });

function build(server: any, om: any, omErr?: string): Fc {
  const now = Date.now();
  const out: Fc = { place: server?.place ?? "", source: server?.source ?? "", hours: [], days: [], server, om: !!om, omErr };
  if (om?.hourly?.time) {
    const h = om.hourly;
    out.tz = om.timezone;
    for (let i = 0; i < h.time.length; i++) {
      const t = h.time[i] * 1000;
      if (t < now - 3600000) continue;
      out.hours.push({
        t,
        temp: h.temperature_2m[i],
        feels: h.apparent_temperature[i],
        dew: h.dew_point_2m[i],
        rh: h.relative_humidity_2m[i],
        pop: h.precipitation_probability[i],
        precip: h.precipitation[i],
        snow: h.snowfall[i],
        wind: h.wind_speed_10m[i],
        gust: h.wind_gusts_10m[i],
        dir: h.wind_direction_10m[i],
        pres: h.pressure_msl[i],
        cloud: h.cloud_cover[i],
        vis: h.visibility[i],
        uv: h.uv_index[i],
        cape: h.cape[i],
        short: WMO[h.weather_code[i]] ?? "",
        day: h.is_day[i] === 1,
      });
    }
    const d = om.daily;
    for (let i = 0; i < (d?.time?.length ?? 0); i++) {
      const t = d.time[i] * 1000;
      out.days.push({
        key: dayKey(t + 12 * 3600000, om.timezone),
        t,
        hi: d.temperature_2m_max[i],
        lo: d.temperature_2m_min[i],
        pop: d.precipitation_probability_max[i],
        precip: d.precipitation_sum[i],
        snow: d.snowfall_sum[i],
        wind: d.wind_speed_10m_max[i],
        gust: d.wind_gusts_10m_max[i],
        dir: d.wind_direction_10m_dominant[i],
        uv: d.uv_index_max[i],
        sunrise: d.sunrise[i] ? d.sunrise[i] * 1000 : null,
        sunset: d.sunset[i] ? d.sunset[i] * 1000 : null,
        short: WMO[d.weather_code[i]] ?? "",
      });
    }
    const c = om.current;
    if (c) {
      const h0 = out.hours.find((x) => x.t >= now - 3600000);
      out.current = { t: c.time * 1000, temp: c.temperature_2m, feels: c.apparent_temperature, rh: c.relative_humidity_2m, dew: h0?.dew, precip: c.precipitation, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, dir: c.wind_direction_10m, pres: c.pressure_msl, cloud: c.cloud_cover, vis: h0?.vis, uv: h0?.uv, short: WMO[c.weather_code] ?? "", day: c.is_day === 1 };
    }
  } else if (server?.hourly) {
    for (const x of server.hourly) {
      out.hours.push({
        t: Date.parse(x.t),
        temp: x.temp_f == null ? null : (x.temp_f - 32) / 1.8,
        dew: x.dew_c,
        rh: x.rh,
        pop: x.pop,
        wind: x.wind_mph == null ? null : x.wind_mph * 0.44704,
        gust: x.gust_mph == null ? null : x.gust_mph * 0.44704,
        dirTxt: x.dir,
        short: x.short ?? "",
        day: x.day !== false,
      });
    }
    out.current = out.hours[0] ?? null;
  }
  // NWS / server periods → text per day
  const per: any[] = server?.periods ?? [];
  const byKey = new Map<string, { day?: any; night?: any }>();
  for (const p of per) {
    const k = String(p.start ?? "").slice(0, 10);
    const e = byKey.get(k) ?? {};
    if (p.day) e.day = p;
    else e.night = p;
    byKey.set(k, e);
  }
  if (!out.days.length) {
    for (const [k, e] of byKey) {
      const p = e.day ?? e.night;
      out.days.push({ key: k, t: Date.parse(p.start), hi: e.day?.temp_f != null ? (e.day.temp_f - 32) / 1.8 : null, lo: e.night?.temp_f != null ? (e.night.temp_f - 32) / 1.8 : null, pop: Math.max(e.day?.pop ?? 0, e.night?.pop ?? 0) || null, wind: e.day?.wind_mph != null ? e.day.wind_mph * 0.44704 : null, short: p.short ?? "" });
    }
  }
  if (server?.source === "NWS") for (const d of out.days) {
    const e = byKey.get(d.key);
    if (e) {
      d.nws = e.day;
      d.nwsNight = e.night;
    }
  }
  return out;
}

// ---------- units ----------

const U = () => settings.value.units;
const fT = (c: number | null | undefined) => (c == null ? null : U().temp === "C" ? c : c * 1.8 + 32);
const T = (c: number | null | undefined) => (c == null ? "—" : `${Math.round(fT(c)!)}°`);
const fS = (ms: number | null | undefined) => {
  if (ms == null) return null;
  const u = U().speed;
  return u === "kt" ? ms * 1.94384 : u === "km/h" ? ms * 3.6 : u === "mph" ? ms * 2.23694 : ms;
};
const S = (ms: number | null | undefined, unit = true) => (ms == null ? "—" : `${Math.round(fS(ms)!)}${unit ? ` ${U().speed}` : ""}`);
const fP = (mm: number | null | undefined) => (mm == null ? null : U().precip === "in" ? mm / 25.4 : mm);
const P = (mm: number | null | undefined) => (mm == null ? "—" : U().precip === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`);
const inHg = () => U().precip === "in";
const fPr = (h: number | null | undefined) => (h == null ? null : inHg() ? h * 0.02953 : h);
const Pr = (h: number | null | undefined) => (h == null ? "—" : inHg() ? `${(h * 0.02953).toFixed(2)} inHg` : `${Math.round(h)} hPa`);
const V = (m: number | null | undefined) => {
  if (m == null) return "—";
  const km = U().distance === "km";
  const v = km ? m / 1000 : m / 1609.344;
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${km ? "km" : "mi"}`;
};
const dirOf = (h: Hour) => h.dirTxt ?? (h.dir != null ? compass(h.dir) : "");
const tzOpt = (tz?: string) => (settings.value.utc ? "UTC" : tz);
const hhmm = (ms: number | null | undefined, tz?: string) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tzOpt(tz) }) : "—");
const hr = (ms: number, tz?: string) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", timeZone: tzOpt(tz) });

// ---------- chart ----------

interface Ser {
  id: string;
  label: string;
  color: string;
  panel: "t" | "p" | "w" | "c" | "pr";
  kind?: "line" | "area" | "bar";
  dash?: number[];
  get: (h: Hour) => number | null | undefined;
  fmt: (h: Hour) => string;
}
const SERIES: Ser[] = [
  { id: "temp", label: "Temp", color: "#f87171", panel: "t", get: (h) => fT(h.temp), fmt: (h) => T(h.temp) },
  { id: "feels", label: "Feels like", color: "#fb923c", panel: "t", dash: [5, 3], get: (h) => fT(h.feels), fmt: (h) => T(h.feels) },
  { id: "dew", label: "Dewpoint", color: "#4ade80", panel: "t", get: (h) => fT(h.dew), fmt: (h) => T(h.dew) },
  { id: "pop", label: "Precip %", color: "#38bdf8", panel: "p", kind: "area", get: (h) => h.pop, fmt: (h) => (h.pop == null ? "—" : `${h.pop}%`) },
  { id: "precip", label: "Precip amount", color: "#60a5fa", panel: "p", kind: "bar", get: (h) => fP(h.precip), fmt: (h) => P(h.precip) },
  { id: "wind", label: "Wind", color: "#c4b5fd", panel: "w", get: (h) => fS(h.wind), fmt: (h) => `${dirOf(h)} ${S(h.wind)}` },
  { id: "gust", label: "Gusts", color: "#e879f9", panel: "w", dash: [4, 3], get: (h) => fS(h.gust), fmt: (h) => S(h.gust) },
  { id: "cloud", label: "Cloud cover", color: "#94a3b8", panel: "c", kind: "area", get: (h) => h.cloud, fmt: (h) => (h.cloud == null ? "—" : `${h.cloud}%`) },
  { id: "rh", label: "Humidity", color: "#2dd4bf", panel: "c", get: (h) => h.rh, fmt: (h) => (h.rh == null ? "—" : `${h.rh}%`) },
  { id: "pres", label: "Pressure", color: "#facc15", panel: "pr", get: (h) => fPr(h.pres), fmt: (h) => Pr(h.pres) },
];
const PANELS: { id: Ser["panel"]; w: number; fixed?: [number, number]; unit: () => string }[] = [
  { id: "t", w: 3, unit: () => `°${U().temp}` },
  { id: "p", w: 1.6, fixed: [0, 100], unit: () => "%" },
  { id: "w", w: 1.6, unit: () => U().speed },
  { id: "c", w: 1.2, fixed: [0, 100], unit: () => "%" },
  { id: "pr", w: 1.3, unit: () => (inHg() ? "inHg" : "hPa") },
];

function Chart({ hours, tz, on, setOn }: { hours: Hour[]; tz?: string; on: Set<string>; setOn: (s: Set<string>) => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setW(wrap.current.clientWidth));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  const avail = SERIES.filter((s) => hours.some((h) => s.get(h) != null));
  const vis = avail.filter((s) => on.has(s.id));
  const panels = PANELS.filter((p) => vis.some((s) => s.panel === p.id));
  const H = 60 + panels.reduce((a, p) => a + p.w * 44, 0);
  const L = 46;
  const R = 46;
  const n = hours.length;
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (w - L - R) : 0);
  useEffect(() => {
    const c = cv.current;
    if (!c || n < 2) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    g.font = "10.5px Inter, system-ui, sans-serif";
    const top = 22;
    const bottom = H - 20;
    const tw = panels.reduce((a, p) => a + p.w, 0);
    let y0 = top;
    // night shading + day separators
    for (let i = 0; i < n; i++) {
      if (!hours[i].day) {
        g.fillStyle = "rgba(120,140,200,.06)";
        g.fillRect(x(i) - (w - L - R) / (n - 1) / 2, top, (w - L - R) / (n - 1) + 0.5, bottom - top);
      }
    }
    g.textAlign = "left";
    for (let i = 0; i < n; i++) {
      const hh = new Date(hours[i].t).toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: tzOpt(tz) });
      if (+hh % 24 === 0 || i === 0) {
        g.strokeStyle = "rgba(255,255,255,.14)";
        g.beginPath();
        g.moveTo(x(i), top - 14);
        g.lineTo(x(i), bottom);
        g.stroke();
        g.fillStyle = "#b9c3cf";
        g.fillText(new Date(hours[i].t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: tzOpt(tz) }), x(i) + 4, top - 6);
      }
    }
    // hour labels
    const step = n <= 50 ? 3 : n <= 170 ? 12 : 24;
    g.fillStyle = "#8b97a6";
    g.textAlign = "center";
    for (let i = 0; i < n; i++) {
      const hh = +new Date(hours[i].t).toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: tzOpt(tz) }) % 24;
      if (hh % step === 0 && step < 24) g.fillText(hr(hours[i].t, tz), x(i), H - 6);
    }
    for (const p of panels) {
      const ph = ((bottom - top - (panels.length - 1) * 10) * p.w) / tw;
      const ss = vis.filter((s) => s.panel === p.id);
      let lo = Infinity;
      let hi = -Infinity;
      if (p.fixed) [lo, hi] = p.fixed;
      else
        for (const s of ss)
          for (const h of hours) {
            const v = s.get(h);
            if (v == null) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
      if (!isFinite(lo)) [lo, hi] = [0, 1];
      if (!p.fixed) {
        const pad = Math.max((hi - lo) * 0.1, p.id === "pr" ? (inHg() ? 0.03 : 1) : 1);
        lo -= pad;
        hi += pad;
        if (p.id === "w") lo = 0;
      }
      const Y = (v: number) => y0 + ph - ((v - lo) / (hi - lo || 1)) * ph;
      // frame + grid
      g.strokeStyle = "rgba(255,255,255,.07)";
      g.strokeRect(L, y0, w - L - R, ph);
      g.fillStyle = "#8b97a6";
      g.textAlign = "right";
      for (let k = 0; k <= 2; k++) {
        const v = lo + ((hi - lo) * k) / 2;
        const yy = Y(v);
        g.beginPath();
        g.moveTo(L, yy);
        g.lineTo(w - R, yy);
        g.stroke();
        g.fillText(p.id === "pr" && inHg() ? v.toFixed(2) : String(Math.round(v)), L - 5, yy + 3.5);
      }
      g.textAlign = "left";
      g.fillText(p.unit(), w - R + 5, y0 + 10);
      // precip amount: own scale on the right
      for (const s of ss) {
        g.strokeStyle = s.color;
        g.fillStyle = s.color;
        g.setLineDash(s.dash ?? []);
        if (s.kind === "bar") {
          let mx = U().precip === "in" ? 0.1 : 2.5;
          for (const h of hours) mx = Math.max(mx, s.get(h) ?? 0);
          const bw = Math.max(1, ((w - L - R) / (n - 1)) * 0.7);
          g.globalAlpha = 0.85;
          for (let i = 0; i < n; i++) {
            const v = s.get(hours[i]);
            if (!v) continue;
            const bh = (v / mx) * ph;
            g.fillRect(x(i) - bw / 2, y0 + ph - bh, bw, bh);
          }
          g.globalAlpha = 1;
          g.fillStyle = s.color;
          g.fillText(U().precip === "in" ? `${mx.toFixed(2)} in` : `${mx.toFixed(1)} mm`, w - R + 5, y0 + 22);
          continue;
        }
        g.lineWidth = s.id === "temp" ? 2.2 : 1.6;
        g.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          const v = s.get(hours[i]);
          if (v == null) {
            pen = false;
            continue;
          }
          if (pen) g.lineTo(x(i), Y(v));
          else g.moveTo(x(i), Y(v));
          pen = true;
        }
        g.stroke();
        if (s.kind === "area") {
          g.lineTo(x(n - 1), y0 + ph);
          g.lineTo(x(0), y0 + ph);
          g.closePath();
          g.globalAlpha = 0.18;
          g.fill();
          g.globalAlpha = 1;
        }
        g.setLineDash([]);
      }
      // wind direction arrows
      if (p.id === "w" && on.has("wind")) {
        const every = Math.max(1, Math.ceil(n / ((w - L - R) / 26)));
        g.strokeStyle = "#c4b5fd";
        g.lineWidth = 1.3;
        for (let i = 0; i < n; i += every) {
          const d = hours[i].dir;
          if (d == null) continue;
          const a = ((d + 90) * Math.PI) / 180; // toward
          const cx = x(i);
          const cy = y0 + 8;
          g.beginPath();
          g.moveTo(cx - Math.cos(a) * 5, cy - Math.sin(a) * 5);
          g.lineTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
          g.lineTo(cx + Math.cos(a) * 5 - Math.cos(a - 0.6) * 4, cy + Math.sin(a) * 5 - Math.sin(a - 0.6) * 4);
          g.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
          g.lineTo(cx + Math.cos(a) * 5 - Math.cos(a + 0.6) * 4, cy + Math.sin(a) * 5 - Math.sin(a + 0.6) * 4);
          g.stroke();
        }
      }
      y0 += ph + 10;
    }
    // now line
    const now = Date.now();
    const ni = hours.findIndex((h) => h.t > now);
    if (ni > 0) {
      const f = (now - hours[ni - 1].t) / (hours[ni].t - hours[ni - 1].t);
      const xx = x(ni - 1 + f);
      g.strokeStyle = "rgba(63,183,255,.8)";
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(xx, top);
      g.lineTo(xx, bottom);
      g.stroke();
      g.setLineDash([]);
    }
    if (hover != null) {
      g.strokeStyle = "rgba(255,255,255,.55)";
      g.beginPath();
      g.moveTo(x(hover), top);
      g.lineTo(x(hover), bottom);
      g.stroke();
    }
  }, [hours, w, H, on, hover, settings.value.units, settings.value.utc]);
  const toggle = (id: string) => {
    const s = new Set(on);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOn(s);
  };
  const h = hover != null ? hours[hover] : null;
  return (
    <div class="fcc-chart" ref={wrap}>
      <div class="fcc-chips">
        {avail.map((s) => (
          <button key={s.id} class={`chip ${on.has(s.id) ? "on" : ""}`} onClick={() => toggle(s.id)}>
            <i style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
      </div>
      <div class="fcc-canvas">
        <canvas
          ref={cv}
          style={{ width: `${w}px`, height: `${H}px` }}
          onMouseMove={(e) => {
            const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - L) / (w - L - R)) * (n - 1));
            setHover(i >= 0 && i < n ? i : null);
          }}
          onMouseLeave={() => setHover(null)}
        />
        {h && (
          <div class="fcc-tip" style={{ left: `${Math.min(x(hover!) + 12, w - 190)}px` }}>
            <b>{new Date(h.t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tzOpt(tz) })}</b>
            <span class="muted">{h.short}</span>
            {vis.map((s) => (
              <div key={s.id} class="fcc-tip-row">
                <i style={{ background: s.color }} />
                <span>{s.label}</span>
                <b>{s.fmt(h)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- the window ----------

function Stat({ icon, label, v }: { icon?: any; label: string; v: string }) {
  return (
    <div class="fcc-stat">
      <small class="muted">
        {icon} {label}
      </small>
      <b>{v}</b>
    </div>
  );
}

export function ForecastCenter() {
  if (!forecastOpen.value) return null;
  return <ForecastBody />;
}

function ForecastBody() {
  const s = settings.value;
  const sel = s.forecast.point;
  const [center, setCenter] = useState<[number, number] | null>(() => (fccAt.value ? [fccAt.value.lon, fccAt.value.lat] : mapRef.value ? [mapRef.value.getCenter().lng, mapRef.value.getCenter().lat] : null)); // data 0.6: fccAt
  useEffect(() => void (fccAt.value && setCenter([fccAt.value.lon, fccAt.value.lat])), [fccAt.value?.n]); // data 0.6
  const [fc, setFc] = useState<Fc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<48 | 168 | 336>(48);
  const [on, setOn] = useState<Set<string>>(() => new Set(["temp", "feels", "dew", "pop", "precip", "wind", "gust", "cloud", "pres"]));
  const [dsel, setDsel] = useState<string | null>(null);
  const tab = fccTab.value; // intl & forecast tools
  const setTab = (t: FccTab) => (fccTab.value = t);
  const where = useMemo(() => {
    const p = s.points.find((x) => x.id === sel);
    if (p) return { lat: p.lat, lon: p.lon, name: p.name };
    return center ? { lat: center[1], lon: center[0], name: fccAt.value && center[0] === fccAt.value.lon && center[1] === fccAt.value.lat ? `${center[1].toFixed(2)}, ${center[0].toFixed(2)}` : "Map center" } : null; // data 0.6
  }, [sel, center, s.points]);
  const load = () => {
    if (!where) return;
    setBusy(true);
    setErr(null);
    const sv = api.get(`/api/ovl/forecast?lat=${where.lat.toFixed(3)}&lon=${where.lon.toFixed(3)}`).catch((e) => ({ _err: e.message }));
    const om = openMeteo(where.lat, where.lon).catch((e) => ({ _err: String(e.message ?? e) }));
    Promise.all([sv, om])
      .then(([a, b]: any[]) => {
        if (a?._err && b?._err) setErr(a._err);
        const f = build(a?._err ? null : a, b?._err ? null : b, b?._err);
        if (!f.place) f.place = `${where.lat.toFixed(2)}, ${where.lon.toFixed(2)}`;
        setFc(f);
      })
      .finally(() => setBusy(false));
  };
  useEffect(load, [where?.lat, where?.lon]);
  const close = () => (forecastOpen.value = false);
  const hours = useMemo(() => (fc ? fc.hours.slice(0, range) : []), [fc, range]);
  const ptAlerts = useMemo(() => (where ? [...alerts.value.values()].filter((f) => f.geometry && pointInGeometry(where.lon, where.lat, f.geometry)).sort((a, b) => b.properties.priority - a.properties.priority) : []), [alerts.value, where?.lat, where?.lon]);
  const cur = fc?.current;
  const today = fc?.days[0];
  const CurI = cur ? iconFor(cur.short, cur.day) : CloudSun;
  const selDay = fc?.days.find((d) => d.key === dsel) ?? fc?.days.find((d) => d.nws) ?? null;
  return (
    <CenterModal
      cls="fcc"
      icon={<CloudSun size={20} />}
      title="Forecast"
      sub={fc ? `${fc.place}${fc.server?.office ? ` · NWS ${fc.server.office}` : ""}` : where?.name}
      onClose={close}
      actions={
        <>
          <div class="seg sm fcc-tabs">
            <button class={tab === "fc" ? "on" : ""} onClick={() => setTab("fc")}>
              Forecast
            </button>
            <button class={tab === "ens" ? "on" : ""} onClick={() => setTab("ens")}>
              Ensembles
            </button>
            {D6_TABS.map(([k, n]) => (
              <button key={k} class={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {n}
              </button>
            ))}
          </div>
          {where && (
            <button class="btn sm ghost" title="Skew-T sounding for this point" onClick={() => openSounding(where.lat, where.lon)}>
              <Activity size={13} /> Sounding
            </button>
          )}
          <select value={sel} onChange={(e) => update((x) => (x.forecast.point = (e.target as HTMLSelectElement).value))}>
            <option value="center">Map center</option>
            {s.points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {sel === "center" && (
            <button class="btn sm ghost" title="Use the current map center" onClick={() => mapRef.value && setCenter([mapRef.value.getCenter().lng, mapRef.value.getCenter().lat])}>
              <MapPin size={13} /> Here
            </button>
          )}
          <button class="icon-btn" title="Refresh" onClick={() => (omCache.clear(), load())}>
            <RefreshCw size={15} class={busy ? "spin" : ""} />
          </button>
          <button class="icon-btn" title="Compact side panel" onClick={() => ((openPanel.value = "forecast"), close())}>
            <PanelLeft size={15} />
          </button>
        </>
      }
    >
      {tab === "ens" && where && <Ensembles lat={where.lat} lon={where.lon} />}
      {/* data 0.6 */}
      {tab === "models" && where && <ModelCompare lat={where.lat} lon={where.lon} />}
      {tab === "health" && where && <HealthTab lat={where.lat} lon={where.lon} />}
      {tab === "stars" && where && <StarsTab lat={where.lat} lon={where.lon} />}
      {tab === "climate" && where && <ClimatePanel lat={where.lat} lon={where.lon} />}
      {tab === "fc" && err && !fc?.hours.length && <div class="err-text">{err}</div>}
      {tab === "fc" && !fc && !err && <div class="muted">Loading forecast…</div>}
      {tab === "fc" && fc && (
        <div class="fcc-grid">
          <div class="fcc-now">
            <div class="fcc-now-main">
              <CurI size={46} />
              <div>
                <div class="fcc-big">{T(cur?.temp)}</div>
                <div>{cur?.short || "—"}</div>
                <small class="muted">
                  Feels {T(cur?.feels)} · H {T(today?.hi)} L {T(today?.lo)}
                </small>
              </div>
            </div>
            <div class="fcc-stats">
              <Stat icon={<Wind size={11} />} label="Wind" v={cur ? `${dirOf(cur)} ${S(cur.wind)}${cur.gust ? ` G${S(cur.gust, false)}` : ""}` : "—"} />
              <Stat icon={<Droplets size={11} />} label="Humidity" v={cur?.rh != null ? `${Math.round(cur.rh)}%` : "—"} />
              <Stat label="Dewpoint" v={T(cur?.dew)} />
              <Stat icon={<Gauge size={11} />} label="Pressure" v={Pr(cur?.pres)} />
              <Stat label="Clouds" v={cur?.cloud != null ? `${cur.cloud}%` : "—"} />
              <Stat icon={<Eye size={11} />} label="Visibility" v={V(cur?.vis)} />
              <Stat icon={<Sun size={11} />} label="UV" v={cur?.uv != null ? cur.uv.toFixed(0) : "—"} />
              <Stat icon={<Sunrise size={11} />} label="Sunrise" v={hhmm(today?.sunrise, fc.tz)} />
              <Stat icon={<Sunset size={11} />} label="Sunset" v={hhmm(today?.sunset, fc.tz)} />
            </div>
          </div>
          <div class="fcc-alerts">
            <label class="lbl">
              <TriangleAlert size={11} /> Alerts here
            </label>
            {ptAlerts.length === 0 && <div class="muted small">None in effect.</div>}
            {ptAlerts.slice(0, 6).map((a) => (
              <button key={a.properties.id} class="fcc-alert" style={{ borderColor: a.properties.color }} onClick={() => (selectedAlert.value = a.properties.id)}>
                <b style={{ color: a.properties.color }}>{a.properties.event}</b>
                <small class="muted">until {a.properties.ends || a.properties.expires ? new Date(a.properties.ends ?? a.properties.expires).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tzOpt() }) : "—"}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* data 0.8: model agreement per day */ tab === "fc" && fc && where && (
        <section class="fcc-sec p8-fconf">
          <label class="lbl">Forecast confidence</label>
          <ForecastConfidence lat={where.lat} lon={where.lon} />
        </section>
      )}
      {tab === "fc" && fc && hours.length > 1 && (
        <section class="fcc-sec">
          <div class="row">
            <label class="lbl">Hourly</label>
            <div class="seg fcc-range">
              {([48, 168, 336] as const).map((r) => (
                <button key={r} class={range === r ? "on" : ""} disabled={r > fc.hours.length + 24} onClick={() => setRange(r)}>
                  {r === 48 ? "48 h" : r === 168 ? "7 days" : "14 days"}
                </button>
              ))}
            </div>
          </div>
          <Chart hours={hours} tz={fc.tz} on={on} setOn={setOn} />
        </section>
      )}
      {tab === "fc" && fc && fc.days.length > 0 && (
        <section class="fcc-sec">
          <label class="lbl">{fc.days.length} days</label>
          <div class="fcc-days">
            {fc.days.map((d) => {
              const I = iconFor(d.nws?.short ?? d.short, true);
              return (
                <button key={d.key} class={`fcc-day ${selDay?.key === d.key ? "on" : ""}`} onClick={() => setDsel(d.key)} title={d.nws?.text ?? d.short}>
                  <small>{new Date(d.t + (fc.om ? 12 * 3600000 : 0)).toLocaleDateString(undefined, { weekday: "short", timeZone: fc.tz })}</small>
                  <small class="muted">{d.key.slice(5).replace("-", "/")}</small>
                  <I size={26} />
                  <span class="fcc-hilo">
                    <b>{T(d.hi)}</b> <span class="muted">{T(d.lo)}</span>
                  </span>
                  <small class="fcc-short">{d.nws?.short ?? d.short}</small>
                  <small class="fcc-pop">{d.pop ? `${d.pop}%` : " "}{d.precip ? ` · ${P(d.precip)}` : ""}</small>
                  <small class="muted">{d.wind != null ? `${d.dir != null ? compass(d.dir) : ""} ${S(d.wind, false)}${d.gust ? `G${S(d.gust, false)}` : ""}` : ""}</small>
                </button>
              );
            })}
          </div>
          {selDay && (
            <div class="fcc-text">
              <b>{new Date(selDay.t + (fc.om ? 12 * 3600000 : 0)).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: fc.tz })}</b>
              {selDay.sunrise && (
                <small class="muted">
                  {" "}
                  · <Sunrise size={11} /> {hhmm(selDay.sunrise, fc.tz)} <Sunset size={11} /> {hhmm(selDay.sunset, fc.tz)}
                  {selDay.uv != null ? ` · UV ${selDay.uv.toFixed(0)}` : ""}
                  {selDay.snow ? ` · snow ${U().precip === "in" ? `${(selDay.snow / 2.54).toFixed(1)} in` : `${selDay.snow.toFixed(1)} cm`}` : ""}
                </small>
              )}
              {selDay.nws && (
                <p>
                  <b>{selDay.nws.name}:</b> {selDay.nws.text}
                </p>
              )}
              {selDay.nwsNight && (
                <p>
                  <b>{selDay.nwsNight.name}:</b> {selDay.nwsNight.text}
                </p>
              )}
              {!selDay.nws && !selDay.nwsNight && <p class="muted">{selDay.short}. No NWS text forecast for this day.</p>}
            </div>
          )}
        </section>
      )}
      {tab === "fc" && fc && fc.hours.length > 0 && (
        <section class="fcc-sec">
          <label class="lbl">Next 48 hours</label>
          <div class="fcc-table-wrap">
            <table class="fcc-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th />
                  <th class="l">Sky</th>
                  <th>Temp</th>
                  <th>Feels</th>
                  <th>Dew</th>
                  <th>RH</th>
                  <th>Precip</th>
                  <th>Amt</th>
                  <th>Wind</th>
                  <th>Gust</th>
                  <th>Cloud</th>
                  <th>Press</th>
                  <th>Vis</th>
                  <th>UV</th>
                  <th>CAPE</th>
                </tr>
              </thead>
              <tbody>
                {fc.hours.slice(0, 48).map((h) => {
                  const I = iconFor(h.short, h.day);
                  return (
                    <tr key={h.t} class={h.day ? "" : "night"}>
                      <td class="l">{new Date(h.t).toLocaleString(undefined, { weekday: "short", hour: "numeric", timeZone: tzOpt(fc.tz) })}</td>
                      <td>
                        <I size={14} />
                      </td>
                      <td class="l">{h.short}</td>
                      <td class="tt">{T(h.temp)}</td>
                      <td>{T(h.feels)}</td>
                      <td>{T(h.dew)}</td>
                      <td>{h.rh != null ? `${Math.round(h.rh)}%` : "—"}</td>
                      <td class="fcc-pop">{h.pop != null ? `${h.pop}%` : "—"}</td>
                      <td>{h.precip ? P(h.precip) : h.precip === 0 ? "0" : "—"}</td>
                      <td>
                        {dirOf(h)} {S(h.wind, false)}
                      </td>
                      <td>{S(h.gust, false)}</td>
                      <td>{h.cloud != null ? `${h.cloud}%` : "—"}</td>
                      <td>{h.pres != null ? (inHg() ? (h.pres * 0.02953).toFixed(2) : Math.round(h.pres)) : "—"}</td>
                      <td>{V(h.vis)}</td>
                      <td>{h.uv != null ? h.uv.toFixed(0) : "—"}</td>
                      <td>{h.cape != null ? Math.round(h.cape) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === "fc" && fc && (
        <p class="muted small">
          {fc.om ? "Hourly & daily: Open-Meteo.com (CC BY 4.0)" : `Hourly: ${fc.source}${fc.omErr ? ` (Open-Meteo unavailable: ${fc.omErr})` : ""}`}
          {fc.server?.source === "NWS" ? ` · Text forecast: NWS ${fc.server.office ?? ""}` : ""}. Speeds in {U().speed}. Times are local to the point.
        </p>
      )}
    </CenterModal>
  );
}
