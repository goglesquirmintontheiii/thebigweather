// Basemap styles. Layers named "base-*" draw under the radar; "top-*" draw above it
// (labels, roads), like RadarOmega keeps place names readable over storms.

import type { StyleSpecification, LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { Basemap, CustomBasemap } from "../store";

export const BASEMAPS: { id: Basemap; name: string; needsKey?: string }[] = [
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
  { id: "road", name: "Road network" },
  { id: "darkroad", name: "Dark roadmap" },
  { id: "terrain", name: "Terrain" },
  { id: "satellite", name: "Satellite" },
  { id: "google", name: "Google satellite", needsKey: "google_maps" },
  { id: "offline", name: "Offline (built-in)" },
];

const carto = (style: string) => ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}@2x.png`);
const CARTO_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>';
const ESRI_ATTR = "Tiles © Esri — Esri, Maxar, Earthstar Geographics, USDA, USGS, AeroGRID, IGN, GIS User Community";
const OFM_ATTR = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const raster = (tiles: string[], attribution: string, maxzoom = 19, tileSize = 256): SourceSpecification => ({ type: "raster", tiles, tileSize, attribution, maxzoom });

const BG: Record<string, string> = {
  dark: "#0b0e13",
  light: "#e9ecef",
  road: "#f2efe9",
  darkroad: "#0d1117",
  terrain: "#dfe3d5",
  satellite: "#0a0a0a",
  google: "#0a0a0a",
  offline: "#0b1016",
};

export function isDarkBasemap(b: Basemap, custom?: CustomBasemap[]) {
  if (b.startsWith("custom:")) return custom?.find((c) => `custom:${c.id}` === b)?.dark ?? true;
  return ["dark", "darkroad", "satellite", "google", "offline"].includes(b);
}

/** Expand a {s} template over its subdomains ("abc" or "mt0,mt1"). */
export function customTiles(c: CustomBasemap): string[] {
  if (!c.url.includes("{s}")) return [c.url];
  const subs = c.subdomains.includes(",") ? c.subdomains.split(",").map((x) => x.trim()).filter(Boolean) : c.subdomains.trim().split("");
  return (subs.length ? subs : ["a", "b", "c"]).map((s) => c.url.replace("{s}", s));
}

/** Offline land/borders, always available (bundled with the app). */
function offlineLayers(dark: boolean): { sources: Record<string, SourceSpecification>; layers: LayerSpecification[] } {
  return {
    sources: {
      land: { type: "geojson", data: "geo/land.json" },
      borders: { type: "geojson", data: "geo/borders.json" },
    },
    layers: [
      { id: "base-land", type: "fill", source: "land", paint: { "fill-color": dark ? "#151b23" : "#f5f5f0" } },
      { id: "base-borders", type: "line", source: "borders", paint: { "line-color": dark ? "#5b6675" : "#888", "line-width": 1 } },
    ],
  };
}

interface Theme {
  water: string;
  land?: string;
  park: string;
  urban: string;
  building: string;
  minor: string;
  secondary: string;
  primary: string;
  motorway: string;
  boundary: string;
  text: string;
  halo: string;
  waterText: string;
  roadsOnTop: boolean;
}

const THEMES: Record<"dark" | "light" | "road" | "darkroad", Theme> = {
  dark: { water: "#0e1620", park: "#121a16", urban: "#161b22", building: "#1b2028", minor: "#262c35", secondary: "#2f3742", primary: "#3c4552", motorway: "#4a5462", boundary: "#7c8796", text: "#d9e1ea", halo: "#05070a", waterText: "#5f7a96", roadsOnTop: false },
  light: { water: "#b9cfe0", park: "#dce8d5", urban: "#e3e3df", building: "#d6d4cf", minor: "#ffffff", secondary: "#fbfbf8", primary: "#f6f2e6", motorway: "#f0dfb5", boundary: "#8d8d9a", text: "#30353b", halo: "#ffffff", waterText: "#5a7a98", roadsOnTop: false },
  road: { water: "#9fc4e6", park: "#cde6c3", urban: "#ece7df", building: "#ddd6cc", minor: "#ffffff", secondary: "#fff6cf", primary: "#ffd98a", motorway: "#f6a65a", boundary: "#7d6f8f", text: "#23272d", halo: "#ffffff", waterText: "#3e6f9c", roadsOnTop: true },
  darkroad: { water: "#0a1a2a", park: "#101a14", urban: "#12171e", building: "#1a2029", minor: "#3a4350", secondary: "#5a6573", primary: "#8a95a3", motorway: "#c9a227", boundary: "#9aa4b1", text: "#e6edf3", halo: "#000000", waterText: "#6d8fb3", roadsOnTop: true },
};

/** OpenFreeMap (OpenMapTiles schema) vector basemap. Fills draw under weather; roads (optionally),
 * borders and labels draw on top so they stay readable over storms. */
function vectorLayers(t: Theme, labels: boolean): LayerSpecification[] {
  const roadPos = t.roadsOnTop ? "top" : "base";
  const road = (id: string, classes: string[], color: string, w: [number, number, number, number], minzoom = 0): LayerSpecification => ({
    id: `${roadPos}-road-${id}`,
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    minzoom,
    filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], w[0], w[1], w[2], w[3]], "line-opacity": t.roadsOnTop ? 0.85 : 1 },
  });
  const font = ["Noto Sans Regular"];
  const out: LayerSpecification[] = [
    { id: "base-landuse", type: "fill", source: "ofm", "source-layer": "landuse", filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "retail"]]], minzoom: 8, paint: { "fill-color": t.urban, "fill-opacity": 0.7 } },
    { id: "base-park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": t.park, "fill-opacity": 0.6 } },
    { id: "base-landcover", type: "fill", source: "ofm", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]], paint: { "fill-color": t.park, "fill-opacity": 0.35 } },
    { id: "base-water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": t.water } },
    { id: "base-waterway", type: "line", source: "ofm", "source-layer": "waterway", minzoom: 8, paint: { "line-color": t.water, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2] } },
    { id: "base-building", type: "fill", source: "ofm", "source-layer": "building", minzoom: 13, paint: { "fill-color": t.building } },
    road("minor", ["minor", "service"], t.minor, [11, 0.4, 18, 8], 10),
    road("secondary", ["secondary", "tertiary"], t.secondary, [8, 0.5, 18, 12], 7),
    road("primary", ["primary", "trunk"], t.primary, [6, 0.6, 18, 16], 5),
    road("motorway", ["motorway"], t.motorway, [5, 0.8, 18, 20], 4),
    {
      id: "top-boundary",
      type: "line",
      source: "ofm",
      "source-layer": "boundary",
      filter: ["all", ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": t.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 10, 1.6], "line-dasharray": [2, 1] },
    },
  ];
  if (labels) {
    out.push(
      {
        id: "top-water-name",
        type: "symbol",
        source: "ofm",
        "source-layer": "water_name",
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Italic"], "text-size": 11 },
        paint: { "text-color": t.waterText, "text-halo-color": t.halo, "text-halo-width": 1 },
      },
      {
        id: "top-road-name",
        type: "symbol",
        source: "ofm",
        "source-layer": "transportation_name",
        minzoom: 11,
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": font, "text-size": 10 },
        paint: { "text-color": t.text, "text-halo-color": t.halo, "text-halo-width": 1.2, "text-opacity": 0.85 },
      },
      {
        id: "top-place",
        type: "symbol",
        source: "ofm",
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "state", "country"]]],
        layout: {
          "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
          "text-font": font,
          "text-size": ["interpolate", ["linear"], ["zoom"], 3, ["match", ["get", "class"], "country", 12, "city", 11, "state", 10, 9], 12, ["match", ["get", "class"], "city", 18, 13]],
          "text-transform": ["match", ["get", "class"], ["state", "country"], "uppercase", "none"],
          "text-letter-spacing": ["match", ["get", "class"], ["state", "country"], 0.1, 0],
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": ["match", ["get", "class"], ["state", "country"], t.boundary, t.text], "text-halo-color": t.halo, "text-halo-width": 1.4 },
      },
    );
  }
  return out;
}

export function buildStyle(b: Basemap, opts: { googleSession?: string; googleKey?: string; labels: boolean; provider?: "openfreemap" | "carto"; custom?: CustomBasemap[] }): StyleSpecification {
  const dark = isDarkBasemap(b, opts.custom);
  const off = offlineLayers(dark);
  const style: StyleSpecification = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { ...off.sources },
    layers: [{ id: "base-bg", type: "background", paint: { "background-color": BG[b as keyof typeof BG] ?? (dark ? "#0b0e13" : "#e9ecef") } }, ...off.layers],
  };
  const addRaster = (id: string, src: SourceSpecification, top = false, paint: Record<string, unknown> = {}) => {
    style.sources[id] = src;
    style.layers.push({ id: `${top ? "top" : "base"}-${id}`, type: "raster", source: id, paint } as LayerSpecification);
  };
  const labels = (st: string) => opts.labels && addRaster("labels", raster(carto(st), CARTO_ATTR, 20, 512), true);
  const ofm = (t: Theme) => {
    style.sources.ofm = { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OFM_ATTR };
    style.layers.push(...vectorLayers(t, opts.labels));
  };
  const useOfm = (opts.provider ?? "openfreemap") === "openfreemap";
  if (b.startsWith("custom:")) {
    const c = opts.custom?.find((x) => `custom:${x.id}` === b);
    if (c) {
      style.sources.custom = { type: "raster", tiles: customTiles(c), tileSize: 256, minzoom: c.minzoom, maxzoom: c.maxzoom, attribution: c.name };
      style.layers.push({ id: "base-custom", type: "raster", source: "custom" } as LayerSpecification);
      // keep place names readable on top when labels are on
      if (opts.labels) addRaster("labels", raster(carto(dark ? "dark_only_labels" : "voyager_only_labels"), CARTO_ATTR, 20, 512), true);
    }
    return style;
  }
  if (useOfm && (b === "dark" || b === "light" || b === "road")) {
    ofm(THEMES[b]);
    return style;
  }
  switch (b) {
    case "dark":
      addRaster("carto", raster(carto("dark_nolabels"), CARTO_ATTR, 20, 512));
      labels("dark_only_labels");
      break;
    case "light":
      addRaster("carto", raster(carto("light_nolabels"), CARTO_ATTR, 20, 512));
      labels("light_only_labels");
      break;
    case "road":
      addRaster("carto", raster(carto("voyager_nolabels"), CARTO_ATTR, 20, 512));
      labels("voyager_only_labels");
      break;
    case "terrain":
      addRaster("relief", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 13));
      addRaster("hillshade", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 13), false, { "raster-opacity": 0.45 });
      labels("voyager_only_labels");
      break;
    case "satellite":
      addRaster("imagery", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 19));
      if (opts.labels) addRaster("ref", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 19), true);
      break;
    case "google":
      if (opts.googleSession && opts.googleKey) {
        addRaster(
          "google",
          raster([`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${opts.googleSession}&key=${opts.googleKey}`], "Map data © Google", 22),
        );
        if (opts.labels) addRaster("ref", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 19), true);
      } else {
        addRaster("imagery", raster(["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], ESRI_ATTR, 19));
      }
      break;
    case "darkroad":
      ofm(THEMES.darkroad);
      break;
    case "offline":
      break;
  }
  return style;
}

/** Google Map Tiles API needs a session token per map type. */
export async function googleSession(key: string): Promise<string> {
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }),
  });
  if (!r.ok) throw new Error(`Google tiles: HTTP ${r.status}`);
  return (await r.json()).session;
}
