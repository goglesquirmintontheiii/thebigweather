// Basemap styles. Layers named "base-*" draw under the radar; "top-*" draw above it
// (labels, roads), like RadarOmega keeps place names readable over storms.

import type { StyleSpecification, LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { Basemap } from "../store";

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

const BG: Record<Basemap, string> = {
  dark: "#0b0e13",
  light: "#e9ecef",
  road: "#f2efe9",
  darkroad: "#0d1117",
  terrain: "#dfe3d5",
  satellite: "#0a0a0a",
  google: "#0a0a0a",
  offline: "#0b1016",
};

export function isDarkBasemap(b: Basemap) {
  return ["dark", "darkroad", "satellite", "google", "offline"].includes(b);
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

function vectorRoadLayers(): LayerSpecification[] {
  // OpenMapTiles schema, dark theme with roads above the radar
  const road = (id: string, classes: string[], color: string, w: [number, number, number, number]): LayerSpecification => ({
    id: `top-road-${id}`,
    type: "line",
    source: "ofm",
    "source-layer": "transportation",
    filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], w[0], w[1], w[2], w[3]], "line-opacity": 0.85 },
  });
  return [
    { id: "base-water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": "#0a1a2a" } },
    { id: "base-park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": "#101a14", "fill-opacity": 0.6 } },
    { id: "base-building", type: "fill", source: "ofm", "source-layer": "building", minzoom: 13, paint: { "fill-color": "#1a2029" } },
    road("minor", ["minor", "service"], "#3a4350", [11, 0.4, 18, 8]),
    road("secondary", ["secondary", "tertiary"], "#5a6573", [8, 0.5, 18, 12]),
    road("primary", ["primary", "trunk"], "#8a95a3", [6, 0.6, 18, 16]),
    road("motorway", ["motorway"], "#c9a227", [5, 0.8, 18, 20]),
    {
      id: "top-boundary",
      type: "line",
      source: "ofm",
      "source-layer": "boundary",
      filter: ["<=", ["get", "admin_level"], 4],
      paint: { "line-color": "#9aa4b1", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 10, 1.6], "line-dasharray": [2, 1] },
    },
    {
      id: "top-place",
      type: "symbol",
      source: "ofm",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "state"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, ["match", ["get", "class"], "city", 12, "state", 11, 9], 12, ["match", ["get", "class"], "city", 18, 13]],
        "symbol-sort-key": ["get", "rank"],
      },
      paint: { "text-color": "#e6edf3", "text-halo-color": "#000", "text-halo-width": 1.4 },
    },
  ];
}

export function buildStyle(b: Basemap, opts: { googleSession?: string; googleKey?: string; labels: boolean }): StyleSpecification {
  const dark = isDarkBasemap(b);
  const off = offlineLayers(dark);
  const style: StyleSpecification = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { ...off.sources },
    layers: [{ id: "base-bg", type: "background", paint: { "background-color": BG[b] } }, ...off.layers],
  };
  const addRaster = (id: string, src: SourceSpecification, top = false, paint: Record<string, unknown> = {}) => {
    style.sources[id] = src;
    style.layers.push({ id: `${top ? "top" : "base"}-${id}`, type: "raster", source: id, paint } as LayerSpecification);
  };
  const labels = (st: string) => opts.labels && addRaster("labels", raster(carto(st), CARTO_ATTR, 20, 512), true);
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
      style.sources.ofm = { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: OFM_ATTR };
      style.layers.push(...vectorRoadLayers().filter((l) => opts.labels || l.type !== "symbol"));
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
