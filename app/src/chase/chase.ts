// data 0.8: chaser toolkit — storm-relative motion for you and your team vs the nearest storm cell,
// a rough "safe zone" guide around a selected storm, route flood / closure warnings, and the
// geometry drawn on the map. Chase logs live in chase/log.ts.

import { signal, computed, effect } from "@preact/signals";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { settings, update } from "../store";
import { api } from "../api";
import { mapRef } from "../map/mapview";
import { fix } from "../gps";
import { stormCells } from "../overlays/stormcells";
import { memberList, members, me, team, prefs } from "../share/collab";
import { route } from "../route/route";
import { alerts } from "../alerts";
import { distance, bearing, destination, pointInGeometry } from "../util";

export const chaseOpen = signal(false);
export type Cell = { lon: number; lat: number; p: any };
export const C8 = () => ({ snapMin: 5, autoLog: false, safeZone: true, vectors: true, ...(settings.value.p8?.chase ?? {}) });
export function setC8(fn: (c: ReturnType<typeof C8>) => void) {
  update((s) => {
    const c = { ...C8() };
    fn(c);
    s.p8 = { ...(s.p8 ?? {}), chase: c };
  });
}
export const cellId = (c: Cell) => `${c.p.nexrad ?? ""}:${c.p.storm_id ?? `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`}`;

// ---------- people (me + teammates) ----------
export interface Person {
  id: string;
  name: string;
  color: string;
  lat: number;
  lon: number;
  /** ground motion: direction it moves toward (deg) and speed (m/s); null when unknown */
  dir: number | null;
  spd: number | null;
  t: number;
  self: boolean;
}
/** motion from the last two GPS fixes when the device gives no heading / speed */
let lastFix: { lat: number; lon: number; t: number } | null = null;
let derived: { dir: number; spd: number } | null = null;
setTimeout(() => effect(() => {
  const f = fix.value;
  if (!f) return;
  if (lastFix && f.t - lastFix.t > 3000) {
    const d = distance(lastFix.lat, lastFix.lon, f.lat, f.lon);
    derived = d > 15 ? { dir: bearing(lastFix.lat, lastFix.lon, f.lat, f.lon), spd: d / ((f.t - lastFix.t) / 1000) } : { dir: 0, spd: 0 };
  }
  if (!lastFix || f.t - lastFix.t > 3000) lastFix = { lat: f.lat, lon: f.lon, t: f.t };
}), 0);

export const people = computed<Person[]>(() => {
  const out: Person[] = [];
  const f = fix.value;
  if (f) out.push({ id: "me", name: prefs.value.name || "You", color: prefs.value.color, lat: f.lat, lon: f.lon, dir: f.hdg ?? derived?.dir ?? null, spd: f.speed ?? derived?.spd ?? null, t: f.t, self: true });
  if (team.value)
    for (const m of memberList.value) {
      if (m.id === me.value || !m.pos) continue;
      out.push({ id: m.id, name: m.name, color: m.color, lat: m.pos.lat, lon: m.pos.lon, dir: m.pos.heading ?? null, spd: m.pos.speed ?? null, t: m.pos.t, self: false });
    }
  return out;
});

/** cells with motion, nearest first to a point */
export function cellsNear(lat: number, lon: number, n = 8): (Cell & { d: number })[] {
  return stormCells.value.cells
    .map((c) => ({ ...c, d: distance(lat, lon, c.lat, c.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

// ---------- storm-relative motion ----------
const KT = 0.514444;
const vec = (dir: number | null, spd: number | null): [number, number] => (dir == null || spd == null ? [0, 0] : [spd * Math.sin((dir * Math.PI) / 180), spd * Math.cos((dir * Math.PI) / 180)]); // east, north (m/s)
export interface SrInfo {
  person: Person;
  cell: Cell & { d: number };
  /** you relative to the storm: direction (deg toward) and speed (m/s) */
  srDir: number;
  srSpd: number;
  /** storm motion */
  sDir: number;
  sSpd: number;
  /** rate of change of distance (m/s): negative = the storm is closing in */
  closing: number;
  /** minutes to closest approach (null if opening) and the closest distance (m) */
  tca: number | null;
  dca: number;
  /** where you are relative to the storm's motion: "ahead", "ahead-right", … */
  side: string;
  brgFromCell: number;
}
export function srFor(p: Person, cell: Cell & { d: number }): SrInfo {
  const sDir = +cell.p.dir_to || 0;
  const sSpd = (+cell.p.sknt || 0) * KT;
  const [ue, un] = vec(p.dir, p.spd ?? 0);
  const [se, sn] = vec(sDir, sSpd);
  const re = ue - se, rn = un - sn;
  const srSpd = Math.hypot(re, rn);
  const srDir = srSpd < 0.05 ? 0 : ((Math.atan2(re, rn) * 180) / Math.PI + 360) % 360;
  // position of the person relative to the cell (m, local plane)
  const b = bearing(cell.lat, cell.lon, p.lat, p.lon);
  const px = cell.d * Math.sin((b * Math.PI) / 180), py = cell.d * Math.cos((b * Math.PI) / 180);
  const closing = cell.d > 1 ? (px * re + py * rn) / cell.d : 0;
  const v2 = re * re + rn * rn;
  const tStar = v2 > 1e-6 ? -(px * re + py * rn) / v2 : -1;
  const tca = tStar > 0 ? tStar / 60 : null;
  const dca = tStar > 0 ? Math.hypot(px + re * tStar, py + rn * tStar) : cell.d;
  const rel = (((b - sDir) % 360) + 540) % 360 - 180; // -180..180, 0 = straight ahead
  const a = Math.abs(rel);
  const lr = rel > 0 ? "right" : "left";
  const side = a < 25 ? "ahead (in its path)" : a < 70 ? `ahead-${lr}` : a < 110 ? `${lr} flank` : a < 155 ? `behind-${lr}` : "behind";
  return { person: p, cell, srDir, srSpd, sDir, sSpd, closing, tca, dca, side, brgFromCell: b };
}
export const srList = computed<SrInfo[]>(() => {
  const out: SrInfo[] = [];
  for (const p of people.value) {
    const c = cellsNear(p.lat, p.lon, 6).find((x) => x.p.sknt > 0 && x.p.dir_to != null) ?? cellsNear(p.lat, p.lon, 1)[0];
    if (c) out.push(srFor(p, c));
  }
  return out;
});

// ---------- selected storm & safe zone ----------
export const selCell = computed<Cell | null>(() => {
  const id = C8().cell;
  const cs = stormCells.value.cells;
  if (id) {
    const c = cs.find((x) => cellId(x) === id);
    if (c) return c;
  }
  return null;
});
export function selectCell(c: Cell | null) {
  setC8((x) => (x.cell = c ? cellId(c) : undefined));
}

/** storm "size" (km) from its attributes — a rough scale for the zones */
export function stormRadiusKm(p: any): number {
  const dbz = +p.max_dbz || 50;
  const vil = +p.vil || 0;
  const top = +p.top || 0; // kft
  return Math.max(3, Math.min(10, 3 + Math.max(0, dbz - 50) * 0.15 + vil / 20 + Math.max(0, top - 35) * 0.05 + (+p.meso > 0 ? 0.8 : 0)));
}

function ring(lat: number, lon: number, pts: [number, number][]): [number, number][] {
  // pts in km (east, north) → lon/lat
  const ky = 111.195, kx = 111.195 * Math.cos((lat * Math.PI) / 180);
  const r = pts.map(([x, y]) => [+(lon + x / kx).toFixed(5), +(lat + y / ky).toFixed(5)] as [number, number]);
  r.push(r[0]);
  return r;
}
/** frame helpers: forward unit (motion), right unit */
function frame(dir: number) {
  const a = (dir * Math.PI) / 180;
  const f: [number, number] = [Math.sin(a), Math.cos(a)];
  const r: [number, number] = [Math.cos(a), -Math.sin(a)];
  return { at: (fw: number, rt: number): [number, number] => [f[0] * fw + r[0] * rt, f[1] * fw + r[1] * rt] };
}
export interface Zone {
  kind: "core" | "hook" | "path" | "inflow";
  name: string;
  hint: string;
  color: string;
}
export const ZONES: Record<Zone["kind"], Zone> = {
  core: { kind: "core", name: "Hail / heavy-rain core", hint: "Avoid: large hail, blinding rain, can hide a tornado", color: "#22d3ee" },
  hook: { kind: "hook", name: "Hook / rotation (rear flank)", hint: "Avoid: tornado, RFD winds", color: "#ef4444" },
  path: { kind: "path", name: "Storm path · next 30 min", hint: "Don't stop or park here", color: "#f97316" },
  inflow: { kind: "inflow", name: "Inflow side · usual viewing area", hint: "Keep distance and an escape route away from the path", color: "#22c55e" },
};
/** GeoJSON of the guide zones around a cell (km-based, oriented by the storm motion) */
export function safeZones(c: Cell): any {
  const p = c.p;
  const R = stormRadiusKm(p);
  const dir = p.dir_to != null && +p.sknt > 0 ? +p.dir_to : 60; // unknown motion: typical SW→NE
  const spdKmh = (+p.sknt || 25) * 1.852;
  const F = frame(dir);
  const feats: any[] = [];
  const add = (kind: Zone["kind"], pts: [number, number][], label: [number, number]) => {
    feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring(c.lat, c.lon, pts)] }, properties: { zone: kind, name: ZONES[kind].name, color: ZONES[kind].color } });
    const [lx, ly] = label;
    const k = 111.195;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon + lx / (k * Math.cos((c.lat * Math.PI) / 180)), c.lat + ly / k] }, properties: { zone: kind, label: ZONES[kind].name, color: ZONES[kind].color } });
  };
  // storm path: corridor 2R wide ahead for 30 min of motion
  const L = Math.max(2 * R, spdKmh * 0.5);
  add("path", [F.at(0, -R), F.at(L, -R), F.at(L + R * 0.6, 0), F.at(L, R), F.at(0, R)], F.at(L * 0.8, 0));
  // inflow sector: ahead-right, 2R … 2R + max(12 km, 15 min of motion)
  const r0 = 2 * R, r1 = 2 * R + Math.max(12, spdKmh * 0.25);
  const arc: [number, number][] = [];
  for (let a = 60; a <= 150; a += 6) arc.push([Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)]); // angle from forward toward the right
  const sec = [...arc.map(([fw, rt]) => F.at(fw * r1, rt * r1)), ...arc.reverse().map(([fw, rt]) => F.at(fw * r0, rt * r0))];
  add("inflow", sec, F.at((Math.cos((105 * Math.PI) / 180) * (r0 + r1)) / 2, (Math.sin((105 * Math.PI) / 180) * (r0 + r1)) / 2));
  // precipitation / hail core: forward flank, left of the motion (classic NH right-mover)
  const core: [number, number][] = [];
  for (let i = 0; i < 36; i++) {
    const t = (i / 36) * Math.PI * 2;
    core.push(F.at(1.2 * R + 1.6 * R * Math.cos(t), -0.9 * R + 1.1 * R * Math.sin(t)));
  }
  add("core", core, F.at(1.4 * R, -1.1 * R));
  // hook / RFD: around the updraft, sweeping to the rear-right
  const hook: [number, number][] = [[0, 0]];
  for (let a = 70; a <= 230; a += 8) {
    const rr = 1.7 * R;
    hook.push(F.at(Math.cos((a * Math.PI) / 180) * rr, Math.sin((a * Math.PI) / 180) * rr));
  }
  const hk = hook.map((q) => (q === hook[0] ? F.at(0.4 * R, -0.3 * R) : q)) as [number, number][];
  add("hook", hk, F.at(-0.6 * R, 1.0 * R));
  // updraft marker + motion arrow
  const tip = F.at(Math.min(L, R * 2.5), 0);
  feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[c.lon, c.lat], [c.lon + tip[0] / (111.195 * Math.cos((c.lat * Math.PI) / 180)), c.lat + tip[1] / 111.195]] }, properties: { zone: "motion" } });
  return { type: "FeatureCollection", features: feats, R, dir, spdKmh };
}

// ---------- route flood / closure warnings ----------
export interface RouteHaz {
  kind: "flood" | "closure" | "road" | "warning";
  text: string;
  km: number;
  color: string;
  lat: number;
  lon: number;
}
export const routeHaz = signal<{ busy: boolean; list: RouteHaz[]; err: string; t: number }>({ busy: false, list: [], err: "", t: 0 });
function samples(coords: [number, number][], stepM = 1000): { lat: number; lon: number; km: number }[] {
  const out: { lat: number; lon: number; km: number }[] = [];
  let acc = 0;
  out.push({ lat: coords[0][1], lon: coords[0][0], km: 0 });
  let next = stepM;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const d = distance(y0, x0, y1, x1);
    // every stepM along the segment (sparse routes are interpolated)
    while (d > 0 && next <= acc + d) {
      const f = (next - acc) / d;
      out.push({ lat: y0 + (y1 - y0) * f, lon: x0 + (x1 - x0) * f, km: next / 1000 });
      next += stepM;
    }
    acc += d;
  }
  const last = coords[coords.length - 1];
  out.push({ lat: last[1], lon: last[0], km: acc / 1000 });
  return out;
}
/** first route sample within tolM of a geometry (inside polygons; distance to line segments) */
function nearRoute(sp: { lat: number; lon: number; km: number }[], g: any, tolM: number): { km: number; lat: number; lon: number } | null {
  if (!g) return null;
  const lines: [number, number][][] = g.type === "Point" ? [[g.coordinates, g.coordinates]] : g.type === "MultiPoint" ? g.coordinates.map((c: any) => [c, c]) : g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  const poly = g.type === "Polygon" || g.type === "MultiPolygon";
  for (const s of sp) {
    if (poly && pointInGeometry(s.lon, s.lat, g)) return { km: s.km, lat: s.lat, lon: s.lon };
    if (tolM <= 0) continue;
    const kx = 111_195 * Math.cos((s.lat * Math.PI) / 180), ky = 111_195;
    for (const ln of lines)
      for (let i = 0; i < ln.length - 1 || (i === 0 && ln.length === 1); i++) {
        const a = ln[i], b = ln[Math.min(i + 1, ln.length - 1)];
        const ax = (a[0] - s.lon) * kx, ay = (a[1] - s.lat) * ky, bx = (b[0] - s.lon) * kx, by = (b[1] - s.lat) * ky;
        const dx = bx - ax, dy = by - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
        if (Math.hypot(ax + t * dx, ay + t * dy) < tolM) return { km: s.km, lat: s.lat, lon: s.lon };
      }
  }
  return null;
}
export async function checkRoute() {
  const r = route.value;
  if (!r || r.coords.length < 2) {
    routeHaz.value = { busy: false, list: [], err: "Plan a route first (Route weather).", t: Date.now() };
    return;
  }
  routeHaz.value = { ...routeHaz.value, busy: true, err: "" };
  const sp = samples(r.coords);
  const lons = r.coords.map((c) => c[0]), lats = r.coords.map((c) => c[1]);
  const bbox = [Math.min(...lons) - 0.05, Math.min(...lats) - 0.05, Math.max(...lons) + 0.05, Math.max(...lats) + 0.05].map((x) => x.toFixed(3)).join(",");
  const list: RouteHaz[] = [];
  // NWS flood / flash flood / severe warnings crossing the route
  for (const a of alerts.value.values()) {
    const ev = a.properties.event as string;
    if (!a.geometry || !/Flood|Tornado Warning|Severe Thunderstorm Warning|Dust Storm|Blizzard|Ice Storm/i.test(ev)) continue;
    const hit = nearRoute(sp, a.geometry, 0);
    if (hit) list.push({ kind: /Flood/i.test(ev) ? "flood" : "warning", text: ev, km: hit.km, color: a.properties.color ?? "#ef4444", lat: hit.lat, lon: hit.lon });
  }
  const errs: string[] = [];
  const get = (id: string, q = "") => api.get(`/api/ovl/${id}?bbox=${bbox}${q}`).catch((e) => (errs.push(`${id}: ${e.message}`), null));
  const [rw, rc, rf] = await Promise.all([get("roadwork", "&kinds=closure,incident,workzone"), get("roadcond"), get("riverflood")]);
  for (const f of rw?.features ?? []) {
    const p = f.properties ?? {};
    const closed = p.kind === "closure" || /clos/i.test(`${p.type ?? ""} ${p.desc ?? ""} ${p.description ?? ""}`);
    const flood = /flood|water over|high water/i.test(`${p.desc ?? ""} ${p.description ?? ""} ${p.type ?? ""}`);
    if (!closed && !flood) continue;
    const hit = nearRoute(sp, f.geometry, 400);
    if (hit) list.push({ kind: flood ? "flood" : "closure", text: `${flood ? "High water" : "Closure"}: ${p.road ?? p.name ?? ""} ${p.desc ?? p.description ?? ""}`.trim().slice(0, 140), km: hit.km, color: flood ? "#3b82f6" : "#ef4444", lat: hit.lat, lon: hit.lon });
  }
  for (const f of rc?.features ?? []) {
    const p = f.properties ?? {};
    const s = `${p.cond ?? ""} ${p.desc ?? ""}`;
    if (!/clos|no travel|flood|water|ice|snow/i.test(s)) continue;
    const hit = nearRoute(sp, f.geometry, 400);
    if (hit) list.push({ kind: /clos|no travel/i.test(s) ? "closure" : /flood|water/i.test(s) ? "flood" : "road", text: `${p.road ?? "Road"}: ${s.trim()}`.slice(0, 140), km: hit.km, color: /clos/i.test(s) ? "#ef4444" : /flood|water/i.test(s) ? "#3b82f6" : "#a855f7", lat: hit.lat, lon: hit.lon });
  }
  for (const f of rf?.features ?? []) {
    const p = f.properties ?? {};
    if (!/major|moderate|minor|flood/i.test(`${p.status ?? ""} ${p.category ?? ""} ${p.cat ?? ""}`)) continue;
    const hit = nearRoute(sp, f.geometry, 2500);
    if (hit) list.push({ kind: "flood", text: `River flooding: ${p.name ?? p.lid ?? "gauge"} (${p.status ?? p.category ?? p.cat})`, km: hit.km, color: "#3b82f6", lat: hit.lat, lon: hit.lon });
  }
  // one entry per thing, ordered along the route
  const seen = new Set<string>();
  const uniq = list.filter((h) => !seen.has(h.text) && (seen.add(h.text), true)).sort((a, b) => a.km - b.km);
  routeHaz.value = { busy: false, list: uniq, err: errs.length === 3 ? errs.join(" · ") : "", t: Date.now() };
  drawChase();
}

// ---------- map drawing ----------
const SRC = "p8-chase";
const EMPTY = { type: "FeatureCollection", features: [] };
function ensure(m: MLMap) {
  if (!m.getStyle() || m.getSource(SRC)) return;
  m.addSource(SRC, { type: "geojson", data: EMPTY as any });
  const ZF = ["==", ["geometry-type"], "Polygon"] as any;
  m.addLayer({ id: `${SRC}-zfill`, type: "fill", source: SRC, filter: ZF, paint: { "fill-color": ["get", "color"], "fill-opacity": ["match", ["get", "zone"], "path", 0.16, "inflow", 0.14, 0.24] } });
  m.addLayer({ id: `${SRC}-zline`, type: "line", source: SRC, filter: ZF, paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-dasharray": ["match", ["get", "zone"], "path", ["literal", [3, 2]], "inflow", ["literal", [1, 1.5]], ["literal", [1, 0]]] } });
  m.addLayer({ id: `${SRC}-motion`, type: "line", source: SRC, filter: ["==", ["get", "zone"], "motion"], layout: { "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 2.5 } });
  m.addLayer({ id: `${SRC}-vec`, type: "line", source: SRC, filter: ["==", ["get", "k"], "vec"], layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 3, "line-dasharray": ["case", ["==", ["get", "sr"], 1], ["literal", [2, 1]], ["literal", [1, 0]]] } });
  m.addLayer({ id: `${SRC}-haz`, type: "circle", source: SRC, filter: ["==", ["get", "k"], "haz"], paint: { "circle-color": ["get", "color"], "circle-radius": 7, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  m.addLayer({ id: `${SRC}-dot`, type: "circle", source: SRC, filter: ["==", ["get", "k"], "who"], paint: { "circle-color": ["get", "color"], "circle-radius": 6, "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
  m.addLayer({
    id: `${SRC}-lbl`,
    type: "symbol",
    source: SRC,
    filter: ["has", "label"],
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": ["case", ["has", "zone"], 11, 10.5], "text-max-width": 9, "text-offset": ["case", ["has", "zone"], ["literal", [0, 0]], ["literal", [0, 1.4]]], "text-anchor": ["case", ["has", "zone"], "center", "top"], "text-allow-overlap": false },
    paint: { "text-color": ["coalesce", ["get", "tcolor"], "#fff"], "text-halo-color": "#000", "text-halo-width": 1.4 },
  });
}
export function drawChase() {
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  ensure(m);
  const feats: any[] = [];
  const c8 = C8();
  if (chaseOpen.value || c8.autoLog) {
    const sc = selCell.value;
    if (c8.safeZone && sc) feats.push(...safeZones(sc).features);
    if (c8.vectors)
      for (const s of srList.value) {
        const p = s.person;
        feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { k: "who", color: p.color, label: `${p.name} · SR ${Math.round(s.srSpd * 2.23694)} mph`, tcolor: p.color } });
        if (s.srSpd > 0.5) {
          const end = destination(p.lat, p.lon, s.srDir, s.srSpd * 900); // 15 min of storm-relative motion
          feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[p.lon, p.lat], end] }, properties: { k: "vec", sr: 1, color: p.color } });
        }
      }
    for (const h of routeHaz.value.list) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [h.lon, h.lat] }, properties: { k: "haz", color: h.color } });
  }
  (m.getSource(SRC) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: feats } as any);
}
let hooked: MLMap | null = null;
// deferred past module init (import cycles through map/mapview.ts)
setTimeout(() => effect(() => {
  void chaseOpen.value;
  void settings.value.p8?.chase;
  void srList.value;
  void selCell.value;
  void routeHaz.value;
  const m = mapRef.value;
  if (!m) return;
  if (hooked !== m) {
    hooked = m;
    m.on("style.load", () => setTimeout(drawChase, 60));
  }
  if ((m as any).style?._loaded) drawChase();
}), 0);

(window as any).__tbwChase = { chaseOpen, selectCell, safeZones, srList, people, routeHaz, checkRoute, stormCells, fix, members, team, me, route }; // console / screenshots
