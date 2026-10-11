// Overlay catalog: what each overlay fetches, how it draws, what it shows when clicked.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { settings } from "../store";

export interface Style {
  color: string;
  opacity: number;
  size: number;
  labels: boolean;
}

export interface OptionDef {
  key: string;
  label: string;
  choices: [string, string][];
  def: string;
}

export interface Popup {
  title: string;
  sub?: string;
  rows?: [string, string][];
  link?: [string, string];
  text?: string;
  /** special content handled by the popup component */
  kind?: "metar" | "tide" | "camera" | "iss" | "buoy" | "ship" | "waffle";
  props?: any;
}

export interface OverlayDef {
  id: string;
  name: string;
  group: string;
  /** server feed (default: id); "client" = computed in the app */
  feed?: string | "client";
  refresh: number;
  options?: OptionDef[];
  /** which style controls the config popover offers, with defaults */
  style: Partial<Style>;
  /** refetch when the map moves (data depends on the view) */
  view?: "center" | "bbox";
  minzoom?: number;
  layers: (src: string, st: Style, opts: Record<string, string>) => LayerSpecification[];
  click?: (p: any) => Popup;
  note?: string;
  key?: string;
}

const days = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [String(i + 1), `Day ${i + 1}`]);
const when = (ms: any) => (ms ? new Date(typeof ms === "number" ? ms : Date.parse(ms)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—");
const spcTime = (s: string) => (s && s.length >= 12 ? when(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))) : "—");
const tempLabel = (): ExpressionSpecification =>
  settings.value.units.temp === "F" ? ["to-string", ["round", ["+", ["*", ["get", "t"], 1.8], 32]]] : ["to-string", ["round", ["get", "t"]]];
const fmtT = (c: number | null) => (c == null ? "—" : settings.value.units.temp === "F" ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`);
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };
const font = ["Noto Sans Regular"];

/** Polygons colored by their own fill/stroke properties (outlooks). */
function outlookPolys(src: string, st: Style, extraLine?: LayerSpecification[]): LayerSpecification[] {
  const out: LayerSpecification[] = [
    { id: `${src}-fill`, type: "fill", source: src, filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!", ["to-boolean", ["get", "_cig"]]]], paint: { "fill-color": ["coalesce", ["get", "fill"], st.color], "fill-opacity": st.opacity * 0.45 } },
    { id: `${src}-line`, type: "line", source: src, filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!", ["to-boolean", ["get", "_cig"]]]], paint: { "line-color": ["coalesce", ["get", "stroke"], ["get", "fill"], st.color], "line-width": st.size, "line-opacity": Math.min(1, st.opacity + 0.25) } },
    // conditional-intensity groups (hatched area on SPC graphics): dashed black outline
    { id: `${src}-cig`, type: "line", source: src, filter: ["to-boolean", ["get", "_cig"]], paint: { "line-color": "#000", "line-width": st.size + 0.5, "line-dasharray": [2, 1.5], "line-opacity": 0.85 } },
    ...(extraLine ?? []),
  ];
  if (st.labels)
    out.push({
      id: `${src}-label`,
      type: "symbol",
      source: src,
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: { "text-field": ["coalesce", ["get", "label"], ["get", "label2"], ""], "text-font": font, "text-size": 11, "symbol-placement": "point" },
      paint: halo,
    });
  return out;
}

function points(src: string, st: Style, color: ExpressionSpecification | string, radius: ExpressionSpecification | number, extra: Partial<LayerSpecification> = {}): LayerSpecification {
  return {
    id: `${src}-pt`,
    type: "circle",
    source: src,
    paint: { "circle-color": color, "circle-radius": radius, "circle-opacity": st.opacity, "circle-stroke-color": "rgba(0,0,0,.7)", "circle-stroke-width": 1 },
    ...(extra as any),
  } as LayerSpecification;
}

function icons(src: string, image: ExpressionSpecification | string, size: number, extra: any = {}): LayerSpecification {
  return {
    id: `${src}-icon`,
    type: "symbol",
    source: src,
    layout: { "icon-image": image, "icon-size": size, "icon-allow-overlap": true, "icon-ignore-placement": true, ...(extra.layout ?? {}) },
    paint: { ...(extra.paint ?? {}) },
    ...(extra.filter ? { filter: extra.filter } : {}),
    ...(extra.minzoom ? { minzoom: extra.minzoom } : {}),
  } as LayerSpecification;
}

function label(src: string, field: ExpressionSpecification, minzoom = 6, offset: [number, number] = [0, 1.2], extra: any = {}): LayerSpecification {
  return {
    id: `${src}-text`,
    type: "symbol",
    source: src,
    minzoom,
    layout: { "text-field": field, "text-font": font, "text-size": 11, "text-offset": offset, "text-anchor": "top", "text-optional": true, ...(extra.layout ?? {}) },
    paint: { ...halo, ...(extra.paint ?? {}) },
    ...(extra.filter ? { filter: extra.filter } : {}),
  } as LayerSpecification;
}

const LSR_COLOR: ExpressionSpecification = [
  "case",
  ["in", "TORNADO", ["upcase", ["get", "typetext"]]], "#ef4444",
  ["in", "FUNNEL", ["upcase", ["get", "typetext"]]], "#f87171",
  ["in", "HAIL", ["upcase", ["get", "typetext"]]], "#22c55e",
  ["in", "WIND", ["upcase", ["get", "typetext"]]], "#3b82f6",
  ["in", "WND", ["upcase", ["get", "typetext"]]], "#3b82f6",
  ["in", "FLOOD", ["upcase", ["get", "typetext"]]], "#15803d",
  ["in", "SNOW", ["upcase", ["get", "typetext"]]], "#a5b4fc",
  ["in", "ICE", ["upcase", ["get", "typetext"]]], "#c084fc",
  ["in", "FREEZING", ["upcase", ["get", "typetext"]]], "#c084fc",
  "#9ca3af",
];
const LSR_LETTER: ExpressionSpecification = [
  "case",
  ["in", "TORNADO", ["upcase", ["get", "typetext"]]], "T",
  ["in", "HAIL", ["upcase", ["get", "typetext"]]], "H",
  ["in", "WIND", ["upcase", ["get", "typetext"]]], "W",
  ["in", "WND", ["upcase", ["get", "typetext"]]], "W",
  ["in", "FLOOD", ["upcase", ["get", "typetext"]]], "F",
  ["in", "SNOW", ["upcase", ["get", "typetext"]]], "S",
  "",
];

const HAZARD_COLOR: ExpressionSpecification = [
  "case",
  ["in", "CONV", ["upcase", ["to-string", ["get", "hazard"]]]], "#ef4444",
  ["in", "TURB", ["upcase", ["to-string", ["get", "hazard"]]]], "#f59e0b",
  ["in", "ICE", ["upcase", ["to-string", ["get", "hazard"]]]], "#3b82f6",
  ["in", "FZLVL", ["upcase", ["to-string", ["get", "hazard"]]]], "#60a5fa",
  ["in", "IFR", ["upcase", ["to-string", ["get", "hazard"]]]], "#a855f7",
  ["in", "MT", ["upcase", ["to-string", ["get", "hazard"]]]], "#a16207",
  ["in", "ASH", ["upcase", ["to-string", ["get", "hazard"]]]], "#6b7280",
  ["in", "WIND", ["upcase", ["to-string", ["get", "hazard"]]]], "#14b8a6",
  ["in", "LLWS", ["upcase", ["to-string", ["get", "hazard"]]]], "#14b8a6",
  "#e5e7eb",
];

const FRONT_COLOR: ExpressionSpecification = ["match", ["get", "kind"], "cold", "#2563eb", "warm", "#dc2626", "occluded", "#9333ea", "stationary", "#dc2626", "trough", "#a16207", "dryline", "#d97706", "#999"];

export const OVERLAYS: OverlayDef[] = [
  // ---------------- Severe ----------------
  {
    id: "spc",
    name: "SPC convective outlook",
    group: "Severe",
    refresh: 300,
    options: [
      { key: "day", label: "Day", choices: days(8), def: "1" },
      { key: "kind", label: "Type", choices: [["cat", "Categorical"], ["torn", "Tornado"], ["wind", "Wind"], ["hail", "Hail"], ["prob", "Probability (day 3+)"]], def: "cat" },
    ],
    style: { opacity: 0.6, size: 1.6, labels: false, color: "#888888" },
    layers: (s, st) => outlookPolys(s, st),
    click: (p) => ({ title: p.label2 || p.label || "SPC outlook", rows: [["Valid", spcTime(p.valid)], ["Until", spcTime(p.expire)]], link: ["Open SPC outlooks", "https://www.spc.noaa.gov/products/outlook/"] }),
  },
  {
    id: "mcd",
    name: "Mesoscale discussions",
    group: "Severe",
    refresh: 60,
    style: { color: "#3b82f6", opacity: 0.5, size: 2.2 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, paint: { "fill-color": st.color, "fill-opacity": st.opacity * 0.25 } },
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": st.color, "line-width": st.size } },
      { id: `${s}-label`, type: "symbol", source: s, layout: { "text-field": ["concat", "MD ", ["to-string", ["get", "num"]]], "text-font": font, "text-size": 11 }, paint: halo },
    ],
    click: (p) => ({
      title: `Mesoscale Discussion ${p.num}`,
      sub: p.concerning,
      rows: [["Issued", when(p.issue)], ["Until", when(p.expire)], ["Watch chance", p.watch_confidence != null ? `${p.watch_confidence}%` : "—"]],
      link: ["Read the discussion", `https://www.spc.noaa.gov/products/md/md${String(p.num).padStart(4, "0")}.html`],
    }),
  },
  {
    id: "watchbox",
    name: "Watch outlines",
    group: "Severe",
    refresh: 60,
    style: { opacity: 0.9, size: 2.5 },
    layers: (s, st) => [
      {
        id: `${s}-line`,
        type: "line",
        source: s,
        paint: { "line-color": ["case", ["in", "TOR", ["upcase", ["to-string", ["coalesce", ["get", "type"], ["get", "sel"], ""]]]], "#ff1744", "#ffd600"], "line-width": st.size, "line-opacity": st.opacity, "line-dasharray": [3, 1.5] },
      },
    ],
    click: (p) => ({ title: `${String(p.type ?? "").includes("TOR") ? "Tornado" : "Severe Thunderstorm"} Watch ${p.num ?? ""}`, rows: [["Issued", when(p.issue)], ["Until", when(p.expire)]], link: ["SPC watch page", `https://www.spc.noaa.gov/products/watch/ww${String(p.num ?? "").padStart(4, "0")}.html`] }),
  },
  {
    id: "lsr",
    name: "Storm reports (LSR)",
    group: "Severe",
    refresh: 120,
    options: [{ key: "hours", label: "Last", choices: [["1", "1 hour"], ["3", "3 hours"], ["6", "6 hours"], ["12", "12 hours"], ["24", "24 hours"], ["48", "48 hours"], ["72", "72 hours"]], def: "24" }],
    style: { opacity: 0.95, size: 6, labels: true },
    layers: (s, st) => [
      points(s, st, LSR_COLOR, st.size),
      ...(st.labels ? [{ id: `${s}-letter`, type: "symbol", source: s, layout: { "text-field": LSR_LETTER, "text-font": ["Noto Sans Bold"], "text-size": st.size * 1.5, "text-allow-overlap": true }, paint: { "text-color": "#fff" } } as LayerSpecification] : []),
    ],
    click: (p) => ({
      title: `${p.typetext}${p.mag != null && p.mag !== "" ? ` · ${p.mag} ${p.unit ?? ""}` : ""}`,
      sub: [p.city, p.county && `${p.county} Co.`, p.st].filter(Boolean).join(", "),
      rows: [["Time", when(p.valid)], ["Source", p.source ?? "—"], ["Office", p.wfo ?? "—"]],
      text: p.remark,
    }),
  },
  {
    id: "glm",
    name: "Lightning (GOES GLM)",
    group: "Severe",
    refresh: 20,
    options: [{ key: "minutes", label: "Last", choices: [["5", "5 min"], ["10", "10 min"], ["15", "15 min"], ["30", "30 min"]], def: "15" }],
    style: { opacity: 0.95, size: 3.5 },
    layers: (s, st) => [
      points(s, st, ["interpolate", ["linear"], ["get", "age"], 0, "#ffffff", 120, "#fff59d", 300, "#ffb300", 900, "#f4511e", 1800, "#8d2a1a"], ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.6, 8, st.size * 1.4], { paint: { "circle-color": ["interpolate", ["linear"], ["get", "age"], 0, "#ffffff", 120, "#fff59d", 300, "#ffb300", 900, "#f4511e", 1800, "#8d2a1a"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.6, 8, st.size * 1.4], "circle-opacity": st.opacity, "circle-stroke-width": 0 } } as any),
    ],
    click: (p) => ({ title: "Lightning flash", rows: [["Age", `${Math.round(p.age / 60)} min`], ["Energy", p.e ? `${Number(p.e).toFixed(0)} fJ` : "—"]] }),
    note: "GOES-19 and GOES-18 flashes, updated every 20 s.",
  },

  // ---------------- Tropical ----------------
  {
    id: "nhc",
    name: "Hurricanes · cones & tracks",
    group: "Tropical",
    refresh: 300,
    style: { opacity: 0.9, size: 2 },
    layers: (s, st) => [
      { id: `${s}-cone`, type: "fill", source: s, filter: ["==", ["get", "_kind"], "cone"], paint: { "fill-color": "#ffffff", "fill-opacity": 0.18 * st.opacity } },
      { id: `${s}-coneline`, type: "line", source: s, filter: ["==", ["get", "_kind"], "cone"], paint: { "line-color": "#ffffff", "line-width": 1.2, "line-opacity": st.opacity } },
      { id: `${s}-ww`, type: "line", source: s, filter: ["==", ["get", "_kind"], "ww"], paint: { "line-color": ["coalesce", ["get", "stroke"], "#ff0000"], "line-width": st.size * 2.5 } },
      { id: `${s}-past`, type: "line", source: s, filter: ["==", ["get", "_kind"], "past"], paint: { "line-color": "#d1d5db", "line-width": st.size, "line-dasharray": [1, 1] } },
      { id: `${s}-track`, type: "line", source: s, filter: ["==", ["get", "_kind"], "track"], paint: { "line-color": "#111", "line-width": st.size } },
      {
        id: `${s}-icon`,
        type: "symbol",
        source: s,
        filter: ["==", ["get", "_kind"], "point"],
        layout: { "icon-image": ["match", ["get", "dvlbl"], ["H", "M"], "tc-h", "tc-s"], "icon-size": 0.8, "icon-allow-overlap": true, "text-field": st.labels !== false ? ["get", "datelbl"] : "", "text-font": font, "text-size": 10, "text-offset": [0, 1.4], "text-anchor": "top", "text-optional": true },
        paint: halo,
      },
    ],
    click: (p) =>
      p._kind === "point"
        ? { title: `${p.stormname ?? ""} · ${p.datelbl ?? ""}`, rows: [["Max wind", p.maxwind ? `${p.maxwind} kt` : "—"], ["Gusts", p.gust ? `${p.gust} kt` : "—"], ["Pressure", p.mslp && p.mslp < 9000 ? `${p.mslp} mb` : "—"], ["Type", p.dvlbl ?? "—"]], link: ["NHC", "https://www.nhc.noaa.gov/"] }
        : { title: `${p.stormname ?? "Tropical cyclone"}`, sub: p.tcww ? ({ HWA: "Hurricane Watch", HWR: "Hurricane Warning", TWA: "Tropical Storm Watch", TWR: "Tropical Storm Warning" } as any)[p.tcww] : `Advisory ${p.advisnum ?? ""}`, link: ["NHC", "https://www.nhc.noaa.gov/"] },
  },
  {
    id: "gtwo",
    name: "Tropical outlook (7-day)",
    group: "Tropical",
    refresh: 600,
    style: { opacity: 0.6, size: 2 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": ["get", "fill"], "fill-opacity": st.opacity * 0.35 } },
      { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": ["get", "stroke"], "line-width": st.size } },
      { id: `${s}-x`, type: "symbol", source: s, filter: ["==", ["geometry-type"], "Point"], layout: { "text-field": "X", "text-font": ["Noto Sans Bold"], "text-size": 20, "text-allow-overlap": true }, paint: { "text-color": ["get", "fill"], "text-halo-color": "#000", "text-halo-width": 1.5 } },
    ],
    click: (p) => ({ title: "Tropical development area", sub: p.basin, rows: [["2-day chance", `${p.prob2day ?? "—"} (${p.risk2day ?? ""})`], ["7-day chance", `${p.prob7day ?? "—"} (${p.risk7day ?? ""})`]], link: ["NHC outlook", "https://www.nhc.noaa.gov/gtwo.php"] }),
  },
  {
    id: "recon",
    name: "Recon flights (Hurricane Hunters)",
    group: "Tropical",
    refresh: 60,
    style: { color: "#fb923c", opacity: 1, size: 2 },
    layers: (s, st) => [
      { id: `${s}-track`, type: "line", source: s, filter: ["==", ["get", "_kind"], "track"], paint: { "line-color": st.color, "line-width": st.size, "line-opacity": st.opacity } },
      icons(s, "plane", 1, { filter: ["==", ["get", "_kind"], "plane"] }),
    ],
    click: (p) => ({ title: `${p.aircraft} · ${p.storm || "recon"}`, rows: [["Last report", when(p.time)], ["Flight-level wind", p.wind != null ? `${p.wind} kt` : "—"], ["SFMR surface wind", p.sfmr != null ? `${p.sfmr} kt` : "—"], ["Peak flight-level", p.maxwind ? `${p.maxwind} kt` : "—"], ["Peak SFMR", p.maxsfmr ? `${p.maxsfmr} kt` : "—"], ["Lowest extrap. pressure", p.minp ? `${p.minp.toFixed(1)} mb` : "—"]], link: ["NHC recon", "https://www.nhc.noaa.gov/recon.php"] }),
    note: "Tracks build up while this overlay is on (NHC sends 10-minute messages).",
  },

  // ---------------- Outlooks ----------------
  {
    id: "ero",
    name: "Excessive rainfall (WPC)",
    group: "Outlooks",
    refresh: 600,
    options: [{ key: "day", label: "Day", choices: days(5), def: "1" }],
    style: { opacity: 0.55, size: 1.6, labels: false },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#888" }),
    click: (p) => ({ title: p.outlook || p.label2 || "Excessive rainfall", rows: [["Valid", p.valid_time ?? "—"], ["Issued", p.issue_time ?? "—"]], link: ["WPC ERO", "https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php"] }),
  },
  {
    id: "wssi",
    name: "Winter storm severity (WSSI)",
    group: "Outlooks",
    refresh: 900,
    options: [{ key: "day", label: "When", choices: [["1", "Day 1"], ["2", "Day 2"], ["3", "Day 3"], ["13", "Days 1–3"]], def: "1" }],
    style: { opacity: 0.5, size: 1.2, labels: false },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#888" }),
    click: (p) => ({ title: p.label2 ?? "Winter impacts", link: ["WPC WSSI", "https://www.wpc.ncep.noaa.gov/wwd/wssi/wssi.php"] }),
  },
  {
    id: "spcfire",
    name: "Fire weather outlook (SPC)",
    group: "Outlooks",
    refresh: 600,
    options: [
      { key: "day", label: "Day", choices: days(8), def: "1" },
      { key: "kind", label: "Type", choices: [["windrh", "Wind & low humidity"], ["dryt", "Dry thunderstorms"]], def: "windrh" },
    ],
    style: { opacity: 0.5, size: 1.6, labels: false },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#e69800" }),
    click: (p) => ({ title: p.label2 ?? "Fire weather", link: ["SPC fire weather", "https://www.spc.noaa.gov/products/fire_wx/"] }),
  },
  {
    id: "cpc",
    name: "CPC temperature / precip outlook",
    group: "Outlooks",
    refresh: 3600,
    options: [
      { key: "period", label: "Period", choices: [["610", "6–10 day"], ["814", "8–14 day"], ["month", "Monthly"], ["season", "Seasonal"]], def: "610" },
      { key: "var", label: "Field", choices: [["temp", "Temperature"], ["precip", "Precipitation"]], def: "temp" },
    ],
    style: { opacity: 0.45, size: 0.8, labels: false },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#888" }),
    click: (p) => ({ title: p.label2, rows: [["Period", `${p.start_date ?? ""} – ${p.end_date ?? ""}`]], link: ["CPC outlooks", "https://www.cpc.ncep.noaa.gov/products/predictions/"] }),
  },
  {
    id: "cpchaz",
    name: "CPC hazards outlook",
    group: "Outlooks",
    refresh: 3600,
    options: [{ key: "period", label: "Period", choices: [["37", "3–7 day"], ["814", "8–14 day"]], def: "37" }],
    style: { opacity: 0.4, size: 1.2, labels: true },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#888" }),
    click: (p) => ({ title: p.label ?? "Hazard", rows: [["From", p.start_date ?? "—"], ["To", p.end_date ?? "—"]], link: ["CPC hazards", "https://www.cpc.ncep.noaa.gov/products/predictions/threats/threats.php"] }),
  },
  {
    id: "riverflood",
    name: "Significant river flood outlook",
    group: "Outlooks",
    refresh: 1800,
    style: { opacity: 0.45, size: 1.4 },
    layers: (s, st) => outlookPolys(s, { ...st, color: "#2e7d32" }),
    click: (p) => ({ title: p.label2 ?? "River flood outlook", link: ["WPC", "https://www.wpc.ncep.noaa.gov/nationalfloodoutlook/"] }),
  },

  // ---------------- Surface ----------------
  {
    id: "fronts",
    name: "Surface fronts & pressure centers",
    group: "Surface",
    refresh: 900,
    options: [{ key: "src", label: "Show", choices: [["analysis", "Current analysis"], ["day1", "Forecast day 1"], ["day2", "Forecast day 2"], ["day3", "Forecast day 3"]], def: "analysis" }],
    style: { opacity: 1, size: 2.4 },
    layers: (s, st) => [
      { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": FRONT_COLOR, "line-width": st.size, "line-opacity": st.opacity, "line-dasharray": ["match", ["get", "kind"], "trough", ["literal", [3, 2]], "dryline", ["literal", [1, 1.5]], ["literal", [1, 0]]] } },
      {
        id: `${s}-pips`,
        type: "symbol",
        source: s,
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "kind"], ["literal", ["cold", "warm", "occluded", "stationary"]]]],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 46,
          "icon-image": ["match", ["get", "kind"], "cold", "pip-cold", "warm", "pip-warm", "occluded", "pip-occl", "pip-cold"],
          "icon-size": st.size / 2.4,
          "icon-allow-overlap": true,
          "icon-rotation-alignment": "map",
        },
        paint: { "icon-opacity": st.opacity },
      },
      {
        id: `${s}-hl`,
        type: "symbol",
        source: s,
        filter: ["in", ["get", "kind"], ["literal", ["high", "low"]]],
        layout: { "text-field": ["format", ["match", ["get", "kind"], "high", "H", "L"], { "font-scale": 1.6 }, "\n", {}, ["to-string", ["coalesce", ["get", "pres"], ""]], { "font-scale": 0.8 }], "text-font": ["Noto Sans Bold"], "text-size": 14, "text-allow-overlap": true },
        paint: { "text-color": ["match", ["get", "kind"], "high", "#3b82f6", "#ef4444"], "text-halo-color": "#fff", "text-halo-width": 1.5 },
      },
    ],
    click: (p) => ({ title: p.kind === "high" ? "High pressure" : p.kind === "low" ? "Low pressure" : `${String(p.kind).replace(/^\w/, (c: string) => c.toUpperCase())} front`, rows: p.pres ? [["Pressure", `${p.pres} mb`]] : p.strength ? [["Strength", p.strength]] : [] }),
  },
  {
    id: "metar",
    name: "METARs (station plots)",
    group: "Surface",
    refresh: 120,
    style: { opacity: 1, size: 4, labels: true },
    layers: (s, st) => [
      points(s, st, ["match", ["get", "cat"], "VFR", "#22c55e", "MVFR", "#3b82f6", "IFR", "#ef4444", "LIFR", "#d946ef", "#9ca3af"], ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.5, 8, st.size]),
      {
        id: `${s}-barb`,
        type: "symbol",
        source: s,
        minzoom: 6,
        filter: ["has", "ws"],
        layout: { "icon-image": ["concat", "barb-", ["to-string", ["min", 150, ["*", 5, ["round", ["/", ["coalesce", ["get", "ws"], 0], 5]]]]]], "icon-rotate": ["coalesce", ["get", "wd"], 0], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-size": 0.8 },
      },
      ...(st.labels
        ? [
            {
              id: `${s}-temp`,
              type: "symbol",
              source: s,
              minzoom: 6,
              filter: ["has", "t"],
              layout: { "text-field": tempLabel(), "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [-1.1, -0.8], "text-allow-overlap": false },
              paint: { "text-color": "#fca5a5", "text-halo-color": "#000", "text-halo-width": 1.3 },
            } as LayerSpecification,
            {
              id: `${s}-dew`,
              type: "symbol",
              source: s,
              minzoom: 7,
              filter: ["has", "td"],
              layout: { "text-field": settings.value.units.temp === "F" ? ["to-string", ["round", ["+", ["*", ["get", "td"], 1.8], 32]]] : ["to-string", ["round", ["get", "td"]]], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [-1.1, 0.8] },
              paint: { "text-color": "#86efac", "text-halo-color": "#000", "text-halo-width": 1.3 },
            } as LayerSpecification,
            label(s, ["get", "id"], 8, [1.2, 0.2], { layout: { "text-anchor": "left", "text-size": 9 } }),
          ]
        : []),
    ],
    click: (p) => ({ title: p.id, sub: p.cat ? `${p.cat}` : undefined, kind: "metar", props: p, rows: [["Temperature", fmtT(p.t)], ["Dewpoint", fmtT(p.td)], ["Wind", p.ws != null ? `${p.wd ?? "VRB"}° ${Math.round(p.ws)} kt${p.wg ? ` G${Math.round(p.wg)}` : ""}` : "—"], ["Visibility", p.vis != null ? `${(p.vis / 1.609).toFixed(1)} mi` : "—"], ["Altimeter", p.alt != null ? `${(p.alt / 33.8639).toFixed(2)} inHg` : "—"], ["Observed", when(p.time)]], text: p.raw }),
  },
  {
    id: "buoys",
    name: "Buoys (NDBC)",
    group: "Surface",
    refresh: 300,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      icons(s, "buoy", st.size, { paint: { "icon-opacity": st.opacity } }),
      ...(st.labels ? [label(s, ["case", ["has", "wvht"], ["concat", ["to-string", ["round", ["*", ["get", "wvht"], 3.28084]]], " ft"], ""], 5, [0, 0.9])] : []),
    ],
    click: (p) => ({
      title: `Buoy ${p.id}`,
      kind: "buoy",
      props: p,
      rows: [
        ["Wind", p.ws != null ? `${p.wd ?? "—"}° ${Math.round(p.ws * 1.944)} kt${p.wg ? ` G${Math.round(p.wg * 1.944)}` : ""}` : "—"],
        ["Waves", p.wvht != null ? `${(p.wvht * 3.28084).toFixed(1)} ft @ ${p.dpd ?? "—"} s` : "—"],
        ["Pressure", p.pres != null ? `${p.pres} mb` : "—"],
        ["Air / water", `${fmtT(p.atmp)} / ${fmtT(p.wtmp)}`],
        ["Observed", when(p.time)],
      ],
      link: ["NDBC station page", `https://www.ndbc.noaa.gov/station_page.php?station=${p.id}`],
    }),
  },
  {
    id: "tides",
    name: "Tide stations",
    group: "Surface",
    refresh: 86400,
    minzoom: 5,
    style: { opacity: 1, size: 0.9, labels: false },
    layers: (s, st) => [icons(s, "tide", st.size, { paint: { "icon-opacity": st.opacity } }), ...(st.labels ? [label(s, ["get", "name"], 8)] : [])],
    click: (p) => ({ title: p.name, sub: `NOAA tide station ${p.id}`, kind: "tide", props: p, link: ["Tides & Currents", `https://tidesandcurrents.noaa.gov/stationhome.html?id=${p.id}`] }),
  },
  {
    id: "gauges",
    name: "River gauges",
    group: "Surface",
    refresh: 900,
    options: [{ key: "only", label: "Show", choices: [["flood", "Flooding & action only"], ["all", "All gauges"]], def: "flood" }],
    style: { opacity: 1, size: 5 },
    layers: (s, st, o) => [
      {
        ...points(s, st, ["match", ["get", "cat"], "action", "#facc15", "minor", "#f97316", "moderate", "#ef4444", "major", "#a855f7", "no_flooding", "#22c55e", "#9ca3af"], ["match", ["get", "cat"], ["minor", "moderate", "major"], st.size * 1.3, st.size * 0.8]),
        ...(o.only !== "all" ? { filter: ["in", ["get", "cat"], ["literal", ["action", "minor", "moderate", "major"]]] } : {}),
      } as LayerSpecification,
    ],
    click: (p) => ({ title: p.name, sub: `${p.id}${p.wfo ? ` · NWS ${p.wfo}` : ""}`, rows: [["Now", `${String(p.cat ?? "—").replace(/_/g, " ")}`], ["Forecast", `${String(p.fcat ?? "—").replace(/_/g, " ")}`], ["Stage", p.stage != null ? `${p.stage} ${p.unit ?? ""}` : "—"], ["Flow", p.flow != null ? `${p.flow} ${p.funit ?? ""}` : "—"], ["Updated", when(p.time)]], link: ["NWS hydrograph", `https://water.noaa.gov/gauges/${String(p.id).toLowerCase()}`] }),
  },
  {
    id: "wfo",
    name: "NWS offices",
    group: "Surface",
    refresh: 86400,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => [icons(s, "office", st.size, { paint: { "icon-opacity": st.opacity } }), ...(st.labels ? [label(s, ["get", "sid"], 5, [0, 1])] : [])],
    click: (p) => ({ title: `NWS ${p.sname ?? p.sid}`, sub: p.sid, link: ["Office page", `https://www.weather.gov/${String(p.sid).toLowerCase()}`] }),
  },

  // ---------------- Aviation ----------------
  {
    id: "sigmet",
    name: "SIGMETs & AIRMETs",
    group: "Aviation",
    refresh: 120,
    style: { opacity: 0.8, size: 1.8 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": HAZARD_COLOR, "fill-opacity": st.opacity * 0.15 } },
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": HAZARD_COLOR, "line-width": st.size, "line-opacity": st.opacity } },
    ],
    click: (p) => ({ title: `${p.airSigmetType ?? "SIGMET"} · ${p.hazard ?? ""}`, sub: p.firName ?? p.icaoId, rows: [["Valid", when(p.validTimeFrom)], ["Until", when(p.validTimeTo)], ["Altitude", p.altitudeHi1 || p.top ? `${p.altitudeLow1 ?? p.base ?? "SFC"} – ${p.altitudeHi1 ?? p.top} ft` : "—"]], text: p.rawAirSigmet ?? p.rawSigmet }),
  },
  {
    id: "gairmet",
    name: "G-AIRMETs",
    group: "Aviation",
    refresh: 600,
    options: [
      { key: "type", label: "Type", choices: [["sierra", "IFR & mountain obscuration"], ["tango", "Turbulence & wind"], ["zulu", "Icing & freezing level"]], def: "sierra" },
      { key: "fcst", label: "Forecast", choices: [["0", "Now"], ["3", "+3 h"], ["6", "+6 h"], ["9", "+9 h"], ["12", "+12 h"]], def: "0" },
    ],
    style: { opacity: 0.8, size: 1.6 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": HAZARD_COLOR, "fill-opacity": st.opacity * 0.12 } },
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": HAZARD_COLOR, "line-width": st.size, "line-opacity": st.opacity, "line-dasharray": [2, 1] } },
    ],
    click: (p) => ({ title: `G-AIRMET · ${p.hazard}`, rows: [["Valid", when(p.validTime)], ["Level", p.level ?? "—"]] }),
  },
  {
    id: "pirep",
    name: "PIREPs",
    group: "Aviation",
    refresh: 120,
    style: { opacity: 1, size: 4.5 },
    layers: (s, st) => [
      points(
        s,
        st,
        ["case", ["==", ["get", "pirepType"], "Urgent PIREP"], "#ef4444", ["has", "tbInt1"], "#f59e0b", ["has", "icgInt1"], "#3b82f6", "#d1d5db"],
        ["case", ["==", ["get", "pirepType"], "Urgent PIREP"], st.size * 1.4, st.size],
      ),
    ],
    click: (p) => ({ title: `${p.pirepType ?? "PIREP"} · ${p.acType ?? ""}`, rows: [["Time", when(p.obsTime ? p.obsTime * 1000 : p.receiptTime)], ["Level", p.fltLvl ? `FL${p.fltLvl}` : "—"], ["Turbulence", [p.tbInt1, p.tbType1].filter(Boolean).join(" ") || "—"], ["Icing", [p.icgInt1, p.icgType1].filter(Boolean).join(" ") || "—"]], text: p.rawOb }),
  },
  {
    id: "airports",
    name: "Airports",
    group: "Aviation",
    refresh: 86400 * 7,
    options: [{ key: "all", label: "Include", choices: [["0", "Large & medium"], ["1", "All incl. small"]], def: "0" }],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      { ...icons(s, "airport", st.size, { paint: { "icon-opacity": st.opacity } }), filter: ["any", [">=", ["get", "size"], 3], [">=", ["zoom"], 6]] } as LayerSpecification,
      ...(st.labels ? [label(s, ["get", "id"], 7, [0, 0.9])] : []),
    ],
    click: (p) => ({ title: p.name, sub: [p.id, p.iata].filter(Boolean).join(" · "), kind: "metar", props: { id: p.id }, rows: [["City", p.city || "—"], ["Elevation", p.elev != null ? `${p.elev} ft` : "—"]] }),
  },
  {
    id: "flights",
    name: "Flights (ADS-B)",
    group: "Aviation",
    refresh: 10,
    view: "center",
    minzoom: 5,
    style: { opacity: 1, size: 0.9, labels: true },
    layers: (s, st) => [
      icons(s, "plane", st.size, { layout: { "icon-rotate": ["get", "trk"], "icon-rotation-alignment": "map" }, paint: { "icon-opacity": st.opacity } }),
      ...(st.labels ? [label(s, ["coalesce", ["get", "cs"], ""], 8, [0, 1.1], { layout: { "text-size": 10 } })] : []),
    ],
    click: (p) => ({ title: p.cs || p.hex, sub: [p.type, p.reg].filter(Boolean).join(" · "), rows: [["Altitude", typeof p.alt === "number" ? `${p.alt.toLocaleString()} ft` : p.alt || "—"], ["Speed", p.gs != null ? `${Math.round(p.gs)} kt` : "—"], ["Track", `${Math.round(p.trk)}°`], ["Squawk", p.sq ?? "—"]], link: ["Track on ADSB.lol", `https://adsb.lol/?icao=${p.hex}`] }),
    note: "Aircraft within 250 nm of the map center (zoom in to 5+). Data: airplanes.live / adsb.lol.",
  },

  // ---------------- Cameras ----------------
  {
    id: "cameras",
    name: "Traffic & weather cameras",
    group: "Cameras",
    refresh: 1800,
    style: { opacity: 1, size: 0.85 },
    layers: (s, st) => [
      {
        id: `${s}-icon`,
        type: "symbol",
        source: s,
        layout: { "icon-image": ["case", ["==", ["get", "k"], "buoy"], "cam-buoy", ["concat", "cam-", ["get", "t"]]], "icon-size": ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.55, 9, st.size], "icon-allow-overlap": ["step", ["zoom"], false, 8, true], "icon-padding": 1 },
        paint: { "icon-opacity": st.opacity },
      },
    ],
    click: (p) => ({ title: p.n, sub: p.sn, kind: "camera", props: p }),
  },
  {
    id: "mycams",
    name: "My cameras & streams",
    group: "Cameras",
    feed: "client",
    refresh: 0,
    style: { opacity: 1, size: 1 },
    layers: (s, st) => [icons(s, ["concat", "cam-", ["get", "t"]], st.size, { paint: { "icon-opacity": st.opacity } })],
    click: (p) => ({ title: p.n, sub: "My camera", kind: "camera", props: p }),
    note: "Right-click the map → Add camera here (YouTube, HLS, image or web page URL).",
  },

  // ---------------- Marine ----------------
  {
    id: "ships",
    name: "Ships (AIS)",
    group: "Marine",
    refresh: 30,
    view: "bbox",
    minzoom: 4,
    style: { opacity: 1, size: 0.8, labels: true },
    layers: (s, st) => [
      icons(s, "ship", st.size, { layout: { "icon-rotate": ["get", "hdg"], "icon-rotation-alignment": "map" }, paint: { "icon-opacity": st.opacity } }),
      ...(st.labels ? [label(s, ["get", "name"], 9, [0, 1], { layout: { "text-size": 10 } })] : []),
    ],
    click: (p) => ({ title: p.name || `MMSI ${p.mmsi}`, sub: shipType(p.type), kind: "ship", props: p, rows: [["Speed", `${p.sog} kt`], ["Course", `${p.cog}°`], ["Destination", p.dest || "—"], ["MMSI", String(p.mmsi)], ["Updated", when(p.t)], ["Source", p.src]] }),
    note: "Keyless: Finland (Digitraffic) and Norway (Kystverket). Add an aisstream.io key in Settings for worldwide ships.",
  },

  // ---------------- Space ----------------
  {
    id: "iss",
    name: "ISS & space stations",
    group: "Space",
    feed: "client",
    refresh: 0,
    options: [{ key: "set", label: "Show", choices: [["iss", "ISS"], ["stations", "ISS, Tiangong, Hubble"], ["weather", "Stations + weather satellites"]], def: "iss" }],
    style: { color: "#38bdf8", opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      { id: `${s}-foot`, type: "fill", source: s, filter: ["==", ["get", "_kind"], "foot"], paint: { "fill-color": st.color, "fill-opacity": 0.08 * st.opacity } },
      { id: `${s}-footline`, type: "line", source: s, filter: ["==", ["get", "_kind"], "foot"], paint: { "line-color": st.color, "line-width": 1, "line-opacity": 0.6 * st.opacity } },
      { id: `${s}-track`, type: "line", source: s, filter: ["==", ["get", "_kind"], "track"], paint: { "line-color": st.color, "line-width": 1.5, "line-opacity": ["case", ["get", "past"], 0.35, 0.9], "line-dasharray": [2, 1.5] } },
      icons(s, "satellite", st.size, { filter: ["==", ["get", "_kind"], "sat"] }),
      ...(st.labels ? [label(s, ["get", "name"], 1, [0, 1.3], { filter: ["==", ["get", "_kind"], "sat"] })] : []),
    ],
    click: (p) => ({ title: p.name, kind: "iss", props: p }),
    note: "Positions computed in the app from CelesTrak orbital elements.",
  },
  {
    id: "aurora",
    name: "Aurora forecast",
    group: "Space",
    refresh: 600,
    style: { opacity: 0.7 },
    layers: (s, st) => [
      {
        id: `${s}-heat`,
        type: "heatmap",
        source: s,
        paint: {
          "heatmap-weight": ["/", ["get", "p"], 100],
          "heatmap-intensity": 1,
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 6, 5, 40],
          "heatmap-opacity": st.opacity,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "rgba(34,197,94,.4)", 0.5, "rgba(132,204,22,.7)", 0.8, "rgba(250,204,21,.85)", 1, "rgba(239,68,68,.9)"],
        },
      },
    ],
    note: "NOAA SWPC OVATION, next ~30–90 minutes.",
  },

  // ---------------- Hazards ----------------
  {
    id: "quakes",
    name: "Earthquakes",
    group: "Hazards",
    refresh: 120,
    options: [
      { key: "period", label: "Period", choices: [["hour", "Past hour"], ["day", "Past day"], ["week", "Past week"], ["month", "Past month"]], def: "day" },
      { key: "mag", label: "Magnitude", choices: [["all", "All"], ["1.0", "1.0+"], ["2.5", "2.5+"], ["4.5", "4.5+"], ["significant", "Significant"]], def: "2.5" },
    ],
    style: { opacity: 0.85, size: 1 },
    layers: (s, st) => [
      points(
        s,
        st,
        ["interpolate", ["linear"], ["-", ["/", ["number", ["get", "time"], 0], 1], 0], 0, "#f59e0b", 1e15, "#f59e0b"],
        ["*", st.size, ["interpolate", ["linear"], ["get", "mag"], 0, 2, 3, 4, 5, 9, 7, 16, 9, 26]],
        { paint: { "circle-color": ["case", [">", ["get", "mag"], 5.9], "#dc2626", [">", ["get", "mag"], 4.4], "#f97316", "#facc15"], "circle-radius": ["*", st.size, ["interpolate", ["linear"], ["get", "mag"], 0, 2, 3, 4, 5, 9, 7, 16, 9, 26]], "circle-opacity": st.opacity * 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } } as any,
      ),
    ],
    click: (p) => ({ title: `M${Number(p.mag).toFixed(1)} · ${p.place}`, rows: [["Time", when(p.time)], ["Depth", p.depth != null ? `${Number(p.depth).toFixed(0)} km` : "—"], ["Tsunami", p.tsunami ? "Possible — check tsunami.gov" : "No"]], link: ["USGS event page", p.url] }),
  },
  {
    id: "fires",
    name: "Wildfires (perimeters & hotspots)",
    group: "Hazards",
    refresh: 900,
    style: { color: "#ef4444", opacity: 0.6, size: 3 },
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["get", "_kind"], "perimeter"], paint: { "fill-color": st.color, "fill-opacity": st.opacity * 0.4 } },
      { id: `${s}-line`, type: "line", source: s, filter: ["==", ["get", "_kind"], "perimeter"], paint: { "line-color": st.color, "line-width": 1.5 } },
      { ...points(s, st, "#ff9800", ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.5, 9, st.size * 1.3]), filter: ["==", ["get", "_kind"], "hotspot"] } as LayerSpecification,
      { id: `${s}-name`, type: "symbol", source: s, minzoom: 6, filter: ["==", ["get", "_kind"], "perimeter"], layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 11 }, paint: halo },
    ],
    click: (p) =>
      p._kind === "perimeter"
        ? { title: `${p.name} fire`, rows: [["Size", p.acres ? `${Math.round(p.acres).toLocaleString()} acres` : "—"], ["Contained", p.contained != null ? `${p.contained}%` : "—"], ["Started", when(p.start)]] }
        : { title: "Fire hotspot", sub: p.src, rows: [["Detected", `${p.date} ${p.time}Z`], ["Radiative power", p.frp ? `${p.frp} MW` : "—"], ["Confidence", p.conf || "—"]] },
    note: "NIFC perimeters and NASA FIRMS VIIRS detections (last 24 h, US).",
  },

  // ---------------- Fun ----------------
  {
    id: "waffle",
    name: "Waffle House Index",
    group: "Fun",
    refresh: 86400,
    options: [{ key: "status", label: "Store status", choices: [["off", "Off (locations only)"], ["on", "Check locator (in view)"]], def: "off" }],
    style: { opacity: 1, size: 1 },
    layers: (s, st) => [
      { ...points(s, st, ["match", ["get", "_st"], "closed", "#ef4444", "limited", "#facc15", "open", "#22c55e", "rgba(0,0,0,0)"], 9), filter: ["has", "_st"] } as LayerSpecification,
      icons(s, "waffle", st.size, { paint: { "icon-opacity": st.opacity } }),
    ],
    click: (p) => ({ title: "Waffle House", sub: [p.addr, p.city, p.state].filter(Boolean).join(", "), kind: "waffle", props: p, rows: [["Hours", p.hours || "—"], ["Status", p._st ?? "not checked"]] }),
    note: "Locations from OpenStreetMap. Status (off by default) checks the official locator pages for closure notices — best effort.",
  },
];

export function overlayDef(id: string) {
  return OVERLAYS.find((o) => o.id === id);
}

const SHIP_TYPES: [number, number, string][] = [
  [20, 29, "Wing in ground"],
  [30, 30, "Fishing"],
  [31, 32, "Towing"],
  [33, 33, "Dredging"],
  [35, 35, "Military"],
  [36, 36, "Sailing"],
  [37, 37, "Pleasure craft"],
  [40, 49, "High-speed craft"],
  [50, 50, "Pilot"],
  [51, 51, "Search & rescue"],
  [52, 52, "Tug"],
  [55, 55, "Law enforcement"],
  [60, 69, "Passenger"],
  [70, 79, "Cargo"],
  [80, 89, "Tanker"],
];
export function shipType(t: number) {
  return SHIP_TYPES.find(([a, b]) => t >= a && t <= b)?.[2] ?? (t ? `Type ${t}` : "Vessel");
}

/** Style for an overlay: defaults merged with the user's overrides. */
export function styleFor(d: OverlayDef): Style {
  const o = settings.value.ovl[d.id] ?? {};
  return {
    color: o.color ?? d.style.color ?? "#3b82f6",
    opacity: o.opacity ?? d.style.opacity ?? 1,
    size: o.size ?? d.style.size ?? 1,
    labels: o.labels ?? d.style.labels ?? true,
  };
}

export function optsFor(d: OverlayDef): Record<string, string> {
  const o = settings.value.ovl[d.id]?.opts ?? {};
  const out: Record<string, string> = {};
  for (const op of d.options ?? []) out[op.key] = o[op.key] ?? op.def;
  return out;
}
