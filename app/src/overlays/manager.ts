// Turns overlay settings into map sources/layers, keeps data fresh, and handles clicks.

import { signal, effect } from "@preact/signals";
import type { Map as MLMap, GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { api } from "../api";
import { settings, type DetailItem } from "../store";
import { OVERLAYS, overlayDef, styleFor, optsFor, type OverlayDef, type Popup } from "./defs";
import { registerIcons } from "./icons";
import { fileOverlays, fileLayers, fileClick, ensureFileData, fileSourceOpts } from "./files";

export const ovlStatus = signal<Record<string, { loading?: boolean; error?: string; count?: number; note?: string }>>({});
export const popup = signal<{ x: number; y: number; lng: number; lat: number; p: Popup; overlay: string } | null>(null);
/** extra info returned with some feeds (camera sources, ship sources) */
export const ovlMeta = signal<Record<string, any>>({});

let map: MLMap | null = null;
const data = new Map<string, any>();
const timers = new Map<string, number>();
const shown = new Map<string, string>(); // overlay id → signature of what's drawn
const fetchedOpts = new Map<string, string>();
const refreshKey = new Map<string, string>();
const EMPTY = { type: "FeatureCollection", features: [] };

function setStatus(id: string, s: { loading?: boolean; error?: string; count?: number; note?: string }) {
  ovlStatus.value = { ...ovlStatus.value, [id]: s };
}

export function isOn(id: string) {
  return !!settings.value.ovl[id]?.on;
}

function firstTop(m: MLMap): string | undefined {
  return m.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
}

function removeOverlay(m: MLMap, id: string) {
  const src = `o-${id}`;
  for (const l of m.getStyle()?.layers ?? []) if (l.id.startsWith(`${src}-`)) m.removeLayer(l.id);
  if (m.getSource(src)) m.removeSource(src);
  shown.delete(id);
}

function addOverlay(m: MLMap, id: string) {
  const src = `o-${id}`;
  const def = overlayDef(id);
  const specs = def ? def.layers(src, styleFor(def), optsFor(def)) : fileLayers(id, src);
  if (!specs) return;
  if (!m.getSource(src)) m.addSource(src, { type: "geojson", data: (data.get(id) ?? EMPTY) as any, ...(def ? def.source ?? {} : fileSourceOpts(id)) });
  if (!def && !data.has(id)) ensureFileData(id);
  const below = m.getLayer("ovl-alerts-fill") ? "ovl-alerts-fill" : firstTop(m);
  const user = settings.value.ovl[id] ?? {};
  for (const spec0 of specs) {
    if (m.getLayer(spec0.id)) continue;
    const spec: any = { ...spec0 };
    if (user.minzoom) spec.minzoom = Math.max(spec.minzoom ?? 0, user.minzoom);
    const under = !user.top && (spec.type === "fill" || spec.type === "heatmap" || (spec.type === "line" && !id.startsWith("file:")));
    try {
      m.addLayer(spec as any, under ? below : m.getLayer("ovl-tools-line") ? "ovl-tools-line" : undefined);
    } catch (e) {
      console.warn("overlay layer", spec.id, e);
    }
  }
}

function signature(id: string): string {
  const def = overlayDef(id);
  const o = settings.value.ovl[id] ?? {};
  // METAR labels depend on temperature units
  return JSON.stringify([o.color, o.opacity, o.size, o.labels, o.minzoom, o.top, def ? optsFor(def) : null, id === "metar" ? settings.value.units : 0]);
}

function viewParams(def: OverlayDef, m: MLMap): Record<string, string> | null {
  if (!def.view) return {};
  if (def.minzoom && m.getZoom() < def.minzoom) return null;
  const b = m.getBounds();
  if (def.view === "bbox") {
    // a little margin so small pans don't need a new request
    const pad = (hi: number, lo: number) => (hi - lo) * 0.15;
    const w = Math.max(-180, b.getWest() - pad(b.getEast(), b.getWest()));
    const e = Math.min(180, b.getEast() + pad(b.getEast(), b.getWest()));
    const so = Math.max(-85, b.getSouth() - pad(b.getNorth(), b.getSouth()));
    const n = Math.min(85, b.getNorth() + pad(b.getNorth(), b.getSouth()));
    return { bbox: [w, so, e, n].map((x) => x.toFixed(2)).join(","), z: m.getZoom().toFixed(1) };
  }
  const c = m.getCenter();
  // radius to the view corner in nautical miles, capped by the APIs
  const dlat = (b.getNorth() - b.getSouth()) / 2;
  const dlon = ((b.getEast() - b.getWest()) / 2) * Math.cos((c.lat * Math.PI) / 180);
  const nm = Math.min(250, Math.max(20, Math.hypot(dlat, dlon) * 60));
  return { lat: c.lat.toFixed(2), lon: c.lng.toFixed(2), r: String(Math.round(nm)) };
}

async function fetchOverlay(id: string) {
  const def = overlayDef(id);
  if (!def || def.feed === "client" || !map || !api.base) return;
  const vp = viewParams(def, map);
  if (vp === null) {
    setData(id, EMPTY);
    setStatus(id, { note: `Zoom in to ${def.minzoom}+` });
    return;
  }
  const q = new URLSearchParams({ ...optsFor(def), ...vp });
  // cameras: sources switched off are filtered on the server (before clustering)
  const off = settings.value.ovl[id]?.opts?.off;
  if (id === "cameras" && off !== undefined) q.set("off", off);
  setStatus(id, { ...ovlStatus.value[id], loading: true, error: undefined });
  try {
    let fc = await api.get(`/api/ovl/${def.feed ?? id}?${q}`);
    if (!isOn(id)) return;
    if (id === "cameras") ovlMeta.value = { ...ovlMeta.value, cameras: fc.sources, camdb: { db: fc.db, msg: fc.db_msg, total: fc.total } };
    if (id === "ships") ovlMeta.value = { ...ovlMeta.value, ships: fc.sources };
    if (id === "waffle" && optsFor(def).status === "on") fc = await withWaffleStatus(fc);
    setData(id, fc);
    const n = fc.features?.reduce?.((a: number, f: any) => a + (f.properties?.cl ?? 1), 0) ?? 0;
    setStatus(id, { count: id === "cameras" ? n : fc.features?.length ?? 0, note: fc.loading || fc.pending ? "Loading…" : undefined });
    // flights: the server is still fetching this area — ask again shortly
    if (fc.pending) window.setTimeout(() => isOn(id) && fetchOverlay(id), 3000);
  } catch (e: any) {
    setStatus(id, { error: e.message });
  }
}

/** Check the official store pages for stores in view (30 at a time, closest to the center first). */
async function withWaffleStatus(fc: any) {
  if (!map) return fc;
  const b = map.getBounds();
  const c = map.getCenter();
  const inView = fc.features
    .filter((f: any) => b.contains(f.geometry.coordinates))
    .sort((a: any, z: any) => Math.hypot(a.geometry.coordinates[0] - c.lng, a.geometry.coordinates[1] - c.lat) - Math.hypot(z.geometry.coordinates[0] - c.lng, z.geometry.coordinates[1] - c.lat));
  if (!inView.length) return fc;
  const pick = inView.slice(0, 30);
  setStatus("waffle", { count: fc.features.length, loading: true, note: `Checking ${pick.length} stores…` });
  try {
    const st = await api.get(`/api/ovl/wafflestatus?ids=${encodeURIComponent(pick.map((f: any) => f.properties.id).join(","))}`);
    const feats = fc.features.map((f: any) => {
      const r = st[f.properties.id];
      if (!r) return f;
      const s = typeof r === "string" ? r : r.st;
      return { ...f, properties: { ...f.properties, _st: s, web: (typeof r === "object" && r.url) || f.properties.web } };
    });
    const checked = Object.values(st).filter((x: any) => (typeof x === "string" ? x : x.st) !== "unknown").length;
    const closed = Object.values(st).filter((x: any) => (typeof x === "string" ? x : x.st) === "closed").length;
    setStatus("waffle", { count: fc.features.length, note: `${closed}/${checked} checked closed${inView.length > 30 ? " · zoom in for more" : ""}` });
    return { ...fc, features: feats };
  } catch (e: any) {
    setStatus("waffle", { count: fc.features.length, error: e.message });
    return fc;
  }
}

export function setData(id: string, fc: any) {
  data.set(id, fc);
  const s = map?.getSource(`o-${id}`) as GeoJSONSource | undefined;
  s?.setData(fc);
}

function schedule(id: string) {
  clearInterval(timers.get(id));
  const def = overlayDef(id);
  if (!def || !def.refresh || def.feed === "client") return;
  const secs = Math.max(5, settings.value.ovl[id]?.refresh ?? def.refresh);
  timers.set(id, window.setInterval(() => fetchOverlay(id), secs * 1000));
}

/** All overlay ids the map should show right now (catalog + imported files). */
function activeIds(): string[] {
  const ids = OVERLAYS.filter((d) => isOn(d.id)).map((d) => d.id);
  for (const f of fileOverlays.value) if (isOn(`file:${f.id}`)) ids.push(`file:${f.id}`);
  return ids;
}

function sync() {
  const m = map;
  if (!m || !m.getStyle()) return;
  const want = new Set(activeIds());
  for (const id of [...shown.keys()]) {
    if (!want.has(id)) {
      removeOverlay(m, id);
      clearInterval(timers.get(id));
      timers.delete(id);
      fetchedOpts.delete(id);
    }
  }
  for (const id of want) {
    const sig = signature(id);
    const prev = shown.get(id);
    const rk = `${settings.value.ovl[id]?.refresh ?? ""}`;
    if (refreshKey.get(id) !== rk) {
      refreshKey.set(id, rk);
      if (timers.has(id)) {
        clearInterval(timers.get(id));
        timers.delete(id);
        schedule(id);
      }
    }
    if (prev === sig && m.getSource(`o-${id}`)) continue;
    const def = overlayDef(id);
    const opts = JSON.stringify([def ? optsFor(def) : null, settings.value.ovl[id]?.opts?.off ?? null]);
    // client-side overlays (files, my cameras, satellites) supply their own data
    const client = !def || def.feed === "client";
    const optsChanged = !client && (fetchedOpts.get(id) !== opts || !data.has(id));
    removeOverlay(m, id);
    if (optsChanged) data.delete(id);
    addOverlay(m, id);
    shown.set(id, sig);
    if (optsChanged) {
      fetchedOpts.set(id, opts);
      fetchOverlay(id);
      schedule(id);
    } else if (!timers.has(id)) schedule(id);
  }
}

export function attachOverlays(m: MLMap) {
  map = m;
  m.on("style.load", () => {
    registerIcons(m);
    shown.clear();
    sync();
    if (flightTrack) drawFlightTrack(m);
  });
  if (m.isStyleLoaded()) {
    registerIcons(m);
    sync();
  }
  // the popup sticks to the clicked spot; it closes once that spot leaves the screen
  m.on("move", () => {
    const p = popup.value;
    if (!p) return;
    const pt = m.project([p.lng, p.lat]);
    const c = m.getCanvas();
    if (pt.x < -20 || pt.y < -20 || pt.x > c.clientWidth + 20 || pt.y > c.clientHeight + 20) popup.value = null;
    else popup.value = { ...p, x: pt.x, y: pt.y };
  });
  // view-dependent feeds follow the map
  let t: number | undefined;
  m.on("moveend", () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      for (const d of OVERLAYS) if (isOn(d.id) && (d.view || (d.id === "waffle" && optsFor(d).status === "on"))) fetchOverlay(d.id);
    }, 400);
  });
  // pointer cursor over clickable overlay features
  let last = 0;
  m.on("mousemove", (e) => {
    const now = performance.now();
    if (now - last < 60) return;
    last = now;
    const ids = clickableLayers(m);
    if (!ids.length) return;
    const hit = m.queryRenderedFeatures(e.point, { layers: ids }).length > 0;
    m.getCanvas().style.cursor = hit ? "pointer" : m.getCanvas().style.cursor === "pointer" ? "" : m.getCanvas().style.cursor;
  });
}

function clickableLayers(m: MLMap): string[] {
  return (m.getStyle()?.layers ?? []).filter((l) => l.id.startsWith("o-") && !l.id.endsWith("-text") && !l.id.endsWith("-label")).map((l) => l.id);
}

/** What's under a click: a point feature opens the popup right away (handled); area features
 * from "panel" overlays (watches, storms, MDs) go to the info panel together with alerts; other
 * areas (outlooks, files) open the popup only if nothing else is there (fallback). */
export function pickOverlay(e: MapMouseEvent): { handled: boolean; panel: DetailItem[]; fallback?: () => void } {
  const m = map;
  const none = { handled: false, panel: [] as DetailItem[] };
  if (!m) return none;
  const ids = clickableLayers(m);
  if (!ids.length) {
    clearSelections();
    return none;
  }
  const feats = m.queryRenderedFeatures(e.point, { layers: ids });
  const panel: DetailItem[] = [];
  const seen = new Set<string>();
  let fallback: (() => void) | undefined;
  for (const f of feats) {
    const lid = f.layer.id;
    const oid = lid.startsWith("o-file:") ? lid.slice(2).split("-")[0] : lid.slice(2, lid.indexOf("-", 2));
    const def = overlayDef(oid);
    const props = f.properties ?? {};
    const area = f.layer.type === "fill" || f.layer.type === "line";
    if (!area) {
      const p = def?.click ? def.click(props) : oid.startsWith("file:") ? fileClick(props) : null;
      if (!p) continue;
      if (oid === "cameras" && props.cl) {
        m.easeTo({ center: e.lngLat, zoom: Math.min(m.getZoom() + 2.5, 14) });
        return { handled: true, panel: [] };
      }
      if (oid === "flights") showFlightTrack(String(props.hex ?? ""));
      else showFlightTrack(null);
      popup.value = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat, p, overlay: oid };
      return { handled: true, panel: [] };
    }
    if (def?.panel) {
      const p = def.click?.(props);
      if (!p) continue;
      const key = `${oid}|${p.title}|${p.sub ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      panel.push({ kind: "ovl", overlay: oid, p });
    } else if (!fallback) {
      const p = def?.click ? def.click(props) : oid.startsWith("file:") ? fileClick(props) : null;
      if (p) fallback = () => (popup.value = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat, p, overlay: oid });
    }
  }
  clearSelections();
  return { handled: false, panel, fallback };
}

function clearSelections() {
  if (flightTrackHex.value) showFlightTrack(null);
  clearSat();
}

let clearSat: () => void = () => {};
export function onClearSelection(fn: () => void) {
  clearSat = fn;
}

// ---------- clicked-aircraft track ----------
let flightTrack: any = null;
export const flightTrackHex = signal<string | null>(null);

function drawFlightTrack(m: MLMap) {
  if (!m.getStyle()) return;
  if (!m.getSource("sel-flight")) {
    m.addSource("sel-flight", { type: "geojson", data: EMPTY as any });
    m.addLayer({
      id: "sel-flight-line",
      type: "line",
      source: "sel-flight",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": 3,
        "line-opacity": 0.95,
        "line-color": ["interpolate", ["linear"], ["get", "alt"], -1, "#9ca3af", 0, "#f97316", 5000, "#eab308", 10000, "#22c55e", 20000, "#06b6d4", 30000, "#3b82f6", 40000, "#a855f7"],
      },
    }, m.getLayer("o-flights-icon") ? "o-flights-icon" : undefined);
  }
  (m.getSource("sel-flight") as GeoJSONSource).setData(flightTrack ?? (EMPTY as any));
}

/** Show the track of a clicked aircraft (since takeoff when the archive has it). */
export async function showFlightTrack(hex: string | null) {
  flightTrackHex.value = hex;
  flightTrack = null;
  if (map) drawFlightTrack(map);
  if (!hex) return;
  try {
    const mode = settings.value.ovl.flights?.opts?.trackmin === "seen" ? "&mode=seen" : "";
    const f = await api.get(`/api/ovl/flighttrack?hex=${encodeURIComponent(hex)}${mode}`);
    if (flightTrackHex.value !== hex) return;
    const c = f.geometry?.coordinates ?? [];
    const alts = f.properties?.alts ?? [];
    const feats = [];
    for (let i = 1; i < c.length; i++) feats.push({ type: "Feature", properties: { alt: typeof alts[i] === "number" ? alts[i] : -1 }, geometry: { type: "LineString", coordinates: [c[i - 1], c[i]] } });
    flightTrack = { type: "FeatureCollection", features: feats };
    trackNote.value = f.properties?.source === "takeoff" ? "Track since takeoff" : c.length > 1 ? "Track since it appeared on the map" : "No track yet";
    if (map) drawFlightTrack(map);
  } catch (e: any) {
    trackNote.value = `Track unavailable (${e.message})`;
  }
}
export const trackNote = signal("");

export function refreshOverlay(id: string) {
  fetchOverlay(id);
}

// react to settings / connection
effect(() => {
  void settings.value.ovl;
  void settings.value.units.temp;
  void fileOverlays.value;
  sync();
});
api.on("connected", () => {
  for (const id of shown.keys()) fetchOverlay(id);
});
