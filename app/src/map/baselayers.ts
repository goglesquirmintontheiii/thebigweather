// 0.8.2: the built-in map layers (counties, states, weather alerts), their styles, the alert
// features and the radar site markers, shared by the main map and every map pane so panes draw
// exactly what the main map draws (fills, patterns, hidden alert types, widths, hover, flashing).

import type { Map as MLMap, GeoJSONSource } from "maplibre-gl";
import { settings } from "../store";
import { isDarkBasemap } from "./basemaps";
import { alerts } from "../alerts";
import { alertStyle, alertVisible, alertKind, patternId } from "../alertstyle";
import { selectSite } from "../radar/controller";

const EMPTY = { type: "FeatureCollection", features: [] } as any;
export const ALERT_LAYERS = ["ovl-alerts-fill", "ovl-alerts-pattern", "ovl-alerts-casing", "ovl-alerts-line", "ovl-alerts-flash"];

/** Counties, states and the alert layers (same ids on every map). */
export function addBaseLayers(map: MLMap, before: string | undefined) {
  const dark = isDarkBasemap(settings.value.basemap, settings.value.customBasemaps);
  if (!map.getSource("counties")) map.addSource("counties", { type: "geojson", data: "geo/counties.json" });
  if (!map.getSource("states")) map.addSource("states", { type: "geojson", data: "geo/states.json" });
  if (!map.getLayer("ovl-counties")) map.addLayer({ id: "ovl-counties", type: "line", source: "counties", minzoom: 5, paint: { "line-color": dark ? "#8a96a6" : "#6b7280", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 10, 1], "line-opacity": 0.55 } }, before);
  if (!map.getLayer("ovl-states")) map.addLayer({ id: "ovl-states", type: "line", source: "states", paint: { "line-color": dark ? "#c9d1d9" : "#374151", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 10, 2] } }, before);
  if (map.getSource("alerts")) return;
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
}

/** Colors/widths for the built-in map overlays (Layers → gear). */
export function applyBaseStyles(map: MLMap) {
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

/** Show / hide the built-in layers (`on` = the main map's toggles, or a pane's own). */
export function applyBaseVisibility(map: MLMap, on: { counties: boolean; states: boolean; alerts: boolean; rings: boolean }) {
  const vis = (id: string, v: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", v ? "visible" : "none");
  vis("ovl-counties", on.counties);
  vis("ovl-states", on.states);
  for (const id of ALERT_LAYERS) vis(id, on.alerts);
  vis("ovl-rings", on.rings);
}

/** first time each alert was seen (for flashing new ones); shared so every map flashes the same */
const alertSeen = new Map<string, number>();
let alertsPrimed = false;

/** The alert polygons as drawn: hidden types left out, styles from Alerts → settings. */
export function alertFeatures(now = Date.now()): { fc: any; flashing: boolean } {
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
  return { fc: { type: "FeatureCollection", features: feats }, flashing };
}

/** Alert hover highlight (fill brightens under the pointer) and pointer cursor. `blocked` = a tool is active. */
export function hookAlertHover(map: MLMap, blocked: () => boolean) {
  let hovered: number | string | undefined;
  const onMove = (e: any) => {
    if (blocked()) return;
    map.getCanvas().style.cursor = "pointer";
    const f = e.features?.[0];
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = f?.id;
    if (hovered !== undefined) map.setFeatureState({ source: "alerts", id: hovered }, { hover: true });
  };
  map.on("mousemove", "ovl-alerts-fill", onMove);
  map.on("mousemove", "ovl-alerts-pattern", onMove);
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
    if (hovered !== undefined && map.getSource("alerts")) map.setFeatureState({ source: "alerts", id: hovered }, { hover: false });
    hovered = undefined;
  };
  map.on("mouseleave", "ovl-alerts-fill", onLeave);
  map.on("mouseleave", "ovl-alerts-pattern", onLeave);
}

/** Radar site marker button (same element on every map). */
export function siteEl(id: string, type: string, region = "US"): HTMLElement {
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

/** dots at low zoom, TDWRs hidden until zoomed in */
export function markerDensity(map: MLMap) {
  const z = map.getZoom();
  const root = map.getContainer();
  root.classList.toggle("sites-dots", z < 4.6);
  root.classList.toggle("sites-hide-tdwr", z < 5.6);
}

/** set the alert source data (no-op without the source) */
export function setAlertData(map: MLMap, fc: any) {
  (map.getSource("alerts") as GeoJSONSource | undefined)?.setData(fc);
}
