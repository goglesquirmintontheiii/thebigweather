// Layers 0.5: more overlay definitions (storm cells, rotation, model tracks, traffic, hazards and
// environment feeds). They are spliced into OVERLAYS next to their group, and the NHC layer gets
// its spinning current-position symbol here. Imported once from App.tsx.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef } from "./defs";
import { settings } from "../store";
import { nhcPrepare, nhcNowLayers, atcfPrepare, atcfLayers, atcfClick, atcfStormOpt } from "./tropical";
import { stormPrepare, stormLayers, stormClick } from "./stormcells";
import { rotationLayers, rotationClick, scanLayers, scanClick } from "./rotation";
import { trafficSource, trafficLayers, incPrepare, incLayers, incClick } from "./traffic";

const font = ["Noto Sans Regular"];
const bold = ["Noto Sans Bold"];
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };
const when = (ms: any) => (ms ? new Date(typeof ms === "number" ? ms : Date.parse(ms)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

// ---------- Severe ----------

const severe: OverlayDef[] = [
  {
    id: "stormattr",
    name: "Storm tracks & attributes",
    group: "Severe",
    refresh: 120,
    options: [
      { key: "show", label: "Cells", choices: [["all", "All"], ["severe", "Rotation or hail"], ["rot", "Rotation only"]], def: "all" },
      { key: "track", label: "Forecast track", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
    ],
    style: { opacity: 1, size: 1, labels: true },
    prepare: (fc) => stormPrepare(fc),
    layers: (s, st, o) => stormLayers(s, st, o),
    click: (p) => stormClick(p)!,
    note: "NEXRAD storm cell tables (all US radars, via IEM). Red ▼ TVS, yellow ring mesocyclone (rank 5+), green ▲ hail (POSH ≥ 50% or ≥ 1 in). Ticks every 15 min to +60 min.",
  },
  {
    id: "rotation",
    name: "Rotation (selected radar)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    options: [{ key: "min", label: "Minimum", choices: [["weak", "Weak"], ["meso", "Meso"], ["tvs", "TVS"]], def: "meso" }],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st, o) => rotationLayers(s, st, o),
    click: (p) => rotationClick(p),
    note: "Velocity couplets found in the selected radar's Level II scan (follows the frame on screen; while animating it updates every few frames). Circles show the couplet's width.",
  },
  {
    id: "rotscan",
    name: "Rotation scan (all US radars)",
    group: "Severe",
    feed: "client",
    refresh: 0,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => scanLayers(s, st),
    click: (p) => scanClick(p),
    note: "Adds two buttons under the header. Tornadic rotation: a TVS, or a mesocyclone of strength rank 10+. Supercells: a mesocyclone (rank 5+) with max reflectivity ≥ 50 dBZ, POSH ≥ 30% or VIL ≥ 40. Rescans every 2 min.",
  },
];

// ---------- Tropical ----------

const tropical: OverlayDef[] = [
  {
    id: "atcf",
    name: "Spaghetti models",
    group: "Tropical",
    refresh: 1800,
    options: [
      { key: "kinds", label: "Models", choices: [["all", "All models"], ["noens", "No ensemble members"], ["main", "Official & consensus"], ["dyn", "Official & dynamical"], ["ens", "Official & ensembles"]], def: "noens" },
      atcfStormOpt,
    ],
    style: { opacity: 1, size: 1.4, labels: true },
    panel: true,
    prepare: (fc) => atcfPrepare(fc),
    layers: (s, st, o) => atcfLayers(s, st, o),
    click: (p) => atcfClick(p),
    note: "Latest run of every model in the NHC a-decks. White = official forecast, pink = consensus, blue = dynamical, yellow dashed = statistical, grey = ensemble members.",
  },
];

// ---------- Hazards ----------

const VOLC: ExpressionSpecification = ["match", ["upcase", ["to-string", ["get", "color"]]], "GREEN", "volc-green", "YELLOW", "volc-yellow", "ORANGE", "volc-orange", "RED", "volc-red", "volc-unassigned"];
const VOLC_COLOR: Record<string, string> = { GREEN: "#22c55e", YELLOW: "#facc15", ORANGE: "#f97316", RED: "#ef4444" };
const hazards: OverlayDef[] = [
  {
    id: "volcanoes",
    name: "Volcanoes (USGS alert levels)",
    group: "Hazards",
    refresh: 1800,
    options: [{ key: "only", label: "Show", choices: [["elev", "Elevated only"], ["all", "All US volcanoes"]], def: "elev" }],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st, o) => {
      const f: any = o.only === "all" ? ["literal", true] : ["in", ["upcase", ["to-string", ["get", "color"]]], ["literal", ["YELLOW", "ORANGE", "RED"]]];
      return [
        { id: `${s}-icon`, type: "symbol", source: s, filter: f, layout: { "icon-image": VOLC, "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.8 * st.size, 8, 1.1 * st.size], "icon-allow-overlap": true, "symbol-sort-key": ["match", ["upcase", ["to-string", ["get", "color"]]], "RED", 0, "ORANGE", 1, "YELLOW", 2, 3] }, paint: { "icon-opacity": st.opacity } } as LayerSpecification,
        ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 5, filter: f, layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 10.5, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true }, paint: halo } as LayerSpecification] : []),
      ];
    },
    click: (p) => ({
      title: p.name,
      sub: `${cap(p.alert ?? "")} · ${cap(p.color ?? "")} aviation code`,
      color: VOLC_COLOR[String(p.color).toUpperCase()] ?? "#9ca3af",
      rows: [["Alert level", cap(p.alert ?? "—")], ["Aviation code", cap(p.color ?? "—")], ["Observatory", p.obs || "—"], ["Updated", when(p.updated)], ...(p.threat ? [["Threat", String(p.threat)] as [string, string]] : []), ...(p.elev ? [["Elevation", `${Math.round(p.elev).toLocaleString()} m`] as [string, string]] : [])],
      link: p.notice_url ? ["Latest notice", p.notice_url] : p.url ? ["Volcano page", p.url] : ["USGS volcanoes", "https://www.usgs.gov/programs/VHP"],
    }),
    note: "USGS Volcano Hazards Program. Aviation color code: green normal, yellow advisory, orange watch, red warning.",
  },
  {
    id: "hmsfire",
    name: "Fire detections (satellite, HMS)",
    group: "Hazards",
    feed: "hms",
    params: { kind: "fire" },
    refresh: 1800,
    style: { opacity: 0.9, size: 1 },
    layers: (s, st) => [
      {
        id: `${s}-pt`,
        type: "circle",
        source: s,
        layout: { "circle-sort-key": ["coalesce", ["get", "frp"], 0] },
        paint: {
          "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 0], 0, "#fbbf24", 50, "#f97316", 300, "#dc2626"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.8 * st.size, 8, 4 * st.size, 11, 6 * st.size],
          "circle-opacity": st.opacity,
          "circle-stroke-color": "rgba(0,0,0,.6)",
          "circle-stroke-width": 0.6,
        },
      } as LayerSpecification,
    ],
    click: (p) => ({ title: "Fire detection", sub: `${p.sat ?? ""}${p.method ? ` · ${p.method}` : ""}`, color: "#f97316", rows: [["Detected", when(p.t)], ["Fire power", p.frp != null ? `${Math.round(p.frp)} MW` : "—"]] }),
    note: "NOAA Hazard Mapping System satellite fire detections for today (UTC).",
  },
];

// ---------- Environment ----------

const DM_COLOR: ExpressionSpecification = ["match", ["to-number", ["get", "dm"], 0], 0, "#ffff00", 1, "#fcd37f", 2, "#ffaa00", 3, "#e60000", 4, "#730000", "#ffff00"];
const DM_NAME = ["Abnormally dry", "Moderate drought", "Severe drought", "Extreme drought", "Exceptional drought"];
const AQI_COLOR: ExpressionSpecification = ["match", ["to-number", ["get", "cat"], 0], 1, "#00e400", 2, "#ffff00", 3, "#ff7e00", 4, "#ff0000", 5, "#8f3f97", 6, "#7e0023", "#9ca3af"];
const AQI_TEXT: ExpressionSpecification = ["match", ["to-number", ["get", "cat"], 0], [1, 2, 3], "#000", "#fff"];
const SVI_THEMES: Record<string, string> = { svi: "Overall", t1: "Socioeconomic", t2: "Household & disability", t3: "Minority & language", t4: "Housing & transportation" };

const environment: OverlayDef[] = [
  {
    id: "drought",
    name: "Drought monitor",
    group: "Environment",
    refresh: 21600,
    style: { opacity: 0.5, size: 0.8 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, layout: { "fill-sort-key": ["to-number", ["get", "dm"], 0] }, paint: { "fill-color": DM_COLOR, "fill-opacity": st.opacity } } as LayerSpecification,
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": DM_COLOR, "line-width": st.size, "line-opacity": Math.min(1, st.opacity + 0.3) } } as LayerSpecification,
    ],
    click: (p) => ({ title: `D${p.dm} · ${DM_NAME[+p.dm] ?? "Drought"}`, sub: `US Drought Monitor · ${p.date ?? ""}`, rows: [], link: ["Drought Monitor", "https://droughtmonitor.unl.edu/"] }),
    note: "US Drought Monitor (weekly, Thursdays): D0 abnormally dry … D4 exceptional.",
  },
  {
    id: "smoke",
    name: "Smoke (satellite, HMS)",
    group: "Environment",
    feed: "hms",
    params: { kind: "smoke" },
    refresh: 1800,
    style: { opacity: 0.6, size: 1 },
    layers: (s, st) => {
      const c: ExpressionSpecification = ["match", ["get", "density"], "Heavy", "#4b5563", "Medium", "#8b939f", "#cfd4da"];
      return [
        { id: `${s}-fill`, type: "fill", source: s, layout: { "fill-sort-key": ["match", ["get", "density"], "Heavy", 2, "Medium", 1, 0] }, paint: { "fill-color": c, "fill-opacity": ["*", st.opacity, ["match", ["get", "density"], "Heavy", 0.75, "Medium", 0.55, 0.38]] } } as LayerSpecification,
        { id: `${s}-line`, type: "line", source: s, paint: { "line-color": c, "line-width": st.size, "line-opacity": 0.7 } } as LayerSpecification,
      ];
    },
    click: (p) => ({ title: `${p.density ?? ""} smoke`, sub: p.sat ?? "HMS analysis", rows: [["From", when(p.t0)], ["Until", when(p.t1)]] }),
    note: "NOAA HMS analyst smoke plumes for today (UTC): light, medium and heavy.",
  },
  {
    id: "airquality",
    name: "Air quality (AQI)",
    group: "Environment",
    refresh: 1800,
    options: [
      { key: "param", label: "Pollutant", choices: [["all", "Any"], ["PM2.5", "PM2.5"], ["OZONE", "Ozone"], ["PM10", "PM10"]], def: "all" },
      { key: "kind", label: "Show", choices: [["obs", "Observed"], ["fcst", "Forecast"]], def: "obs" },
    ],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st, o) => {
      const f: any = ["all", ["==", ["get", "kind"], o.kind === "fcst" ? "fcst" : "obs"], ["has", "aqi"], o.param && o.param !== "all" ? ["==", ["upcase", ["to-string", ["get", "param"]]], o.param] : true];
      return [
        { id: `${s}-pt`, type: "circle", source: s, filter: f, layout: { "circle-sort-key": ["coalesce", ["get", "aqi"], 0] }, paint: { "circle-color": AQI_COLOR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 9 * st.size, 8, 14 * st.size], "circle-opacity": 0.9 * st.opacity, "circle-stroke-color": "rgba(0,0,0,.75)", "circle-stroke-width": 1.2 } } as LayerSpecification,
        ...(st.labels ? [{ id: `${s}-val-text`, type: "symbol", source: s, filter: f, layout: { "text-field": ["to-string", ["round", ["get", "aqi"]]], "text-font": bold, "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9.5, 8, 12.5], "text-allow-overlap": true, "symbol-sort-key": ["-", 0, ["coalesce", ["get", "aqi"], 0]] }, paint: { "text-color": AQI_TEXT } } as LayerSpecification] : []),
      ];
    },
    click: (p) => ({
      title: `AQI ${p.aqi ?? "—"} · ${p.catname || ""}`,
      sub: `${p.area}, ${p.st}`,
      color: ["#9ca3af", "#00e400", "#ffff00", "#ff7e00", "#ff0000", "#8f3f97", "#7e0023"][+p.cat || 0],
      rows: [["Pollutant", p.param ?? "—"], [p.kind === "fcst" ? "Forecast for" : "Observed", p.kind === "fcst" ? p.date : `${p.time || ""} ${p.date ?? ""}`], ...(p.action_day ? [["Action day", "Yes"] as [string, string]] : [])],
      link: ["AirNow", "https://www.airnow.gov/"],
    }),
    note: "AirNow reporting areas: latest hourly AQI or today's forecast (US EPA colors).",
  },
  {
    id: "svi",
    name: "Social vulnerability (CDC SVI)",
    group: "Environment",
    refresh: 86400,
    options: [{ key: "theme", label: "Theme", choices: Object.entries(SVI_THEMES), def: "svi" }],
    style: { opacity: 0.6, size: 0.4 },
    layers: (s, st, o) => {
      const k = SVI_THEMES[o.theme] ? o.theme : "svi";
      return [
        { id: `${s}-fill`, type: "fill", source: s, filter: ["has", k], paint: { "fill-color": ["interpolate", ["linear"], ["get", k], 0, "#ffffcc", 0.25, "#fed976", 0.5, "#fd8d3c", 0.75, "#e31a1c", 1, "#6a0177"], "fill-opacity": st.opacity } } as LayerSpecification,
        { id: `${s}-line`, type: "line", source: s, minzoom: 5, paint: { "line-color": "#000", "line-width": st.size, "line-opacity": 0.35 } } as LayerSpecification,
      ];
    },
    click: (p) => {
      const pct = (v: any) => (v == null ? "—" : `${Math.round(v * 100)}th pct`);
      return { title: `${p.name}, ${p.st}`, sub: `Social vulnerability ${pct(p.svi)}`, rows: [["Overall", pct(p.svi)], ["Socioeconomic", pct(p.t1)], ["Household", pct(p.t2)], ["Minority & language", pct(p.t3)], ["Housing & transport", pct(p.t4)], ["Population", p.pop ? Number(p.pop).toLocaleString() : "—"]], link: ["CDC SVI", "https://www.atsdr.cdc.gov/place-health/php/svi/"] };
    },
    note: "CDC/ATSDR SVI 2022 by county: percentile among US counties (higher = more vulnerable).",
  },
];

// ---------- Traffic ----------

const traffic: OverlayDef[] = [
  {
    id: "traffic",
    name: "Traffic flow (TomTom)",
    group: "Traffic",
    feed: "client",
    refresh: 0,
    key: "tomtom",
    options: [
      { key: "style", label: "Colors", choices: [["relative0-dark", "Relative speed"], ["absolute", "Absolute speed"], ["relative-delay", "Delays only"]], def: "relative0-dark" },
      { key: "inc", label: "Incidents", choices: [["0", "Off"], ["1", "On"]], def: "0" },
    ],
    style: { opacity: 0.85 },
    raster: (o) => trafficSource(o),
    layers: (s, st) => trafficLayers(s, st),
    note: "Needs a TomTom key on the server (Settings → API keys). Incidents show from zoom 9. Drawn under the weather unless 'Draw above weather' is on; tiles refresh every 2 min.",
  },
  {
    id: "trafficinc",
    name: "Traffic incidents",
    group: "Traffic",
    hidden: true,
    path: "/api/traffic/incidents",
    view: "bbox",
    minzoom: 9,
    maxKm2: 10000,
    refresh: 300,
    style: { opacity: 1, size: 1 },
    prepare: (fc) => incPrepare(fc),
    layers: (s, st) => incLayers(s, st),
    click: (p) => incClick(p),
  },
];

/** Insert defs after `afterId` (or after the group's last layer; a new group goes after `anchorGroup`). */
function place(defs: OverlayDef[], afterId?: string, anchorGroup?: string) {
  if (defs.some((d) => overlayDef(d.id))) return; // hot reload: already in
  const last = (g?: string) => OVERLAYS.reduce((a, o, k) => (o.group === g ? k : a), -1);
  let i = afterId ? OVERLAYS.findIndex((o) => o.id === afterId) : -1;
  if (i < 0) i = last(defs[0].group);
  if (i < 0) i = last(anchorGroup);
  if (i < 0) i = OVERLAYS.findIndex((o) => o.group === "Hidden") - 1;
  OVERLAYS.splice(i + 1, 0, ...defs);
}

place(severe, "glm");
place(tropical, "nhc");
place([hazards[0]], undefined, "Hazards");
place([hazards[1]], "fires");
place(environment, undefined, "Hazards");
place(traffic, undefined, "Cameras");

// NHC: spinning symbol at each storm's current position, bigger than the forecast points
const nhc = overlayDef("nhc");
if (nhc && !nhc.prepare) {
  const layers = nhc.layers;
  const click = nhc.click;
  nhc.prepare = (fc) => nhcPrepare(fc);
  nhc.layers = (s, st, o) => [...layers(s, st, o), ...nhcNowLayers(s, st)];
  nhc.click = (p) => {
    const r = click!(p);
    return p._kind === "now" ? { ...r, sub: "Current position" } : r;
  };
}

