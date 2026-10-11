// Map setup, basemap switching, overlay layers and map tools.

import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { signal, effect } from "@preact/signals";
import { settings, update, tool, crosshair, toast, selectedAlert, uid } from "../store";
import { buildStyle, googleSession } from "./basemaps";
import { RadarLayer } from "../radar/RadarLayer";
import { attachLayer, sites, currentSite, displaySweep, selectSite, activeTable, liveSweep, frames, liveState } from "../radar/controller";
import { sampleAt } from "../radar/sweep";
import { alerts } from "../alerts";
import { api } from "../api";
import { distance, bearing, compass, fmtDist, circle } from "../util";

export const mapRef = signal<MLMap | null>(null);
export const hover = signal<{ lat: number; lon: number; value: number; range: number; az: number; height: number; x: number; y: number } | null>(null);
export const centerReadout = signal<{ value: number; range: number; az: number; height: number; lat: number; lon: number } | null>(null);
export const measurePts = signal<[number, number][]>([]);
export const bearingInfo = signal<{ dist: number; brg: number } | null>(null);
export const contextMenu = signal<{ x: number; y: number; lat: number; lon: number } | null>(null);

let radarLayer: RadarLayer;
let googleSess: { key: string; session: string } | null = null;
let siteMarkers = new Map<string, maplibregl.Marker>();
let pointMarkers: maplibregl.Marker[] = [];

const EMPTY = { type: "FeatureCollection", features: [] } as any;

async function styleFor() {
  const s = settings.value;
  let session: string | undefined;
  let key: string | undefined;
  if (s.basemap === "google") {
    try {
      const info = await api.get("/api/info");
      key = info.google_maps_key;
      if (key) {
        if (googleSess?.key !== key) googleSess = { key, session: await googleSession(key) };
        session = googleSess.session;
      } else toast("Add a Google Maps key in Settings → API keys (using Esri imagery meanwhile)", "warn", 6000);
    } catch (e: any) {
      toast(e.message, "warn");
    }
  }
  return buildStyle(s.basemap, { googleSession: session, googleKey: key, labels: s.overlays.labels });
}

function firstTopLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
}

function addOverlays(map: MLMap) {
  const before = firstTopLayer(map);
  if (!map.getLayer(radarLayer.id)) map.addLayer(radarLayer, before);
  const dark = ["dark", "darkroad", "satellite", "google", "offline"].includes(settings.value.basemap);
  map.addSource("counties", { type: "geojson", data: "geo/counties.json" });
  map.addSource("states", { type: "geojson", data: "geo/states.json" });
  map.addLayer({ id: "ovl-counties", type: "line", source: "counties", minzoom: 5, paint: { "line-color": dark ? "#8a96a6" : "#6b7280", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 10, 1], "line-opacity": 0.55 } }, before);
  map.addLayer({ id: "ovl-states", type: "line", source: "states", paint: { "line-color": dark ? "#c9d1d9" : "#374151", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 10, 2] } }, before);
  map.addSource("alerts", { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "ovl-alerts-fill",
    type: "fill",
    source: "alerts",
    paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.28, ["match", ["get", "kind"], "warning", 0.14, 0.07]] },
  }, before);
  map.addLayer({
    id: "ovl-alerts-casing",
    type: "line",
    source: "alerts",
    filter: ["==", ["get", "kind"], "warning"],
    paint: { "line-color": "#000", "line-width": ["case", ["has", "tag"], 6, 4], "line-opacity": 0.7 },
  }, before);
  map.addLayer({
    id: "ovl-alerts-line",
    type: "line",
    source: "alerts",
    paint: {
      "line-color": ["case", ["==", ["get", "tag"], "TORNADO EMERGENCY"], "#ff00ff", ["get", "color"]],
      "line-width": ["case", ["has", "tag"], 3.5, ["==", ["get", "kind"], "warning"], 2.4, 1.4],
      "line-dasharray": ["case", ["==", ["get", "kind"], "watch"], ["literal", [3, 2]], ["literal", [1, 0]]],
    },
  }, before);
  // tools (above labels)
  map.addSource("rings", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "ovl-rings", type: "line", source: "rings", paint: { "line-color": "#9fb3c8", "line-width": 1, "line-opacity": 0.55, "line-dasharray": [4, 3] } });
  map.addSource("tools", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "ovl-tools-line", type: "line", source: "tools", paint: { "line-color": "#ffd166", "line-width": 2.5, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "ovl-tools-pts", type: "circle", source: "tools", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffd166", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
  refreshOverlayVisibility(map);
  refreshAlerts(map);
  refreshRings(map);
  refreshTools(map);
}

function refreshOverlayVisibility(map: MLMap) {
  const o = settings.value.overlays;
  const vis = (id: string, v: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
  vis("ovl-counties", o.counties);
  vis("ovl-states", o.states);
  for (const id of ["ovl-alerts-fill", "ovl-alerts-casing", "ovl-alerts-line"]) vis(id, o.alerts);
  vis("ovl-rings", o.rings);
}

function refreshAlerts(map: MLMap) {
  const src = map.getSource("alerts") as GeoJSONSource | undefined;
  if (!src) return;
  const feats = [...alerts.value.values()]
    .filter((f) => f.geometry)
    .sort((a, b) => a.properties.priority - b.properties.priority)
    .map((f, i) => {
      const e: string = f.properties.event;
      const kind = e.endsWith("Warning") ? "warning" : e.endsWith("Watch") ? "watch" : "other";
      const props: any = { id: f.properties.id, color: f.properties.color, kind, event: e };
      if (f.properties.tag) props.tag = f.properties.tag;
      return { type: "Feature", id: i + 1, geometry: f.geometry, properties: props };
    });
  src.setData({ type: "FeatureCollection", features: feats } as any);
}

function refreshRings(map: MLMap) {
  const src = map.getSource("rings") as GeoJSONSource | undefined;
  const site = currentSite.value;
  if (!src) return;
  if (!site || !settings.value.overlays.rings) return src.setData(EMPTY);
  const unit = settings.value.units.distance === "km" ? 1000 : settings.value.units.distance === "mi" ? 1609.344 : 1852;
  const step = 50 * unit;
  const feats = [1, 2, 3, 4, 5].map((k) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: circle(site.lat, site.lon, k * step) } }));
  src.setData({ type: "FeatureCollection", features: feats } as any);
}

function refreshTools(map: MLMap) {
  const src = map.getSource("tools") as GeoJSONSource | undefined;
  if (!src) return;
  const feats: any[] = [];
  const pts = measurePts.value;
  if (tool.value === "measure" && pts.length) {
    if (pts.length > 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    for (const p of pts) feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } });
  }
  const site = currentSite.value;
  if (tool.value === "bearing" && site) {
    const c = map.getCenter();
    feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[site.lon, site.lat], [c.lng, c.lat]] } });
    feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [site.lon, site.lat] } });
    bearingInfo.value = { dist: distance(site.lat, site.lon, c.lat, c.lng), brg: bearing(site.lat, site.lon, c.lat, c.lng) };
  } else bearingInfo.value = null;
  src.setData({ type: "FeatureCollection", features: feats } as any);
}

function siteEl(id: string, type: string): HTMLElement {
  const el = document.createElement("button");
  el.className = `site-marker ${type === "TDWR" ? "tdwr" : "nexrad"}`;
  el.textContent = id;
  el.title = id;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectSite(id);
  });
  return el;
}

function refreshSiteMarkers(map: MLMap) {
  const show = settings.value.overlays.sites;
  const sel = settings.value.radar.site;
  const list = sites.value;
  if (!show) {
    for (const m of siteMarkers.values()) m.remove();
    siteMarkers.clear();
    return;
  }
  const ids = new Set(list.map((s) => s.id));
  for (const [id, m] of siteMarkers) if (!ids.has(id)) (m.remove(), siteMarkers.delete(id));
  for (const s of list) {
    let m = siteMarkers.get(s.id);
    if (!m) {
      m = new maplibregl.Marker({ element: siteEl(s.id, s.type), anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map);
      siteMarkers.set(s.id, m);
    }
    m.getElement().classList.toggle("selected", s.id === sel);
  }
  updateMarkerDensity(map);
}

function updateMarkerDensity(map: MLMap) {
  const z = map.getZoom();
  const root = map.getContainer();
  root.classList.toggle("sites-dots", z < 4.6);
  root.classList.toggle("sites-hide-tdwr", z < 5.6);
}

function refreshPointMarkers(map: MLMap) {
  for (const m of pointMarkers) m.remove();
  pointMarkers = [];
  if (!settings.value.overlays.points) return;
  for (const p of settings.value.points) {
    const el = document.createElement("div");
    el.className = "point-marker";
    el.innerHTML = `<span class="pin" style="--c:${p.color}"></span><span class="lbl"></span>`;
    (el.querySelector(".lbl") as HTMLElement).textContent = p.name;
    pointMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(map));
  }
}

function updateCenterReadout(map: MLMap) {
  const s = displaySweep.value;
  if (!crosshair.value || !s) {
    centerReadout.value = null;
    return;
  }
  const c = map.getCenter();
  const r = sampleAt(s, c.lat, c.lng);
  centerReadout.value = r ? { ...r, lat: c.lat, lon: c.lng } : null;
}

export function createMap(container: HTMLElement): MLMap {
  const s = settings.value;
  const map = new maplibregl.Map({
    container,
    style: buildStyle(s.basemap === "google" ? "satellite" : s.basemap, { labels: s.overlays.labels }),
    center: s.view.center,
    zoom: s.view.zoom,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false },
    maxPitch: 0,
    dragRotate: false,
    fadeDuration: 0,
  } as any);
  map.touchZoomRotate.disableRotation();
  radarLayer = new RadarLayer();
  attachLayer(radarLayer);
  mapRef.value = map;
  (window as any).__tbw = { map, radarLayer, liveSweep, frames, liveState }; // console debugging handle

  map.on("style.load", () => {
    addOverlays(map);
    refreshSiteMarkers(map);
    refreshPointMarkers(map);
  });
  if (s.basemap === "google") styleFor().then((st) => map.setStyle(st));

  let viewTimer: number | undefined;
  map.on("move", () => {
    if (tool.value === "bearing") refreshTools(map);
    updateCenterReadout(map);
  });
  map.on("zoom", () => updateMarkerDensity(map));
  map.on("moveend", () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      const c = map.getCenter();
      update((st) => (st.view = { center: [c.lng, c.lat], zoom: map.getZoom() }));
    }, 500);
  });

  map.on("mousemove", (e) => {
    const sw = displaySweep.value;
    const r = sw ? sampleAt(sw, e.lngLat.lat, e.lngLat.lng) : null;
    hover.value = { lat: e.lngLat.lat, lon: e.lngLat.lng, value: r?.value ?? NaN, range: r?.range ?? 0, az: r?.az ?? 0, height: r?.height ?? 0, x: e.point.x, y: e.point.y };
  });
  map.getCanvas().addEventListener("mouseleave", () => (hover.value = null));

  let hovered: number | string | undefined;
  map.on("mousemove", "ovl-alerts-fill", (e) => {
    if (tool.value !== "none") return;
    map.getCanvas().style.cursor = "pointer";
    const f = e.features?.[0];
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = f?.id;
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: true });
  });
  map.on("mouseleave", "ovl-alerts-fill", () => {
    map.getCanvas().style.cursor = "";
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = undefined;
  });

  map.on("click", (e) => {
    contextMenu.value = null;
    if (tool.value === "measure") {
      measurePts.value = [...measurePts.value, [e.lngLat.lng, e.lngLat.lat]];
      return;
    }
    const feats = map.queryRenderedFeatures(e.point, { layers: ["ovl-alerts-fill"] });
    if (feats.length) {
      // queryRenderedFeatures returns the top-most (highest priority) polygon first
      selectedAlert.value = feats[0].properties.id;
    }
  });
  map.on("dblclick", (e) => {
    if (tool.value === "measure") e.preventDefault();
  });
  map.on("contextmenu", (e) => {
    if (tool.value === "measure") {
      tool.value = "none";
      return;
    }
    contextMenu.value = { x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lon: e.lngLat.lng };
  });

  // reactive refreshes
  let lastStyleSig = `${s.basemap}|${s.overlays.labels}`;
  effect(() => {
    const st = settings.value;
    const sig = `${st.basemap}|${st.overlays.labels}`;
    if (sig !== lastStyleSig) {
      lastStyleSig = sig;
      styleFor().then((style) => map.setStyle(style, { diff: false }));
    }
  });
  effect(() => {
    void settings.value.overlays;
    if (map.isStyleLoaded() || map.getLayer("ovl-states")) {
      refreshOverlayVisibility(map);
      refreshRings(map);
    }
  });
  effect(() => {
    void alerts.value;
    refreshAlerts(map);
  });
  effect(() => {
    void sites.value;
    void settings.value.radar.site;
    void settings.value.overlays.sites;
    refreshSiteMarkers(map);
    refreshRings(map);
  });
  effect(() => {
    void settings.value.points;
    void settings.value.overlays.points;
    refreshPointMarkers(map);
  });
  effect(() => {
    void measurePts.value;
    void tool.value;
    void currentSite.value;
    refreshTools(map);
  });
  effect(() => {
    void displaySweep.value;
    void crosshair.value;
    void activeTable.value;
    updateCenterReadout(map);
  });
  effect(() => {
    const t = tool.value;
    map.getCanvas().style.cursor = t === "measure" ? "crosshair" : "";
    if (t !== "measure") measurePts.value = [];
  });
  return map;
}

export function measureTotal(): number {
  const p = measurePts.value;
  let d = 0;
  for (let i = 1; i < p.length; i++) d += distance(p[i - 1][1], p[i - 1][0], p[i][1], p[i][0]);
  return d;
}

export function describeBearing(): string {
  const b = bearingInfo.value;
  if (!b) return "";
  return `${fmtDist(b.dist)} · ${Math.round(b.brg)}° ${compass(b.brg)}`;
}

export function addPointAt(lat: number, lon: number, name?: string) {
  const n = name ?? `Point ${settings.value.points.length + 1}`;
  update((s) => s.points.push({ id: uid(), name: n, lat, lon, color: "#4cc9f0", notify: true }));
}

export function flyToSite() {
  const s = currentSite.value;
  if (s && mapRef.value) mapRef.value.flyTo({ center: [s.lon, s.lat], zoom: Math.max(mapRef.value.getZoom(), 7) });
}
