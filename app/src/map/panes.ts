// Extra map panes (dual / quad view). Each pane is its own MapLibre map with its own weather
// layer (a radar product or a gridded layer), following the main map's time and, when synced,
// its position.
// 0.8.2: panes draw the built-in layers and every overlay from the same layer definitions, styles
// and data as the main map (map/baselayers.ts, overlays/manager.ts), with per-pane layer overrides;
// the timeline loop is preloaded like the main map's and a pane never stalls on a frame that is
// still loading (it shows the nearest loaded one and then jumps to the newest wanted time); the
// data inspector, crosshair, cross-section and drawing work in any pane.

import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { signal, effect, untracked } from "@preact/signals";
import { api, lastHello } from "../api";
import { settings, update, type PaneCfg, type PaneLink } from "../store"; // 0.8.3 inspector: update
import { buildStyle } from "./basemaps";
import { RadarLayer } from "../radar/RadarLayer";
import { GridLayer } from "../grid/GridLayer";
import { fetchSweep, tableById, tableKeyFor, sites, l3For, listL2Range } from "../radar/controller";
import { gridGateKey } from "../gate";
import { gridDef, gridTable, GIBS, gridExtraQ } from "../weather";
import { parseRaster, type Raster } from "../grid/raster";
import type { Sweep } from "../radar/sweep";
import { activeTime, activeFrames } from "../active";
import { alerts } from "../alerts";
import { mapRef, measurePts } from "./mapview";
import { shiftHeld } from "../ui/Readouts"; // 0.8.2
import { myKind, myLink, linkedTime } from "../linkwin"; // panes 0.8
import { perf, perfNow, applyPerfToMap, pageHidden, pausedNow } from "../perf"; // 0.8.1 perf
import { fitImage } from "../perfcore"; // 0.8.1 perf
import { rasterBudget } from "../grid/budget"; // 0.8.1 perf
import { playing, framesToRequest, liveLoop, trimToSpan, histThin } from "../anim"; // 0.8.1 perf, 0.8.2
/* 0.8.1: centre crosshair readouts, clickable alerts / model detections, drawings in linked panes */
import { crosshair, tool, details, type DetailItem } from "../store";
import { sampleAt } from "../radar/sweep";
import { rasterValue } from "../grid/raster";
import { fmtValue, fmtGrid, fmtDist, compass, circle } from "../util";
import { OVERLAYS, overlayDef } from "../overlays/defs";
import { isOn, popup, ovlData, ovlDataVer, activeOverlayIds, overlaySig, addOverlayTo, removeOverlayFrom, applyHistFilterTo, fetchOverlayFor, pickOverlay, overlayMap } from "../overlays/manager";
import { registerMlIcons } from "../ml/targets";
import { attachDrawPane, refreshDrawPanes } from "./draw";
/* 0.8.2 */
import { addBaseLayers, applyBaseStyles, applyBaseVisibility, alertFeatures, siteEl, markerDensity, hookAlertHover, setAlertData, ALERT_HIT_LAYERS } from "./baselayers";
import { contextMenu } from "./mapview"; // 0.8.2 integration: the map's right-click menu in panes
import { addSameMap, removeSameMap } from "../same/mapshow"; // 0.8.2 integration: SAME outlines in panes
import { registerIcons } from "../overlays/icons";
import { registerPatterns } from "../alertstyle";
import { fileOverlays } from "../overlays/files";
import { histRange, histTime, histAllowed } from "../history";
import { siteRegion, siteShown, type AnySite } from "../intl/sites";
import { tickerMaps, addAnim, wakeTicker } from "../overlays/ticker";
import { refreshMul, pollPaused } from "../saver";
import { xsPick, xsLine, xsFirst, xsPane } from "../ui/XSection";
import { paneLayerOn, nearestFrame, nearestReady, preloadOrder } from "./panesync";
/* 0.8.3 inspector: radar inspector, bearing tool and radar-site clicks in every pane */
import { selectSite } from "../radar/controller";
import { wantPaneInsp, dropPaneInsp } from "../radar/inspector";
import { bearing, distance } from "../util";
import { siteClickTarget, inspLayers } from "../radar/insp083";
/** the radar Inspector's cursor in a pane (pane-local pixels) */
export const paneInsp = signal<{ idx: number; x: number; y: number; lat: number; lon: number } | null>(null);
/** distance & direction tool in each pane: from that pane's radar to its centre */
export const paneBearing = signal<Record<number, { site: string; dist: number; brg: number }>>({});

export const paneStatus = signal<Record<number, { loading?: boolean; error?: string; time?: number; label?: string }>>({});
const panes = new Map<number, PaneView>();
let syncing = false;
/* ---------- data 0.6: swipe compare always follows the main map; satellite imagery in panes ---------- */
/* panes 0.8: per-pane links (position / time / layers); swipe compare always shares the position */
export function paneLink(idx: number): PaneLink {
  if (myKind === "pane") return { ...myLink.value, pos: false }; // a pane window links through linkwin.ts
  const p = settings.value.panes;
  const l = p.links?.[idx] ?? { pos: p.sync, time: true, layers: true };
  return p.layout === "swipe" ? { ...l, pos: true } : l;
}
const synced = (idx: number) => paneLink(idx).pos;
/** 0.8.1: is the main map part of the position group? (unlinked: linked panes still move together) */
export function mainLinked(): boolean {
  const p = settings.value.panes;
  return p.layout === "swipe" || p.mainPos !== false;
}
const ML = "mldetect";
const EMPTY_FC = { type: "FeatureCollection", features: [] } as any;

/* ---------- 0.8.2: per-pane layers ---------- */
/** a pane's own setting for a layer (undefined = follows the main map / the layers link) */
export function paneOverride(idx: number, id: string): boolean | undefined {
  const o = settings.value.panes.layers?.[idx]?.[id];
  if (o !== undefined) return o;
  if (id === ML && settings.value.panes.ml?.[idx] === false) return false; // 0.8.1 per-pane detections toggle
  return undefined;
}
/** is layer `id` (catalog id, "file:<id>" or "base:<k>") shown in pane idx? */
export function paneLayerShown(idx: number, id: string): boolean {
  const linked = paneLink(idx).layers;
  if (id.startsWith("base:")) {
    const k = id.slice(5);
    return paneLayerOn(!!(settings.value.overlays as any)[k], linked, paneOverride(idx, id), k === "states");
  }
  return paneLayerOn(isOn(id), linked, paneOverride(idx, id));
}
/** does the pane have any layer settings of its own? */
export function paneHasOverrides(idx: number): boolean {
  return Object.keys(settings.value.panes.layers?.[idx] ?? {}).length > 0 || settings.value.panes.ml?.[idx] === false;
}
/** 0.8.1: does pane idx draw model detections? (per-pane toggle, default shown) */
export function paneMl(idx: number): boolean {
  return paneLayerShown(idx, ML);
}

/** 0.8.1: value at each pane's centre (crosshair) */
export const paneCenter = signal<Record<number, { v: string; sub?: string } | null>>({});
function setCenter(i: number, r: { v: string; sub?: string } | null) {
  const o = paneCenter.peek()[i];
  if (o === r || (o && r && o.v === r.v && o.sub === r.sub)) return;
  paneCenter.value = { ...paneCenter.peek(), [i]: r };
}
/** 0.8.2: data inspector — value under the mouse in a pane (pane-relative position) */
export const paneHover = signal<{ idx: number; x: number; y: number; v: string; sub?: string } | null>(null);

function gibsTiles(id: string, t: number): { tiles: string[]; maxzoom: number; key: string } | null {
  const g = GIBS.find((x) => x.id === id);
  if (!g) return null;
  const step = g.step * 60_000;
  // newest image that is surely published: daily layers yesterday, others ~40 min back
  const lim = g.step >= 1440 ? Date.now() - 86400_000 : Date.now() - 40 * 60_000;
  const tt = Math.floor(Math.min(t || lim, lim) / step) * step;
  const iso = new Date(tt).toISOString().slice(0, 19) + "Z";
  const time = g.step >= 1440 ? iso.slice(0, 10) : iso;
  const tiles = g.wms
    ? [`${g.wms}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(g.layer)}&styles=&format=image/png&transparent=true&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256&time=${iso}`]
    : [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${g.layer}/default/${time}/GoogleMapsCompatible_Level${g.level}/{z}/{y}/{x}.${g.format}`];
  return { tiles, maxzoom: g.level, key: `${id}|${time}` };
}
/* ---------- end data 0.6 ---------- */

function setStatus(i: number, s: { loading?: boolean; error?: string; time?: number; label?: string }) {
  // 0.8.1 perf: peek — this runs inside the time-follow effect, and reading the signal it writes made a
  // cycle ("Cycle detected"), which killed that effect: panes then stopped following the timeline
  const cur = paneStatus.peek();
  const o = cur[i] ?? {};
  if (Object.entries(s).every(([k, v]) => (o as any)[k] === v)) return; // 0.8.2: no re-render per unchanged frame
  paneStatus.value = { ...cur, [i]: { ...o, ...s } };
}

function mercView(m: MLMap, frames: number) {
  const c = m.getCanvas();
  const b = m.getBounds();
  const mx = (lon: number) => (lon + 180) / 360;
  const my = (lat: number) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  let x0 = mx(b.getWest()), x1 = mx(b.getEast()), y0 = my(b.getNorth()), y1 = my(b.getSouth());
  const px = (x1 - x0) * 0.1, py = (y1 - y0) * 0.1;
  x0 -= px; x1 += px; y0 = Math.max(0, y0 - py); y1 = Math.min(1, y1 + py);
  let w = Math.min(1800, Math.max(64, Math.round(c.clientWidth * 1.1)));
  let h = Math.min(1800, Math.max(64, Math.round(c.clientHeight * 1.1)));
  // 0.8.1 perf: image-size cap, and a pane's loop fits its share of the frame cache (40% for all panes)
  // 0.8.2: sized for the frames the pane actually preloads (rounded up so a new frame doesn't resize)
  const p = perfNow();
  const n = Math.ceil(Math.max(2, Math.min(frames, p.prefetch === "none" ? 2 : p.prefetch === "near" ? 7 : frames > 40 ? 34 : frames)) / 8) * 8;
  ({ w, h } = fitImage(w, h, p.imgRes, n, 4, (p.cacheMB * 1024 * 1024 * 0.4) / Math.max(1, panes.size)));
  return { sig: [x0, y0, x1, y1, w, h].map((v) => v.toFixed(5)).join(","), bbox: [x0, y0, x1, y1], w, h };
}

/** radar frame list / grid frame list for a pane, matching the main map's loop (count or time span,
 * history window, bandwidth saver) so time-linked panes have a frame for every main frame */
async function listFrames(cfg: PaneCfg): Promise<{ key: string; time: number; label?: string }[]> {
  const h = histRange.peek();
  if (cfg.weather.kind === "radar") {
    const site = cfg.site ?? settings.peek().radar.site;
    const src = cfg.source ?? "L2";
    const count = settings.peek().radar.frames;
    if (src === "L2") {
      if (h) return histThin(await listL2Range(site, h.start, h.end)).map((v) => ({ key: v.key, time: v.time }));
      const r = await api.get(`/api/radar/${site}/latest?n=${framesToRequest(count, 4, 200)}`);
      const list = (r.volumes as any[]).map((v) => ({ key: v.key, time: v.time })).sort((a, b) => a.time - b.time);
      return liveLoop(list, count);
    }
    if (h) throw new Error("Level III has no archive");
    const prod = l3For(cfg.product ?? "N0B", sites.peek().find((s) => s.id === site)?.type === "TDWR");
    const r = await api.get(`/api/l3/${site}/${prod}/list?n=${framesToRequest(count, 4, 200)}`);
    return trimToSpan((r.volumes as any[]).map((v) => ({ key: v.key, time: v.time })).sort((a, b) => a.time - b.time));
  }
  if (cfg.weather.kind === "grid") {
    const id = cfg.weather.id;
    const d = gridDef(id);
    const obs = d?.source !== "model" && d?.source !== "ndfd" && d?.source !== "future" && d?.source !== "mlpred" && !id.startsWith("mlpred/");
    const n = obs ? framesToRequest(settings.peek().grid.frames, 2) : settings.peek().grid.frames;
    const end = obs && h ? `&end=${h.end}` : "";
    const r = await api.get(`/api/grid/frames?layer=${encodeURIComponent(id)}&n=${n}${end}${gridExtraQ(cfg.weather) /* data 0.8: ensemble threshold */}`);
    const fs = ((r.frames ?? []) as { key: string; time: number; label?: string }[]).sort((a, b) => a.time - b.time);
    return obs ? trimToSpan(fs) : fs;
  }
  return [];
}

class PaneView {
  map: MLMap;
  radar = new RadarLayer("pane-radar");
  grid = new GridLayer();
  cfg: PaneCfg | null = null;
  frames: { key: string; time: number; label?: string }[] = [];
  sweeps = new Map<string, Sweep>();
  rasters = new Map<string, { r: Raster; sig: string }>();
  gen = 0;
  timer: number | undefined;
  siteMarkers = new Map<string, maplibregl.Marker>();
  pointMarkers: maplibregl.Marker[] = [];
  /* 0.8.1 */
  cur: { sweep?: Sweep; raster?: Raster; key?: string; table: { units: string; labels?: Record<number, string> } | null; units: string } | null = null;
  offDraw: () => void = () => {};
  lastHover = 0;
  /* 0.8.2: animation */
  viewSig = "";
  view: ReturnType<typeof mercView> | null = null;
  failed = new Set<string>();
  tried = new Set<string>();
  shownKey = "";
  /* 0.8.2: overlays */
  ovShown = new Map<string, string>(); // overlay id → signature of the drawn layers
  ovSet = new Map<string, any>(); // overlay id → data last set
  own = new Map<string, { fc: any; timer: number; busy: boolean }>(); // overlays this pane fetches itself
  hovFid: number | null = null;

  constructor(public idx: number, el: HTMLElement) {
    const s = settings.value;
    const main = mapRef.value;
    this.map = new maplibregl.Map({
      container: el,
      style: buildStyle(s.basemap === "google" ? "satellite" : s.basemap, { labels: s.overlays.labels, provider: s.basemapProvider, custom: s.customBasemaps }),
      center: main?.getCenter() ?? s.view.center,
      zoom: main?.getZoom() ?? s.view.zoom,
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
      fadeDuration: 0,
      keyboard: false,
    } as any);
    this.grid.id = "pane-grid";
    applyPerfToMap(this.map); // 0.8.1 perf: render resolution, frame-rate cap
    registerPatterns(this.map); // 0.8.2: striped / checkered alert fills
    this.map.on("style.load", () => this.addLayers());
    this.map.on("move", () => {
      this.readCenter(); // 0.8.1
      if (tool.peek() === "bearing") this.refreshTools(); // 0.8.3 inspector
      this.followPopup();
      if (syncing || !synced(this.idx)) return; // data 0.6, panes 0.8
      syncing = true;
      const c = this.map.getCenter();
      if (mainLinked()) mapRef.value?.jumpTo({ center: c, zoom: this.map.getZoom() }); // 0.8.1: the main map can move freely
      for (const p of panes.values()) if (p !== this && synced(p.idx)) p.map.jumpTo({ center: c, zoom: this.map.getZoom() });
      syncing = false;
    });
    /* 0.8.1: alerts and model detections are clickable here too; 0.8.2: every overlay */
    this.map.on("click", (e) => this.onClick(e));
    this.map.on("mousemove", (e) => this.onHover(e));
    this.map.getCanvas().addEventListener("mouseleave", () => this.onLeave());
    hookAlertHover(this.map, () => tool.peek() !== "none"); // 0.8.2: same highlight as the main map
    this.offDraw = attachDrawPane(this.map, () => settings.value.panes.drawAll !== false && synced(this.idx));
    this.map.on("zoom", () => this.siteDensity());
    this.map.on("dblclick", (e) => tool.peek() === "measure" && e.preventDefault()); // 0.8.2
    this.map.on("contextmenu", (e) => {
      // 0.8.2: like the main map (measure: right-click ends it); otherwise the map's right-click menu for this pane
      if (tool.peek() === "measure") return void (tool.value = "none");
      // the menu is placed like the main map's (relative to the main map's corner)
      const r = this.map.getContainer().getBoundingClientRect();
      const mr = mapRef.peek()?.getContainer().getBoundingClientRect();
      contextMenu.value = { x: r.left - (mr?.left ?? 0) + e.point.x, y: r.top - (mr?.top ?? 0) + e.point.y, lat: e.lngLat.lat, lon: e.lngLat.lng, pane: this.idx, px: e.point.x, py: e.point.y };
    });
    addSameMap(this.map); // 0.8.2 integration
    this.map.on("moveend", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.show();
        for (const id of this.own.keys()) if (overlayDef(id)?.view) this.fetchOwn(id); // 0.8.2
      }, 200);
    });
    tickerMaps.add(this.map); // 0.8.2: animated overlays (rotation pulses, spinning cyclones)
  }

  addLayers() {
    const m = this.map;
    const top = m.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
    if (!m.getLayer("pane-grid")) m.addLayer(this.grid, top);
    if (!m.getLayer("pane-radar")) m.addLayer(this.radar, top);
    /* 0.8.2: the main map's built-in layers, icons and patterns */
    registerIcons(m);
    registerMlIcons(m);
    addBaseLayers(m, top);
    if (!m.getSource("rings")) {
      m.addSource("rings", { type: "geojson", data: EMPTY_FC });
      m.addLayer({ id: "ovl-rings", type: "line", source: "rings", paint: { "line-color": "#9fb3c8", "line-width": 1, "line-opacity": 0.55, "line-dasharray": [4, 3] } });
    }
    if (!m.getSource("tools")) {
      // 0.8.2: the measure tool works in panes too (same look as the main map)
      m.addSource("tools", { type: "geojson", data: EMPTY_FC });
      m.addLayer({ id: "ovl-tools-line", type: "line", source: "tools", paint: { "line-color": "#ffd166", "line-width": 2.5, "line-dasharray": [2, 1] } });
      m.addLayer({ id: "ovl-tools-pts", type: "circle", source: "tools", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffd166", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
    }
    if (!m.getSource("xs-line")) {
      m.addSource("xs-line", { type: "geojson", data: EMPTY_FC });
      m.addLayer({ id: "xs-line-case", type: "line", source: "xs-line", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#000", "line-width": 5, "line-opacity": 0.6 } });
      m.addLayer({ id: "xs-line", type: "line", source: "xs-line", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#fff", "line-width": 2.2, "line-dasharray": [3, 1.5] } });
      m.addLayer({ id: "xs-dot", type: "circle", source: "xs-line", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 5, "circle-color": "#facc15", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } });
    }
    setAlertData(m, alertFc);
    this.ovShown.clear();
    this.ovSet.clear();
    this.refreshBase();
    this.syncOverlays();
    this.refreshSites();
    this.refreshXs();
    this.refreshTools();
    this.show();
  }

  /* ---------- 0.8.2: built-in layers ---------- */
  refreshBase() {
    const m = this.map;
    if (!m.getLayer("ovl-states")) return;
    const on = (k: string) => paneLayerShown(this.idx, `base:${k}`);
    applyBaseStyles(m);
    applyBaseVisibility(m, { counties: on("counties"), states: on("states"), alerts: on("alerts"), rings: on("rings") });
    this.refreshRings();
    this.refreshPoints();
  }

  /** range rings around this pane's radar */
  refreshRings() {
    const src = this.map.getSource("rings") as GeoJSONSource | undefined;
    if (!src) return;
    const id = this.cfg?.site ?? settings.value.radar.site;
    const site = sites.value.find((s) => s.id === id);
    if (!site || !paneLayerShown(this.idx, "base:rings")) return src.setData(EMPTY_FC);
    const unit = settings.value.units.distance === "km" ? 1000 : settings.value.units.distance === "mi" ? 1609.344 : 1852;
    const feats = [1, 2, 3, 4, 5].map((k) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: circle(site.lat, site.lon, k * 50 * unit) } }));
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }

  /** saved points (same markers as the main map) */
  refreshPoints() {
    for (const mk of this.pointMarkers) mk.remove();
    this.pointMarkers = [];
    if (!paneLayerShown(this.idx, "base:points")) return;
    for (const p of settings.value.points) {
      const el = document.createElement("div");
      el.className = "point-marker";
      el.innerHTML = `<span class="pin" style="--c:${p.color}"></span><span class="lbl"></span>`;
      (el.querySelector(".lbl") as HTMLElement).textContent = p.name;
      this.pointMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(this.map));
    }
  }

  /** radar site markers (same elements, region filter and click behaviour as the main map) */
  refreshSites() {
    const show = paneLayerShown(this.idx, "base:sites") && this.cfg?.weather.kind === "radar"; // panes 0.8
    if (!show) {
      for (const m of this.siteMarkers.values()) m.remove();
      this.siteMarkers.clear();
      return;
    }
    const sel = this.cfg?.site ?? settings.value.radar.site;
    const extra = this.cfg?.site ? [] : settings.value.extraSites;
    const list = (sites.value as AnySite[]).filter(siteShown); // 0.8.2: region filter like the main map
    const ids = new Set(list.map((x) => x.id));
    for (const [id, m] of this.siteMarkers) if (!ids.has(id)) (m.remove(), this.siteMarkers.delete(id));
    for (const st of list) {
      let m = this.siteMarkers.get(st.id);
      if (!m) {
        m = new maplibregl.Marker({ element: siteEl(st.id, st.type, siteRegion(st), (id, add) => this.pickSite(id, add) /* 0.8.3 inspector */), anchor: "center" }).setLngLat([st.lon, st.lat]).addTo(this.map);
        this.siteMarkers.set(st.id, m);
      }
      m.getElement().classList.toggle("selected", st.id === sel);
      m.getElement().classList.toggle("extra", extra.includes(st.id));
    }
    this.siteDensity();
  }

  siteDensity() {
    markerDensity(this.map);
  }

  /** 0.8.3 inspector (R35): a radar-site click in an unlinked pane switches only this pane's radar */
  pickSite(id: string, additive: boolean) {
    const swipe = myKind !== "pane" && settings.peek().panes.layout === "swipe";
    const lk = myKind === "pane" ? myLink.peek() : paneLink(this.idx);
    const radar = this.cfg?.weather.kind === "radar";
    if (swipe || siteClickTarget(lk, radar) === "main") {
      if (this.cfg?.site)
        update((s) => {
          const c = s.panes.list[this.idx - 1];
          if (c?.site) s.panes.list[this.idx - 1] = { ...c, site: undefined }; // linked: follow the main radar again
        });
      selectSite(id, additive);
      return;
    }
    update((s) => {
      const c = s.panes.list[this.idx - 1];
      if (c?.weather.kind === "radar") s.panes.list[this.idx - 1] = { ...c, site: id };
    });
  }

  /* ---------- 0.8.2: overlays (same layer specs as the main map) ---------- */
  wantedOverlays(): string[] {
    const ids = [...OVERLAYS.map((d) => d.id), ...fileOverlays.value.map((f) => `file:${f.id}`)].filter((id) => paneLayerShown(this.idx, id));
    return histRange.value ? ids.filter((id) => histAllowed(id)) : ids;
  }

  syncOverlays() {
    const m = this.map;
    if (!m.getStyle() || !m.getLayer("ovl-alerts-fill")) return;
    const want = new Set(this.wantedOverlays());
    for (const id of [...this.ovShown.keys()]) {
      if (want.has(id)) continue;
      removeOverlayFrom(m, id);
      this.ovShown.delete(id);
      this.ovSet.delete(id);
      this.stopOwn(id);
    }
    for (const id of want) {
      const sig = overlaySig(id);
      if (this.ovShown.get(id) === sig && m.getSource(`o-${id}`)) continue;
      removeOverlayFrom(m, id);
      try {
        addOverlayTo(m, id);
      } catch (e) {
        console.warn("pane overlay", id, e);
      }
      if (this.ovShown.has(id)) this.stopOwn(id); // options changed: fetch again
      this.ovShown.set(id, sig);
      this.ovSet.delete(id);
    }
    this.pushOverlayData();
  }

  /** this pane fetches the overlay itself: the main map doesn't draw it, or it depends on the view
   * and this pane isn't position-linked (client-side layers always share the main map's data) */
  needsOwn(id: string): boolean {
    const def = overlayDef(id);
    if (!def || def.feed === "client" || def.raster || histRange.peek()) return false;
    if (!overlayMap() || !activeOverlayIds().includes(id)) return true;
    return !!def.view && !synced(this.idx);
  }

  pushOverlayData() {
    const m = this.map;
    for (const id of this.ovShown.keys()) {
      if (overlayDef(id)?.raster) continue;
      let d: any;
      if (this.needsOwn(id)) {
        this.ensureOwn(id);
        d = this.own.get(id)?.fc;
      } else {
        this.stopOwn(id);
        d = ovlData(id);
      }
      d = d ?? EMPTY_FC;
      if (this.ovSet.get(id) === d) continue;
      this.ovSet.set(id, d);
      (m.getSource(`o-${id}`) as GeoJSONSource | undefined)?.setData(d);
      if (histRange.peek()) applyHistFilterTo(m, id);
    }
  }

  ensureOwn(id: string) {
    if (this.own.has(id)) return;
    const def = overlayDef(id)!;
    const e = { fc: null as any, timer: 0, busy: false };
    this.own.set(id, e);
    if (def.refresh) e.timer = window.setInterval(() => !pollPaused() && this.fetchOwn(id), Math.max(15, settings.peek().ovl[id]?.refresh ?? def.refresh) * refreshMul() * 1000);
    this.fetchOwn(id);
  }
  stopOwn(id: string) {
    const e = this.own.get(id);
    if (!e) return;
    clearInterval(e.timer);
    this.own.delete(id);
  }
  async fetchOwn(id: string) {
    const e = this.own.get(id);
    if (!e || e.busy || this.dead) return;
    e.busy = true;
    try {
      const fc = await fetchOverlayFor(id, this.map);
      if (this.own.get(id) !== e || this.dead) return;
      e.fc = fc ?? EMPTY_FC;
      this.pushOverlayData();
    } catch {
      /* keep the last data */
    } finally {
      e.busy = false;
    }
  }
  histFilter() {
    if (!histRange.peek()) return;
    for (const id of this.ovShown.keys()) applyHistFilterTo(this.map, id);
  }

  /** measure tool points (clicked on any map) */
  refreshTools() {
    const src = this.map.getSource("tools") as GeoJSONSource | undefined;
    if (!src) return;
    const pts = tool.peek() === "measure" ? measurePts.peek() : [];
    const feats: any[] = pts.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
    if (pts.length > 1) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    // 0.8.3 inspector: distance & direction from this pane's radar to its centre
    const id = this.cfg?.weather.kind === "radar" && this.cfg.site ? this.cfg.site : settings.peek().radar.site;
    const st = tool.peek() === "bearing" ? (sites.peek() as AnySite[]).find((x) => x.id === id) : undefined;
    const pb = paneBearing.peek();
    if (st) {
      const c = this.map.getCenter();
      feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[st.lon, st.lat], [c.lng, c.lat]] } });
      feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [st.lon, st.lat] } });
      paneBearing.value = { ...pb, [this.idx]: { site: st.id, dist: distance(st.lat, st.lon, c.lat, c.lng), brg: bearing(st.lat, st.lon, c.lat, c.lng) } };
    } else if (pb[this.idx]) {
      const n = { ...pb };
      delete n[this.idx];
      paneBearing.value = n;
    }
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }

  /** cross-section line (picked on any map) */
  refreshXs() {
    const src = this.map.getSource("xs-line") as GeoJSONSource | undefined;
    if (!src) return;
    const l = xsLine.peek();
    const f = xsFirst.peek();
    const feats: any[] = [];
    if (l) feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: l }, properties: {} });
    else if (f) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: f }, properties: {} });
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }

  async configure(cfg: PaneCfg) {
    this.cfg = cfg;
    this.grid.gateKey = cfg.weather.kind === "grid" ? gridGateKey(cfg.weather.id) : "";
    this.refreshSites();
    this.refreshRings();
    if (tool.peek() === "bearing") this.refreshTools(); // 0.8.3 inspector: the pane's radar changed
    const gen = ++this.gen;
    this.frames = [];
    this.radar.setItems([]);
    this.grid.set(null, null, 0, 0);
    for (const sw of this.sweeps.values()) this.radar.release(sw);
    this.sweeps.clear();
    rasterBudget.deletePrefix(this.bid);
    for (const h of this.rasters.values()) this.grid.release(h.r);
    this.rasters.clear();
    this.failed.clear();
    this.tried.clear();
    this.shownKey = "";
    this.cur = null; // 0.8.1
    this.readCenter();
    setStatus(this.idx, { loading: true, error: undefined, label: label(cfg) });
    if (cfg.weather.kind === "gibs") {
      if (gen === this.gen) (setStatus(this.idx, { loading: false, error: undefined }), this.show()); // data 0.6: drawn by showGibs
      return;
    }
    await this.refreshList(gen);
  }

  /** 0.8.2: reload the frame list only (new volumes, loop length, history window): loaded frames stay */
  async refreshList(gen = this.gen) {
    const cfg = this.cfg;
    if (!cfg || cfg.weather.kind === "gibs") return;
    try {
      const fs = await listFrames(cfg);
      if (gen !== this.gen) return;
      this.frames = fs;
      const keep = new Set(fs.map((f) => f.key));
      for (const [k, sw] of this.sweeps) if (!keep.has(k)) (this.radar.release(sw), this.sweeps.delete(k));
      this.tried.clear();
      setStatus(this.idx, { loading: false, error: fs.length ? undefined : "No data" });
      this.show();
    } catch (e: any) {
      if (gen === this.gen) setStatus(this.idx, { loading: false, error: e.message });
    }
  }

  /* ---------- 0.8.2: animation ---------- */
  /** the time this pane should show (0 = newest frame) */
  wantTime(): number {
    const lk = paneLink(this.idx);
    return !lk.time ? 0 : myKind === "pane" ? linkedTime.peek() : activeTime.peek();
  }
  /** Frame nearest the main map's time (panes 0.8: newest frame when time isn't linked). */
  pick() {
    return nearestFrame(this.frames, this.wantTime());
  }
  /** decoded and ready for the current view */
  ready(f: { key: string }): boolean {
    if (this.cfg?.weather.kind === "radar") return this.sweeps.has(f.key);
    const h = this.rasters.get(f.key);
    return !!h && h.sig === this.viewSig;
  }
  /** something to show while the wanted frame loads (any view) */
  has(f: { key: string }): boolean {
    return this.cfg?.weather.kind === "radar" ? this.sweeps.has(f.key) : this.rasters.has(f.key);
  }

  /** put a loaded frame on screen (no network) */
  display(f: { key: string; time: number }) {
    const cfg = this.cfg;
    if (!cfg) return;
    if (cfg.weather.kind === "radar") {
      const sw = this.sweeps.get(f.key);
      if (!sw) return;
      // most recently used last (the cache drops the oldest)
      this.sweeps.delete(f.key);
      this.sweeps.set(f.key, sw);
      const product = cfg.source === "L3" ? cfg.product ?? "N0B" : cfg.product ?? "REF";
      const base = tableKeyFor(product);
      const t = tableById(settings.peek().tables[base] ?? base);
      this.radar.smooth = settings.peek().radar.smooth;
      this.radar.setItems([{ sweep: sw, table: t, opacity: settings.peek().radar.opacity }]);
      this.cur = { sweep: sw, key: f.key, table: t, units: t.units }; // 0.8.1
      // 0.8.2: a cross-section picked in this pane follows its frame
      const xp = xsPane.peek();
      if (xp && xp.idx === this.idx && xp.key !== f.key && (cfg.source ?? "L2") === "L2") xsPane.value = { ...xp, key: f.key, product };
    } else if (cfg.weather.kind === "grid") {
      const hit = this.rasters.get(f.key);
      if (!hit) return;
      rasterBudget.touch(this.bid + f.key);
      const d = gridDef(cfg.weather.id);
      const table = !d || d.cmap === "RGB" ? null : settings.peek().tables[d.cmap] ? tableById(settings.peek().tables[d.cmap]) : gridTable(d.cmap);
      this.grid.set(hit.r, table, settings.peek().grid.opacity, settings.peek().grid.smooth);
      this.cur = { raster: hit.r, key: f.key, table, units: d?.units ?? table?.units ?? "" }; // 0.8.1
    } else return;
    this.shownKey = f.key;
    setStatus(this.idx, { time: f.time, error: undefined });
    this.readCenter(); // 0.8.1
  }

  /** the wanted frame if it is ready, else the nearest one that is (never a blank or a stall) */
  displayBest(force = false) {
    const t = this.pick();
    if (!t) return;
    if (this.ready(t)) {
      if (force || !this.isShown(t)) this.display(t);
      return;
    }
    const n = nearestReady(this.frames, this.wantTime(), (f) => this.has(f));
    if (n && (force || !this.isShown(n))) this.display(n);
  }
  /** is exactly this frame's data on screen? */
  isShown(f: { key: string }): boolean {
    const c = this.cur;
    if (!c || c.key !== f.key) return false;
    return c.sweep ? c.sweep === this.sweeps.get(f.key) : c.raster === this.rasters.get(f.key)?.r;
  }

  /** download and decode one frame into this pane's cache */
  async load(f: { key: string }): Promise<void> {
    const cfg = this.cfg!;
    if (cfg.weather.kind === "radar") {
      const product = cfg.source === "L3" ? cfg.product ?? "N0B" : cfg.product ?? "REF";
      const sw = await fetchSweep(f.key, cfg.source ?? "L2", product, cfg.tilt ?? 0.5);
      if (!sw) throw new Error("product not in this volume");
      if (this.dead || cfg !== this.cfg) return;
      this.sweeps.set(f.key, sw);
      const cap = Math.max(30, Math.min(60, this.frames.length));
      while (this.sweeps.size > cap) {
        const k = this.sweeps.keys().next().value!;
        if (k === this.shownKey) break;
        this.radar.release(this.sweeps.get(k)!);
        this.sweeps.delete(k);
      }
      this.radar.preload([...this.sweeps.values()]); // GPU upload ahead of playback (like the main map)
      return;
    }
    if (cfg.weather.kind !== "grid" || !this.view) return;
    const v = this.view;
    const buf = await api.bin(`/api/grid/render?key=${encodeURIComponent(f.key)}&bbox=${v.bbox.join(",")}&w=${v.w}&h=${v.h}&sv=${lastHello.value?.version ?? ""}`);
    if (this.dead || cfg !== this.cfg) return;
    const r = parseRaster(buf, f.key);
    const old = this.rasters.get(f.key);
    if (old && old.r !== this.grid.raster) this.grid.release(old.r);
    this.rasters.set(f.key, { r, sig: v.sig });
    // 0.8.1 perf: counted in the frame cache shared by all maps (was: 24 per pane, any size)
    const key = f.key;
    rasterBudget.set(this.bid + key, r.bytes, () => {
      const e = this.rasters.get(key);
      if (!e) return true;
      if (e.r === this.grid.raster) return false;
      this.grid.release(e.r);
      this.rasters.delete(key);
      return true;
    });
  }

  /** next frame to preload: the ones the loop plays next (Settings → Performance → prefetch) */
  nextPreload(): { key: string; time: number } | undefined {
    const t = this.pick();
    if (!t) return;
    const i = this.frames.indexOf(t);
    for (const j of preloadOrder(this.frames.length, i, perfNow().prefetch)) {
      const f = this.frames[j];
      if (this.ready(f) || this.failed.has(f.key) || this.tried.has(f.key)) continue;
      this.tried.add(f.key); // once per list / view: a loop bigger than the cache never re-downloads forever
      return f;
    }
  }

  /* 0.8.1 perf: one load at a time per pane (a slow full-disk image used to stack up downloads). 0.8.2:
   * every time change shows the best ready frame at once; the single loader then fetches the newest
   * wanted frame (never a queue of stale ones) and preloads the loop in the order it plays. */
  busy = false;
  again = false;
  show(): Promise<void> {
    if (this.dead) return Promise.resolve(); // 0.8.1: destroyed (closed, or rebuilt after a lost GPU context)
    if (pausedNow()) return (this.again = true), Promise.resolve(); // hidden window: catch up when shown
    const cfg = this.cfg;
    if (cfg && this.map.getStyle()) this.showGibs(cfg.weather.kind === "gibs" ? cfg.weather.id : null); // data 0.6
    if (!cfg || cfg.weather.kind === "gibs") return Promise.resolve();
    this.displayBest();
    if (this.busy) return (this.again = true), Promise.resolve();
    return this.pump();
  }

  private async pump() {
    this.busy = true;
    this.again = false;
    try {
      for (let guard = 0; guard < 500 && !this.dead && !pausedNow(); guard++) {
        const cfg = this.cfg;
        if (!cfg || cfg.weather.kind === "gibs" || !this.map.getStyle()) break;
        const gen = this.gen;
        if (cfg.weather.kind === "grid") {
          this.view = mercView(this.map, this.frames.length);
          if (this.view.sig !== this.viewSig) (this.viewSig = this.view.sig), this.tried.clear();
        }
        const t = this.pick();
        if (!t) break;
        let f: { key: string; time: number } | undefined = !this.ready(t) && !this.failed.has(t.key) ? t : undefined;
        if (!f) {
          this.display(t);
          f = this.nextPreload();
          if (!f) break;
        }
        try {
          await this.load(f);
        } catch (e: any) {
          this.failed.add(f.key);
          if (f === t) setStatus(this.idx, { error: e.message });
        }
        if (gen !== this.gen) break;
        this.displayBest(); // the newest wanted time (or the nearest ready frame)
      }
      if (pausedNow()) this.again = true; // hidden window: continue when shown
    } finally {
      this.busy = false;
      if (this.again && !this.dead) {
        this.again = false;
        setTimeout(() => this.show(), 0);
      }
    }
  }

  /* data 0.6 */
  gibsKey = "";
  gibsWait = false;
  showGibs(id: string | null) {
    const m = this.map;
    const g = id ? gibsTiles(id, activeTime.value) : null;
    if ((g?.key ?? "") === this.gibsKey && (!g || m.getSource("pane-gibs"))) return;
    // 0.8.1 perf: while playing, switch the image time only once the current one has loaded (each
    // switch drops the source and refetches every tile; at animation speed that never settled)
    if (g && playing.peek() && m.getSource("pane-gibs") && !m.isSourceLoaded("pane-gibs")) {
      if (!this.gibsWait) (this.gibsWait = true), m.once("idle", () => ((this.gibsWait = false), this.show()));
      return;
    }
    this.gibsKey = g?.key ?? "";
    if (m.getLayer("pane-gibs")) m.removeLayer("pane-gibs");
    if (m.getSource("pane-gibs")) m.removeSource("pane-gibs");
    if (!g) return;
    m.addSource("pane-gibs", { type: "raster", tiles: g.tiles, tileSize: 256, maxzoom: g.maxzoom, attribution: "NASA GIBS / EUMETSAT" });
    m.addLayer({ id: "pane-gibs", type: "raster", source: "pane-gibs", paint: { "raster-opacity": 0.95, "raster-fade-duration": 0 } }, "pane-grid");
    setStatus(this.idx, { loading: false, error: undefined, time: Date.parse(g.key.split("|")[1]) || undefined });
  }

  setBasemap() {
    const s = settings.value;
    this.map.setStyle(buildStyle(s.basemap === "google" ? "satellite" : s.basemap, { labels: s.overlays.labels, provider: s.basemapProvider, custom: s.customBasemaps }), { diff: false });
  }

  /* ---------- 0.8.1 ---------- */
  /** value of this pane's product at a point */
  valueAt(lat: number, lon: number): { v: string; sub?: string } | null {
    const cur = this.cur;
    if (!cur || !cur.table) return cur?.raster || cur?.sweep ? { v: "—" } : null;
    if (cur.sweep) {
      const r = sampleAt(cur.sweep, lat, lon);
      if (!r || Number.isNaN(r.value)) return { v: "—" };
      const h = settings.peek().units.distance === "km" ? `${(r.height / 1000).toFixed(1)} km` : `${((r.height * 3.28084) / 1000).toFixed(1)} kft`;
      return { v: fmtValue(r.value, cur.table.units, cur.table.labels), sub: r.range > 0 ? `${fmtDist(r.range)} ${compass(r.az)} · ${h}` : undefined };
    }
    if (cur.raster) {
      const v = rasterValue(cur.raster, lat, lon);
      return { v: Number.isNaN(v) ? "—" : fmtGrid(v, cur.units, cur.table.labels) };
    }
    return null;
  }
  /** crosshair readout: this pane's product at its own centre */
  readCenter() {
    if (!crosshair.peek()) return setCenter(this.idx, null);
    const c = this.map.getCenter();
    setCenter(this.idx, this.valueAt(c.lat, c.lng));
  }

  /* 0.8.3 inspector (R4): mouse moves are coalesced to one update per animation frame (the readout
   * follows the pointer smoothly instead of every 50 ms), and the rendered-feature queries for the
   * pointer cursor / detection highlight run at most ~12 times a second with a trailing update. */
  hovEv: { lat: number; lon: number; x: number; y: number } | null = null;
  hovRaf = 0;
  lastQ = 0;
  qTimer: number | undefined;
  onHover(e: maplibregl.MapMouseEvent) {
    this.hovEv = { lat: e.lngLat.lat, lon: e.lngLat.lng, x: e.point.x, y: e.point.y };
    if (!this.hovRaf) this.hovRaf = requestAnimationFrame(() => this.hoverFrame());
  }
  hoverFrame() {
    this.hovRaf = 0;
    const h = this.hovEv;
    if (!h || this.dead) return;
    // 0.8.2: data inspector (the value under the mouse in this pane's product)
    const r = settings.peek().ui.cursorValue || shiftHeld.peek() ? this.valueAt(h.lat, h.lon) : null;
    const ph = paneHover.peek();
    if (r) {
      if (!ph || ph.idx !== this.idx || ph.x !== h.x || ph.y !== h.y || ph.v !== r.v || ph.sub !== r.sub) paneHover.value = { idx: this.idx, x: h.x, y: h.y, ...r };
    } else if (ph?.idx === this.idx) paneHover.value = null;
    // radar Inspector in this pane
    if (settings.peek().radar6?.inspector) {
      paneInsp.value = { idx: this.idx, ...h };
      const cfg = this.cfg;
      const l2 = cfg?.weather.kind === "radar" && (cfg.source ?? "L2") === "L2";
      wantPaneInsp(this.idx, l2 ? this.cur?.key : undefined, cfg?.tilt ?? settings.peek().radar.tiltAngle);
    } else if (paneInsp.peek()) paneInsp.value = null;
    if (tool.peek() !== "none") return;
    clearTimeout(this.qTimer);
    const wait = 80 - (performance.now() - this.lastQ);
    if (wait > 0) this.qTimer = window.setTimeout(() => this.queryHover(), wait);
    else this.queryHover();
  }
  queryHover() {
    const h = this.hovEv;
    if (!h || this.dead || tool.peek() !== "none") return;
    this.lastQ = performance.now();
    const m = this.map;
    let order: string[] = [];
    try {
      order = m.getLayersOrder(); // cheap (getStyle() serialised the whole style on every move)
    } catch {
      return; // style not ready
    }
    const layers = inspLayers(order, []);
    const pt: [number, number] = [h.x, h.y];
    const feats = layers.length ? m.queryRenderedFeatures(pt, { layers }) : [];
    const c = m.getCanvas().style;
    if (feats.length) c.cursor = "pointer";
    else if (c.cursor === "pointer" && !m.queryRenderedFeatures(pt, { layers: ALERT_HIT_LAYERS.filter((l) => m.getLayer(l)) }).length) c.cursor = "";
    // 0.8.2: model detections brighten on hover (feature-state on fid, like the main map)
    const det = feats.find((f) => f.layer.id.startsWith(`o-${ML}-`) && f.properties?.fid != null && f.properties.fid !== "");
    this.setDetHover(det ? +det.properties!.fid : null);
  }
  setDetHover(fid: number | null) {
    if (fid === this.hovFid) return;
    const src = `o-${ML}`;
    const set = (id: number | null, on: boolean) => {
      if (id == null || !this.map.getSource(src)) return;
      try {
        this.map.setFeatureState({ source: src, id }, { hover: on });
      } catch {
        /* source reloading */
      }
    };
    set(this.hovFid, false);
    this.hovFid = fid;
    set(fid, true);
  }
  onLeave() {
    this.hovEv = null; // 0.8.3 inspector
    clearTimeout(this.qTimer);
    if (paneInsp.peek()?.idx === this.idx) paneInsp.value = null;
    if (paneHover.peek()?.idx === this.idx) paneHover.value = null;
    this.setDetHover(null);
  }

  onClick(e: maplibregl.MapMouseEvent) {
    const t = tool.peek();
    if (t === "xsect") {
      // 0.8.2: a cross-section picked here uses this pane's Level II volume
      const cfg = this.cfg;
      const l2 = cfg?.weather.kind === "radar" && (cfg.source ?? "L2") === "L2" && this.cur?.key;
      xsPick([e.lngLat.lng, e.lngLat.lat], l2 ? { idx: this.idx, key: this.cur!.key!, product: cfg!.product ?? "REF" } : null);
      return;
    }
    if (t === "measure") {
      measurePts.value = [...measurePts.peek(), [e.lngLat.lng, e.lngLat.lat]]; // 0.8.2
      return;
    }
    if (t !== "none") return;
    popup.value = null;
    contextMenu.value = null; // 0.8.2 integration
    // 0.8.2: the main map's click logic: point features first, then alerts + panel overlays
    const pick = pickOverlay(e, { map: this.map, pane: this.idx });
    if (pick.handled) return;
    const layers = ALERT_HIT_LAYERS.filter((l) => this.map.getLayer(l));
    const ids = [...new Set(this.map.queryRenderedFeatures(e.point, { layers }).map((f) => String(f.properties?.id)))];
    const al = ids.map((id) => alerts.value.get(id)).filter(Boolean).sort((a: any, b: any) => b.properties.priority - a.properties.priority || String(b.properties.sent).localeCompare(String(a.properties.sent)));
    const items: DetailItem[] = [...al.map((a: any) => ({ kind: "alert" as const, id: a.properties.id })), ...pick.panel];
    if (items.length) details.value = { items, i: 0 };
    else if (pick.fallback) pick.fallback();
    else details.value = null;
  }

  /** a popup opened here sticks to its spot (closes once it leaves the pane) */
  followPopup() {
    const p = popup.peek();
    if (!p || p.pane !== this.idx) return;
    const pt = this.map.project([p.lng, p.lat]);
    const c = this.map.getContainer();
    if (pt.x < -20 || pt.y < -20 || pt.x > c.clientWidth + 20 || pt.y > c.clientHeight + 20) return void (popup.value = null);
    const r = c.getBoundingClientRect();
    popup.value = { ...p, x: r.left + pt.x, y: r.top + pt.y };
  }
  /* ---------- end 0.8.1 ---------- */

  /** 0.8.1 perf: this pane's entries in the shared frame cache */
  get bid() {
    return `pane${this.idx}#${this.uid}|`;
  }
  uid = Math.random().toString(36).slice(2, 8);

  dead = false;
  destroy() {
    // 0.8.1: stop pending reloads and in-flight loads of this view (a rebuilt pane gets a new one)
    this.dead = true;
    this.gen++;
    clearTimeout(this.timer);
    this.offDraw(); // 0.8.1
    tickerMaps.delete(this.map); // 0.8.2
    removeSameMap(this.map); // 0.8.2 integration
    if (contextMenu.peek()?.pane === this.idx) contextMenu.value = null;
    for (const id of [...this.own.keys()]) this.stopOwn(id);
    if (popup.peek()?.pane === this.idx) popup.value = null;
    if (paneHover.peek()?.idx === this.idx) paneHover.value = null;
    /* 0.8.3 inspector */
    cancelAnimationFrame(this.hovRaf);
    clearTimeout(this.qTimer);
    if (paneInsp.peek()?.idx === this.idx) paneInsp.value = null;
    dropPaneInsp(this.idx);
    if (paneBearing.peek()[this.idx]) {
      const n = { ...paneBearing.peek() };
      delete n[this.idx];
      paneBearing.value = n;
    }
    setCenter(this.idx, null);
    // 0.8.1 perf: free GPU copies and drop the module-level references (the radar layer registry kept
    // closed panes' maps alive) before the map and its WebGL context go
    rasterBudget.deletePrefix(this.bid);
    for (const id of ["pane-radar", "pane-grid"])
      try {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
      } catch {
        /* style gone */
      }
    this.sweeps.clear();
    this.rasters.clear();
    for (const mk of this.pointMarkers) mk.remove();
    this.map.remove();
  }
}

export function label(cfg: PaneCfg): string {
  if (cfg.weather.kind === "grid") return gridDef(cfg.weather.id)?.name ?? cfg.weather.id;
  if (cfg.weather.kind === "gibs") return GIBS.find((g) => g.id === (cfg.weather as any).id)?.name ?? cfg.weather.id; // data 0.6
  return `${cfg.site ?? settings.value.radar.site} ${cfg.product ?? "REF"}`;
}

export function mountPane(idx: number, el: HTMLElement, fallback?: PaneCfg, onMap?: (m: MLMap | null) => void) {
  panes.get(idx)?.destroy();
  /* 0.8.1 perf: Settings → Performance → max panes (each pane is a full map with its own WebGL
   * context), and a pane whose WebGL context is lost for good (Chromium drops the oldest when too many
   * exist, or the GPU process restarted) is rebuilt instead of staying blank */
  let p: PaneView | null = null;
  let lostTimer = 0;
  let dead = false;
  let rebuilds = 0; // 0.8.1: back off when the GPU keeps dropping the context
  // a pane window is its own process: the limit is for the panes inside the main window
  const limit = () => (myKind === "pane" ? 8 : perfNow().maxPanes);
  const make = () => {
    if (dead) return;
    if (idx > limit()) {
      onMap?.(null);
      el.innerHTML = `<div class="muted small" style="display:grid;place-items:center;height:100%;text-align:center;padding:12px">Pane off · Settings → Performance → Max panes</div>`;
      return;
    }
    el.innerHTML = "";
    const v = new PaneView(idx, el);
    p = v;
    panes.set(idx, v);
    onMap?.(v.map); // 0.8.1: a pane window links through this map (also after a rebuild)
    // 0.8.1: a new pane has no saved config yet (the layout adds it a moment later): load what its selector shows
    const cfg = settings.value.panes.list[idx - 1] ?? fallback;
    if (cfg) v.configure(cfg);
    v.map.on("webglcontextlost", () => {
      clearTimeout(lostTimer);
      lostTimer = window.setTimeout(() => {
        if (dead || p !== v) return;
        v.destroy();
        if (panes.get(idx) === v) panes.delete(idx);
        p = null;
        rebuilds++;
        make();
      }, 3000 * 2 ** Math.min(rebuilds, 5));
    });
    v.map.on("webglcontextrestored", () => clearTimeout(lostTimer));
  };
  make();
  const stop = effect(() => {
    const allowed = idx <= (myKind === "pane" ? 8 : perf.value.maxPanes);
    untracked(() => {
      if (allowed === !!p) return;
      if (!allowed && p) {
        p.destroy();
        if (panes.get(idx) === p) panes.delete(idx);
        p = null;
      }
      make();
    });
  });
  return () => {
    dead = true;
    stop();
    clearTimeout(lostTimer);
    if (p) {
      p.destroy();
      if (panes.get(idx) === p) panes.delete(idx);
    }
  };
}

export function paneConfigured(idx: number, cfg: PaneCfg) {
  const p = panes.get(idx);
  if (p && !sameCfg(p.cfg, cfg)) p.configure(cfg); // 0.8.1: the list effect below may have done it already
}
const sameCfg = (a: PaneCfg | null | undefined, b: PaneCfg | null | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/* panes 0.8 */
export function paneMap(idx: number): MLMap | null {
  return panes.get(idx)?.map ?? null;
}
export function paneCount() {
  return panes.size;
}
/** 0.8.3 inspector: what a pane shows (its config, frame and the value reader) for the Inspector */
export function paneView(idx: number): { cfg: PaneCfg | null; key?: string; sweep?: Sweep; valueAt: (lat: number, lon: number) => { v: string; sub?: string } | null } | null {
  const p = panes.get(idx);
  if (!p) return null;
  return { cfg: p.cfg, key: p.cur?.key, sweep: p.cur?.sweep, valueAt: (lat, lon) => p.valueAt(lat, lon) };
}

export function resizePanes() {
  for (const p of panes.values()) p.map.resize();
  mapRef.value?.resize();
}

// main map → panes (position)
let hooked = false;
effect(() => {
  const m = mapRef.value;
  if (!m || hooked) return;
  hooked = true;
  m.on("move", () => {
    if (syncing || !panes.size || !mainLinked()) return; // data 0.6, 0.8.1: main map unlinked
    syncing = true;
    const c = m.getCenter();
    for (const p of panes.values()) if (synced(p.idx)) p.map.jumpTo({ center: c, zoom: m.getZoom() }); // panes 0.8
    syncing = false;
  });
});

// time follows the main timeline
effect(() => {
  void activeTime.value;
  void linkedTime.value; // panes 0.8: pane windows
  void myLink.value;
  untracked(() => {
    for (const p of panes.values()) p.show();
  });
});

/* ---------- 0.8.2: alerts drawn exactly like the main map's (one feature build for every pane) ---------- */
let alertFc: any = EMPTY_FC;
let alertFlash = 0;
let lastAlertSig = "";
let lastAlerts: unknown = null;
function refreshPaneAlerts() {
  const { fc, flashing } = alertFeatures();
  alertFc = fc;
  for (const p of panes.values()) setAlertData(p.map, fc);
  clearInterval(alertFlash);
  const setFlash = (o: number) => {
    for (const p of panes.values()) if (p.map.getLayer("ovl-alerts-flash")) p.map.setPaintProperty("ovl-alerts-flash", "line-opacity", o);
  };
  if (flashing) {
    let on = false;
    alertFlash = window.setInterval(() => setFlash((on = !on) ? 0.95 : 0), 450);
    window.setTimeout(refreshPaneAlerts, 5000); // re-evaluate when the earliest flash window ends
  } else setFlash(0);
}
// 0.8.1 perf: settings change on every pan (the saved view): only when something alerts depend on changed
effect(() => {
  const a = alerts.value;
  const s = settings.value;
  const sig = JSON.stringify([s.alertCfg, s.a11y?.cvd, panes.size]);
  if (a === lastAlerts && sig === lastAlertSig) return;
  lastAlerts = a;
  lastAlertSig = sig;
  untracked(() => refreshPaneAlerts());
});
/* 0.8.2: layers (built-in + overlays) follow the main map's Layers menu, the layers link and the
 * pane's own overrides; again only when something they depend on changed */
let lastLayerSig = "";
effect(() => {
  const s = settings.value;
  const sig = JSON.stringify([s.overlays, s.ovl, s.units, s.points, s.panes.links, s.panes.layers, s.panes.ml, s.panes.layout, s.panes.sync, s.basemap, myLink.value, histRange.value, fileOverlays.value.map((f) => f.id), panes.size]);
  if (sig === lastLayerSig) return;
  lastLayerSig = sig;
  untracked(() => {
    for (const p of panes.values()) (p.refreshBase(), p.syncOverlays(), p.refreshSites());
  });
});
// overlay data changed on the main map (new fetch, replay step, files)
effect(() => {
  void ovlDataVer.value;
  untracked(() => {
    for (const p of panes.values()) p.pushOverlayData();
  });
});
// history replay: the same time filter on each pane's copy
effect(() => {
  if (!histTime.value) return;
  untracked(() => {
    for (const p of panes.values()) p.histFilter();
  });
});
// 0.8.2: measure tool
effect(() => {
  void measurePts.value;
  void tool.value;
  untracked(() => {
    for (const p of panes.values()) {
      p.refreshTools();
      const t = tool.peek();
      if (t === "measure" || t === "xsect") p.map.getCanvas().style.cursor = "crosshair";
      else if (t === "none" && p.map.getCanvas().style.cursor === "crosshair") p.map.getCanvas().style.cursor = "";
    }
  });
});
// cross-section line
effect(() => {
  void xsLine.value;
  void xsFirst.value;
  untracked(() => {
    for (const p of panes.values()) p.refreshXs();
  });
});
// 0.8.2: high-probability detections pulse like on the main map (copied from its animated ring)
addAnim({
  active: () => {
    const mm = mapRef.peek();
    const L = `o-${ML}-pulse`;
    return panes.size > 0 && !!mm?.getLayer(L) && mm.getPaintProperty(L, "circle-stroke-opacity") !== 0;
  },
  frame: (m) => {
    const mm = mapRef.peek();
    const L = `o-${ML}-pulse`;
    if (!mm || m === mm || !m.getLayer(L) || !mm.getLayer(L)) return;
    for (const prop of ["circle-radius", "circle-stroke-opacity", "circle-stroke-width"] as const) m.setPaintProperty(L, prop, mm.getPaintProperty(L, prop) as any);
  },
});
setInterval(() => panes.size && wakeTicker(), 2000);

// 0.8.1 perf: panes paused while the window was hidden catch up when it is shown again
effect(() => {
  if (!pageHidden.value) for (const p of panes.values()) if (p.again) p.show();
});
/* panes 0.8: a pane whose position link is switched on jumps to the main map */
let lastLinks = "";
effect(() => {
  const p = settings.value.panes;
  const sig = JSON.stringify([p.links, p.sync, p.layout, p.mainPos, p.drawAll]);
  if (sig === lastLinks) return;
  const first = !lastLinks;
  lastLinks = sig;
  refreshDrawPanes(); // 0.8.1
  const m = mapRef.peek();
  if (first || !m) return;
  // 0.8.1: with the main map unlinked, the linked panes line up with the first of them
  const group = [...panes.values()].filter((v) => synced(v.idx)).sort((a, b) => a.idx - b.idx);
  const ref = mainLinked() ? m : group[0]?.map;
  if (!ref) return;
  syncing = true;
  for (const v of group) if (v.map !== ref) v.map.jumpTo({ center: ref.getCenter(), zoom: ref.getZoom() });
  syncing = false;
});
/* 0.8.1: panes load whatever config the list holds (new panes, restored workspaces) */
effect(() => {
  const list = settings.value.panes.list;
  for (const p of panes.values()) {
    const c = list[p.idx - 1];
    if (c && !sameCfg(p.cfg, c)) p.configure(c);
  }
});
effect(() => {
  void crosshair.value;
  for (const p of panes.values()) p.readCenter();
});
// 0.8.2: colour tables, opacity and smoothing apply to the frame on screen right away
let lastLook = "";
effect(() => {
  const s = settings.value;
  const sig = JSON.stringify([s.tables, s.radar.opacity, s.radar.smooth, s.grid.opacity, s.grid.smooth]);
  if (sig === lastLook) return;
  const first = !lastLook;
  lastLook = sig;
  if (!first)
    untracked(() => {
      for (const p of panes.values()) p.displayBest(true);
    });
});
// radar panes that follow the main radar reload when it changes
let lastSite = "";
effect(() => {
  const site = settings.value.radar.site;
  if (site === lastSite) return;
  lastSite = site;
  settings.value.panes.list.forEach((c, i) => c && c.weather.kind === "radar" && !c.site && panes.get(i + 1)?.configure(c));
});
// site markers follow the radar list, the selected radar and the Sites toggle
effect(() => {
  void sites.value;
  void settings.value.radar.site;
  void settings.value.overlays.sites;
  void settings.value.extraSites;
  void settings.value.ovl["base:sites"]; // 0.8.2: region filter
  untracked(() => {
    for (const p of panes.values()) (p.refreshSites(), p.refreshRings());
  });
});
let lastBase = "";
effect(() => {
  const s = settings.value;
  const sig = `${s.basemap}|${s.overlays.labels}|${s.basemapProvider}`;
  if (sig === lastBase) return;
  const first = !lastBase;
  lastBase = sig;
  if (!first) for (const p of panes.values()) p.setBasemap();
});
/* 0.8.2: the frame lists follow the main loop: its length / time span, history window, and a new
 * newest frame on the main map (refreshed right away instead of up to 2 minutes later) */
let lastLoopSig = "";
effect(() => {
  const s = settings.value;
  const fs = activeFrames.value;
  const sig = JSON.stringify([s.anim.mode, s.anim.minutes, s.radar.frames, s.grid.frames, histRange.value, fs.length ? fs[fs.length - 1].time : 0]);
  if (sig === lastLoopSig) return;
  const first = !lastLoopSig;
  lastLoopSig = sig;
  if (!first)
    untracked(() => {
      for (const p of panes.values()) p.refreshList();
    });
});
// refresh pane frame lists every 2 minutes (0.8.2: keeps what is loaded)
setInterval(() => {
  for (const p of panes.values()) p.refreshList();
}, 120_000);
(window as any).__tbwPanes = panes; // 0.8.2: console / screenshot handle
