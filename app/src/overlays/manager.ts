// Turns overlay settings into map sources/layers, keeps data fresh, and handles clicks.

import { signal, effect } from "@preact/signals";
import type { Map as MLMap, GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import { api } from "../api";
import { settings } from "../store";
import { OVERLAYS, overlayDef, styleFor, optsFor, type OverlayDef, type Popup } from "./defs";
import { registerIcons } from "./icons";
import { fileOverlays, fileLayers, fileClick } from "./files";

export const ovlStatus = signal<Record<string, { loading?: boolean; error?: string; count?: number; note?: string }>>({});
export const popup = signal<{ x: number; y: number; lng: number; lat: number; p: Popup; overlay: string } | null>(null);
/** extra info returned with some feeds (camera sources, ship sources) */
export const ovlMeta = signal<Record<string, any>>({});

let map: MLMap | null = null;
const data = new Map<string, any>();
const timers = new Map<string, number>();
const shown = new Map<string, string>(); // overlay id → signature of what's drawn
const fetchedOpts = new Map<string, string>();
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
  if (!m.getSource(src)) m.addSource(src, { type: "geojson", data: (data.get(id) ?? EMPTY) as any });
  const below = m.getLayer("ovl-alerts-fill") ? "ovl-alerts-fill" : firstTop(m);
  for (const spec of specs) {
    if (m.getLayer(spec.id)) continue;
    const under = spec.type === "fill" || spec.type === "heatmap" || (spec.type === "line" && !id.startsWith("file:"));
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
  return JSON.stringify([o.color, o.opacity, o.size, o.labels, def ? optsFor(def) : null, id === "metar" ? settings.value.units.temp : 0]);
}

function viewParams(def: OverlayDef, m: MLMap): Record<string, string> | null {
  if (!def.view) return {};
  if (def.minzoom && m.getZoom() < def.minzoom) return null;
  const b = m.getBounds();
  if (def.view === "bbox") return { bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(2)).join(",") };
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
  setStatus(id, { ...ovlStatus.value[id], loading: true, error: undefined });
  try {
    let fc = await api.get(`/api/ovl/${def.feed ?? id}?${q}`);
    if (!isOn(id)) return;
    if (id === "cameras") {
      ovlMeta.value = { ...ovlMeta.value, cameras: fc.sources };
      const off = new Set(settings.value.ovl.cameras?.opts?.off?.split(",").filter(Boolean) ?? (fc.sources ?? []).filter((s: any) => s.off).map((s: any) => s.id));
      fc = { ...fc, features: fc.features.filter((f: any) => !off.has(f.properties.s)) };
    }
    if (id === "ships") ovlMeta.value = { ...ovlMeta.value, ships: fc.sources };
    if (id === "waffle" && optsFor(def).status === "on") fc = await withWaffleStatus(fc);
    setData(id, fc);
    setStatus(id, { count: fc.features?.length ?? 0, note: fc.loading ? "Collecting…" : undefined });
  } catch (e: any) {
    setStatus(id, { error: e.message });
  }
}

/** Check closure notices for stores in view that link to the official locator. */
async function withWaffleStatus(fc: any) {
  if (!map) return fc;
  const b = map.getBounds();
  const inView = fc.features.filter((f: any) => {
    const [x, y] = f.geometry.coordinates;
    return b.contains([x, y]) && String(f.properties.web ?? "").startsWith("https://locations.wafflehouse.com/");
  });
  if (!inView.length || inView.length > 30) {
    setStatus("waffle", { count: fc.features.length, note: inView.length > 30 ? "Zoom in to check store status (30 max)" : undefined });
    return fc;
  }
  try {
    const st = await api.get(`/api/ovl/wafflestatus?urls=${encodeURIComponent(inView.map((f: any) => f.properties.web).join(","))}`);
    const feats = fc.features.map((f: any) => (st[f.properties.web] ? { ...f, properties: { ...f.properties, _st: st[f.properties.web] } } : f));
    const checked = inView.length;
    const closed = Object.values(st).filter((x) => x === "closed").length;
    setStatus("waffle", { count: fc.features.length, note: `${closed}/${checked} in view closed` });
    return { ...fc, features: feats };
  } catch {
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
  timers.set(id, window.setInterval(() => fetchOverlay(id), def.refresh * 1000));
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
    if (prev === sig && m.getSource(`o-${id}`)) continue;
    const def = overlayDef(id);
    const opts = JSON.stringify(def ? optsFor(def) : null);
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
  });
  if (m.isStyleLoaded()) {
    registerIcons(m);
    sync();
  }
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

/** Overlay feature under a click, if any (shown in the popup). Returns true when handled. */
export function pickOverlay(e: MapMouseEvent): boolean {
  const m = map;
  if (!m) return false;
  const ids = clickableLayers(m);
  if (!ids.length) return false;
  const feats = m.queryRenderedFeatures(e.point, { layers: ids });
  for (const f of feats) {
    const lid = f.layer.id;
    const oid = lid.startsWith("o-file:") ? lid.slice(2).split("-")[0] : lid.slice(2, lid.indexOf("-", 2));
    const def = overlayDef(oid);
    const p = def?.click ? def.click(f.properties ?? {}) : oid.startsWith("file:") ? fileClick(f.properties ?? {}) : null;
    if (!p) continue;
    popup.value = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat, p, overlay: oid };
    return true;
  }
  return false;
}

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
