// workflow 0.6: shared data helpers for route weather, rules, briefings and desktop widgets.
// Small, cached fetchers on top of the server API (no MapLibre here, so widget windows can use it).

import { api } from "./api";
import { settings, type SavedPoint } from "./store";
import { distance, bearing, compass, pointInGeometry } from "./util";
import { mergeCells, cellFlags } from "./overlays/stormcells";
import { parseRaster, rasterValue, type Raster } from "./grid/raster";

const cache = new Map<string, { t: number; p: Promise<any> }>();
/** GET with a time-to-live cache (failed requests are dropped from the cache). */
export function cached<T = any>(path: string, ttlMs: number): Promise<T> {
  const c = cache.get(path);
  if (c && Date.now() - c.t < ttlMs) return c.p;
  const p = api.get(path);
  cache.set(path, { t: Date.now(), p });
  p.catch(() => cache.delete(path));
  if (cache.size > 300) for (const [k, v] of cache) if (Date.now() - v.t > 3600_000) cache.delete(k);
  return p;
}

export const MI = 1609.344;
export const fmtMi = (m: number) => {
  const u = settings.value.units.distance;
  const v = u === "km" ? m / 1000 : u === "nmi" ? m / 1852 : m / MI;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u}`;
};
export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });

/** A saved point by id ("" = the first one), or null. */
export function pointById(id: string): SavedPoint | null {
  const pts = settings.value.points;
  return pts.find((p) => p.id === id) ?? pts[0] ?? null;
}

// ---------- storm cells ----------
export interface Cell {
  lon: number;
  lat: number;
  p: any;
}
/** NEXRAD storm cells (merged across radars), refreshed every 2 min. */
export async function stormCellsNow(): Promise<Cell[]> {
  const fc = await cached("/api/ovl/stormattr", 120_000);
  return (mergeCells(fc?.features ?? []) as any[]).filter((f) => f.geometry?.coordinates).map((f) => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], p: f.properties ?? {} }));
}

/** Minutes until a cell's projected path (dir_to / sknt, 60 min) passes within `radiusM` of a
 * point (same model as overlays/stormcells.ts cellEtas), or null. */
export function cellEtaTo(c: Cell, lat: number, lon: number, radiusM = 5000, horizonMin = 60): number | null {
  const p = c.p;
  const k = Math.cos((c.lat * Math.PI) / 180) * 111_195;
  const dx = (lon - c.lon) * k, dy = (lat - c.lat) * 111_195;
  if (Math.hypot(dx, dy) < radiusM) return 0;
  if (p?.dir_to == null || !(p.sknt > 0)) return null;
  const mpm = (p.sknt * 1852) / 60;
  const a = (p.dir_to * Math.PI) / 180;
  const ux = Math.sin(a), uy = Math.cos(a);
  const along = dx * ux + dy * uy, cross = Math.abs(dx * uy - dy * ux);
  if (along < 0 || along > mpm * horizonMin + radiusM || cross > radiusM) return null;
  return Math.max(0, Math.round(along / mpm));
}

/** The soonest storm arrival at a point (cell track within ~5 km in the next hour). */
export async function nextArrival(pt: { lat: number; lon: number }): Promise<{ cell: Cell; min: number; flags: string; at: number } | null> {
  const cells = await stormCellsNow();
  let best: { cell: Cell; min: number; flags: string; at: number } | null = null;
  for (const c of cells) {
    const m = cellEtaTo(c, pt.lat, pt.lon);
    if (m == null) continue;
    const t0 = c.p.t && Date.now() - c.p.t < 3600_000 ? c.p.t : Date.now();
    const t = t0 + m * 60_000;
    if (!best || t < best.at) best = { cell: c, min: Math.max(0, Math.round((t - Date.now()) / 60_000)), flags: cellFlags(c.p), at: t };
  }
  return best;
}

/** Nearest storm cell to a point. */
export async function nearestCell(lat: number, lon: number): Promise<{ cell: Cell; dist: number; brg: number } | null> {
  const cells = await stormCellsNow();
  let best: { cell: Cell; dist: number; brg: number } | null = null;
  for (const c of cells) {
    const d = distance(lat, lon, c.lat, c.lon);
    if (!best || d < best.dist) best = { cell: c, dist: d, brg: bearing(lat, lon, c.lat, c.lon) };
  }
  return best;
}

// ---------- lightning ----------
/** the radar agent's helper, when it exists (src/radar/lightning*.ts exporting lightningNear) */
const ltgMods = import.meta.glob("./radar/lightning*.ts");
let ltgHelper: ((lat: number, lon: number, radiusM: number, minutes: number) => any) | null | undefined;
async function helper() {
  if (ltgHelper !== undefined) return ltgHelper;
  ltgHelper = null;
  for (const load of Object.values(ltgMods)) {
    try {
      const m: any = await load();
      if (typeof m.lightningNear === "function") ltgHelper = m.lightningNear;
    } catch {
      /* not available */
    }
  }
  return ltgHelper;
}

/** Nearest GOES GLM flash within `minutes` (distance m, bearing, age ms), or null. */
export async function nearestStrike(lat: number, lon: number, minutes = 15, radiusM = 300_000): Promise<{ dist: number; brg: number; age: number; count: number } | null> {
  const h = await helper();
  if (h) {
    try {
      // radar 0.6 helper: lightningNear(lat, lon, km, minutes) → { count, dist?, brg?, age? }
      const r: any = await h(lat, lon, radiusM / 1000, minutes);
      if (r && r.count > 0 && typeof r.dist === "number") return { dist: r.dist, brg: r.brg ?? 0, age: r.age ?? 0, count: r.count };
      if (r && r.count === 0) return null;
    } catch {
      /* fall back */
    }
  }
  const fc = await cached(`/api/ovl/glm?minutes=${Math.max(5, Math.min(60, Math.round(minutes)))}`, 60_000);
  let best: { dist: number; brg: number; age: number; count: number } | null = null;
  let n = 0;
  for (const f of fc?.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const d = distance(lat, lon, c[1], c[0]);
    if (d > radiusM) continue;
    n++;
    // GLM "age" is seconds (server); older than asked is ignored
    const ageMin = Number(f.properties?.age ?? 0) / 60;
    if (ageMin > minutes) continue;
    if (!best || d < best.dist) best = { dist: d, brg: bearing(lat, lon, c[1], c[0]), age: ageMin * 60_000, count: 0 };
  }
  if (best) best.count = n;
  return best;
}

// ---------- MRMS reflectivity ----------
export async function mrmsFrames(layer = "cref", n = 1): Promise<{ key: string; time: number }[]> {
  const r = await cached(`/api/grid/frames?layer=${layer}&n=${n}`, 90_000);
  return r?.frames ?? [];
}
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
/** A rendered raster of a frame over a lon/lat box (cached per key + box). */
export async function rasterFor(key: string, w: number, s: number, e: number, n: number, px = 256, ph = px): Promise<Raster> {
  const bb = [mercX(w), mercY(n), mercX(e), mercY(s)].map((v) => v.toFixed(5)).join(",");
  const path = `/api/grid/render?key=${encodeURIComponent(key)}&bbox=${bb}&w=${px}&h=${ph}`;
  const c = cache.get("R" + path);
  if (c && Date.now() - c.t < 600_000) return c.p;
  const p = api.bin(path).then((b) => parseRaster(b, key));
  cache.set("R" + path, { t: Date.now(), p });
  p.catch(() => cache.delete("R" + path));
  return p;
}
/** dBZ at many points from one raster of the newest MRMS composite (NaN = no echo). */
export async function dbzAt(pts: { lat: number; lon: number }[], key?: string): Promise<{ values: number[]; time: number }> {
  let time = 0;
  if (!key) {
    const f = (await mrmsFrames("cref", 1)).at(-1);
    if (!f) return { values: pts.map(() => NaN), time: 0 };
    key = f.key;
    time = f.time;
  }
  if (!pts.length) return { values: [], time };
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) (w = Math.min(w, p.lon)), (e = Math.max(e, p.lon)), (s = Math.min(s, p.lat)), (n = Math.max(n, p.lat));
  const pad = 0.1;
  const span = Math.max(e - w, n - s);
  const px = Math.min(1024, Math.max(64, Math.round(span * 120)));
  const r = await rasterFor(key, w - pad, s - pad, e + pad, n + pad, px, px);
  return { values: pts.map((p) => rasterValue(r, p.lat, p.lon)), time };
}
/** Strongest echo near a point now and ~30 min ago: max dBZ within radius, nearest ≥ 35 dBZ. */
export async function echoTrend(lat: number, lon: number, radiusM = 60_000): Promise<{ now: number; before: number; core: { dist: number; brg: number; dbz: number } | null; time: number } | null> {
  const fs = await mrmsFrames("cref", 16);
  if (!fs.length) return null;
  const cur = fs[fs.length - 1];
  const old = [...fs].reverse().find((f) => cur.time - f.time >= 25 * 60_000) ?? fs[0];
  const dLat = radiusM / 111_195, dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const scan = async (key: string) => {
    const r = await rasterFor(key, lon - dLon, lat - dLat, lon + dLon, lat + dLat, 96, 96);
    let mx = NaN;
    let core: { dist: number; brg: number; dbz: number } | null = null;
    for (let j = 0; j < 48; j++)
      for (let i = 0; i < 48; i++) {
        const la = lat - dLat + ((j + 0.5) / 48) * 2 * dLat, lo = lon - dLon + ((i + 0.5) / 48) * 2 * dLon;
        const v = rasterValue(r, la, lo);
        if (!(v > -50)) continue;
        const d = distance(lat, lon, la, lo);
        if (d > radiusM) continue;
        if (!(v <= mx)) mx = v;
        if (v >= 35 && (!core || d < core.dist)) core = { dist: d, brg: bearing(lat, lon, la, lo), dbz: v };
      }
    return { mx, core };
  };
  const [a, b] = await Promise.all([scan(cur.key), old.key === cur.key ? Promise.resolve(null) : scan(old.key).catch(() => null)]);
  return { now: a.mx, before: b?.mx ?? NaN, core: a.core, time: cur.time };
}

export function dbzWords(v: number): string {
  if (!(v >= 15)) return "";
  if (v >= 60) return "Intense storms (possible hail)";
  if (v >= 50) return "Heavy rain / storms";
  if (v >= 40) return "Moderate to heavy rain";
  if (v >= 30) return "Moderate rain";
  return "Light precipitation";
}

// ---------- forecast ----------
export interface Hourly {
  t: string;
  temp_f: number | null;
  pop: number | null;
  wind_mph: number | null;
  gust_mph?: number | null;
  dir?: string;
  short: string;
  rh?: number | null;
  day?: boolean;
}
export async function forecastAt(lat: number, lon: number): Promise<{ hourly: Hourly[]; periods: any[]; place: string; source: string } | null> {
  const r = await cached(`/api/ovl/forecast?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, 900_000).catch(() => null);
  return r ? { hourly: r.hourly ?? [], periods: r.periods ?? [], place: r.place ?? "", source: r.source ?? "" } : null;
}
export function hourAt(h: Hourly[], t: number): Hourly | null {
  let best: Hourly | null = null, bd = Infinity;
  for (const x of h) {
    const d = Math.abs(Date.parse(x.t) - t);
    if (d < bd) (bd = d), (best = x);
  }
  return bd < 2 * 3600_000 ? best : null;
}
export function fmtTempF(f: number | null | undefined): string {
  if (f == null || !Number.isFinite(f)) return "—";
  return settings.value.units.temp === "C" ? `${Math.round((f - 32) / 1.8)}°C` : `${Math.round(f)}°F`;
}
/** Heat index / wind chill (°F) from temperature, humidity and wind. */
export function feelsLikeF(t: number, rh: number | null | undefined, wind: number | null | undefined): number {
  if (t <= 50 && (wind ?? 0) > 3) return 35.74 + 0.6215 * t - 35.75 * (wind! ** 0.16) + 0.4275 * t * (wind! ** 0.16);
  if (t >= 80 && rh != null) {
    const R = rh;
    return -42.379 + 2.04901523 * t + 10.14333127 * R - 0.22475541 * t * R - 0.00683783 * t * t - 0.05481717 * R * R + 0.00122874 * t * t * R + 0.00085282 * t * R * R - 0.00000199 * t * t * R * R;
  }
  return t;
}

// ---------- SPC outlook ----------
const SPC_LEVEL: Record<string, number> = { TSTM: 0, MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 5 };
export const SPC_NAME = ["general thunderstorms", "marginal", "slight", "enhanced", "moderate", "high"];
/** Highest SPC categorical risk (day 1..3) at a point: level 0 (TSTM) … 5 (HIGH), -1 = none. */
export async function spcLevel(lat: number, lon: number, day = 1): Promise<{ level: number; label: string }> {
  const fc = await cached(`/api/ovl/spc?day=${day}&kind=cat`, 600_000).catch(() => null);
  let best = { level: -1, label: "" };
  for (const f of fc?.features ?? []) {
    const lab = String(f.properties?.label ?? f.properties?.LABEL ?? "").toUpperCase();
    const lv = SPC_LEVEL[lab];
    if (lv == null || lv <= best.level) continue;
    if (pointInGeometry(lon, lat, f.geometry)) best = { level: lv, label: lab };
  }
  return best;
}

// ---------- observations ----------
/** Nearest METAR (°C, kt) and AQI reporting area to a point. */
export async function nearestMetar(lat: number, lon: number): Promise<{ id: string; dist: number; t: number | null; wg: number | null; ws: number | null } | null> {
  const fc = await cached("/api/ovl/metar", 300_000).catch(() => null);
  let best: any = null, bd = Infinity;
  for (const f of fc?.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const d = distance(lat, lon, c[1], c[0]);
    if (d < bd) (bd = d), (best = f.properties);
  }
  return best ? { id: best.id, dist: bd, t: best.t ?? null, wg: best.wg ?? null, ws: best.ws ?? null } : null;
}
export async function nearestAqi(lat: number, lon: number, maxM = 80_000): Promise<{ aqi: number; dist: number; name: string } | null> {
  const fc = await cached("/api/ovl/airquality", 900_000).catch(() => null);
  let best: { aqi: number; dist: number; name: string } | null = null;
  for (const f of fc?.features ?? []) {
    const c = f.geometry?.coordinates, a = Number(f.properties?.aqi);
    if (!c || !Number.isFinite(a)) continue;
    const d = distance(lat, lon, c[1], c[0]);
    if (d > maxM) continue;
    if (!best || d < best.dist - 5000 || (Math.abs(d - best.dist) < 5000 && a > best.aqi)) best = { aqi: a, dist: d, name: f.properties?.area ?? f.properties?.name ?? "" };
  }
  return best;
}

// ---------- places ----------
const ST: Record<string, string> = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR" };
let counties: Promise<{ name: string; bb: number[]; g: any }[]> | null = null;
/** "Jasper Co., MO" for a US point (bundled county outlines), or "". */
export async function placeName(lat: number, lon: number): Promise<string> {
  counties ??= import("topojson-client").then(async ({ feature }) => {
    const t = await fetch("geo/counties-fips.json").then((r) => r.json());
    const fc: any = feature(t, t.objects.counties);
    return fc.features.map((f: any) => {
      let w = 180, s = 90, e = -180, n = -90;
      const walk = (a: any) => (typeof a[0] === "number" ? ((w = Math.min(w, a[0])), (e = Math.max(e, a[0])), (s = Math.min(s, a[1])), (n = Math.max(n, a[1]))) : a.forEach(walk));
      walk(f.geometry?.coordinates ?? []);
      return { name: `${f.properties?.name ?? ""} Co., ${ST[String(f.id).slice(0, 2)] ?? ""}`, bb: [w, s, e, n], g: f.geometry };
    });
  });
  try {
    const list = await counties;
    for (const c of list) if (lon >= c.bb[0] && lon <= c.bb[2] && lat >= c.bb[1] && lat <= c.bb[3] && pointInGeometry(lon, lat, c.g)) return c.name;
  } catch {
    counties = null;
  }
  return "";
}

export { compass, distance, bearing };
