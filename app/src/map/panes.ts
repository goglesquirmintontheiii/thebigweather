// Extra map panes (dual / quad view). Each pane is its own MapLibre map with its own weather
// layer (a radar product or a gridded layer), following the main map's time and, when synced,
// its position.

import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { signal, effect } from "@preact/signals";
import { api, lastHello } from "../api";
import { settings, type PaneCfg } from "../store";
import { buildStyle, isDarkBasemap } from "./basemaps";
import { RadarLayer } from "../radar/RadarLayer";
import { GridLayer } from "../grid/GridLayer";
import { fetchSweep, tableById, tableKeyFor, sites, l3For, selectSite } from "../radar/controller";
import { gridGateKey } from "../gate";
import { gridDef, gridTable, GIBS } from "../weather";
import { parseRaster, type Raster } from "../grid/raster";
import type { Sweep } from "../radar/sweep";
import { activeTime } from "../active";
import { alerts } from "../alerts";
import { mapRef } from "./mapview";

export const paneStatus = signal<Record<number, { loading?: boolean; error?: string; time?: number; label?: string }>>({});
const panes = new Map<number, PaneView>();
let syncing = false;
/* ---------- data 0.6: swipe compare always follows the main map; satellite imagery in panes ---------- */
const synced = () => settings.value.panes.sync || settings.value.panes.layout === "swipe";
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
  paneStatus.value = { ...paneStatus.value, [i]: { ...paneStatus.value[i], ...s } };
}

function mercView(m: MLMap) {
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
  const w = Math.min(1800, Math.max(64, Math.round(c.clientWidth * 1.1)));
  const h = Math.min(1800, Math.max(64, Math.round(c.clientHeight * 1.1)));
  return { sig: [x0, y0, x1, y1, w, h].map((v) => v.toFixed(5)).join(","), bbox: [x0, y0, x1, y1], w, h };
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
    this.map.on("style.load", () => this.addLayers());
    this.map.on("move", () => {
      if (syncing || !synced()) return; // data 0.6
      syncing = true;
      const c = this.map.getCenter();
      mapRef.value?.jumpTo({ center: c, zoom: this.map.getZoom() });
      for (const p of panes.values()) if (p !== this) p.map.jumpTo({ center: c, zoom: this.map.getZoom() });
      syncing = false;
    });
    this.map.on("zoom", () => this.siteDensity());
    this.map.on("moveend", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.show(), 200);
    });
  }

  addLayers() {
    const m = this.map;
    const dark = isDarkBasemap(settings.value.basemap, settings.value.customBasemaps);
    const top = m.getStyle().layers.find((l) => l.id.startsWith("top-"))?.id;
    if (!m.getLayer("pane-grid")) m.addLayer(this.grid, top);
    if (!m.getLayer("pane-radar")) m.addLayer(this.radar, top);
    if (!m.getSource("states")) {
      m.addSource("states", { type: "geojson", data: "geo/states.json" });
      m.addLayer({ id: "p-states", type: "line", source: "states", paint: { "line-color": dark ? "#c9d1d9" : "#374151", "line-width": 1 } }, top);
    }
    if (!m.getSource("alerts")) {
      m.addSource("alerts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "p-alerts", type: "line", source: "alerts", paint: { "line-color": ["get", "color"], "line-width": ["match", ["get", "kind"], "warning", 2.2, 1.2] } });
    }
    this.refreshAlerts();
    this.refreshSites();
    this.show();
  }

  /** radar site markers (same look and click behaviour as the main map) */
  refreshSites() {
    const show = settings.value.overlays.sites && this.cfg?.weather.kind === "radar";
    if (!show) {
      for (const m of this.siteMarkers.values()) m.remove();
      this.siteMarkers.clear();
      return;
    }
    const sel = this.cfg?.site ?? settings.value.radar.site;
    const extra = this.cfg?.site ? [] : settings.value.extraSites;
    const list = sites.value;
    const ids = new Set(list.map((x) => x.id));
    for (const [id, m] of this.siteMarkers) if (!ids.has(id)) (m.remove(), this.siteMarkers.delete(id));
    for (const st of list) {
      let m = this.siteMarkers.get(st.id);
      if (!m) {
        const el = document.createElement("button");
        el.className = `site-marker ${st.type === "TDWR" ? "tdwr" : "nexrad"}`;
        el.textContent = st.id;
        el.title = `${st.id} — click to view · Ctrl+click to add/remove alongside the current radar`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          selectSite(st.id, e.ctrlKey || e.metaKey);
        });
        m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([st.lon, st.lat]).addTo(this.map);
        this.siteMarkers.set(st.id, m);
      }
      m.getElement().classList.toggle("selected", st.id === sel);
      m.getElement().classList.toggle("extra", extra.includes(st.id));
    }
    this.siteDensity();
  }

  siteDensity() {
    const z = this.map.getZoom();
    const root = this.map.getContainer();
    root.classList.toggle("sites-dots", z < 4.6);
    root.classList.toggle("sites-hide-tdwr", z < 5.6);
  }

  refreshAlerts() {
    const src = this.map.getSource("alerts") as GeoJSONSource | undefined;
    if (!src) return;
    const feats = [...alerts.value.values()].filter((f) => f.geometry).map((f) => ({ type: "Feature", geometry: f.geometry, properties: { color: f.properties.color, kind: String(f.properties.event).endsWith("Warning") ? "warning" : "other" } }));
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }

  async configure(cfg: PaneCfg) {
    this.cfg = cfg;
    this.grid.gateKey = cfg.weather.kind === "grid" ? gridGateKey(cfg.weather.id) : "";
    this.refreshSites();
    const gen = ++this.gen;
    this.frames = [];
    this.radar.setItems([]);
    this.grid.set(null, null, 0, 0);
    setStatus(this.idx, { loading: true, error: undefined, label: label(cfg) });
    try {
      if (cfg.weather.kind === "radar") {
        const site = cfg.site ?? settings.value.radar.site;
        const src = cfg.source ?? "L2";
        const n = Math.min(Math.max(settings.value.radar.frames, 6), 30);
        if (src === "L2") {
          const r = await api.get(`/api/radar/${site}/latest?n=${n}`);
          this.frames = r.volumes.map((v: any) => ({ key: v.key, time: v.time }));
        } else {
          const prod = l3For(cfg.product ?? "N0B", sites.value.find((s) => s.id === site)?.type === "TDWR");
          const r = await api.get(`/api/l3/${site}/${prod}/list?n=${n}`);
          this.frames = r.volumes.map((v: any) => ({ key: v.key, time: v.time }));
        }
      } else if (cfg.weather.kind === "gibs") {
        this.frames = []; // data 0.6: drawn by showGibs
        if (gen === this.gen) (setStatus(this.idx, { loading: false, error: undefined }), this.show());
        return;
      } else if (cfg.weather.kind === "grid") {
        const r = await api.get(`/api/grid/frames?layer=${encodeURIComponent(cfg.weather.id)}&n=${settings.value.grid.frames}`);
        this.frames = r.frames;
      }
      if (gen !== this.gen) return;
      this.frames.sort((a, b) => a.time - b.time);
      setStatus(this.idx, { loading: false, error: this.frames.length ? undefined : "No data" });
      this.show();
    } catch (e: any) {
      if (gen === this.gen) setStatus(this.idx, { loading: false, error: e.message });
    }
  }

  /** Frame at (or just before) the main map's time. */
  pick(): { key: string; time: number; label?: string } | undefined {
    const fs = this.frames;
    if (!fs.length) return;
    const t = activeTime.value;
    if (!t) return fs[fs.length - 1];
    let best = fs[0];
    for (const f of fs) if (Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
    return best;
  }

  async show() {
    const cfg = this.cfg;
    /* data 0.6: satellite imagery (one image near the main map's time) */
    if (cfg && this.map.getStyle()) this.showGibs(cfg.weather.kind === "gibs" ? cfg.weather.id : null);
    if (cfg?.weather.kind === "gibs") return;
    const f = this.pick();
    if (!cfg || !f || !this.map.getStyle()) return;
    const gen = this.gen;
    try {
      if (cfg.weather.kind === "radar") {
        const product = cfg.source === "L3" ? cfg.product ?? "N0B" : cfg.product ?? "REF";
        let sw = this.sweeps.get(f.key);
        if (!sw) {
          sw = await fetchSweep(f.key, cfg.source ?? "L2", product, cfg.tilt ?? 0.5);
          if (!sw || gen !== this.gen) return;
          this.sweeps.set(f.key, sw);
          if (this.sweeps.size > 30) {
            const k = this.sweeps.keys().next().value!;
            this.radar.release(this.sweeps.get(k)!);
            this.sweeps.delete(k);
          }
        }
        const base = tableKeyFor(product);
        const t = tableById(settings.value.tables[base] ?? base);
        this.radar.smooth = settings.value.radar.smooth;
        this.radar.setItems([{ sweep: sw, table: t, opacity: settings.value.radar.opacity }]);
      } else if (cfg.weather.kind === "grid") {
        const v = mercView(this.map);
        let hit = this.rasters.get(f.key);
        if (!hit || hit.sig !== v.sig) {
          const buf = await api.bin(`/api/grid/render?key=${encodeURIComponent(f.key)}&bbox=${v.bbox.join(",")}&w=${v.w}&h=${v.h}&sv=${lastHello.value?.version ?? ""}`);
          if (gen !== this.gen) return;
          const r = parseRaster(buf, f.key);
          if (hit) this.grid.release(hit.r);
          hit = { r, sig: v.sig };
          this.rasters.set(f.key, hit);
          if (this.rasters.size > 24) {
            const k = this.rasters.keys().next().value!;
            this.grid.release(this.rasters.get(k)!.r);
            this.rasters.delete(k);
          }
        }
        const d = gridDef(cfg.weather.id);
        const table = !d || d.cmap === "RGB" ? null : settings.value.tables[d.cmap] ? tableById(settings.value.tables[d.cmap]) : gridTable(d.cmap);
        this.grid.set(hit.r, table, settings.value.grid.opacity, settings.value.grid.smooth);
      }
      setStatus(this.idx, { time: f.time, error: undefined });
    } catch (e: any) {
      setStatus(this.idx, { error: e.message });
    }
  }

  /* data 0.6 */
  gibsKey = "";
  showGibs(id: string | null) {
    const m = this.map;
    const g = id ? gibsTiles(id, activeTime.value) : null;
    if ((g?.key ?? "") === this.gibsKey && (!g || m.getSource("pane-gibs"))) return;
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

  destroy() {
    this.map.remove();
  }
}

export function label(cfg: PaneCfg): string {
  if (cfg.weather.kind === "grid") return gridDef(cfg.weather.id)?.name ?? cfg.weather.id;
  if (cfg.weather.kind === "gibs") return GIBS.find((g) => g.id === (cfg.weather as any).id)?.name ?? cfg.weather.id; // data 0.6
  return `${cfg.site ?? settings.value.radar.site} ${cfg.product ?? "REF"}`;
}

export function mountPane(idx: number, el: HTMLElement) {
  panes.get(idx)?.destroy();
  const p = new PaneView(idx, el);
  panes.set(idx, p);
  const cfg = settings.value.panes.list[idx - 1];
  if (cfg) p.configure(cfg);
  return () => {
    p.destroy();
    if (panes.get(idx) === p) panes.delete(idx);
  };
}

export function paneConfigured(idx: number, cfg: PaneCfg) {
  panes.get(idx)?.configure(cfg);
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
    if (syncing || !synced() || !panes.size) return; // data 0.6
    syncing = true;
    const c = m.getCenter();
    for (const p of panes.values()) p.map.jumpTo({ center: c, zoom: m.getZoom() });
    syncing = false;
  });
});

// time follows the main timeline
effect(() => {
  void activeTime.value;
  for (const p of panes.values()) p.show();
});
effect(() => {
  void alerts.value;
  for (const p of panes.values()) p.refreshAlerts();
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
  for (const p of panes.values()) p.refreshSites();
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
// refresh pane frame lists every 2 minutes
setInterval(() => {
  for (const p of panes.values()) if (p.cfg) p.configure(p.cfg);
}, 120_000);
