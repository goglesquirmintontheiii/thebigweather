// History 0.6: open history mode around an alert or storm (range = start − before … end + after),
// pick the nearest radar, fit the map, remember recent ranges; Historical Storms map previews
// (warning polygons, tropical best tracks coloured by category with the replay position).

import { signal, effect } from "@preact/signals";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { settings, update, toast, details } from "./store";
import { mapRef } from "./map/mapview";
import { sites, selectSite } from "./radar/controller";
import { enterHistory, histRange, histTime, alertSpan, HIST_MAX_MS } from "./history";
import { alerts } from "./alerts";

export type BBox = [number, number, number, number];
export const histStormsOpen = signal(false);

/** Minutes before the start / after the end of an alert or storm window (persisted). */
export function beforeAfter() {
  const h = settings.value.hist;
  return { before: h?.before ?? 30, after: h?.after ?? 30 };
}
export function setBeforeAfter(before?: number, after?: number) {
  update((s) => {
    if (before != null && Number.isFinite(before)) s.hist.before = Math.max(0, Math.min(1440, Math.round(before)));
    if (after != null && Number.isFinite(after)) s.hist.after = Math.max(0, Math.min(1440, Math.round(after)));
  });
}

// ---------- geometry helpers ----------
export function bboxOf(g: any): BBox | null {
  if (!g) return null;
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c: any) => {
    if (typeof c[0] === "number") {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  if (g.type === "FeatureCollection") g.features.forEach((f: any) => f.geometry && walk(f.geometry.coordinates));
  else if (g.type === "Feature") g.geometry && walk(g.geometry.coordinates);
  else if (g.type === "GeometryCollection") g.geometries.forEach((x: any) => walk(x.coordinates));
  else if (g.coordinates) walk(g.coordinates);
  return w <= e ? [w, s, e, n] : null;
}
export const bboxCenter = (b: BBox): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

function km(lon1: number, lat1: number, lon2: number, lat2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** test-bed radars without a dependable archive */
const NO_ARCHIVE = new Set(["KCRI", "KOUN"]);
/** Nearest archive-capable radar (NEXRAD / European ODIM; TDWRs have no Level II archive). */
export function nearestRadar(lon: number, lat: number): { id: string; km: number } | null {
  let best: { id: string; km: number } | null = null;
  for (const s of sites.value) {
    if (s.type === "TDWR" || NO_ARCHIVE.has(s.id)) continue;
    const d = km(lon, lat, s.lon, s.lat);
    if (!best || d < best.km) best = { id: s.id, km: d };
  }
  return best;
}

/** Fit the map to a box, leaving room for the Historical Storms window when it's open. */
export function fitBox(b: BBox, maxZoom = 9) {
  const m = mapRef.value;
  if (!m) return;
  const left = histStormsOpen.value && window.innerWidth > 1100 ? Math.min(window.innerWidth * 0.62, 1000) + 110 : 80; // room for the window
  const pad = { top: 90, bottom: 140, left, right: 80 };
  const [w, s, e, n] = b;
  const dx = Math.max(0.05, e - w) * 0.001;
  try {
    m.fitBounds([[w - dx, s - dx], [e + dx, n + dx]], { padding: pad, maxZoom, duration: 700 });
  } catch {
    m.fitBounds([[w, s], [e, n]], { maxZoom, duration: 700 });
  }
}

// ---------- open history ----------
export interface OpenSpec {
  label: string;
  kind: "range" | "warning" | "tropical";
  start: number;
  end: number;
  /** pick the nearest radar to this point (lon, lat) */
  center?: [number, number];
  bbox?: BBox;
  site?: string;
  ref?: string;
  /** already includes before/after */
  padded?: boolean;
}

/** Enter history mode for a window, select the nearest radar, fit the map and remember it. */
export function openHistory(o: OpenSpec) {
  const { before, after } = beforeAfter();
  let start = o.padded ? o.start : o.start - before * 60_000;
  let end = o.padded ? o.end : o.end + after * 60_000;
  end = Math.min(end, Date.now());
  if (!(start < end)) return toast("That window is in the future", "warn");
  if (end - start > HIST_MAX_MS) {
    toast("Window trimmed to 7 days", "info");
    start = end - HIST_MAX_MS;
  }
  let site = o.site;
  if (!site && o.center) {
    const r = nearestRadar(o.center[0], o.center[1]);
    if (r && r.km < 460) site = r.id;
    else toast("No archive radar near there: keeping the current layer", "info");
  }
  if (site && (site !== settings.value.radar.site || settings.value.weather.kind !== "radar")) selectSite(site);
  enterHistory(start, end);
  if (o.bbox) fitBox(o.bbox);
  addRecent({ label: o.label, kind: o.kind, start, end, site, bbox: o.bbox, ref: o.ref });
}

/** Remember an opened history range (Historical Storms → Recent). */
export function addRecent(r: { label: string; kind: "range" | "warning" | "tropical"; start: number; end: number; site?: string; bbox?: BBox; ref?: string }) {
  update((s) => {
    const rec = { ...r, at: Date.now() };
    s.histRecent = [rec, ...(s.histRecent ?? []).filter((x) => !(x.start === r.start && x.end === r.end && x.label === r.label))].slice(0, 40);
  });
}

/** "Replay this" on an alert (live or replayed): its whole event ± before/after. */
export function replayAlert(a: any) {
  const p = a.properties;
  const span = alertSpan(p);
  const b = bboxOf(a.geometry);
  openHistory({ label: `${p.event}${p.senderName ? ` · ${String(p.senderName).replace(/^NWS /, "")}` : ""}`, kind: "warning", start: span.start, end: span.end, center: b ? bboxCenter(b) : undefined, bbox: b ?? undefined, ref: p.vtec_id ?? p.id });
}

// ---------- map preview (warning polygons, tropical tracks) ----------
export const SS_COLORS: Record<string, string> = { LO: "#9ca3af", TD: "#5ebaff", TS: "#00faf4", C1: "#ffffcc", C2: "#ffe775", C3: "#ffc140", C4: "#ff8f20", C5: "#ff6060" };
export const SS_NAMES: Record<string, string> = { LO: "Low / remnant", TD: "Tropical depression", TS: "Tropical storm", C1: "Category 1", C2: "Category 2", C3: "Category 3", C4: "Category 4", C5: "Category 5" };

/** Saffir–Simpson class from a feed `cat` (number or text) or the max wind in kt. */
export function catOf(p: { cat?: any; vmax?: number; status?: string }): string {
  const c = p.cat;
  if (typeof c === "number") return c >= 1 ? `C${Math.min(5, c)}` : c === 0 ? "TS" : "TD";
  if (typeof c === "string" && c) {
    const u = c.toUpperCase();
    if (/^[1-5]$/.test(u)) return `C${u}`;
    if (/^C[1-5]$/.test(u) || u === "TS" || u === "TD") return u;
    if (/^(HU|H)([1-5])$/.test(u)) return `C${u.replace(/\D/g, "")}`;
  }
  const st = String(p.status ?? "").toUpperCase();
  if (["LO", "EX", "DB", "WV", "PT"].includes(st) && (p.vmax ?? 0) < 34) return "LO";
  const v = p.vmax ?? 0;
  return v < 34 ? "TD" : v < 64 ? "TS" : v < 83 ? "C1" : v < 96 ? "C2" : v < 113 ? "C3" : v < 137 ? "C4" : "C5";
}

type Preview = { kind: "warning" | "tropical"; fc: any; id: string; pinned: boolean; title: string };
export const preview = signal<Preview | null>(null);
const EMPTY = { type: "FeatureCollection", features: [] };

function trackPoints(fc: any) {
  return (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Point" && f.properties?.t != null).sort((a: any, b: any) => a.properties.t - b.properties.t);
}

/** Map-ready features: polygons; track segments and points with a colour and label. */
function styled(p: Preview): any {
  if (p.kind === "warning") return { type: "FeatureCollection", features: p.fc.features.filter((f: any) => f.geometry).map((f: any) => ({ ...f, properties: { ...f.properties, _k: "poly" } })) };
  const pts = trackPoints(p.fc);
  const out: any[] = [];
  const segs = p.fc.features.filter((f: any) => f.geometry?.type === "LineString" || f.geometry?.type === "MultiLineString");
  if (segs.length > 1 || (segs.length === 1 && segs[0].properties && (segs[0].properties.cat != null || segs[0].properties.vmax != null))) {
    for (const f of segs) out.push({ ...f, properties: { ...f.properties, _k: "seg", _c: SS_COLORS[catOf(f.properties ?? {})] } });
  } else {
    // one plain line: colour each leg by the intensity at its start point
    for (let i = 0; i + 1 < pts.length; i++) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: [pts[i].geometry.coordinates, pts[i + 1].geometry.coordinates] }, properties: { _k: "seg", _c: SS_COLORS[catOf(pts[i].properties)] } });
  }
  const utc = (t: number) => {
    const d = new Date(t);
    return `${d.getUTCDate()}/${String(d.getUTCHours()).padStart(2, "0")}Z`;
  };
  for (const f of pts) {
    const c = catOf(f.properties);
    out.push({ ...f, properties: { ...f.properties, _k: "pt", _c: SS_COLORS[c], _l: `${utc(f.properties.t)} ${c === "LO" ? "" : c.replace("C", "Cat ")}`.trim(), _syn: new Date(f.properties.t).getUTCHours() === 0 ? 1 : 0 } });
  }
  return { type: "FeatureCollection", features: out };
}

function ensureLayers(m: MLMap) {
  if (!m.getStyle()) return false;
  if (!m.getSource("hs")) m.addSource("hs", { type: "geojson", data: EMPTY as any });
  if (!m.getSource("hs-pos")) m.addSource("hs-pos", { type: "geojson", data: EMPTY as any });
  const k = (v: string): any => ["==", ["get", "_k"], v];
  const add = (l: any) => !m.getLayer(l.id) && m.addLayer(l);
  add({ id: "hs-fill", type: "fill", source: "hs", filter: k("poly"), paint: { "fill-color": "#fde047", "fill-opacity": 0.12 } });
  add({ id: "hs-line", type: "line", source: "hs", filter: k("poly"), paint: { "line-color": "#fde047", "line-width": 2.5, "line-dasharray": [3, 1.5] } });
  add({ id: "hs-seg-case", type: "line", source: "hs", filter: k("seg"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": 6, "line-opacity": 0.55 } });
  add({ id: "hs-seg", type: "line", source: "hs", filter: k("seg"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["coalesce", ["get", "_c"], "#fff"], "line-width": 3.5 } });
  add({ id: "hs-pt", type: "circle", source: "hs", filter: k("pt"), paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3, 8, 6], "circle-color": ["coalesce", ["get", "_c"], "#fff"], "circle-stroke-color": "#000", "circle-stroke-width": 1 } });
  add({ id: "hs-lbl", type: "symbol", source: "hs", filter: ["all", k("pt"), ["any", ["==", ["get", "_syn"], 1], [">=", ["zoom"], 5.5]]], layout: { "text-field": ["get", "_l"], "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-offset": [0.8, 0], "text-anchor": "left", "text-optional": true }, paint: { "text-color": "#e5e7eb", "text-halo-color": "#000", "text-halo-width": 1.3 } });
  add({ id: "hs-pos-ring", type: "circle", source: "hs-pos", paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
  add({ id: "hs-pos", type: "circle", source: "hs-pos", paint: { "circle-radius": 7, "circle-color": ["coalesce", ["get", "_c"], "#fff"], "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
  add({ id: "hs-pos-lbl", type: "symbol", source: "hs-pos", layout: { "text-field": ["get", "_l"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, -1.9], "text-anchor": "bottom", "text-allow-overlap": true }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.6 } });
  return true;
}

function draw() {
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  const p = preview.value;
  if (!p && !m.getSource("hs")) return;
  if (!ensureLayers(m)) return;
  (m.getSource("hs") as GeoJSONSource).setData(p ? styled(p) : (EMPTY as any));
  drawPos();
}

/** The tropical storm's position at the replay frame time (interpolated between fixes). */
export function stormAt(fc: any, T: number) {
  const pts = trackPoints(fc);
  if (!pts.length || T < pts[0].properties.t - 3 * 3600_000 || T > pts[pts.length - 1].properties.t + 3 * 3600_000) return null;
  let i = pts.findIndex((f: any) => f.properties.t >= T);
  if (i < 0) i = pts.length - 1;
  const b = pts[i];
  const a = pts[Math.max(0, i - 1)];
  const ta = a.properties.t;
  const tb = b.properties.t;
  const f = tb > ta ? Math.max(0, Math.min(1, (T - ta) / (tb - ta))) : 0;
  const [x0, y0] = a.geometry.coordinates;
  const [x1, y1] = b.geometry.coordinates;
  const vmax = Math.round((a.properties.vmax ?? 0) + f * ((b.properties.vmax ?? 0) - (a.properties.vmax ?? 0)));
  const near = f < 0.5 ? a : b;
  return { lon: x0 + f * (x1 - x0), lat: y0 + f * (y1 - y0), vmax, mslp: near.properties.mslp, cat: catOf({ ...near.properties, vmax }) };
}

function drawPos() {
  const m = mapRef.value;
  const src = m?.getSource("hs-pos") as GeoJSONSource | undefined;
  if (!src) return;
  const p = preview.value;
  const T = histTime.value;
  const pos = p?.kind === "tropical" && p.pinned && T ? stormAt(p.fc, T) : null;
  src.setData(
    (pos
      ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [pos.lon, pos.lat] }, properties: { _c: SS_COLORS[pos.cat], _l: `${p!.title} · ${pos.vmax} kt${pos.mslp ? ` · ${pos.mslp} mb` : ""}` } }] }
      : EMPTY) as any,
  );
}

export function showPreview(p: Preview | null) {
  preview.value = p;
}
export function clearPreview(onlyUnpinned = false) {
  if (onlyUnpinned && preview.value?.pinned) return;
  preview.value = null;
}

effect(() => {
  void preview.value;
  const m = mapRef.value;
  if (!m) return;
  if (m.isStyleLoaded()) draw();
  else m.once("idle", draw);
});
effect(() => {
  void histTime.value;
  drawPos();
});
// a pinned (replayed) track goes away when history mode ends
let wasHist = false;
effect(() => {
  const on = !!histRange.value;
  if (wasHist && !on && preview.peek()?.pinned) preview.value = null;
  wasHist = on;
});
let hooked: MLMap | null = null;
effect(() => {
  const m = mapRef.value;
  if (!m || m === hooked) return;
  hooked = m;
  m.on("style.load", () => setTimeout(draw, 60));
});

(window as any).__tbwHist = { histStormsOpen, openHistory, replayAlert, preview, details, sites, alerts }; // debugging / screenshots
