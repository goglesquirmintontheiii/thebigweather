// workflow 0.6: route weather — plan a drive (OSRM public demo by default, or a custom OSRM /
// Valhalla server), then sample the route every ~10 minutes of driving and check each point at
// its arrival time: active warnings (point in polygon, still valid then), radar (newest MRMS
// composite, or a nowcast layer when one covers that time), and the hourly forecast.
// Plus a storm-intercept helper for chasers. Everything here is an approximation and labelled so.

import { signal, computed } from "@preact/signals";
import { api } from "../api";
import { settings, toast } from "../store";
import { alerts } from "../alerts";
import { distance, bearing, destination, pointInGeometry, compass } from "../util";
import { dbzAt, dbzWords, forecastAt, hourAt, placeName, hhmm, mrmsFrames, fmtMi, type Cell } from "../wf6data";
import { gridLayers } from "../weather";
import { setGeo, removeGeo } from "../map/wf6map";

export const OSRM_DEMO = "https://router.project-osrm.org";

export interface Stop {
  name: string;
  lat: number;
  lon: number;
}
export interface EtaPt {
  i: number;
  lat: number;
  lon: number;
  /** arrival time (ms) */
  t: number;
  /** distance from start (m) */
  d: number;
  place: string;
  warnings: { event: string; id: string; color: string }[];
  dbz: number;
  /** "nowcast" when a nowcast frame near the arrival time was used */
  dbzSrc: "radar" | "nowcast" | "";
  fc: { temp_f: number | null; pop: number | null; short: string; wind_mph: number | null } | null;
  summary: string;
  sev: 0 | 1 | 2 | 3;
}

export const stops = signal<(Stop | null)[]>([null, null]);
/** stop index waiting for a map click */
export const picking = signal<number | null>(null);
export const depart = signal<number | null>(null); // null = now
export const route = signal<{ coords: [number, number][]; cum: number[]; secs: number[]; dist: number; dur: number; provider: string } | null>(null);
export const etaPts = signal<EtaPt[]>([]);
export const routeBusy = signal<string>("");
export const routeError = signal<string>("");
export const routeSummary = computed(() => {
  const l = etaPts.value.filter((p) => p.sev > 0).sort((a, b) => b.sev - a.sev || a.t - b.t);
  return l.slice(0, 3).map((p) => p.summary);
});

const base = () => (settings.value.wf6.routeUrl || OSRM_DEMO).replace(/\/+$/, "");

/** Valhalla polyline6 decoder. */
function decode6(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let r = 0, sh = 0, b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      r |= (b & 0x1f) << sh;
      sh += 5;
    } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

/** Route between points: OSRM (`/route/v1/driving/…`) or Valhalla (`/route` JSON). */
export async function routeBetween(pts: { lat: number; lon: number }[]): Promise<{ coords: [number, number][]; segSecs: number[] | null; dist: number; dur: number; snapped: [number, number][]; provider: string }> {
  const b = base();
  if (/valhalla/i.test(b) || /\/route$/.test(b)) {
    const url = /\/route$/.test(b) ? b : `${b}/route`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locations: pts.map((p) => ({ lat: p.lat, lon: p.lon })), costing: "auto", units: "kilometers" }) });
    if (!r.ok) throw new Error(`Valhalla: HTTP ${r.status}`);
    const j = await r.json();
    const coords: [number, number][] = [];
    for (const leg of j.trip?.legs ?? []) coords.push(...decode6(leg.shape));
    return { coords, segSecs: null, dist: (j.trip?.summary?.length ?? 0) * 1000, dur: j.trip?.summary?.time ?? 0, snapped: (j.trip?.locations ?? []).map((l: any) => [l.lon, l.lat]), provider: "Valhalla" };
  }
  const path = pts.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const r = await fetch(`${b}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=false&annotations=duration`);
  if (r.status === 429) throw new Error("The public OSRM demo is busy (rate limited) — try again shortly, or set your own routing server in Route settings");
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.code !== "Ok") throw new Error(j?.message || `Routing failed (HTTP ${r.status})`);
  const rt = j.routes[0];
  const coords: [number, number][] = rt.geometry.coordinates;
  const segs: number[] = [];
  for (const l of rt.legs ?? []) segs.push(...(l.annotation?.duration ?? []));
  return { coords, segSecs: segs.length === coords.length - 1 ? segs : null, dist: rt.distance, dur: rt.duration, snapped: (j.waypoints ?? []).map((w: any) => w.location), provider: b === OSRM_DEMO ? "OSRM demo" : "OSRM" };
}

export async function geocode(q: string): Promise<{ name: string; label: string; lat: number; lon: number }[]> {
  const r = await api.get(`/api/ovl/geocode?q=${encodeURIComponent(q)}`);
  return r.results ?? [];
}

export function setStop(i: number, s: Stop | null) {
  const l = stops.value.slice();
  l[i] = s;
  stops.value = l;
  drawRoute();
}
export function addWaypoint() {
  const l = stops.value.slice();
  l.splice(l.length - 1, 0, null);
  stops.value = l;
}
export function removeStop(i: number) {
  const l = stops.value.slice();
  if (l.length <= 2) l[i] = null;
  else l.splice(i, 1);
  stops.value = l;
  drawRoute();
}
export function clearRoute() {
  stops.value = [null, null];
  route.value = null;
  etaPts.value = [];
  intercept.value = null;
  routeError.value = "";
  drawRoute();
  removeGeo("wf6-intercept");
}

/** Plan the route and evaluate the weather along it. */
export async function planRoute() {
  const pts = stops.value.filter(Boolean) as Stop[];
  if (pts.length < 2) return void (routeError.value = "Set a start and a destination");
  routeError.value = "";
  routeBusy.value = "Routing…";
  try {
    const r = await routeBetween(pts);
    const cum = [0];
    for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + distance(r.coords[i - 1][1], r.coords[i - 1][0], r.coords[i][1], r.coords[i][0]));
    const total = cum[cum.length - 1] || 1;
    // seconds from the start at each vertex: per-segment durations when given, else proportional
    const secs = [0];
    for (let i = 1; i < r.coords.length; i++) secs.push(r.segSecs ? secs[i - 1] + r.segSecs[i - 1] : (cum[i] / total) * r.dur);
    route.value = { coords: r.coords, cum, secs, dist: r.dist, dur: r.dur, provider: r.provider };
    drawRoute();
    await evaluate();
  } catch (e: any) {
    routeError.value = e.message;
  } finally {
    routeBusy.value = "";
  }
}

/** ETA points every `stepMin` minutes of driving (plus the destination). */
function samplePoints(stepMin = 10): { lat: number; lon: number; s: number; d: number }[] {
  const r = route.value;
  if (!r) return [];
  const out: { lat: number; lon: number; s: number; d: number }[] = [];
  const total = r.secs[r.secs.length - 1];
  let j = 1;
  for (let s = 0; s <= total; s += stepMin * 60) {
    while (j < r.secs.length - 1 && r.secs[j] < s) j++;
    const a = r.secs[j - 1], b = r.secs[j];
    const f = b > a ? (s - a) / (b - a) : 0;
    const [x0, y0] = r.coords[j - 1], [x1, y1] = r.coords[j];
    out.push({ lon: x0 + (x1 - x0) * f, lat: y0 + (y1 - y0) * f, s, d: r.cum[j - 1] + (r.cum[j] - r.cum[j - 1]) * f });
  }
  const last = r.coords[r.coords.length - 1];
  if (!out.length || total - out[out.length - 1].s > 120) out.push({ lon: last[0], lat: last[1], s: total, d: r.cum[r.cum.length - 1] });
  return out;
}

export async function evaluate() {
  const t0 = depart.value ?? Date.now();
  const sp = samplePoints(10).slice(0, 120);
  routeBusy.value = "Checking weather along the route…";
  // radar: newest composite for everything; a nowcast layer (if the server has one) for later arrivals
  const now = await dbzAt(sp).catch(() => ({ values: sp.map(() => NaN), time: 0 }));
  const ncId = gridLayers.value.find((g) => /nowcast/i.test(g.id))?.id;
  const ncVals = new Map<number, number>();
  if (ncId) {
    try {
      const fr = await mrmsFrames(ncId, 13);
      for (let i = 0; i < sp.length; i++) {
        const t = t0 + sp[i].s * 1000;
        if (t - Date.now() < 7 * 60_000) continue;
        let best: { key: string; time: number } | null = null;
        for (const f of fr) if (!best || Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
        if (best && Math.abs(best.time - t) < 10 * 60_000) ncVals.set(i, (await dbzAt([sp[i]], best.key)).values[0]);
      }
    } catch {
      /* no nowcast */
    }
  }
  // forecasts: one per ~25 km cell along the route (server caches each for 15 min), at most 16
  const fcKeys = new Map<string, Promise<any>>();
  const keyOf = (p: { lat: number; lon: number }) => `${(Math.round(p.lat * 4) / 4).toFixed(2)},${(Math.round(p.lon * 4) / 4).toFixed(2)}`;
  for (const p of sp) {
    const k = keyOf(p);
    if (!fcKeys.has(k) && fcKeys.size < 16) {
      const [la, lo] = k.split(",").map(Number);
      fcKeys.set(k, forecastAt(la, lo));
    }
  }
  const out: EtaPt[] = [];
  const al = [...alerts.value.values()].filter((a) => a.geometry);
  for (let i = 0; i < sp.length; i++) {
    const p = sp[i];
    const t = t0 + p.s * 1000;
    const warnings = al
      .filter((a) => {
        const ex = Date.parse(a.properties.ends ?? a.properties.expires ?? "");
        return (!Number.isFinite(ex) || ex > t) && pointInGeometry(p.lon, p.lat, a.geometry);
      })
      .sort((a, b) => b.properties.priority - a.properties.priority)
      .map((a) => ({ event: a.properties.event, id: a.properties.id, color: a.properties.color }));
    const nc = ncVals.get(i);
    const dbz = nc ?? now.values[i];
    let fc: EtaPt["fc"] = null;
    const nearest = fcKeys.get(keyOf(p)) ?? [...fcKeys.values()][Math.min(fcKeys.size - 1, Math.floor((i / sp.length) * fcKeys.size))];
    const f = await nearest?.catch(() => null);
    const h = f ? hourAt(f.hourly, t) : null;
    if (h) fc = { temp_f: h.temp_f, pop: h.pop, short: h.short, wind_mph: h.wind_mph };
    out.push({ i, lat: p.lat, lon: p.lon, t, d: p.d, place: "", warnings, dbz, dbzSrc: nc != null ? "nowcast" : Number.isFinite(dbz) ? "radar" : "", fc, summary: "", sev: 0 });
  }
  // summaries (place names only where something is happening, plus the ends)
  for (const p of out) {
    const w = p.warnings.find((x) => x.event.endsWith("Warning")) ?? p.warnings[0];
    const radar = dbzWords(p.dbz);
    const fcBad = p.fc && (p.fc.pop ?? 0) >= 60 && p.fc.short ? p.fc.short : "";
    p.sev = w?.event.endsWith("Warning") ? 3 : (p.dbz ?? 0) >= 50 ? 2 : w || (p.dbz ?? 0) >= 35 || fcBad ? 1 : 0;
    if (p.sev || p.i === 0 || p === out[out.length - 1]) p.place = await placeName(p.lat, p.lon);
    const where = p.place ? ` near ${p.place.replace(/ Co\.,/, " County,")}` : "";
    const what = w ? w.event : radar || fcBad || (p.fc?.short ?? "");
    p.summary = what ? `${what}${where} ~${hhmm(p.t)}` : "";
  }
  etaPts.value = out;
  routeBusy.value = "";
  drawRoute();
}

const SEV_COLOR = ["#34d399", "#facc15", "#fb923c", "#ef4444"];

export function drawRoute() {
  const r = route.value;
  const feats: any[] = [];
  if (r) feats.push({ type: "Feature", properties: { k: "line" }, geometry: { type: "LineString", coordinates: r.coords } });
  for (const p of etaPts.value) feats.push({ type: "Feature", properties: { k: "eta", c: SEV_COLOR[p.sev], lbl: hhmm(p.t) }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } });
  stops.value.forEach((s, i) => s && feats.push({ type: "Feature", properties: { k: "stop", lbl: i === 0 ? "A" : i === stops.value.length - 1 ? "B" : String(i) }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } }));
  if (!feats.length) return removeGeo("wf6-route");
  setGeo("wf6-route", { type: "FeatureCollection", features: feats }, [
    { id: "wf6-route-casing", type: "line", source: "wf6-route", filter: ["==", ["get", "k"], "line"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b1220", "line-width": 8, "line-opacity": 0.75 } },
    { id: "wf6-route-line", type: "line", source: "wf6-route", filter: ["==", ["get", "k"], "line"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#60a5fa", "line-width": 4.5 } },
    { id: "wf6-route-eta", type: "circle", source: "wf6-route", filter: ["==", ["get", "k"], "eta"], paint: { "circle-radius": 5.5, "circle-color": ["get", "c"], "circle-stroke-color": "#0b1220", "circle-stroke-width": 1.6 } },
    { id: "wf6-route-eta-lbl", type: "symbol", source: "wf6-route", filter: ["==", ["get", "k"], "eta"], minzoom: 6.5, layout: { "text-field": ["get", "lbl"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-offset": [0, 1.15], "text-anchor": "top" }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 } },
    { id: "wf6-route-stop", type: "circle", source: "wf6-route", filter: ["==", ["get", "k"], "stop"], paint: { "circle-radius": 9, "circle-color": "#2563eb", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } },
    { id: "wf6-route-stop-lbl", type: "symbol", source: "wf6-route", filter: ["==", ["get", "k"], "stop"], layout: { "text-field": ["get", "lbl"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": true }, paint: { "text-color": "#fff" } },
  ]);
}

// ---------- storm intercept ----------
export interface InterceptOpt {
  min: number;
  /** projected storm position */
  storm: [number, number];
  /** nearest road point to it (snapped by the router) */
  road: [number, number] | null;
  driveMin: number | null;
  driveKm: number | null;
  offRoadM: number;
  /** minutes to spare (storm arrival − drive time) */
  spare: number | null;
  error?: string;
}
export const intercept = signal<{ cell: Cell; from: { lat: number; lon: number; label: string }; opts: InterceptOpt[] } | null>(null);

/** Projected storm track (+30/+60 min) and the drive from `from` to the nearest road to each. */
export async function planIntercept(cell: Cell, from: { lat: number; lon: number; label: string }) {
  const p = cell.p;
  if (p?.dir_to == null || !(p.sknt > 0)) return toast("This cell has no motion estimate", "warn");
  routeBusy.value = "Planning intercept…";
  const age = p.t ? Math.max(0, (Date.now() - p.t) / 60_000) : 0;
  const opts: InterceptOpt[] = [];
  for (const m of [30, 60]) {
    const storm = destination(cell.lat, cell.lon, p.dir_to, p.sknt * 1852 * ((m + age) / 60));
    try {
      const r = await routeBetween([from, { lon: storm[0], lat: storm[1] }]);
      const road = r.snapped[1] ?? r.coords[r.coords.length - 1];
      const off = distance(storm[1], storm[0], road[1], road[0]);
      opts.push({ min: m, storm, road, driveMin: Math.round(r.dur / 60), driveKm: r.dist / 1000, offRoadM: off, spare: Math.round(m - r.dur / 60) });
    } catch (e: any) {
      opts.push({ min: m, storm, road: null, driveMin: null, driveKm: null, offRoadM: 0, spare: null, error: e.message });
    }
  }
  intercept.value = { cell, from, opts };
  routeBusy.value = "";
  const track = [0, 15, 30, 45, 60].map((m) => destination(cell.lat, cell.lon, p.dir_to, p.sknt * 1852 * ((m + age) / 60)));
  const feats: any[] = [{ type: "Feature", properties: { k: "track" }, geometry: { type: "LineString", coordinates: track } }];
  for (const o of opts) {
    feats.push({ type: "Feature", properties: { k: "storm", lbl: `+${o.min} min` }, geometry: { type: "Point", coordinates: o.storm } });
    if (o.road) feats.push({ type: "Feature", properties: { k: "road", lbl: o.driveMin != null ? `${o.driveMin} min drive` : "" }, geometry: { type: "Point", coordinates: o.road } });
  }
  setGeo("wf6-intercept", { type: "FeatureCollection", features: feats }, [
    { id: "wf6-icpt-track", type: "line", source: "wf6-intercept", filter: ["==", ["get", "k"], "track"], paint: { "line-color": "#f472b6", "line-width": 3, "line-dasharray": [2, 1.5] } },
    { id: "wf6-icpt-storm", type: "circle", source: "wf6-intercept", filter: ["==", ["get", "k"], "storm"], paint: { "circle-radius": 7, "circle-color": "rgba(244,114,182,0.35)", "circle-stroke-color": "#f472b6", "circle-stroke-width": 2 } },
    { id: "wf6-icpt-road", type: "circle", source: "wf6-intercept", filter: ["==", ["get", "k"], "road"], paint: { "circle-radius": 6, "circle-color": "#22d3ee", "circle-stroke-color": "#0b1220", "circle-stroke-width": 2 } },
    { id: "wf6-icpt-lbl", type: "symbol", source: "wf6-intercept", filter: ["!=", ["get", "k"], "track"], layout: { "text-field": ["get", "lbl"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4 } },
  ]);
}

export function describeOpt(o: InterceptOpt, from: string): string {
  if (o.error || o.driveMin == null) return `+${o.min} min: no route (${o.error ?? "unknown"})`;
  const road = o.offRoadM > 1500 ? ` (nearest road ${fmtMi(o.offRoadM)} from the projected core)` : "";
  const verdict = o.spare! >= 10 ? `arrive ~${o.spare} min ahead` : o.spare! >= 0 ? "tight — arrive just ahead" : `storm passes ~${-o.spare!} min before you get there`;
  return `+${o.min} min: ${o.driveMin} min drive from ${from}${road} — ${verdict}`;
}

export function cellLabel(c: Cell): string {
  const p = c.p;
  return `${p.nexrad ?? ""} ${p.storm_id ?? ""}${p.sknt ? ` → ${compass(p.dir_to)} ${Math.round(p.sknt)} kt` : ""}`;
}
export { bearing };
