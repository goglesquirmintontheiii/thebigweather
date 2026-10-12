// Overlay catalog: what each overlay fetches, how it draws, what it shows when clicked.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { settings } from "../store";

/** set by the satellite module (avoids an import cycle) */
let selectSat: (name: string) => void = () => {};
export function onSelectSat(fn: (name: string) => void) {
  selectSat = fn;
}
/* ---------- raspberry shake (shake.ts registers the click handler) ---------- */
let shakeClick: (p: any) => void = () => {};
export function onShakeClick(fn: (p: any) => void) {
  shakeClick = fn;
}
/* ---------- end raspberry shake ---------- */

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
  kind?: "metar" | "tide" | "camera" | "iss" | "buoy" | "ship" | "waffle" | "flight" | "storm" | "cluster" | "radio";
  props?: any;
  /** accent color in the info panel */
  color?: string;
  /** extra links shown as buttons */
  links?: [string, string][];
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
  /** extra GeoJSON source options (cluster, maxzoom…) */
  source?: Record<string, any>;
  /** area features open in the info panel (with alerts at the same spot) instead of a popup */
  panel?: boolean;
  /** not listed in the Layers panel (toggled from elsewhere) */
  hidden?: boolean;
  /* ---------- layers 0.5 hooks (used by moredefs.ts) ---------- */
  /** transform fetched data before drawing (adds derived features) */
  prepare?: (fc: any, opts: Record<string, string>) => any;
  /** fixed query parameters sent with the feed request */
  params?: Record<string, string>;
  /** fetch from this API path instead of /api/ovl/<feed> */
  path?: string;
  /** a view bbox larger than this (km²) is cut down around the map center */
  maxKm2?: number;
  /** raster tile source (tiles, tileSize…) instead of GeoJSON */
  raster?: (opts: Record<string, string>) => Record<string, any>;
  /* ---------- end layers 0.5 hooks ---------- */
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

const CAT_COLOR: ExpressionSpecification = ["match", ["get", "cat"], "VFR", "#22c55e", "MVFR", "#3b82f6", "IFR", "#ef4444", "LIFR", "#d946ef", "#9ca3af"];
const F = (e: ExpressionSpecification): ExpressionSpecification => (settings.value.units.temp === "F" ? ["+", ["*", e, 1.8], 32] : e);
/** temperature/dewpoint colors, in °C */
const TEMP_COLOR = (k: string): ExpressionSpecification => ["interpolate", ["linear"], ["get", k], -30, "#c084fc", -18, "#818cf8", -7, "#38bdf8", 0, "#22d3ee", 7, "#34d399", 15, "#a3e635", 21, "#facc15", 27, "#fb923c", 32, "#ef4444", 38, "#b91c1c", 43, "#7f1d1d"];

/** METAR station plots: a full plot, or one variable as a big colored value. */
function metarLayers(s: string, st: Style, mode: string): LayerSpecification[] {
  const z = st.size;
  const dot = (color: ExpressionSpecification | string, r: number, filter?: any): LayerSpecification =>
    ({
      id: `${s}-pt`,
      type: "circle",
      source: s,
      ...(filter ? { filter } : {}),
      paint: { "circle-color": color, "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, r * 0.55 * z, 8, r * z], "circle-opacity": st.opacity, "circle-stroke-color": "rgba(0,0,0,.8)", "circle-stroke-width": 1 },
    }) as LayerSpecification;
  const value = (field: ExpressionSpecification, color: ExpressionSpecification | string, filter: any): LayerSpecification =>
    ({
      id: `${s}-val`,
      type: "symbol",
      source: s,
      minzoom: 4,
      filter,
      layout: { "text-field": field, "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11 * z, 9, 15 * z], "text-allow-overlap": false, "text-padding": 1 },
      paint: { "text-color": color, "text-halo-color": "#000", "text-halo-width": 1.6, "text-opacity": st.opacity },
    }) as LayerSpecification;
  const ids = st.labels ? [label(s, ["get", "id"], 8, [0, 1.4], { layout: { "text-size": 9 } })] : [];
  switch (mode) {
    case "temp":
    case "dew": {
      const k = mode === "temp" ? "t" : "td";
      return [dot(TEMP_COLOR(k), 4, ["has", k]), value(["to-string", ["round", F(["get", k])]], TEMP_COLOR(k), ["has", k]), ...ids];
    }
    case "wspd": {
      const c: ExpressionSpecification = ["interpolate", ["linear"], ["coalesce", ["get", "wg"], ["get", "ws"]], 0, "#94a3b8", 10, "#38bdf8", 20, "#22c55e", 30, "#facc15", 40, "#f97316", 55, "#ef4444", 70, "#d946ef"];
      const sp = settings.value.units.speed;
      const conv = sp === "mph" ? 1.15078 : sp === "km/h" ? 1.852 : sp === "m/s" ? 0.514444 : 1;
      return [
        dot(c, 4, ["has", "ws"]),
        value(["concat", ["to-string", ["round", ["*", ["get", "ws"], conv]]], ["case", ["has", "wg"], ["concat", "G", ["to-string", ["round", ["*", ["get", "wg"], conv]]]], ""]], c, ["has", "ws"]),
        ...ids,
      ];
    }
    case "wdir":
      return [
        {
          id: `${s}-arrow`,
          type: "symbol",
          source: s,
          filter: ["all", ["has", "wd"], [">", ["coalesce", ["get", "ws"], 0], 0]],
          // arrows point where the wind blows toward
          layout: { "icon-image": "arrow", "icon-rotate": ["+", ["get", "wd"], 180], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.55 * z, 8, 1 * z] },
          paint: { "icon-color": ["interpolate", ["linear"], ["get", "ws"], 0, "#cbd5e1", 15, "#38bdf8", 30, "#facc15", 50, "#ef4444"], "icon-halo-color": "#000", "icon-halo-width": 1.2, "icon-opacity": st.opacity },
        } as LayerSpecification,
        { ...value(["concat", ["to-string", ["get", "wd"]], "°"], "#e2e8f0", ["has", "wd"]), minzoom: 7, layout: { "text-field": ["concat", ["to-string", ["get", "wd"]], "°"], "text-font": ["Noto Sans Bold"], "text-size": 11 * z, "text-offset": [0, 1.4] } } as LayerSpecification,
        ...ids,
      ];
    case "vis": {
      const c: ExpressionSpecification = ["step", ["get", "vis"], "#d946ef", 1.6, "#ef4444", 4.8, "#3b82f6", 8, "#22c55e"];
      const mi = settings.value.units.distance !== "km";
      return [dot(c, 4, ["has", "vis"]), value(mi ? ["to-string", ["/", ["round", ["*", ["/", ["get", "vis"], 1.609], 10]], 10]] : ["to-string", ["round", ["get", "vis"]]], c, ["has", "vis"]), ...ids];
    }
    case "cat":
      return [dot(CAT_COLOR, 6), ...ids];
    default:
      return [
        dot(CAT_COLOR, 6),
        {
          id: `${s}-barb`,
          type: "symbol",
          source: s,
          minzoom: 5,
          filter: ["has", "ws"],
          layout: { "icon-image": ["concat", "barb-", ["to-string", ["min", 150, ["*", 5, ["round", ["/", ["coalesce", ["get", "ws"], 0], 5]]]]]], "icon-rotate": ["coalesce", ["get", "wd"], 0], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-size": 1.05 * z },
        } as LayerSpecification,
        ...(st.labels
          ? [
              {
                id: `${s}-temp`,
                type: "symbol",
                source: s,
                minzoom: 5,
                filter: ["has", "t"],
                layout: { "text-field": tempLabel(), "text-font": ["Noto Sans Bold"], "text-size": 13 * z, "text-offset": [-1.15, -0.85], "text-allow-overlap": false },
                paint: { "text-color": "#fca5a5", "text-halo-color": "#000", "text-halo-width": 1.5 },
              } as LayerSpecification,
              {
                id: `${s}-dew`,
                type: "symbol",
                source: s,
                minzoom: 6,
                filter: ["has", "td"],
                layout: { "text-field": ["to-string", ["round", F(["get", "td"])]], "text-font": ["Noto Sans Bold"], "text-size": 13 * z, "text-offset": [-1.15, 0.85] },
                paint: { "text-color": "#86efac", "text-halo-color": "#000", "text-halo-width": 1.5 },
              } as LayerSpecification,
              label(s, ["get", "id"], 8, [1.3, 0.2], { layout: { "text-anchor": "left", "text-size": 10 } }),
            ]
          : []),
      ];
  }
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
/** Storm report type → icon kind */
const LSR_KIND: ExpressionSpecification = [
  "case",
  ["in", "FUNNEL", ["upcase", ["get", "typetext"]]], "funnel",
  ["in", "WATERSPOUT", ["upcase", ["get", "typetext"]]], "tornado",
  ["in", "TORNADO", ["upcase", ["get", "typetext"]]], "tornado",
  ["in", "HAIL", ["upcase", ["get", "typetext"]]], "hail",
  ["in", "WND", ["upcase", ["get", "typetext"]]], "wind",
  ["in", "WIND", ["upcase", ["get", "typetext"]]], "wind",
  ["in", "FLOOD", ["upcase", ["get", "typetext"]]], "flood",
  ["in", "RAIN", ["upcase", ["get", "typetext"]]], "rain",
  ["in", "FREEZ", ["upcase", ["get", "typetext"]]], "ice",
  ["in", "ICE", ["upcase", ["get", "typetext"]]], "ice",
  ["in", "SLEET", ["upcase", ["get", "typetext"]]], "ice",
  ["in", "SNOW", ["upcase", ["get", "typetext"]]], "snow",
  ["in", "BLIZZARD", ["upcase", ["get", "typetext"]]], "snow",
  ["in", "LIGHTNING", ["upcase", ["get", "typetext"]]], "lightning",
  "other",
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
    panel: true,
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, paint: { "fill-color": st.color, "fill-opacity": st.opacity * 0.25 } },
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": st.color, "line-width": st.size } },
      { id: `${s}-label`, type: "symbol", source: s, layout: { "text-field": ["concat", "MD ", ["to-string", ["get", "num"]]], "text-font": font, "text-size": 11 }, paint: halo },
    ],
    click: (p) => ({
      title: `Mesoscale Discussion ${p.num}`,
      sub: p.concerning,
      color: "#3b82f6",
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
    panel: true,
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, paint: { "fill-color": "#000", "fill-opacity": 0.001 } },
      {
        id: `${s}-line`,
        type: "line",
        source: s,
        paint: { "line-color": ["case", ["in", "TOR", ["upcase", ["to-string", ["coalesce", ["get", "type"], ["get", "sel"], ""]]]], "#ff1744", "#ffd600"], "line-width": st.size, "line-opacity": st.opacity, "line-dasharray": [3, 1.5] },
      },
    ],
    click: (p) => {
      const tor = String(p.type ?? p.sel ?? "").toUpperCase().includes("TOR");
      const num = p.num ?? p.number ?? "";
      const prob = (k: string, label: string): [string, string][] => (p[k] != null && p[k] !== "" ? [[label, `${p[k]}%`]] : []);
      return {
        title: `${tor ? "Tornado" : "Severe Thunderstorm"} Watch ${num}`,
        sub: p.is_pds ? "Particularly Dangerous Situation" : undefined,
        color: tor ? "#ff1744" : "#ffd600",
        rows: [
          ["Issued", when(p.issue)],
          ["Until", when(p.expire)],
          ...prob("prob_tor", "2+ tornadoes"),
          ...prob("prob_sigtor", "Strong tornado"),
          ...prob("prob_wind", "10+ wind events"),
          ...prob("prob_sigwind", "65+ kt wind"),
          ...prob("prob_hail", "10+ hail events"),
          ...prob("prob_sighail", "2 in+ hail"),
          ...(p.max_hail_size ? [["Max hail", `${p.max_hail_size} in`] as [string, string]] : []),
          ...(p.max_wind_gust_knots ? [["Max gusts", `${p.max_wind_gust_knots} kt`] as [string, string]] : []),
        ],
        link: ["SPC watch page", `https://www.spc.noaa.gov/products/watch/ww${String(num).padStart(4, "0")}.html`],
      };
    },
  },
  {
    id: "lsr",
    name: "Storm reports (LSR)",
    group: "Severe",
    refresh: 120,
    options: [
      { key: "hours", label: "Last", choices: [["1", "1 hour"], ["3", "3 hours"], ["6", "6 hours"], ["12", "12 hours"], ["24", "24 hours"], ["48", "48 hours"], ["72", "72 hours"]], def: "24" },
      { key: "types", label: "Types", choices: [["all", "All reports"], ["tornado,funnel,hail,wind", "Severe only"], ["tornado,funnel", "Tornado & funnel"], ["hail", "Hail"], ["wind", "Wind"], ["flood,rain", "Flood & rain"], ["snow,ice", "Winter"]], def: "all" },
    ],
    style: { opacity: 1, size: 1, labels: false },
    layers: (s, st, o) => [
      {
        id: `${s}-icon`,
        type: "symbol",
        source: s,
        ...(o.types && o.types !== "all" ? { filter: ["in", LSR_KIND, ["literal", o.types.split(",")]] } : {}),
        layout: {
          "icon-image": ["concat", "lsr-", LSR_KIND],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.62 * st.size, 7, 0.95 * st.size, 10, 1.15 * st.size],
          "icon-allow-overlap": true,
          "symbol-sort-key": ["match", LSR_KIND, "tornado", 0, "hail", 2, "wind", 3, 5],
        },
        paint: { "icon-opacity": st.opacity },
      } as LayerSpecification,
      ...(st.labels ? [label(s, ["case", ["has", "mag"], ["concat", ["to-string", ["get", "mag"]], " ", ["coalesce", ["get", "unit"], ""]], ""], 7, [0, 1.3], { layout: { "text-size": 10 } })] : []),
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
    options: [{ key: "minutes", label: "Last", choices: [["5", "5 min"], ["10", "10 min"], ["15", "15 min"], ["20", "20 min"], ["30", "30 min"]], def: "15" }],
    style: { opacity: 1, size: 1 },
    layers: (s, st, o) => {
      const span = (+(o.minutes ?? 15) || 15) * 60;
      return [
        {
          id: `${s}-icon`,
          type: "symbol",
          source: s,
          layout: {
            "icon-image": "bolt",
            "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.45 * st.size, 7, 0.7 * st.size, 10, 0.95 * st.size],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["-", 0, ["get", "age"]],
          },
          paint: {
            // new strikes are white-yellow and fully opaque, then turn orange/red and fade out
            "icon-color": ["interpolate", ["linear"], ["get", "age"], 0, "#ffffff", 60, "#fff59d", span * 0.3, "#ffb300", span * 0.65, "#f4511e", span, "#8d2a1a"],
            "icon-opacity": ["*", st.opacity, ["interpolate", ["linear"], ["get", "age"], 0, 1, span * 0.5, 0.75, span, 0.15]],
            "icon-halo-color": "rgba(0,0,0,.85)",
            "icon-halo-width": 1,
          },
        } as LayerSpecification,
      ];
    },
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
    panel: true,
    click: (p) => {
      let st: any = p._s;
      if (typeof st === "string") {
        try {
          st = JSON.parse(st);
        } catch {
          st = null;
        }
      }
      const kt = (v: any) => (v != null && v !== "" ? `${v} kt (${Math.round(+v * 1.15078)} mph)` : "—");
      const CLASS: Record<string, string> = { HU: "Hurricane", TS: "Tropical Storm", TD: "Tropical Depression", STS: "Subtropical Storm", STD: "Subtropical Depression", PTC: "Post-Tropical Cyclone", PC: "Potential Tropical Cyclone", TC: "Tropical Cyclone" };
      const name = p.stormname ?? st?.name ?? "Tropical cyclone";
      const storm: [string, string][] = st
        ? [
            ["Now", `${CLASS[st.class] ?? st.class ?? ""}`],
            ["Max wind", kt(st.wind)],
            ["Pressure", st.pres ? `${st.pres} mb` : "—"],
            ["Moving", st.mdir != null ? `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(+st.mdir / 22.5) % 16]} at ${st.mspd} mph` : "—"],
            ["Position", st.lat != null ? `${Math.abs(st.lat).toFixed(1)}°${st.lat >= 0 ? "N" : "S"} ${Math.abs(st.lon).toFixed(1)}°${st.lon >= 0 ? "E" : "W"}` : "—"],
            ["Advisory", `${st.advnum ?? p.advisnum ?? "—"}${st.updated ? ` · ${when(st.updated)}` : ""}`],
          ]
        : [];
      const links: [string, string][] = st ? ([["Public advisory", st.adv], ["Forecast discussion", st.disc], ["Graphics", st.graphics], ["Wind probabilities", st.wsp]] as [string, string][]).filter((l) => l[1]) : [];
      const color = "#e11d48";
      if (p._kind === "point")
        return {
          title: `${name} · ${p.datelbl ?? ""}`,
          sub: "Forecast position",
          kind: "storm",
          color,
          rows: [["Forecast wind", kt(p.maxwind)], ["Gusts", kt(p.gust)], ["Pressure", p.mslp && p.mslp < 9000 ? `${p.mslp} mb` : "—"], ["Stage", p.dvlbl ?? p.tcdvlp ?? "—"], ...storm],
          links,
          link: ["NHC", "https://www.nhc.noaa.gov/"],
        };
      const what: Record<string, string> = { cone: "Forecast cone", track: "Forecast track", past: "Past track", ww: "Coastal watch/warning" };
      return {
        title: name,
        sub: p.tcww ? ({ HWA: "Hurricane Watch", HWR: "Hurricane Warning", TWA: "Tropical Storm Watch", TWR: "Tropical Storm Warning" } as any)[p.tcww] : what[p._kind] ?? "",
        kind: "storm",
        color,
        rows: storm.length ? storm : [["Advisory", String(p.advisnum ?? "—")]],
        links,
        link: ["NHC", "https://www.nhc.noaa.gov/"],
      };
    },
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
    options: [
      { key: "src", label: "Show", choices: [["analysis", "Current analysis"], ["day1", "Forecast day 1"], ["day2", "Forecast day 2"], ["day3", "Forecast day 3"]], def: "analysis" },
      { key: "hl", label: "Highs & lows", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
      { key: "pips", label: "Front symbols", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
    ],
    style: { opacity: 1, size: 2.4 },
    layers: (s, st, o) => [
      { id: `${s}-line`, type: "line", source: s, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": FRONT_COLOR, "line-width": st.size, "line-opacity": st.opacity, "line-dasharray": ["match", ["get", "kind"], "trough", ["literal", [3, 2]], "dryline", ["literal", [1, 1.5]], ["literal", [1, 0]]] } },
      {
        id: `${s}-pips`,
        type: "symbol",
        source: s,
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "kind"], ["literal", o.pips === "0" ? [] : ["cold", "warm", "occluded", "stationary"]]]],
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
        filter: ["in", ["get", "kind"], ["literal", o.hl === "0" ? [] : ["high", "low"]]],
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
    options: [
      { key: "mode", label: "Show", choices: [["detailed", "Detailed station plot"], ["temp", "Temperature"], ["dew", "Dewpoint"], ["wdir", "Wind direction"], ["wspd", "Wind speed"], ["vis", "Visibility"], ["cat", "Flight category"]], def: "detailed" },
    ],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st, o) => metarLayers(s, st, o.mode ?? "detailed"),
    click: (p) => ({ title: p.id, sub: p.cat ? `${p.cat}` : undefined, kind: "metar", props: p, rows: [["Temperature", fmtT(p.t)], ["Dewpoint", fmtT(p.td)], ["Wind", p.ws != null ? `${p.wd ?? "VRB"}° ${Math.round(p.ws)} kt${p.wg ? ` G${Math.round(p.wg)}` : ""}` : "—"], ["Visibility", p.vis != null ? `${(p.vis / 1.609).toFixed(1)} mi` : "—"], ["Altimeter", p.alt != null ? `${(p.alt / 33.8639).toFixed(2)} inHg` : "—"], ["Observed", when(p.time)]], text: p.raw }),
  },
  {
    id: "buoys",
    name: "Buoys (NDBC)",
    group: "Surface",
    refresh: 300,
    options: [{ key: "label", label: "Label", choices: [["waves", "Wave height"], ["wind", "Wind"], ["water", "Water temp"], ["air", "Air temp"], ["id", "Station id"]], def: "waves" }],
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st, o) => {
      const F2 = (k: string): ExpressionSpecification => ["case", ["has", k], ["concat", ["to-string", ["round", F(["get", k])]], "°"], ""];
      const field: ExpressionSpecification =
        o.label === "wind"
          ? ["case", ["has", "ws"], ["concat", ["to-string", ["round", ["*", ["get", "ws"], 1.944]]], " kt"], ""]
          : o.label === "water"
            ? F2("wtmp")
            : o.label === "air"
              ? F2("atmp")
              : o.label === "id"
                ? ["to-string", ["get", "id"]]
                : ["case", ["has", "wvht"], ["concat", ["to-string", ["round", ["*", ["get", "wvht"], 3.28084]]], " ft"], ""];
      return [icons(s, "buoy", st.size, { paint: { "icon-opacity": st.opacity } }), ...(st.labels ? [label(s, field, 5, [0, 0.9])] : [])];
    },
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
    options: [{ key: "hazard", label: "Hazard", choices: [["all", "All"], ["CONV", "Convective"], ["TURB", "Turbulence"], ["ICE", "Icing"], ["IFR", "IFR"], ["MT", "Mountain obscuration"], ["ASH", "Volcanic ash"]], def: "all" }],
    style: { opacity: 0.8, size: 1.8 },
    layers: (s, st, o) => {
      const hz: any = o.hazard && o.hazard !== "all" ? ["in", o.hazard, ["upcase", ["to-string", ["get", "hazard"]]]] : true;
      return [
        { id: `${s}-fill`, type: "fill", source: s, filter: ["all", ["==", ["geometry-type"], "Polygon"], hz], paint: { "fill-color": HAZARD_COLOR, "fill-opacity": st.opacity * 0.15 } },
        { id: `${s}-line`, type: "line", source: s, filter: hz === true ? ["literal", true] : hz, paint: { "line-color": HAZARD_COLOR, "line-width": st.size, "line-opacity": st.opacity } },
      ] as LayerSpecification[];
    },
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
    options: [{ key: "types", label: "Show", choices: [["all", "All reports"], ["turb", "Turbulence"], ["ice", "Icing"], ["urgent", "Urgent only"]], def: "all" }],
    style: { opacity: 1, size: 4.5 },
    layers: (s, st, o) => [
      {
        ...points(
        s,
        st,
        ["case", ["==", ["get", "pirepType"], "Urgent PIREP"], "#ef4444", ["has", "tbInt1"], "#f59e0b", ["has", "icgInt1"], "#3b82f6", "#d1d5db"],
        ["case", ["==", ["get", "pirepType"], "Urgent PIREP"], st.size * 1.4, st.size],
        ),
        ...(o.types === "turb" ? { filter: ["has", "tbInt1"] } : o.types === "ice" ? { filter: ["has", "icgInt1"] } : o.types === "urgent" ? { filter: ["==", ["get", "pirepType"], "Urgent PIREP"] } : {}),
      } as LayerSpecification,
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
    options: [
      { key: "ground", label: "On the ground", choices: [["show", "Show"], ["hide", "Hide"]], def: "show" },
      { key: "minalt", label: "Altitude", choices: [["0", "All"], ["10000", "Above 10,000 ft"], ["18000", "Above FL180"], ["30000", "Above FL300"]], def: "0" },
      { key: "trackmin", label: "Clicked plane track", choices: [["all", "Since takeoff"], ["seen", "Since it appeared"]], def: "all" },
    ],
    style: { opacity: 1, size: 0.9, labels: true },
    layers: (s, st, o) => [
      icons(s, "plane", st.size, { layout: { "icon-rotate": ["get", "trk"], "icon-rotation-alignment": "map" }, paint: { "icon-opacity": st.opacity }, filter: ["all", o.ground === "hide" ? ["!=", ["get", "alt"], "ground"] : true, +o.minalt > 0 ? [">=", ["to-number", ["get", "alt"], 0], +o.minalt] : true] }),
      ...(st.labels ? [label(s, ["coalesce", ["get", "cs"], ""], 8, [0, 1.1], { layout: { "text-size": 10 } })] : []),
    ],
    click: (p) => ({
      title: p.cs || p.hex,
      sub: [p.desc || p.type, p.reg, p.own].filter(Boolean).join(" · "),
      kind: "flight",
      props: p,
      rows: [
        ["Altitude", typeof p.alt === "number" ? `${p.alt.toLocaleString()} ft` : p.alt || "—"],
        ["Vertical rate", p.vr != null && p.vr !== "" ? `${p.vr > 0 ? "+" : ""}${p.vr} ft/min` : "—"],
        ["Speed", p.gs != null ? `${Math.round(p.gs)} kt` : "—"],
        ["Heading", `${Math.round(p.trk)}°`],
        ["Squawk", p.sq ?? "—"],
        ...(p.emer && p.emer !== "none" ? [["Emergency", String(p.emer)] as [string, string]] : []),
      ],
      link: ["Track on ADSB.lol", `https://adsb.lol/?icao=${p.hex}`],
    }),
    note: "Aircraft within 250 nm of the map center (zoom in to 5+). Click a plane for its track. Data: airplanes.live / adsb.lol.",
  },

  // ---------------- Cameras ----------------
  {
    id: "cameras",
    name: "Traffic & weather cameras",
    group: "Cameras",
    refresh: 600,
    view: "bbox",
    options: [{ key: "kinds", label: "Show", choices: [["all", "All cameras"], ["img", "Still images"], ["video", "Live video & YouTube"]], def: "all" }],
    style: { opacity: 1, size: 0.85 },
    layers: (s, st) => [
      {
        id: `${s}-cluster`,
        type: "circle",
        source: s,
        filter: ["has", "cl"],
        paint: {
          "circle-color": ["step", ["get", "cl"], "#0e7490", 50, "#0369a1", 300, "#1d4ed8", 1500, "#6d28d9"],
          "circle-radius": ["interpolate", ["linear"], ["get", "cl"], 2, 9, 50, 13, 500, 18, 5000, 26],
          "circle-opacity": 0.85 * st.opacity,
          "circle-stroke-color": "rgba(255,255,255,.75)",
          "circle-stroke-width": 1.2,
        },
      } as LayerSpecification,
      {
        id: `${s}-count`,
        type: "symbol",
        source: s,
        filter: ["has", "cl"],
        layout: { "text-field": ["case", [">=", ["get", "cl"], 1000], ["concat", ["to-string", ["round", ["/", ["get", "cl"], 1000]]], "k"], ["to-string", ["get", "cl"]]], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": "#fff" },
      } as LayerSpecification,
      {
        id: `${s}-icon`,
        type: "symbol",
        source: s,
        filter: ["!", ["has", "cl"]],
        layout: { "icon-image": ["case", ["==", ["get", "k"], "buoy"], "cam-buoy", ["concat", "cam-", ["get", "t"]]], "icon-size": ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.55, 9, st.size], "icon-allow-overlap": ["step", ["zoom"], false, 8, true], "icon-padding": 1 },
        paint: { "icon-opacity": ["case", ["has", "stale"], 0.5 * st.opacity, st.opacity] },
      },
    ],
    click: (p) => (p.cl ? { title: `${p.cl} cameras`, kind: "cluster", props: p } : { title: p.n, sub: [p.sn ?? String(p.s ?? "").replace(/^db:/, ""), p.dir].filter(Boolean).join(" · "), kind: "camera", props: p }),
    note: "Zoom in to see single cameras. Add a camera list file as server/data/uploads/filtereddb.json to merge it in (duplicates of the live sources are left out).",
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
    options: [
      { key: "types", label: "Vessels", choices: [["all", "All"], ["cargo", "Cargo & tankers"], ["passenger", "Passenger"], ["fishing", "Fishing"], ["pleasure", "Sailing & pleasure"], ["service", "Tugs, pilots, SAR, law"]], def: "all" },
      { key: "moving", label: "Moving only", choices: [["0", "No"], ["1", "Yes"]], def: "0" },
    ],
    style: { opacity: 1, size: 0.8, labels: true },
    layers: (s, st, o) => [
      icons(s, "ship", st.size, { layout: { "icon-rotate": ["get", "hdg"], "icon-rotation-alignment": "map" }, paint: { "icon-opacity": st.opacity }, filter: shipFilter(o) }),
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
    options: [
      { key: "iss", label: "ISS", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
      { key: "tiangong", label: "Tiangong", choices: [["1", "Show"], ["0", "Hide"]], def: "0" },
      { key: "hubble", label: "Hubble", choices: [["1", "Show"], ["0", "Hide"]], def: "0" },
      { key: "others", label: "All stations + weather sats", choices: [["0", "Hide"], ["1", "Show"]], def: "0" },
      { key: "ring", label: "Ring around stations", choices: [["small", "Small"], ["foot", "Visibility footprint"], ["off", "Off"]], def: "small" },
      { key: "isstrack", label: "ISS orbit track", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
      { key: "trail", label: "Clicked satellite trail", choices: [["5", "5 min"], ["10", "10 min"], ["20", "20 min"], ["30", "30 min"], ["45", "45 min"], ["60", "1 hour"], ["90", "1 orbit (90 min)"]], def: "20" },
    ],
    style: { color: "#38bdf8", opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      { id: `${s}-foot`, type: "fill", source: s, filter: ["==", ["get", "_kind"], "foot"], paint: { "fill-color": st.color, "fill-opacity": 0.1 * st.opacity } },
      { id: `${s}-footline`, type: "line", source: s, filter: ["==", ["get", "_kind"], "foot"], paint: { "line-color": st.color, "line-width": 1.2, "line-opacity": 0.75 * st.opacity } },
      { id: `${s}-track`, type: "line", source: s, filter: ["==", ["get", "_kind"], "track"], paint: { "line-color": st.color, "line-width": 1.5, "line-opacity": ["case", ["get", "past"], 0.35, 0.9], "line-dasharray": [2, 1.5] } },
      { id: `${s}-trail`, type: "line", source: s, filter: ["==", ["get", "_kind"], "trail"], layout: { "line-cap": "round" }, paint: { "line-color": "#fbbf24", "line-width": 3, "line-opacity": 0.95 } },
      { id: `${s}-ahead`, type: "line", source: s, filter: ["==", ["get", "_kind"], "ahead"], paint: { "line-color": "#fbbf24", "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 2] } },
      icons(s, "satellite", st.size, {
        filter: ["==", ["get", "_kind"], "sat"],
        layout: { "icon-size": ["case", ["get", "station"], st.size, ["get", "sel"], st.size * 0.9, st.size * 0.6], "symbol-sort-key": ["case", ["get", "sel"], 0, ["get", "station"], 1, 2] },
      }),
      ...(st.labels ? [label(s, ["get", "name"], 1, [0, 1.3], { filter: ["all", ["==", ["get", "_kind"], "sat"], ["any", ["get", "station"], ["get", "sel"], [">=", ["zoom"], 5]]] })] : []),
    ],
    click: (p) => {
      selectSat(p.name);
      return { title: p.name, kind: "iss", props: p };
    },
    note: "Positions computed in the app from CelesTrak orbital elements.",
  },
  {
    id: "aurora",
    name: "Aurora forecast",
    group: "Space",
    refresh: 600,
    options: [{ key: "min", label: "Hide below", choices: [["1", "1% chance"], ["5", "5%"], ["10", "10%"], ["30", "30%"]], def: "5" }],
    style: { opacity: 0.9, size: 1 },
    layers: (s, st, o) => [
      {
        id: `${s}-heat`,
        type: "heatmap",
        source: s,
        filter: [">=", ["get", "p"], +(o.min ?? 5)],
        paint: {
          // bright, saturated ramp so it shows on dark maps too
          "heatmap-weight": ["interpolate", ["linear"], ["get", "p"], 0, 0, 10, 0.35, 50, 0.8, 100, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 1, 1.6 * st.size, 5, 2.4 * st.size],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 7, 3, 16, 5, 42, 7, 90],
          "heatmap-opacity": st.opacity,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.08, "rgba(16,185,129,.35)", 0.25, "rgba(52,211,153,.75)", 0.5, "rgba(163,230,53,.9)", 0.75, "rgba(250,204,21,.95)", 1, "rgba(244,63,94,1)"],
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
      { key: "color", label: "Color by", choices: [["mag", "Magnitude"], ["depth", "Depth"], ["age", "Age"]], def: "mag" },
    ],
    style: { opacity: 0.85, size: 1 },
    layers: (s, st, o) => [
      points(
        s,
        st,
        ["interpolate", ["linear"], ["-", ["/", ["number", ["get", "time"], 0], 1], 0], 0, "#f59e0b", 1e15, "#f59e0b"],
        ["*", st.size, ["interpolate", ["linear"], ["get", "mag"], 0, 2, 3, 4, 5, 9, 7, 16, 9, 26]],
        { paint: { "circle-color": o.color === "depth" ? ["interpolate", ["linear"], ["coalesce", ["get", "depth"], 0], 0, "#f43f5e", 35, "#f97316", 70, "#facc15", 150, "#22c55e", 300, "#3b82f6", 700, "#8b5cf6"] : o.color === "age" ? ["interpolate", ["linear"], ["-", Date.now(), ["number", ["get", "time"], 0]], 0, "#ffffff", 3600000, "#facc15", 86400000, "#f97316", 604800000, "#7c2d12"] : ["case", [">", ["get", "mag"], 5.9], "#dc2626", [">", ["get", "mag"], 4.4], "#f97316", "#facc15"], "circle-radius": ["*", st.size, ["interpolate", ["linear"], ["get", "mag"], 0, 2, 3, 4, 5, 9, 7, 16, 9, 26]], "circle-opacity": st.opacity * 0.75, "circle-stroke-color": "#000", "circle-stroke-width": 1 } } as any,
      ),
    ],
    click: (p) => ({ title: `M${Number(p.mag).toFixed(1)} · ${p.place}`, rows: [["Time", when(p.time)], ["Depth", p.depth != null ? `${Number(p.depth).toFixed(0)} km` : "—"], ["Tsunami", p.tsunami ? "Possible — check tsunami.gov" : "No"]], link: ["USGS event page", p.url] }),
  },
  {
    id: "fires",
    name: "Wildfires (perimeters & hotspots)",
    group: "Hazards",
    refresh: 900,
    options: [{ key: "show", label: "Show", choices: [["both", "Perimeters & hotspots"], ["perimeter", "Perimeters"], ["hotspot", "Hotspots"]], def: "both" }],
    style: { color: "#ef4444", opacity: 0.6, size: 3 },
    layers: (s, st, o) => [
      ...(o.show !== "hotspot"
        ? ([
            { id: `${s}-fill`, type: "fill", source: s, filter: ["==", ["get", "_kind"], "perimeter"], paint: { "fill-color": st.color, "fill-opacity": st.opacity * 0.4 } },
            { id: `${s}-line`, type: "line", source: s, filter: ["==", ["get", "_kind"], "perimeter"], paint: { "line-color": st.color, "line-width": 1.5 } },
          ] as LayerSpecification[])
        : []),
      ...(o.show !== "perimeter" ? [{ ...points(s, st, "#ff9800", ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.5, 9, st.size * 1.3]), filter: ["==", ["get", "_kind"], "hotspot"] } as LayerSpecification] : []),
      { id: `${s}-name`, type: "symbol", source: s, minzoom: 6, filter: ["==", ["get", "_kind"], "perimeter"], layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 11 }, paint: halo },
    ],
    click: (p) =>
      p._kind === "perimeter"
        ? { title: `${p.name} fire`, rows: [["Size", p.acres ? `${Math.round(p.acres).toLocaleString()} acres` : "—"], ["Contained", p.contained != null ? `${p.contained}%` : "—"], ["Started", when(p.start)]] }
        : { title: "Fire hotspot", sub: p.src, rows: [["Detected", `${p.date} ${p.time}Z`], ["Radiative power", p.frp ? `${p.frp} MW` : "—"], ["Confidence", p.conf || "—"]] },
    note: "NIFC perimeters and NASA FIRMS VIIRS detections (last 24 h, US).",
  },
  /* ---------- raspberry shake ---------- */
  {
    id: "shake",
    name: "Raspberry Shake seismographs",
    group: "Hazards",
    refresh: 3600,
    style: { color: "#a78bfa", opacity: 1, size: 1, labels: false },
    source: { cluster: true, clusterRadius: 34, clusterMaxZoom: 6 },
    layers: (s, st) => [
      {
        id: `${s}-cl`,
        type: "circle",
        source: s,
        filter: ["has", "point_count"],
        paint: { "circle-color": "rgba(76,29,149,.85)", "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 9, 50, 13, 500, 19], "circle-stroke-color": st.color, "circle-stroke-width": 1.5, "circle-opacity": st.opacity },
      } as LayerSpecification,
      { id: `${s}-count`, type: "symbol", source: s, filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true }, paint: { "text-color": "#fff" } } as LayerSpecification,
      // a ring with a dark core, reads as a sensor
      { id: `${s}-pt`, type: "circle", source: s, filter: ["!", ["has", "point_count"]], paint: { "circle-color": "#1e1033", "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.5 * st.size, 9, 6 * st.size], "circle-stroke-color": st.color, "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 1.5, 9, 2.5], "circle-opacity": st.opacity, "circle-stroke-opacity": st.opacity } } as LayerSpecification,
      ...(st.labels ? [label(s, ["get", "sta"], 7, [0, 1], { filter: ["!", ["has", "point_count"]], layout: { "text-size": 10 } })] : []),
    ],
    click: (p) => {
      shakeClick(p);
      return p.cluster ? { title: `${p.point_count} seismographs` } : { title: p.name || `${p.net}.${p.sta}`, sub: "Raspberry Shake" };
    },
    note: "Citizen seismographs. Click one for its seismogram (data is 30+ min old). Data: Raspberry Shake, not for redistribution.",
  },
  /* ---------- end raspberry shake ---------- */

  // ---------------- Chasers & reports ----------------
  {
    id: "spotters",
    name: "Spotter Network positions",
    group: "Chasers & reports",
    refresh: 60,
    options: [{ key: "streamers", label: "Show", choices: [["0", "All spotters"], ["1", "Live streamers only"]], def: "0" }],
    style: { color: "#22d3ee", opacity: 1, size: 1, labels: false },
    layers: (s, st) => [
      {
        id: `${s}-pt`,
        type: "circle",
        source: s,
        paint: {
          "circle-color": ["case", ["get", "stream"], "#ef4444", ["get", "moving"], st.color, "#94a3b8"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3 * st.size, 9, 5.5 * st.size],
          "circle-stroke-color": "#000",
          "circle-stroke-width": 1,
          "circle-opacity": st.opacity,
        },
      } as LayerSpecification,
      { ...icons(s, "arrow", 0.55 * st.size, { filter: ["get", "moving"], layout: { "icon-rotate": ["get", "hdg"], "icon-rotation-alignment": "map", "icon-offset": [0, -16] }, paint: { "icon-color": st.color, "icon-opacity": st.opacity } }), id: `${s}-dir` } as LayerSpecification,
      ...(st.labels ? [label(s, ["coalesce", ["get", "name"], ""], 8, [0, 1])] : []),
    ],
    click: (p) => ({
      title: p.name || "Spotter",
      sub: p.stream ? "Live streaming" : p.moving ? "Moving" : "Stationary",
      rows: [["Updated", when(p.time)], ...(p.heading ? [["Heading", String(p.heading)] as [string, string]] : []), ...(p.note ? [["Note", String(p.note)] as [string, string]] : [])],
      link: p.web ? ["Website", String(p.web).startsWith("http") ? p.web : `https://${p.web}`] : ["Spotter Network", "https://www.spotternetwork.org/"],
    }),
    note: "Public Spotter Network feed (names left out by default). Personal, non-commercial use; positions older than 48 h are dropped.",
  },
  {
    id: "mping",
    name: "mPING reports",
    group: "Chasers & reports",
    refresh: 120,
    key: "mping",
    options: [{ key: "hours", label: "Last", choices: [["1", "1 hour"], ["2", "2 hours"], ["4", "4 hours"]], def: "2" }],
    style: { opacity: 1, size: 5 },
    layers: (s, st) => [
      points(
        s,
        st,
        ["match", ["get", "cat"], "Rain/Snow", ["case", ["in", "Snow", ["get", "desc"]], "#a5b4fc", ["in", "Freezing", ["get", "desc"]], "#f0abfc", ["in", "Ice", ["get", "desc"]], "#c084fc", "#22c55e"], "Hail", "#16a34a", "Wind Damage", "#3b82f6", "Tornado", "#ef4444", "Flooding", "#0f766e", "Mudslide", "#a16207", "Reduced Visibility", "#9ca3af", "#e5e7eb"],
        ["interpolate", ["linear"], ["zoom"], 3, st.size * 0.6, 9, st.size * 1.2],
      ),
    ],
    click: (p) => ({ title: p.desc || p.cat || "Report", sub: `mPING · ${p.cat ?? ""}`, rows: [["Time", when(p.time)]] }),
    note: "Needs a free mPING key (Settings → API keys). Their license allows the last 4 hours for display.",
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
  // ---------------- not in the layer list ----------------
  {
    id: "nwr",
    name: "Weather radio stations",
    group: "Hidden",
    hidden: true,
    feed: "radiomap",
    refresh: 600,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      points(s, st, "#f59e0b", ["interpolate", ["linear"], ["zoom"], 3, 4, 8, 7]),
      ...(st.labels ? [label(s, ["get", "call"], 5, [0, 1])] : []),
    ],
    click: (p) => ({ title: `${p.call} · ${p.city}, ${p.state}`, sub: "NOAA Weather Radio stream (placed at its city)", kind: "radio", props: p }),
  },
  {
    id: "search",
    name: "Search results",
    group: "Hidden",
    hidden: true,
    feed: "client",
    refresh: 0,
    style: { opacity: 1, size: 1, labels: true },
    layers: (s, st) => [
      points(s, st, "#f472b6", 6),
      ...(st.labels ? [label(s, ["get", "name"], 10, [0, 1.1])] : []),
    ],
    click: (p) => ({
      title: p.name,
      sub: p.kind,
      rows: [...(p.addr ? [["Address", p.addr] as [string, string]] : []), ...(p.hours ? [["Hours", String(p.hours)] as [string, string]] : []), ...(p.phone ? [["Phone", String(p.phone)] as [string, string]] : [])],
      link: p.web ? ["Website", p.web] : ["OpenStreetMap", p.osm],
    }),
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
function shipFilter(o: Record<string, string>): any {
  const t: any = ["to-number", ["get", "type"], 0];
  const rng = (a: number, b: number): any => ["all", [">=", t, a], ["<=", t, b]];
  const parts: any[] = [];
  const types: Record<string, any> = {
    cargo: ["any", rng(70, 89)],
    passenger: rng(60, 69),
    fishing: ["==", t, 30],
    pleasure: ["any", ["==", t, 36], ["==", t, 37]],
    service: ["any", rng(31, 33), rng(50, 55)],
  };
  if (o.types && o.types !== "all") parts.push(types[o.types]);
  if (o.moving === "1") parts.push([">", ["to-number", ["get", "sog"], 0], 0.5]);
  return parts.length ? ["all", ...parts] : ["literal", true];
}

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
