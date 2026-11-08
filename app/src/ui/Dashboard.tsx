// radio/dash 0.8: personal dashboard — one screen per saved point: current conditions, warnings at
// the point, nearby storms with ETA, a 12-hour mini meteogram, a radar thumbnail (newest MRMS
// composite rendered around the point, with county/state lines, warnings and storm tracks), air
// quality and pollen, plus a summary card to save as PNG, copy, or print.
// 0.8.2: the cards are widgets on a grid: pencil → drag to move, resize, add/remove, per-widget point
// and options, rename, more dashboards (settings.dashboards; layout maths in dashgrid.ts).

import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LayoutDashboard, MapPin, RefreshCw, ImageDown, Printer, ClipboardCopy, TriangleAlert, CloudLightning, Wind, Droplets, Gauge, Navigation, Locate } from "lucide-preact";
import { settings, toast, openPanel, update } from "../store";
import { alerts } from "../alerts";
import { mapRef } from "../map/mapview";
import { pointInGeometry, distance, bearing, compass, speedFactor } from "../util";
import { stormCellsNow, cellEtaTo, mrmsFrames, rasterFor, spcLevel, SPC_NAME, fmtMi, hhmm, nearestStrike, cached, type Cell } from "../wf6data";
/* 0.8.2: editable layouts, several dashboards, more widgets */
import { Pencil, Plus, Copy, Trash2, Settings2, X, Check, RotateCcw, FileImage, CalendarDays, Zap, Waves, BrainCircuit } from "lucide-preact";
import { normState, defaultDash, place, compact, addWidget, setCols, cellAt, uid, WIDGETS, WTYPES, type Dash, type DashState, type DWidget, type WType } from "./dashgrid";
import { detections } from "../ml/client";
import "./tb082.css";
import { cellFlags } from "../overlays/stormcells";
import { CenterModal } from "./CenterModal";
import { LineChart, type LSeries } from "./Meteogram";
import { saveBlob } from "../radio";
import type { Raster } from "../grid/raster";

export const dashOpen = signal(false);
const dashPoint = signal<string>("");

interface Pt {
  id: string;
  name: string;
  lat: number;
  lon: number;
  color?: string;
}

const WMO: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "T-storms, hail", 99: "T-storms, hail" };
const fT = (c: number | null | undefined) => (c == null || !Number.isFinite(c) ? "—" : settings.value.units.temp === "F" ? `${Math.round(c * 1.8 + 32)}°` : `${Math.round(c)}°`);
const tU = () => (settings.value.units.temp === "F" ? "°F" : "°C");
const fW = (ms: number | null | undefined) => (ms == null ? "—" : `${Math.round(ms * speedFactor())} ${settings.value.units.speed}`);

function aqiLevel(v: number | null | undefined): [string, string] {
  if (v == null || !Number.isFinite(v)) return ["—", "#6b7280"];
  const t = [50, 100, 150, 200, 300];
  const n = ["Good", "Moderate", "Unhealthy for sensitive groups", "Unhealthy", "Very unhealthy", "Hazardous"];
  const c = ["#22c55e", "#facc15", "#f97316", "#ef4444", "#a855f7", "#7e0023"];
  const i = t.findIndex((x) => v <= x);
  return [n[i < 0 ? 5 : i], c[i < 0 ? 5 : i]];
}
const POLLEN: [string, string, number[]][] = [
  ["grass_pollen", "Grass", [5, 20, 200]],
  ["birch_pollen", "Birch", [10, 100, 1000]],
  ["alder_pollen", "Alder", [10, 100, 1000]],
  ["ragweed_pollen", "Ragweed", [5, 20, 200]],
  ["olive_pollen", "Olive", [10, 100, 1000]],
  ["mugwort_pollen", "Mugwort", [5, 20, 200]],
];
const pollenLvl = (v: number, th: number[]) => (v < th[0] ? ["Low", "#22c55e"] : v < th[1] ? ["Moderate", "#facc15"] : v < th[2] ? ["High", "#f97316"] : ["Very high", "#ef4444"]);

// ---------- data ----------

interface DashData {
  t: number;
  om?: any;
  omErr?: string;
  aq?: any;
  aqErr?: string;
  cells?: { c: Cell; d: number; brg: number; eta: number | null }[];
  spc?: { level: number; label: string };
}

const cache = new Map<string, { at: number; p: Promise<any> }>();
function getJson(url: string, ttl = 600_000): Promise<any> {
  const c = cache.get(url);
  if (c && Date.now() - c.at < ttl) return c.p;
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  cache.set(url, { at: Date.now(), p });
  p.catch(() => cache.delete(url));
  return p;
}

async function load(pt: Pt, force = false): Promise<DashData> {
  if (force) cache.clear();
  const { lat, lon } = pt;
  const C = "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m";
  const H = "temperature_2m,apparent_temperature,dew_point_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m";
  const om = getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${C}&hourly=${H}&wind_speed_unit=ms&timezone=auto&forecast_days=2&timeformat=unixtime`);
  const aq = getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=us_aqi,pm2_5,ozone&hourly=${POLLEN.map((p) => p[0]).join(",")},us_aqi&timeformat=unixtime&timezone=auto&forecast_days=1`);
  const cells = stormCellsNow()
    .then((cs) =>
      cs
        .map((c) => ({ c, d: distance(lat, lon, c.lat, c.lon), brg: bearing(lat, lon, c.lat, c.lon), eta: cellEtaTo(c, lat, lon, 8000, 90) }))
        .filter((x) => x.d < 200_000)
        .sort((a, b) => (a.eta ?? 999) - (b.eta ?? 999) || a.d - b.d)
        .slice(0, 6),
    )
    .catch(() => []);
  const [o, a, cl, spc] = await Promise.allSettled([om, aq, cells, spcLevel(lat, lon, 1)]);
  return {
    t: Date.now(),
    om: o.status === "fulfilled" ? o.value : undefined,
    omErr: o.status === "rejected" ? String(o.reason?.message ?? o.reason) : undefined,
    aq: a.status === "fulfilled" ? a.value : undefined,
    aqErr: a.status === "rejected" ? String(a.reason?.message ?? a.reason) : undefined,
    cells: cl.status === "fulfilled" ? cl.value : [],
    spc: spc.status === "fulfilled" ? spc.value : undefined,
  };
}

function warningsAt(pt: Pt) {
  return [...alerts.value.values()].filter((a) => a.geometry && pointInGeometry(pt.lon, pt.lat, a.geometry)).sort((a, b) => b.properties.priority - a.properties.priority);
}

function nowIdx(t: number[]) {
  const now = Date.now();
  let b = 0;
  for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - now) < Math.abs(t[b] - now)) b = i;
  return b;
}

// ---------- radar thumbnail ----------

const DBZ: [number, string][] = [
  [5, "#04e9e7"], [10, "#019ff4"], [15, "#0300f4"], [20, "#02fd02"], [25, "#01c501"], [30, "#008e00"], [35, "#fdf802"], [40, "#e5bc00"], [45, "#fd9500"], [50, "#fd0000"], [55, "#d40000"], [60, "#bc0000"], [65, "#f800fd"], [70, "#9854c6"],
];
const dbzRgb = DBZ.map(([v, c]) => [v, parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] as const);
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
let geoLines: Promise<{ states: number[][][]; counties: number[][][] }> | null = null;
function lines() {
  geoLines ??= Promise.all(["geo/states.json", "geo/counties.json"].map((u) => fetch(u).then((r) => r.json()))).then(([s, c]) => ({ states: s.geometry?.coordinates ?? [], counties: c.geometry?.coordinates ?? [] }));
  return geoLines;
}

const RADAR_KM = 120;
interface Thumb {
  canvas: HTMLCanvasElement;
  time: number;
}

async function radarThumb(pt: Pt, px: number, cells: { c: Cell }[], warn: any[]): Promise<Thumb> {
  const dLat = RADAR_KM / 111;
  const dLon = RADAR_KM / (111 * Math.cos((pt.lat * Math.PI) / 180));
  const w = pt.lon - dLon, e = pt.lon + dLon, s = pt.lat - dLat, n = pt.lat + dLat;
  const X0 = mercX(w), X1 = mercX(e), Y0 = mercY(n), Y1 = mercY(s);
  const ph = Math.round(px * ((Y1 - Y0) / (X1 - X0)));
  const cv = document.createElement("canvas");
  cv.width = px;
  cv.height = ph;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#0b1017";
  g.fillRect(0, 0, px, ph);
  const P = (lon: number, lat: number): [number, number] => [((mercX(lon) - X0) / (X1 - X0)) * px, ((mercY(lat) - Y0) / (Y1 - Y0)) * ph];
  let time = 0;
  // radar
  try {
    const f = (await mrmsFrames("cref", 1)).at(-1);
    if (f) {
      time = f.time;
      const r: Raster = await rasterFor(f.key, w, s, e, n, Math.min(256, px), Math.min(256, ph));
      const img = g.createImageData(r.w, r.h);
      for (let i = 0; i < r.w * r.h; i++) {
        const raw = r.data[i];
        if (!raw) continue;
        const v = r.offset + (raw - 1) * r.scale;
        if (v < 5) continue;
        let k = 0;
        while (k + 1 < dbzRgb.length && v >= dbzRgb[k + 1][0]) k++;
        img.data[i * 4] = dbzRgb[k][1];
        img.data[i * 4 + 1] = dbzRgb[k][2];
        img.data[i * 4 + 2] = dbzRgb[k][3];
        img.data[i * 4 + 3] = 215;
      }
      const tmp = document.createElement("canvas");
      tmp.width = r.w;
      tmp.height = r.h;
      tmp.getContext("2d")!.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(tmp, 0, 0, px, ph);
    }
  } catch {
    /* no grid data: lines only */
  }
  // county + state lines
  try {
    const L = await lines();
    const draw = (ls: number[][][], color: string, lw: number) => {
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.beginPath();
      for (const l of ls) {
        let inBox = false;
        for (const c of l) if (c[0] > w - 1 && c[0] < e + 1 && c[1] > s - 1 && c[1] < n + 1) inBox = true;
        if (!inBox) continue;
        l.forEach((c, i) => {
          const [x, y] = P(c[0], c[1]);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
      }
      g.stroke();
    };
    draw(L.counties, "rgba(255,255,255,0.13)", 0.7);
    draw(L.states, "rgba(255,255,255,0.45)", 1.2);
  } catch {
    /* */
  }
  // warnings covering the point
  for (const a of warn) {
    const polys = a.geometry.type === "Polygon" ? [a.geometry.coordinates] : a.geometry.type === "MultiPolygon" ? a.geometry.coordinates : [];
    g.strokeStyle = a.properties.color ?? "#ff3b30";
    g.lineWidth = 2;
    for (const poly of polys)
      for (const ring of poly) {
        g.beginPath();
        ring.forEach((c: number[], i: number) => {
          const [x, y] = P(c[0], c[1]);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.closePath();
        g.stroke();
      }
  }
  // range rings
  const [cx, cy] = P(pt.lon, pt.lat);
  const kmPx = px / (2 * RADAR_KM);
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.setLineDash([3, 4]);
  g.lineWidth = 1;
  for (const km of [25, 50, 100]) {
    g.beginPath();
    g.arc(cx, cy, km * kmPx, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
  // storms + 60 min tracks
  for (const { c } of cells) {
    const [x, y] = P(c.lon, c.lat);
    if (c.p?.dir_to != null && c.p.sknt > 0) {
      const km = (c.p.sknt * 1.852 * 60) / 60;
      const a = (c.p.dir_to * Math.PI) / 180;
      g.strokeStyle = "#fde047";
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(a) * km * kmPx, y - Math.cos(a) * km * kmPx);
      g.stroke();
    }
    g.fillStyle = "#fde047";
    g.strokeStyle = "#000";
    g.beginPath();
    g.arc(x, y, 3.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  // the point
  g.fillStyle = pt.color ?? "#f472b6";
  g.strokeStyle = "#fff";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, 5.5, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  return { canvas: cv, time };
}

function RadarThumb({ pt, cells, warn, onCanvas }: { pt: Pt; cells: { c: Cell }[]; warn: any[]; onCanvas: (c: HTMLCanvasElement | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<{ time: number; err?: string } | null>(null);
  useEffect(() => {
    let dead = false;
    radarThumb(pt, 360, cells, warn)
      .then((t) => {
        if (dead || !box.current) return;
        box.current.replaceChildren(t.canvas);
        onCanvas(t.canvas);
        setSt({ time: t.time });
      })
      .catch((e) => !dead && setSt({ time: 0, err: e.message }));
    return () => {
      dead = true;
    };
  }, [pt.id, pt.lat, pt.lon, cells.length, warn.length]);
  return (
    <div class="dash-radar">
      <div ref={box} class="dash-radar-img" />
      <div class="muted small">
        {st ? (st.err ? st.err : st.time ? `MRMS composite reflectivity · ${hhmm(st.time)} · rings 25/50/100 km` : "No radar mosaic from the server (lines only)") : "Rendering…"}
        {mapRef.value && (
          <button class="btn sm ghost" onClick={() => (mapRef.value!.flyTo({ center: [pt.lon, pt.lat], zoom: 8 }), (dashOpen.value = false))}>
            <MapPin size={11} /> Open on map
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- summary card (PNG / print) ----------

function summaryCanvas(pt: Pt, d: DashData, warn: any[], radar: HTMLCanvasElement | null): HTMLCanvasElement {
  const W = 960, H = 540;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0f172a");
  grad.addColorStop(1, "#111827");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const font = (sz: number, wt = 400) => `${wt} ${sz}px Inter, system-ui, sans-serif`;
  g.fillStyle = "#e5e7eb";
  g.font = font(26, 700);
  g.fillText(pt.name, 28, 46);
  g.font = font(14);
  g.fillStyle = "#9ca3af";
  g.fillText(`${new Date(d.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${pt.lat.toFixed(3)}, ${pt.lon.toFixed(3)}`, 28, 70);
  const cur = d.om?.current;
  g.fillStyle = "#fff";
  g.font = font(64, 700);
  g.fillText(cur ? fT(cur.temperature_2m) : "—", 28, 150);
  g.font = font(18, 600);
  g.fillStyle = "#d1d5db";
  g.fillText(cur ? WMO[cur.weather_code] ?? "" : "", 160, 120);
  g.font = font(14);
  g.fillStyle = "#9ca3af";
  if (cur) {
    g.fillText(`Feels ${fT(cur.apparent_temperature)} · RH ${cur.relative_humidity_2m}% · ${Math.round(cur.pressure_msl)} hPa`, 160, 144);
    g.fillText(`Wind ${fW(cur.wind_speed_10m)} ${compass(cur.wind_direction_10m)}, gusts ${fW(cur.wind_gusts_10m)}`, 160, 164);
  }
  let y = 206;
  g.font = font(15, 700);
  g.fillStyle = warn.length ? "#fca5a5" : "#86efac";
  g.fillText(warn.length ? `${warn.length} alert${warn.length > 1 ? "s" : ""} in effect` : "No alerts in effect", 28, y);
  g.font = font(14);
  for (const a of warn.slice(0, 4)) {
    y += 22;
    g.fillStyle = a.properties.color ?? "#ef4444";
    g.fillRect(28, y - 11, 10, 10);
    g.fillStyle = "#e5e7eb";
    const until = a.properties.ends ?? a.properties.expires;
    g.fillText(`${a.properties.event}${until ? ` until ${hhmm(Date.parse(until))}` : ""}`, 46, y);
  }
  y += 34;
  g.font = font(15, 700);
  g.fillStyle = "#e5e7eb";
  const soon = d.cells?.find((c) => c.eta != null);
  g.fillText(soon ? `Storm arriving in ~${soon.eta} min (${cellFlags(soon.c.p) || "storm"})` : d.cells?.length ? `Nearest storm ${fmtMi(d.cells[0].d)} ${compass(d.cells[0].brg)}` : "No tracked storms nearby", 28, y);
  if (d.spc && d.spc.level >= 0) {
    y += 24;
    g.font = font(14);
    g.fillStyle = "#fcd34d";
    g.fillText(`SPC day 1: ${SPC_NAME[d.spc.level]}${d.spc.level >= 1 ? ` (${d.spc.level}/5)` : ""}`, 28, y);
  }
  const aqi = d.aq?.current?.us_aqi;
  if (aqi != null) {
    y += 24;
    const [l, c] = aqiLevel(aqi);
    g.fillStyle = c;
    g.font = font(14, 600);
    g.fillText(`Air quality: AQI ${Math.round(aqi)} (${l})`, 28, y);
  }
  // 12 h temperature + precip chance
  const h = d.om?.hourly;
  if (h?.time) {
    const t = h.time.map((x: number) => x * 1000);
    const i0 = nowIdx(t);
    const T = h.temperature_2m.slice(i0, i0 + 13);
    const P = (h.precipitation_probability ?? []).slice(i0, i0 + 13);
    const x0 = 28, x1 = 470, y0 = 420, y1 = 510;
    const lo = Math.min(...T), hi = Math.max(...T) + 0.01;
    g.strokeStyle = "rgba(255,255,255,0.1)";
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    P.forEach((p: number, i: number) => {
      g.fillStyle = "rgba(96,165,250,0.45)";
      const bw = (x1 - x0) / 13;
      const bh = ((p ?? 0) / 100) * (y1 - y0);
      g.fillRect(x0 + i * bw + 2, y1 - bh, bw - 4, bh);
    });
    g.strokeStyle = "#f87171";
    g.lineWidth = 2.5;
    g.beginPath();
    T.forEach((v: number, i: number) => {
      const x = x0 + (i / 12) * (x1 - x0);
      const yy = y1 - 6 - ((v - lo) / (hi - lo)) * (y1 - y0 - 12);
      i ? g.lineTo(x, yy) : g.moveTo(x, yy);
    });
    g.stroke();
    g.fillStyle = "#9ca3af";
    g.font = font(12);
    g.fillText(`Next 12 h: ${fT(lo)}–${fT(hi)}${tU().slice(1)} · bars = chance of precipitation`, x0, y0 - 8);
  }
  if (radar) {
    const rw = 420, rh = Math.round((radar.height / radar.width) * rw);
    const rx = W - rw - 28, ry = Math.max(28, (H - rh) / 2);
    g.drawImage(radar, rx, ry, rw, Math.min(rh, H - 56));
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.strokeRect(rx, ry, rw, Math.min(rh, H - 56));
  }
  g.fillStyle = "#6b7280";
  g.font = font(11);
  g.fillText("Stormiq · Open-Meteo, NWS, MRMS · not for protection of life or property", 28, H - 10);
  return cv;
}

// ---------- UI ----------

function useDash(pt: Pt | null, nonce: number) {
  const [d, setD] = useState<DashData | null>(null);
  useEffect(() => {
    if (!pt) return;
    let dead = false;
    setD(null);
    load(pt, nonce > 0).then((x) => !dead && setD(x));
    const t = window.setInterval(() => load(pt).then((x) => !dead && setD(x)), 5 * 60_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [pt?.id, pt?.lat, pt?.lon, nonce]);
  return d;
}

function Current({ d }: { d: DashData }) {
  const c = d.om?.current;
  if (!c) return <div class="muted small">{d.omErr ? `Forecast unavailable (${d.omErr})` : "Loading…"}</div>;
  return (
    <div class="dash-cur">
      <div class="dash-temp">
        {fT(c.temperature_2m)}
        <small>{tU()}</small>
      </div>
      <div class="dash-curtxt">
        <b>{WMO[c.weather_code] ?? ""}</b>
        <span class="muted">Feels like {fT(c.apparent_temperature)}</span>
      </div>
      <div class="dash-kv">
        <span title="Wind">
          <Wind size={12} /> {fW(c.wind_speed_10m)} {compass(c.wind_direction_10m)}
        </span>
        <span title="Gusts">
          <Navigation size={12} /> gusts {fW(c.wind_gusts_10m)}
        </span>
        <span title="Humidity">
          <Droplets size={12} /> {c.relative_humidity_2m}%
        </span>
        <span title="Pressure">
          <Gauge size={12} /> {Math.round(c.pressure_msl)} hPa
        </span>
      </div>
    </div>
  );
}

function Meteo12({ d }: { d: DashData }) {
  const h = d.om?.hourly;
  const res = useMemo(() => {
    if (!h?.time) return null;
    const t: number[] = h.time.map((x: number) => x * 1000);
    const i0 = nowIdx(t);
    const sl = (a: any[]) => (a ?? []).slice(i0, i0 + 13);
    const conv = (v: number | null) => (v == null ? null : settings.value.units.temp === "F" ? v * 1.8 + 32 : v);
    const temp: LSeries[] = [
      { id: "t", name: "Temperature", color: "#f87171", v: sl(h.temperature_2m).map(conv), width: 2 },
      { id: "td", name: "Dew point", color: "#34d399", v: sl(h.dew_point_2m).map(conv), dash: true },
    ];
    const pop: LSeries[] = [
      { id: "pop", name: "Precip. chance", color: "#60a5fa", v: sl(h.precipitation_probability), bar: true },
      { id: "g", name: "Gusts", color: "#a78bfa", v: sl(h.wind_gusts_10m).map((x: number) => (x == null ? null : x * speedFactor())) },
    ];
    return { t: sl(t), temp, pop, tz: d.om.timezone };
  }, [d.t]);
  if (!res) return <div class="muted small">No hourly forecast.</div>;
  return (
    <div class="dash-meteo">
      <LineChart t={res.t} series={res.temp} h={120} unit={tU()} tz={res.tz} title="Next 12 hours" />
      <LineChart t={res.t} series={res.pop} h={96} unit="" tz={res.tz} zero fmt={(v) => v.toFixed(0)} />
    </div>
  );
}

function AirPollen({ d, pt }: { d: DashData; pt: Pt }) {
  const a = d.aq;
  if (!a) return <div class="muted small">{d.aqErr ? `Air quality unavailable (${d.aqErr})` : "Loading…"}</div>;
  const aqi = a.current?.us_aqi;
  const [l, c] = aqiLevel(aqi);
  const t: number[] = (a.hourly?.time ?? []).map((x: number) => x * 1000);
  const i0 = nowIdx(t);
  const pol = POLLEN.map(([k, name, th]) => {
    const v = (a.hourly?.[k] ?? []).slice(i0, i0 + 24).filter((x: any) => x != null) as number[];
    return v.length ? { name, v: Math.max(...v), lvl: pollenLvl(Math.max(...v), th) } : null;
  }).filter(Boolean) as { name: string; v: number; lvl: string[] }[];
  return (
    <div class="dash-aq">
      <div class="dash-aqi" style={{ borderColor: c }}>
        <b style={{ color: c }}>{aqi != null ? Math.round(aqi) : "—"}</b>
        <span>
          US AQI · {l}
          <small class="muted">
            PM2.5 {a.current?.pm2_5 != null ? `${Math.round(a.current.pm2_5)} µg/m³` : "—"} · ozone {a.current?.ozone != null ? `${Math.round(a.current.ozone)} µg/m³` : "—"}
          </small>
        </span>
      </div>
      {pol.length ? (
        <div class="dash-pollen">
          {pol.map((p) => (
            <span key={p.name} class="chip" style={{ borderColor: p.lvl[1] }} title={`${Math.round(p.v)} grains/m³ (24 h peak)`}>
              {p.name} · <b style={{ color: p.lvl[1] }}>{p.lvl[0]}</b>
            </span>
          ))}
        </div>
      ) : (
        <div class="muted small">{pt.lon > -30 && pt.lon < 45 && pt.lat > 30 ? "No pollen today." : "Pollen forecasts cover Europe only (Open-Meteo / CAMS)."}</div>
      )}
    </div>
  );
}

function Storms({ d }: { d: DashData }) {
  const cs = d.cells ?? [];
  if (!cs.length) return <div class="muted small">No tracked storm cells within 200 km.</div>;
  return (
    <table class="dash-storms">
      <tbody>
        {cs.map(({ c, d: dist, brg, eta }) => (
          <tr key={`${c.lon},${c.lat}`} class={eta != null ? "eta" : ""}>
            <td>
              <b>{c.p.id ?? c.p.storm_id ?? "Cell"}</b>
            </td>
            <td>
              {fmtMi(dist)} {compass(brg)}
            </td>
            <td class="muted">{c.p.sknt ? `→ ${compass(c.p.dir_to)} ${Math.round(c.p.sknt * 1.15)} mph` : "stationary"}</td>
            <td>{cellFlags(c.p) || <span class="muted">—</span>}</td>
            <td class="r">{eta != null ? <b class="dash-eta">{eta <= 1 ? "Overhead" : `ETA ${eta} min`}</b> : <span class="muted">misses</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- 0.8.2: more widgets (forecast days, lightning, river gauges, model detections, summary card) ----------

function useAsync<T>(fn: (() => Promise<T>) | null, deps: any[], refreshMs = 0): { v?: T; err?: string; busy: boolean } {
  const [st, setSt] = useState<{ v?: T; err?: string; busy: boolean }>({ busy: true });
  useEffect(() => {
    if (!fn) return;
    let dead = false;
    const run = () =>
      fn()
        .then((v) => !dead && setSt({ v, busy: false }))
        .catch((e) => !dead && setSt({ err: String(e?.message ?? e), busy: false }));
    setSt({ busy: true });
    run();
    const t = refreshMs ? window.setInterval(run, refreshMs) : 0;
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, deps);
  return st;
}

function Days({ pt, n }: { pt: Pt; n: number }) {
  const r = useAsync(
    () => getJson(`https://api.open-meteo.com/v1/forecast?latitude=${pt.lat.toFixed(4)}&longitude=${pt.lon.toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max&wind_speed_unit=ms&timezone=auto&forecast_days=7&timeformat=unixtime`, 1800_000),
    [pt.id, pt.lat, pt.lon],
    30 * 60_000,
  );
  const dd = r.v?.daily;
  if (!dd?.time) return <div class="muted small">{r.err ? `Forecast unavailable (${r.err})` : "Loading…"}</div>;
  return (
    <div class="dash-days">
      {dd.time.slice(0, n).map((t: number, i: number) => (
        <div key={t} class="dash-day" title={`Gusts ${fW(dd.wind_gusts_10m_max?.[i])}`}>
          <span class="muted">{i === 0 ? "Today" : new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", timeZone: r.v.timezone })}</span>
          <b>
            {fT(dd.temperature_2m_max?.[i])} / <span class="muted">{fT(dd.temperature_2m_min?.[i])}</span>
          </b>
          <span>{WMO[dd.weather_code?.[i]] ?? ""}</span>
          <span class="muted">{dd.precipitation_probability_max?.[i] != null ? `${dd.precipitation_probability_max[i]}% precip.` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function Lightning({ pt, minutes }: { pt: Pt; minutes: number }) {
  const r = useAsync(() => nearestStrike(pt.lat, pt.lon, minutes, 300_000), [pt.id, pt.lat, pt.lon, minutes], 60_000);
  if (r.busy && r.v === undefined) return <div class="muted small">Loading…</div>;
  if (r.err) return <div class="muted small">Lightning unavailable ({r.err})</div>;
  const s = r.v;
  if (!s) return <div class="muted small">No lightning within 300 km in the last {minutes} min (GOES GLM).</div>;
  return (
    <div>
      <div class="dash-big" style={{ color: s.dist < 16_000 ? "#f87171" : s.dist < 48_000 ? "#fbbf24" : undefined }}>
        {fmtMi(s.dist)} <small class="muted">{compass(s.brg)}</small>
      </div>
      <div class="muted small">
        Nearest flash {Math.max(0, Math.round(s.age / 60_000))} min ago · {s.count} within 300 km · last {minutes} min
      </div>
    </div>
  );
}

const GAUGE_RANK: Record<string, number> = { major: 5, moderate: 4, minor: 3, action: 2, no_flooding: 1 };
const GAUGE_COL: Record<string, string> = { major: "#a855f7", moderate: "#ef4444", minor: "#f97316", action: "#facc15", no_flooding: "#22c55e" };
function Gauges({ pt, km, all }: { pt: Pt; km: number; all: boolean }) {
  const r = useAsync(() => cached<any>("/api/ovl/gauges", 600_000), [], 15 * 60_000);
  const list = useMemo(() => {
    const out: { p: any; d: number }[] = [];
    for (const f of r.v?.features ?? []) {
      const c = f.geometry?.coordinates;
      if (!c) continue;
      const d = distance(pt.lat, pt.lon, c[1], c[0]);
      if (d > km * 1000) continue;
      if (!all && (GAUGE_RANK[f.properties?.cat] ?? 0) < 2) continue;
      out.push({ p: f.properties ?? {}, d });
    }
    return out.sort((a, b) => (GAUGE_RANK[b.p.cat] ?? 0) - (GAUGE_RANK[a.p.cat] ?? 0) || a.d - b.d).slice(0, 8);
  }, [r.v, pt.lat, pt.lon, km, all]);
  if (!r.v) return <div class="muted small">{r.err ? `River gauges unavailable (${r.err})` : "Loading…"}</div>;
  if (!list.length) return <div class="muted small">{all ? `No river gauges within ${km} km.` : `No gauges at action stage or above within ${km} km.`}</div>;
  return (
    <div class="dash-list">
      {list.map(({ p, d }) => (
        <div key={p.id} title={`${p.id}${p.stage != null ? ` · stage ${p.stage} ${p.unit ?? ""}` : ""}`}>
          <span>{p.name ?? p.id}</span>
          <b style={{ color: GAUGE_COL[p.cat] ?? "#9ca3af" }}>{String(p.cat ?? "—").replace(/_/g, " ")}</b>
          <span class="muted">{fmtMi(d)}</span>
        </div>
      ))}
    </div>
  );
}

function Detections({ pt, km }: { pt: Pt; km: number }) {
  const list = detections.value
    .filter((x) => !x.test)
    .map((x) => ({ x, d: distance(pt.lat, pt.lon, x.lat, x.lon) }))
    .filter((r) => r.d <= km * 1000)
    .sort((a, b) => b.x.prob - a.x.prob || a.d - b.d)
    .slice(0, 8);
  if (!list.length) return <div class="muted small">No model detections within {km} km (detection models must be running).</div>;
  return (
    <div class="dash-list">
      {list.map(({ x, d }) => (
        <div key={x.key} title={`${x.model_name} · ${x.site} · ${hhmm(x.t)}`}>
          <span>
            {x.model_name} <span class="muted">{x.target}</span>
          </span>
          <b style={{ color: x.level === "high" ? "#f87171" : x.level === "med" ? "#fbbf24" : "#9ca3af" }}>{x.value != null ? x.value.toFixed(0) : `${Math.round(x.prob * 100)}%`}</b>
          <span class="muted">{fmtMi(d)}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryPreview({ pt, d, warn }: { pt: Pt; d: DashData; warn: any[] }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let dead = false;
    radarThumb(pt, 360, d.cells ?? [], warn)
      .catch(() => null)
      .then((r) => !dead && setUrl(summaryCanvas(pt, d, warn, r?.canvas ?? null).toDataURL("image/png")));
    return () => {
      dead = true;
    };
  }, [pt.id, d.t, warn.length]);
  return url ? <img class="dash-sumimg" src={url} alt={`Summary card for ${pt.name}`} /> : <div class="muted small">Rendering…</div>;
}

// ---------- 0.8.2: one widget ----------

const DATA_TYPES = new Set<WType>(["cur", "radar", "storms", "meteo", "aq", "summary"]);

function Widget({ w, pt, sel, nonce, onRadar }: { w: DWidget; pt: Pt; sel: Pt; nonce: number; onRadar: (id: string, c: HTMLCanvasElement | null) => void }) {
  const d = useDash(DATA_TYPES.has(w.type) ? pt : null, nonce);
  const warn = w.type === "warn" || w.type === "radar" || w.type === "summary" ? warningsAt(pt) : [];
  const other = pt.id !== sel.id ? <small class="muted">· {pt.name}</small> : null;
  const head = (def: any, icon?: any) => (
    <h3>
      {icon}
      {w.title || def}
      {other}
    </h3>
  );
  const load = <div class="muted small">Loading…</div>;
  const o = w.opt ?? {};
  switch (w.type) {
    case "cur":
      return (
        <>
          {head("Now")}
          {d ? <Current d={d} /> : load}
          {d?.spc && d.spc.level >= 0 && (
            <div class={`dash-spc l${d.spc.level}`}>
              SPC day 1: <b>{SPC_NAME[d.spc.level]}</b>
              {d.spc.level >= 1 ? ` (${d.spc.level} of 5)` : ""}
            </div>
          )}
        </>
      );
    case "warn":
      return (
        <>
          <h3>
            <TriangleAlert size={14} /> {w.title || "Alerts here"} <small class="muted">{warn.length}</small>
            {other}
          </h3>
          {!warn.length && <div class="muted small">No watches, warnings or advisories cover this point.</div>}
          {warn.slice(0, 6).map((a) => {
            const p = a.properties;
            const until = p.ends ?? p.expires;
            return (
              <div key={p.id} class="dash-warn" style={{ borderLeftColor: p.color }}>
                <b style={{ color: p.color }}>{p.event}</b>
                {p.tag && <span class="same-tag">{p.tag}</span>}
                <span class="muted small">{until ? `until ${hhmm(Date.parse(until))}` : ""}</span>
                <div class="muted small dash-warn-h">{p.headline ?? p.areaDesc}</div>
              </div>
            );
          })}
        </>
      );
    case "radar":
      return (
        <>
          {head("Radar")}
          {d ? <RadarThumb pt={pt} cells={d.cells ?? []} warn={warn} onCanvas={(c) => onRadar(pt.id, c)} /> : load}
        </>
      );
    case "storms":
      return (
        <>
          {head("Nearby storms", <CloudLightning size={14} />)}
          {d ? <Storms d={d} /> : load}
        </>
      );
    case "meteo":
      return (
        <>
          {(w.title || other) && head("Next 12 hours")}
          {d ? <Meteo12 d={d} /> : load}
        </>
      );
    case "aq":
      return (
        <>
          {head("Air quality & pollen")}
          {d ? <AirPollen d={d} pt={pt} /> : load}
        </>
      );
    case "summary":
      return (
        <>
          {head("Summary card", <FileImage size={14} />)}
          {d ? <SummaryPreview pt={pt} d={d} warn={warn} /> : load}
        </>
      );
    case "days":
      return (
        <>
          {head("Forecast", <CalendarDays size={14} />)}
          <Days pt={pt} n={o.days ?? 5} />
        </>
      );
    case "ltg":
      return (
        <>
          {head("Lightning", <Zap size={14} />)}
          <Lightning pt={pt} minutes={o.minutes ?? 15} />
        </>
      );
    case "gauges":
      return (
        <>
          {head("River gauges", <Waves size={14} />)}
          <Gauges pt={pt} km={o.km ?? 50} all={o.only === "all"} />
        </>
      );
    case "ml":
      return (
        <>
          {head("Model detections", <BrainCircuit size={14} />)}
          <Detections pt={pt} km={o.km ?? 100} />
        </>
      );
  }
  return null;
}

/** per-widget options (edit mode) */
const OPTS: Partial<Record<WType, { key: string; label: string; choices: [any, string][]; def: any }[]>> = {
  days: [{ key: "days", label: "Days", choices: [[3, "3"], [5, "5"], [7, "7"]], def: 5 }],
  ltg: [{ key: "minutes", label: "Window", choices: [[5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "60 min"]], def: 15 }],
  gauges: [
    { key: "km", label: "Within", choices: [[25, "25 km"], [50, "50 km"], [100, "100 km"], [200, "200 km"]], def: 50 },
    { key: "only", label: "Show", choices: [["flood", "Action stage & flooding"], ["all", "All gauges"]], def: "flood" },
  ],
  ml: [{ key: "km", label: "Within", choices: [[50, "50 km"], [100, "100 km"], [200, "200 km"]], def: 100 }],
};

function WidgetOpts({ w, pts, set, onClose }: { w: DWidget; pts: Pt[]; set: (w: DWidget) => void; onClose: () => void }) {
  return (
    <div class="dash-wopts glass" onPointerDown={(e) => e.stopPropagation()}>
      <label>
        <span class="muted">Title</span>
        <input value={w.title ?? ""} placeholder={WIDGETS[w.type].name} onInput={(e) => set({ ...w, title: (e.target as HTMLInputElement).value || undefined })} />
      </label>
      <label>
        <span class="muted">Point</span>
        <select value={w.pt ?? ""} onChange={(e) => set({ ...w, pt: (e.target as HTMLSelectElement).value || undefined })}>
          <option value="">Selected tab</option>
          {pts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {(OPTS[w.type] ?? []).map((o) => (
        <label key={o.key}>
          <span class="muted">{o.label}</span>
          <select value={String(w.opt?.[o.key] ?? o.def)} onChange={(e) => set({ ...w, opt: { ...(w.opt ?? {}), [o.key]: o.choices.find(([v]) => String(v) === (e.target as HTMLSelectElement).value)![0] } })}>
            {o.choices.map(([v, l]) => (
              <option key={String(v)} value={String(v)}>
                {l}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button class="btn sm" onClick={onClose}>
        <Check size={13} /> Done
      </button>
    </div>
  );
}

// ---------- 0.8.2: the grid (view + drag-and-drop editor) ----------

function DashGrid({ dash, editing, sel, all, nonce, onRadar, onChange }: { dash: Dash; editing: boolean; sel: Pt; all: Pt[]; nonce: number; onRadar: (id: string, c: HTMLCanvasElement | null) => void; onChange: (ws: DWidget[]) => void }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<DWidget[] | null>(null);
  const [dragId, setDragId] = useState("");
  const [optsFor, setOptsFor] = useState("");
  const ws = live ?? dash.widgets;
  const cols = dash.cols;
  const ptOf = (w: DWidget) => (w.pt ? all.find((p) => p.id === w.pt) : null) ?? sel;
  const start = (e: PointerEvent, w: DWidget, mode: "move" | "size") => {
    if (!editing || e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest(".dash-wtools,.dash-wopts,.dash-resize,input,select,button")) return;
    e.preventDefault();
    e.stopPropagation();
    const g = gridRef.current!;
    const r = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    const gap = parseFloat(cs.columnGap) || 12;
    const rows = cs.gridTemplateRows
      .split(/\s+/)
      .map(parseFloat)
      .filter((x) => Number.isFinite(x));
    const at = (ev: PointerEvent) => cellAt(ev.clientX - r.left, ev.clientY - r.top, cols, r.width, gap, rows);
    const c0 = at(e);
    const dx = c0.x - w.x, dy = c0.y - w.y;
    let latest = dash.widgets;
    setDragId(w.id);
    setOptsFor("");
    const move = (ev: PointerEvent) => {
      const c = at(ev);
      latest = mode === "move" ? place(dash.widgets, w.id, c.x - dx, Math.max(0, c.y - dy), w.w, w.h, cols) : place(dash.widgets, w.id, w.x, w.y, Math.max(1, c.x - w.x + 1), Math.max(1, c.y - w.y + 1), cols);
      setLive(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragId("");
      setLive(null);
      if (latest !== dash.widgets) onChange(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent, w: DWidget) => {
    if (!editing || (e.target as HTMLElement) !== e.currentTarget) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (d[e.key]) {
      e.preventDefault();
      const [ax, ay] = d[e.key];
      onChange(e.shiftKey ? place(dash.widgets, w.id, w.x, w.y, Math.max(1, w.w + ax), Math.max(1, w.h + ay), cols) : place(dash.widgets, w.id, w.x + ax, Math.max(0, w.y + ay), w.w, w.h, cols));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onChange(compact(dash.widgets.filter((x) => x.id !== w.id)));
    }
  };
  return (
    <div ref={gridRef} class={`dash-grid d82 ${editing ? "editing" : ""}`} style={{ "--dash-cols": cols } as any}>
      {ws.map((w) => (
        <section
          key={w.id}
          class={`dash-card dash-c-${w.type} ${w.type === "warn" && warningsAt(ptOf(w)).length ? "hot" : ""} ${dragId === w.id ? "dragging" : ""} ${optsFor === w.id ? "opts-open" : ""}`}
          style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
          tabIndex={editing ? 0 : undefined}
          aria-label={editing ? `${w.title || WIDGETS[w.type].name}: arrows move, Shift+arrows resize, Delete removes` : undefined}
          onPointerDown={(e) => start(e as any, w, "move")}
          onKeyDown={(e) => key(e as any, w)}
        >
          <div class="dash-card-body">
            <Widget w={w} pt={ptOf(w)} sel={sel} nonce={nonce} onRadar={onRadar} />
          </div>
          {editing && (
            <>
              <div class="dash-wtools">
                <button class="icon-btn" title="Widget settings" onClick={() => setOptsFor(optsFor === w.id ? "" : w.id)}>
                  <Settings2 size={13} />
                </button>
                <button
                  class="icon-btn"
                  title="Duplicate widget"
                  onClick={() => {
                    const id = uid();
                    const ws2 = addWidget(dash, w.type, id).widgets.map((x) => (x.id === id ? { ...x, pt: w.pt, opt: w.opt, title: w.title } : x));
                    const n = ws2.find((x) => x.id === id)!;
                    onChange(place(ws2, id, n.x, n.y, w.w, w.h, cols));
                  }}
                >
                  <Copy size={13} />
                </button>
                <button class="icon-btn" title="Remove widget" onClick={() => onChange(compact(dash.widgets.filter((x) => x.id !== w.id)))}>
                  <X size={13} />
                </button>
              </div>
              {optsFor === w.id && <WidgetOpts w={w} pts={all} set={(nw) => onChange(dash.widgets.map((x) => (x.id === w.id ? nw : x)))} onClose={() => setOptsFor("")} />}
              <div class="dash-resize" title="Drag to resize" onPointerDown={(e) => start(e as any, w, "size")} />
            </>
          )}
        </section>
      ))}
      {!ws.length && <div class="dash-empty muted">{editing ? "Add widgets from the bar above." : "This dashboard is empty: click the pencil to add widgets."}</div>}
    </div>
  );
}

// ---------- window ----------

export function Dashboard() {
  if (!dashOpen.value) return null;
  return <DashBody />;
}

function DashBody() {
  const s = settings.value;
  const pts: Pt[] = s.points.length ? s.points : [];
  const c = mapRef.value?.getCenter();
  const center: Pt = { id: "_center", name: "Map center", lat: c?.lat ?? s.view.center[1], lon: c?.lng ?? s.view.center[0] };
  const all = [...pts, center];
  const sel = all.find((p) => p.id === dashPoint.value) ?? all[0];
  const [nonce, setNonce] = useState(0);
  const d = useDash(sel, nonce);
  /* 0.8.2: dashboards; `draft` = the edit-mode copy (Done saves it, Cancel drops it) */
  const saved = useMemo(() => normState(s.dashboards), [s.dashboards]);
  const [draft, setDraft] = useState<DashState | null>(null);
  const st = draft ?? saved;
  const dash = st.list.find((x) => x.id === st.active) ?? st.list[0];
  const editing = !!draft;
  const setDash = (fn: (d: Dash) => Dash) => draft && setDraft({ ...draft, list: draft.list.map((x) => (x.id === dash.id ? fn(x) : x)) });
  const switchTo = (id: string) => (draft ? setDraft({ ...draft, active: id }) : update((x) => (x.dashboards = { ...normState(x.dashboards), active: id })));
  const done = () => {
    if (draft) update((x) => (x.dashboards = normState(draft)));
    setDraft(null);
  };
  const newDash = (copy: boolean) => {
    if (!draft) return;
    const id = uid();
    const n: Dash = copy ? { ...structuredClone(dash), id, name: `${dash.name} copy` } : { id, name: `Dashboard ${draft.list.length + 1}`, cols: 3, widgets: [] };
    setDraft({ list: [...draft.list, n], active: id });
  };
  const delDash = () => {
    if (!draft || draft.list.length < 2 || !confirm(`Delete “${dash.name}”?`)) return;
    const list = draft.list.filter((x) => x.id !== dash.id);
    setDraft({ list, active: list[0].id });
  };
  const radars = useRef(new Map<string, HTMLCanvasElement>());
  const onRadar = (id: string, cv: HTMLCanvasElement | null) => (cv ? radars.current.set(id, cv) : radars.current.delete(id));
  const warn = warningsAt(sel);
  const card = async () => {
    if (!d) return null;
    const r = radars.current.get(sel.id) ?? (await radarThumb(sel, 360, d.cells ?? [], warn).catch(() => null))?.canvas ?? null;
    return summaryCanvas(sel, d, warn, r);
  };
  const savePng = async () => {
    const cv = await card();
    cv?.toBlob((b) => b && saveBlob(b, `${sel.name.replace(/[^\w.-]+/g, "_")}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.png`), "image/png");
  };
  const copyPng = async () => {
    const cv = await card();
    cv?.toBlob(async (b) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": b! })]);
        toast("Summary card copied");
      } catch {
        toast("Couldn't copy the image here: use Save PNG", "warn");
      }
    }, "image/png");
  };
  const print = async () => {
    const cv = await card();
    if (!cv) return;
    const img = document.createElement("img");
    img.className = "dash-print-img";
    img.src = cv.toDataURL("image/png");
    document.body.appendChild(img);
    document.body.classList.add("dash-printing");
    const done = () => {
      document.body.classList.remove("dash-printing");
      img.remove();
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    img.onload = () => setTimeout(() => window.print(), 50);
  };
  const title = editing ? (
    <input class="dash-name-in" value={dash.name} aria-label="Dashboard name" onInput={(e) => setDash((x) => ({ ...x, name: (e.target as HTMLInputElement).value }))} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  ) : st.list.length > 1 ? (
    <select class="dash-switch" value={dash.id} aria-label="Dashboard" title="Switch dashboard" onChange={(e) => switchTo((e.target as HTMLSelectElement).value)}>
      {st.list.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  ) : (
    dash.name
  );
  return (
    <CenterModal
      cls="dash"
      icon={<LayoutDashboard size={19} />}
      title={title}
      sub={`${sel.name} · ${sel.lat.toFixed(3)}, ${sel.lon.toFixed(3)}${d ? ` · updated ${hhmm(d.t)}` : ""}`}
      onClose={() => ((dashOpen.value = false), setDraft(null))}
      actions={
        editing ? (
          <>
            <button class="btn sm ghost" onClick={() => setDraft(null)} title="Drop the changes">
              Cancel
            </button>
            <button class="btn sm" onClick={done} title="Save the layout">
              <Check size={13} /> Done
            </button>
          </>
        ) : (
          <>
            <button class="icon-btn" title="Edit dashboard: layout, widgets, name, more dashboards" aria-label="Edit dashboard" onClick={() => setDraft(structuredClone(saved))}>
              <Pencil size={15} />
            </button>
            <button class="icon-btn" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw size={15} />
            </button>
            <button class="btn sm ghost" disabled={!d} title="Save the summary card as PNG" onClick={savePng}>
              <ImageDown size={13} /> Save PNG
            </button>
            <button class="icon-btn" disabled={!d} title="Copy the summary card image" onClick={copyPng}>
              <ClipboardCopy size={15} />
            </button>
            <button class="icon-btn" disabled={!d} title="Print the summary card" onClick={print}>
              <Printer size={15} />
            </button>
          </>
        )
      }
    >
      <div class="dash-tabs" role="tablist">
        {all.map((p) => (
          <button key={p.id} role="tab" aria-selected={p.id === sel.id} class={p.id === sel.id ? "on" : ""} onClick={() => (dashPoint.value = p.id)}>
            {p.id === "_center" ? <Locate size={13} /> : <MapPin size={13} style={{ color: p.color }} />} {p.name}
            {warningsAt(p).length > 0 && <span class="dash-wdot" title="Alerts in effect" />}
          </button>
        ))}
        {!pts.length && (
          <button class="btn sm ghost" onClick={() => ((openPanel.value = "points"), (dashOpen.value = false))}>
            Add saved points…
          </button>
        )}
      </div>
      {editing && (
        <div class="dash-edbar" role="toolbar" aria-label="Dashboard editor">
          <span class="muted">Add:</span>
          <div class="dash-palette">
            {WTYPES.map((t) => (
              <button key={t} class="btn sm ghost" onClick={() => setDash((x) => addWidget(x, t, uid()))}>
                <Plus size={12} /> {WIDGETS[t].name}
              </button>
            ))}
          </div>
          <span class="sp" />
          <label class="row" style={{ gap: 6 }}>
            <span class="muted">Columns</span>
            <select value={dash.cols} onChange={(e) => setDash((x) => setCols(x, +(e.target as HTMLSelectElement).value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {st.list.length > 1 && (
            <select value={dash.id} aria-label="Dashboard" onChange={(e) => switchTo((e.target as HTMLSelectElement).value)}>
              {st.list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          <button class="btn sm ghost" title="New empty dashboard" onClick={() => newDash(false)}>
            <Plus size={12} /> New
          </button>
          <button class="btn sm ghost" title="Duplicate this dashboard" onClick={() => newDash(true)}>
            <Copy size={12} /> Duplicate
          </button>
          <button class="btn sm ghost" title="Back to the standard layout" onClick={() => setDash((x) => ({ ...x, cols: 3, widgets: defaultDash().widgets }))}>
            <RotateCcw size={12} /> Reset
          </button>
          <button class="btn sm ghost" title="Delete this dashboard" disabled={st.list.length < 2} onClick={delDash}>
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
      <DashGrid dash={dash} editing={editing} sel={sel} all={all} nonce={nonce} onRadar={onRadar} onChange={(ws) => setDash((x) => ({ ...x, widgets: ws }))} />
    </CenterModal>
  );
}

(window as any).__tbwDash = { dashOpen, dashPoint };
