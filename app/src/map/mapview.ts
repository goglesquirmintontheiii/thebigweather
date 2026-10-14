// Map setup, basemap switching, overlay layers and map tools.

import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { signal, effect } from "@preact/signals";
import { settings, update, tool, crosshair, toast, uid, details, type DetailItem } from "../store";
import { buildStyle, googleSession, isDarkBasemap } from "./basemaps";
import { attachOverlays, pickOverlay, popup } from "../overlays/manager";
import { attachDraw } from "./draw";
import { RadarLayer } from "../radar/RadarLayer";
import { attachLayer, sites, currentSite, displaySweep, selectSite, activeTable, liveSweep, frames, liveState, extraFrames, extraLive } from "../radar/controller";
import { GridLayer } from "../grid/GridLayer";
import { attachGrid, gridRaster } from "../grid/controller";
import { rasterValue } from "../grid/raster";
import { attachGibs, rebuildGibs } from "../grid/gibs";
/* ---------- intl & forecast tools ---------- */
import { attachIntl, rebuildIntl } from "../intl/radar";
import { attachParticles, type ParticleLayer } from "../grid/particles";
import { siteRegion, siteShown, type AnySite } from "../intl/sites";
import { attachSoundingMap } from "../sounding/maplayer";
/* ---------- end intl & forecast tools ---------- */
import { frameIndex } from "../anim";
import { sampleAt } from "../radar/sweep";
import { alerts } from "../alerts";
import { alertStyle, alertVisible, alertKind, patternId, registerPatterns } from "../alertstyle";
import { api } from "../api";
import { distance, bearing, compass, fmtDist, circle, destination } from "../util";
/* workflow 0.6: offline tiles, terrain, route/plugin layers, precip effect */
import { offlineTransform } from "../offline/tiles";
import { attachWf6 } from "./wf6map";
import { applyPerfToMap, glLost } from "../perf"; // 0.8.1 perf
import { mountPerfUi } from "../ui/PerfSettings"; // 0.8.1 perf: FPS/memory readout, safe-mode banner

export const mapRef = signal<MLMap | null>(null);
export const hover = signal<{ lat: number; lon: number; value: number; range: number; az: number; height: number; x: number; y: number } | null>(null);
export const centerReadout = signal<{ value: number; range: number; az: number; height: number; lat: number; lon: number } | null>(null);
export const measurePts = signal<[number, number][]>([]);
export const bearingInfo = signal<{ dist: number; brg: number } | null>(null);
export const contextMenu = signal<{ x: number; y: number; lat: number; lon: number } | null>(null);
/** map frames rendered in the last second (null = idle) */
export const fps = signal<number | null>(null);
/* ---------- workflow: map click hooks (return true to consume the click) ---------- */
export const mapClickHooks: ((e: maplibregl.MapMouseEvent) => boolean)[] = [];
/* ---------- end workflow ---------- */

let radarLayer: RadarLayer;
let gridLayer: GridLayer;
let particleLayer: ParticleLayer; // intl & forecast tools
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
  return buildStyle(s.basemap, { googleSession: session, googleKey: key, labels: s.overlays.labels, provider: s.basemapProvider, custom: s.customBasemaps });
}

function firstTopLayer(map: MLMap): string | undefined {
  return map.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
}

function addOverlays(map: MLMap) {
  const before = firstTopLayer(map);
  if (!map.getLayer(gridLayer.id)) map.addLayer(gridLayer, before);
  if (!map.getLayer(radarLayer.id)) map.addLayer(radarLayer, before);
  if (!map.getLayer(particleLayer.id)) map.addLayer(particleLayer, before); // intl & forecast tools
  const dark = isDarkBasemap(settings.value.basemap, settings.value.customBasemaps);
  map.addSource("counties", { type: "geojson", data: "geo/counties.json" });
  map.addSource("states", { type: "geojson", data: "geo/states.json" });
  map.addLayer({ id: "ovl-counties", type: "line", source: "counties", minzoom: 5, paint: { "line-color": dark ? "#8a96a6" : "#6b7280", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 10, 1], "line-opacity": 0.55 } }, before);
  map.addLayer({ id: "ovl-states", type: "line", source: "states", paint: { "line-color": dark ? "#c9d1d9" : "#374151", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 10, 2] } }, before);
  map.addSource("alerts", { type: "geojson", data: EMPTY });
  const hover: any = ["boolean", ["feature-state", "hover"], false];
  map.addLayer({
    id: "ovl-alerts-fill",
    type: "fill",
    source: "alerts",
    filter: ["==", ["get", "pat"], ""],
    paint: { "fill-color": ["get", "fc"], "fill-opacity": ["case", hover, ["min", 0.6, ["+", ["get", "fo"], 0.14]], ["get", "fo"]] },
  }, before);
  map.addLayer({
    id: "ovl-alerts-pattern",
    type: "fill",
    source: "alerts",
    filter: ["!=", ["get", "pat"], ""],
    paint: { "fill-pattern": ["get", "pat"], "fill-opacity": ["case", hover, 1, 0.85] },
  }, before);
  map.addLayer({
    id: "ovl-alerts-casing",
    type: "line",
    source: "alerts",
    filter: ["==", ["get", "kind"], "warning"],
    paint: { "line-color": "#000", "line-width": ["+", ["get", "lw"], ["case", ["has", "tag"], 3.6, 1.6]], "line-opacity": 0.7 },
  }, before);
  map.addLayer({
    id: "ovl-alerts-line",
    type: "line",
    source: "alerts",
    paint: {
      "line-color": ["case", ["==", ["get", "tag"], "TORNADO EMERGENCY"], "#ff00ff", ["get", "lc"]],
      "line-width": ["case", ["has", "tag"], ["+", ["get", "lw"], 1.1], ["get", "lw"]],
      "line-dasharray": ["match", ["get", "ls"], "dashed", ["literal", [3, 2]], "dotted", ["literal", [0.6, 1.6]], ["literal", [1, 0]]],
    },
  }, before);
  // new alerts flash for a while (per-type setting)
  map.addLayer({
    id: "ovl-alerts-flash",
    type: "line",
    source: "alerts",
    filter: ["==", ["get", "fl"], 1],
    paint: { "line-color": "#ffffff", "line-width": ["+", ["get", "lw"], 3], "line-opacity": 0, "line-blur": 1 },
  }, before);
  // RapidSweep progress: the current beam position
  map.addSource("sweepline", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "ovl-sweep-glow", type: "line", source: "sweepline", paint: { "line-color": "#7ee0ff", "line-width": 7, "line-opacity": 0.18, "line-blur": 3 } });
  map.addLayer({ id: "ovl-sweep", type: "line", source: "sweepline", paint: { "line-color": "#b8f0ff", "line-width": 1.6, "line-opacity": 0.9 } });
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
  refreshSweepLine(map);
  rebuildGibs();
  rebuildIntl(); // intl & forecast tools
}

// RapidSweep beams (main radar and any ctrl+clicked radars): live events arrive every few
// seconds, so each beam is extrapolated from its measured rotation rate and eased toward each new
// report instead of jumping.
interface Beam {
  rate: number;
  lastAz: number;
  lastT: number;
  shown: number;
  key: string;
  lat: number;
  lon: number;
}
const beams = new Map<string, Beam>();
let beamRaf = 0;

function angDiff(a: number, b: number) {
  return ((a - b + 540) % 360) - 180;
}

/** live states that should show a beam right now: site → message */
function activeLive(): Map<string, { az: number; key: string; lat: number; lon: number }> {
  const out = new Map<string, { az: number; key: string; lat: number; lon: number }>();
  const r = settings.value.radar;
  if (!r.live || r.source !== "L2" || settings.value.weather.kind !== "radar") return out;
  if (frameIndex.value < frames.value.length - 1) return out;
  const l = liveState.value;
  const site = currentSite.value;
  if (l && l.az !== undefined && !l.complete && site) out.set(site.id, { az: l.az, key: l.key, lat: l.lat && Math.abs(l.lat) > 0.1 ? l.lat : site.lat, lon: l.lon && Math.abs(l.lon) > 0.1 ? l.lon : site.lon });
  for (const [id, e] of Object.entries(extraLive.value)) {
    const st = e.state;
    const s2 = sites.value.find((x) => x.id === id);
    if (st.az === undefined || st.complete || !s2 || !settings.value.extraSites.includes(id)) continue;
    out.set(id, { az: st.az, key: st.key, lat: st.lat && Math.abs(st.lat) > 0.1 ? st.lat : s2.lat, lon: st.lon && Math.abs(st.lon) > 0.1 ? st.lon : s2.lon });
  }
  return out;
}

function refreshSweepLine(map: MLMap) {
  const src = map.getSource("sweepline") as GeoJSONSource | undefined;
  if (!src) return;
  const live = activeLive();
  for (const k of [...beams.keys()]) if (!live.has(k)) beams.delete(k);
  if (!live.size) {
    src.setData(EMPTY);
    cancelAnimationFrame(beamRaf);
    beamRaf = 0;
    return;
  }
  const now = performance.now();
  for (const [site, l] of live) {
    let b = beams.get(site);
    if (!b || b.key !== l.key) {
      b = { rate: 0, lastAz: NaN, lastT: 0, shown: NaN, key: l.key, lat: l.lat, lon: l.lon };
      beams.set(site, b);
    }
    b.lat = l.lat;
    b.lon = l.lon;
    // new report: update the rotation-rate estimate (degrees per ms, clockwise)
    if (l.az !== b.lastAz) {
      if (!Number.isNaN(b.lastAz) && b.lastT) {
        const d = angDiff(l.az, b.lastAz);
        const dt = now - b.lastT;
        if (d > 0 && dt > 200 && dt < 30_000) {
          const r = d / dt;
          b.rate = b.rate ? b.rate * 0.6 + r * 0.4 : r;
        }
      }
      b.lastAz = l.az;
      b.lastT = now;
    }
  }
  if (!beamRaf) {
    let lastDraw = 0;
    const tick = () => {
      beamRaf = 0;
      if (!beams.size) return refreshSweepLine(map);
      const t = performance.now();
      for (const b of beams.values()) {
        // predict where the antenna is now, but never more than ~6 s past the last report
        const ahead = Math.min(t - b.lastT, 6000);
        const target = (b.lastAz + b.rate * ahead + 360) % 360;
        if (Number.isNaN(b.shown)) b.shown = target;
        else {
          const d = angDiff(target, b.shown);
          // ease toward the prediction; snap if far off (new tilt)
          b.shown = Math.abs(d) > 45 ? target : (b.shown + d * 0.25 + 360) % 360;
        }
      }
      if (t - lastDraw > 33) {
        lastDraw = t;
        drawBeams(map);
      }
      beamRaf = requestAnimationFrame(tick);
    };
    beamRaf = requestAnimationFrame(tick);
  }
}

function drawBeams(map: MLMap) {
  const src = map.getSource("sweepline") as GeoJSONSource | undefined;
  if (!src) return;
  const features: any[] = [];
  for (const b of beams.values()) {
    if (Number.isNaN(b.shown)) continue;
    const end = destination(b.lat, b.lon, b.shown, 250_000);
    // trailing arc of the last few degrees for a sense of direction
    const trail: [number, number][] = [];
    for (let k = 0; k <= 8; k++) trail.push(destination(b.lat, b.lon, b.shown - k * 1.2, 250_000));
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[b.lon, b.lat], end] } });
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: trail } });
  }
  src.setData({ type: "FeatureCollection", features } as any);
}

/** Colors/widths for the built-in map overlays (Layers → gear). */
function refreshBaseStyles(map: MLMap) {
  const dark = isDarkBasemap(settings.value.basemap, settings.value.customBasemaps);
  const st = (k: string) => settings.value.ovl[`base:${k}`] ?? {};
  const set = (id: string, prop: string, v: any) => map.getLayer(id) && map.setPaintProperty(id, prop as any, v);
  const c = st("counties");
  set("ovl-counties", "line-color", c.color ?? (dark ? "#8a96a6" : "#6b7280"));
  set("ovl-counties", "line-opacity", c.opacity ?? 0.55);
  set("ovl-counties", "line-width", ["interpolate", ["linear"], ["zoom"], 5, 0.3 * (c.size ?? 1), 10, 1 * (c.size ?? 1)]);
  const s = st("states");
  set("ovl-states", "line-color", s.color ?? (dark ? "#c9d1d9" : "#374151"));
  set("ovl-states", "line-opacity", s.opacity ?? 1);
  set("ovl-states", "line-width", ["interpolate", ["linear"], ["zoom"], 3, 0.7 * (s.size ?? 1), 10, 2 * (s.size ?? 1)]);
  const a = st("alerts");
  const ao = a.opacity ?? 1;
  const hov: any = ["boolean", ["feature-state", "hover"], false];
  set("ovl-alerts-fill", "fill-opacity", ["*", ao, ["case", hov, ["min", 0.6, ["+", ["get", "fo"], 0.14]], ["get", "fo"]]]);
  set("ovl-alerts-pattern", "fill-opacity", ["*", ao, ["case", hov, 1, 0.85]]);
  set("ovl-alerts-line", "line-opacity", ao);
  set("ovl-alerts-casing", "line-opacity", 0.7 * ao);
  const r = st("rings");
  set("ovl-rings", "line-color", r.color ?? "#9fb3c8");
  set("ovl-rings", "line-opacity", r.opacity ?? 0.55);
}

function refreshOverlayVisibility(map: MLMap) {
  refreshBaseStyles(map);
  const o = settings.value.overlays;
  const vis = (id: string, v: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
  vis("ovl-counties", o.counties);
  vis("ovl-states", o.states);
  for (const id of ["ovl-alerts-fill", "ovl-alerts-pattern", "ovl-alerts-casing", "ovl-alerts-line", "ovl-alerts-flash"]) vis(id, o.alerts);
  vis("ovl-rings", o.rings);
}

/** first time each alert was seen (for flashing new ones) */
const alertSeen = new Map<string, number>();
let alertsPrimed = false;
let flashTimer: number | undefined;

function refreshAlerts(map: MLMap) {
  const src = map.getSource("alerts") as GeoJSONSource | undefined;
  if (!src) return;
  const now = Date.now();
  const all = [...alerts.value.values()];
  // alerts present at startup don't count as new
  for (const f of all) if (!alertSeen.has(f.properties.id)) alertSeen.set(f.properties.id, alertsPrimed ? now : 0);
  if (all.length) alertsPrimed = true;
  let flashing = false;
  const feats = all
    .filter((f) => f.geometry && alertVisible(f.properties.event))
    .sort((a, b) => a.properties.priority - b.properties.priority)
    .map((f, i) => {
      const e: string = f.properties.event;
      const st = alertStyle(e);
      const seen = alertSeen.get(f.properties.id) ?? 0;
      const fl = st.flash > 0 && seen > 0 && now - seen < st.flash * 1000 ? 1 : 0;
      if (fl) flashing = true;
      const fo = st.fill === "none" ? 0 : st.fillOpacity;
      const props: any = { id: f.properties.id, kind: alertKind(e), event: e, fc: st.color, lc: st.border, lw: st.width, ls: st.line, fo, pat: st.fill === "none" ? "" : patternId(st.fill, st.color, st.fillOpacity), fl };
      if (f.properties.tag) props.tag = f.properties.tag;
      return { type: "Feature", id: i + 1, geometry: f.geometry, properties: props };
    });
  src.setData({ type: "FeatureCollection", features: feats } as any);
  // blink the flash layer while any alert is still in its flash window
  clearInterval(flashTimer);
  if (flashing) {
    let on = false;
    flashTimer = window.setInterval(() => {
      on = !on;
      if (map.getLayer("ovl-alerts-flash")) map.setPaintProperty("ovl-alerts-flash", "line-opacity", on ? 0.95 : 0);
    }, 450);
    // re-evaluate when the earliest flash window ends
    window.setTimeout(() => refreshAlerts(map), 5000);
  } else if (map.getLayer("ovl-alerts-flash")) map.setPaintProperty("ovl-alerts-flash", "line-opacity", 0);
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

function siteEl(id: string, type: string, region = "US"): HTMLElement {
  const el = document.createElement("button");
  el.className = `site-marker ${type === "TDWR" ? "tdwr" : "nexrad"}${region !== "US" ? ` intl-site r-${region.toLowerCase()}` : ""}`;
  el.textContent = id;
  el.title = `${id} — click to view · Ctrl+click to add/remove alongside the current radar`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectSite(id, e.ctrlKey || e.metaKey);
  });
  return el;
}

function refreshSiteMarkers(map: MLMap) {
  // radar sites only matter while a radar layer is shown
  const show = settings.value.overlays.sites && settings.value.weather.kind === "radar";
  const sel = settings.value.radar.site;
  const list = (sites.value as AnySite[]).filter(siteShown); // intl & forecast tools: region filter
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
      m = new maplibregl.Marker({ element: siteEl(s.id, s.type, siteRegion(s)), anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map);
      siteMarkers.set(s.id, m);
    }
    m.getElement().classList.toggle("selected", s.id === sel);
    m.getElement().classList.toggle("extra", settings.value.extraSites.includes(s.id));
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
  const c = map.getCenter();
  if (crosshair.value && settings.value.weather.kind === "grid") {
    const g = gridRaster.value;
    const v = g ? rasterValue(g, c.lat, c.lng) : NaN;
    centerReadout.value = { value: v, range: 0, az: 0, height: 0, lat: c.lat, lon: c.lng };
    return;
  }
  if (!crosshair.value || !s || settings.value.weather.kind !== "radar") {
    centerReadout.value = null;
    return;
  }
  const r = sampleAt(s, c.lat, c.lng);
  centerReadout.value = r ? { ...r, lat: c.lat, lon: c.lng } : null;
}

export function createMap(container: HTMLElement): MLMap {
  const s = settings.value;
  const map = new maplibregl.Map({
    container,
    style: buildStyle(s.basemap === "google" ? "satellite" : s.basemap, { labels: s.overlays.labels, provider: s.basemapProvider, custom: s.customBasemaps }),
    center: s.view.center,
    zoom: s.view.zoom,
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false },
    maxPitch: 0,
    dragRotate: false,
    fadeDuration: 0,
    // arrow keys step frames / tilts instead of panning
    keyboard: false,
    transformRequest: offlineTransform, // workflow 0.6
  } as any);
  map.touchZoomRotate.disableRotation();
  /* 0.8.1 perf: render resolution / frame-rate cap; a lost WebGL context that doesn't come back
   * (driver reset, too many contexts) offers a reload instead of a frozen map */
  applyPerfToMap(map);
  let lostTimer = 0;
  map.on("webglcontextlost", () => {
    clearTimeout(lostTimer);
    lostTimer = window.setTimeout(() => (glLost.value = true), 4000);
  });
  map.on("webglcontextrestored", () => {
    clearTimeout(lostTimer);
    glLost.value = false;
  });
  mountPerfUi();
  registerPatterns(map);
  radarLayer = new RadarLayer();
  attachLayer(radarLayer);
  gridLayer = new GridLayer();
  attachGrid(gridLayer, map);
  attachGibs(map, () => (map.getLayer("grid") ? "grid" : firstTopLayer(map)));
  attachIntl(map, () => (map.getLayer("grid") ? "grid" : firstTopLayer(map))); // intl & forecast tools
  particleLayer = attachParticles(map);
  attachSoundingMap(map, mapClickHooks);
  mapRef.value = map;
  attachOverlays(map);
  attachDraw(map);
  attachWf6(map); // workflow 0.6
  (window as any).__tbw = { map, radarLayer, gridLayer, liveSweep, frames, liveState, extraFrames };

  // FPS: count rendered map frames per second
  let renders = 0;
  map.on("render", () => renders++);
  setInterval(() => {
    fps.value = renders ? renders : null;
    renders = 0;
  }, 1000); // console debugging handle

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
    if (settings.value.weather.kind !== "radar") {
      const g = gridRaster.value;
      const v = g && settings.value.weather.kind === "grid" ? rasterValue(g, e.lngLat.lat, e.lngLat.lng) : NaN;
      hover.value = { lat: e.lngLat.lat, lon: e.lngLat.lng, value: v, range: 0, az: 0, height: 0, x: e.point.x, y: e.point.y };
      return;
    }
    const sw = displaySweep.value;
    const r = sw ? sampleAt(sw, e.lngLat.lat, e.lngLat.lng) : null;
    hover.value = { lat: e.lngLat.lat, lon: e.lngLat.lng, value: r?.value ?? NaN, range: r?.range ?? 0, az: r?.az ?? 0, height: r?.height ?? 0, x: e.point.x, y: e.point.y };
  });
  map.getCanvas().addEventListener("mouseleave", () => (hover.value = null));

  let hovered: number | string | undefined;
  const onAlertMove = (e: any) => {
    if (tool.value !== "none") return;
    map.getCanvas().style.cursor = "pointer";
    const f = e.features?.[0];
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = f?.id;
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: true });
  };
  map.on("mousemove", "ovl-alerts-fill", onAlertMove);
  map.on("mousemove", "ovl-alerts-pattern", onAlertMove);
  const onAlertLeave = () => {
    map.getCanvas().style.cursor = "";
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = undefined;
  };
  map.on("mouseleave", "ovl-alerts-fill", onAlertLeave);
  map.on("mouseleave", "ovl-alerts-pattern", onAlertLeave);

  map.on("click", (e) => {
    contextMenu.value = null;
    popup.value = null;
    if (tool.value === "draw") return;
    if (mapClickHooks.some((h) => h(e))) return; // workflow: cross-section, SRV cell pick
    if (tool.value === "measure") {
      measurePts.value = [...measurePts.value, [e.lngLat.lng, e.lngLat.lat]];
      return;
    }
    // point features (reports, cameras, stations…) take priority over areas
    const pick = pickOverlay(e);
    if (pick.handled) return;
    // every alert under the cursor, most urgent first, then watches/storms/MDs from overlays
    const layers = ["ovl-alerts-fill", "ovl-alerts-pattern"].filter((l) => map.getLayer(l));
    const ids = [...new Set(map.queryRenderedFeatures(e.point, { layers }).map((f) => String(f.properties.id)))];
    const al = ids.map((id) => alerts.value.get(id)).filter(Boolean).sort((a: any, b: any) => b.properties.priority - a.properties.priority || String(b.properties.sent).localeCompare(String(a.properties.sent)));
    const items: DetailItem[] = [...al.map((a: any) => ({ kind: "alert" as const, id: a.properties.id })), ...pick.panel];
    if (items.length) details.value = { items, i: 0 };
    else if (pick.fallback) pick.fallback();
    else details.value = null;
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
  let lastStyleSig = `${s.basemap}|${s.overlays.labels}|${s.basemapProvider}|${JSON.stringify(s.customBasemaps.find((c) => `custom:${c.id}` === s.basemap) ?? "")}`;
  effect(() => {
    const st = settings.value;
    const sig = `${st.basemap}|${st.overlays.labels}|${st.basemapProvider}|${JSON.stringify(st.customBasemaps.find((c) => `custom:${c.id}` === st.basemap) ?? "")}`;
    if (sig !== lastStyleSig) {
      lastStyleSig = sig;
      styleFor().then((style) => map.setStyle(style, { diff: false }));
    }
  });
  effect(() => {
    void settings.value.overlays;
    void settings.value.ovl;
    if (map.isStyleLoaded() || map.getLayer("ovl-states")) {
      refreshOverlayVisibility(map);
      refreshRings(map);
    }
  });
  effect(() => {
    void alerts.value;
    void settings.value.alertCfg;
    refreshAlerts(map);
  });
  effect(() => {
    void sites.value;
    void settings.value.radar.site;
    void settings.value.overlays.sites;
    void settings.value.extraSites;
    void settings.value.weather.kind;
    void settings.value.ovl["base:sites"]; // intl & forecast tools: region filter
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
    void gridRaster.value;
    void settings.value.weather;
    updateCenterReadout(map);
  });
  effect(() => {
    void liveState.value;
    void extraLive.value;
    void currentSite.value;
    void frameIndex.value;
    void frames.value.length;
    void settings.value.weather;
    refreshSweepLine(map);
  });
  effect(() => {
    const t = tool.value;
    if (t !== "draw") map.getCanvas().style.cursor = t === "measure" ? "crosshair" : "";
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
