// data 0.6: forecast & data overlays — NWS damage surveys, SPC tornado history, NHC wind-speed
// probabilities, storm surge / arrival of winds, NWM high flow, road conditions and personal
// weather stations. Spliced into OVERLAYS next to their groups (like moredefs.ts). Imported once
// from App.tsx.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef, type Style } from "./defs";
import { settings } from "../store";
import { api } from "../api";
import { barbIcon } from "../grid/contours";
import { ovlStatus, popup } from "./manager";

const font = ["Noto Sans Regular"];
const bold = ["Noto Sans Bold"];
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };
const when = (ms: any) => (ms ? new Date(typeof ms === "number" ? ms : /^\d+$/.test(String(ms)) ? +ms : Date.parse(ms)).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—");
const day = (v: any) => {
  if (!v) return "—";
  const t = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? +v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : String(v);
};
const LINE: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
const POLY: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];

function arcgis(service: string, q: string) {
  const tok = api.token ? `&token=${encodeURIComponent(api.token)}` : "";
  return { tiles: [`${api.base}/api/arcgis/${service}/{z}/{x}/{y}?${q}${tok}`], tileSize: 256, maxzoom: 12, attribution: "NOAA/NWS" };
}
const rasterLayer = (s: string, st: { opacity: number }): LayerSpecification[] => [{ id: `${s}-r`, type: "raster", source: s, paint: { "raster-opacity": st.opacity, "raster-fade-duration": 0 } } as LayerSpecification];

// ---------- EF scale ----------

export const EF_COLORS = ["#9ca3af", "#60a5fa", "#22c55e", "#facc15", "#f97316", "#ef4444", "#d946ef"]; // EFU, EF0…EF5
/** "EF2", "EF-2", 2, "F3", "EFU" → -1 (unknown) … 5 */
export function efNum(v: any): number {
  if (v == null || v === "") return -1;
  if (typeof v === "number") return Math.max(-1, Math.min(5, Math.round(v)));
  const m = String(v).toUpperCase().match(/(\d)/);
  return m ? Math.min(5, +m[1]) : -1;
}
const efName = (n: number) => (n < 0 ? "EFU" : `EF${n}`);
const EF: ExpressionSpecification = ["match", ["to-number", ["get", "_ef"], -1], 0, EF_COLORS[1], 1, EF_COLORS[2], 2, EF_COLORS[3], 3, EF_COLORS[4], 4, EF_COLORS[5], 5, EF_COLORS[6], EF_COLORS[0]];
const efPrep = (fc: any, key: string) => ({
  ...fc,
  features: (fc?.features ?? []).map((f: any) => ({ ...f, properties: { ...f.properties, _ef: efNum(f.properties?.[key]) } })),
});

// ---------- Severe: damage surveys + tornado history ----------

const severe: OverlayDef[] = [
  {
    id: "dat",
    name: "Damage surveys (NWS DAT)",
    group: "Severe",
    refresh: 1800,
    view: "bbox",
    options: [{ key: "days", label: "Surveyed in", choices: [["7", "Last 7 days"], ["30", "Last 30 days"], ["365", "Last year"], ["all", "All"]], def: "30" }],
    style: { opacity: 0.9, size: 1, labels: true },
    prepare: (fc) => efPrep(fc, "efscale"),
    layers: (s, st) => [
      { id: `${s}-swath`, type: "fill", source: s, filter: POLY, paint: { "fill-color": EF, "fill-opacity": st.opacity * 0.35 } } as LayerSpecification,
      { id: `${s}-swline`, type: "line", source: s, filter: POLY, paint: { "line-color": EF, "line-width": 1, "line-opacity": st.opacity } } as LayerSpecification,
      { id: `${s}-case`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 4.5 * st.size, 9, 7.5 * st.size, 12, 10 * st.size], "line-opacity": 0.7 * st.opacity } } as LayerSpecification,
      { id: `${s}-track`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": EF, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.8 * st.size, 9, 5 * st.size, 12, 7 * st.size], "line-opacity": st.opacity } } as LayerSpecification,
      {
        id: `${s}-pt`,
        type: "circle",
        source: s,
        filter: POINT,
        minzoom: 6,
        layout: { "circle-sort-key": ["get", "_ef"] },
        paint: { "circle-color": EF, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5 * st.size, 12, 6 * st.size], "circle-opacity": st.opacity, "circle-stroke-color": "#000", "circle-stroke-width": 0.8 },
      } as LayerSpecification,
      ...(st.labels ? [{ id: `${s}-label`, type: "symbol", source: s, filter: LINE, minzoom: 7, layout: { "symbol-placement": "line-center", "text-field": ["match", ["to-number", ["get", "_ef"], -1], -1, "EFU", ["concat", "EF", ["to-string", ["get", "_ef"]]]], "text-font": bold, "text-size": 11 }, paint: halo } as LayerSpecification] : []),
    ],
    click: (p) => {
      const n = efNum(p.efscale ?? p._ef);
      const kind = p.kind === "point" ? "Damage point" : p.kind === "swath" ? "Damage swath" : "Tornado track";
      return {
        title: `${kind} · ${efName(n)}`,
        sub: `NWS ${p.wfo ?? ""} survey`,
        color: EF_COLORS[n + 1],
        rows: [
          ["Event", day(p.event_date)],
          ["Surveyed", day(p.survey_date)],
          ["Rating", efName(n)],
          ...(p.wind_mph != null && p.wind_mph !== "" ? [["Est. wind", `${Math.round(+p.wind_mph)} mph`] as [string, string]] : []),
          ...(p.len_mi ? [["Length", `${(+p.len_mi).toFixed(1)} mi`] as [string, string]] : []),
          ...(p.wid_yd ? [["Width", `${Math.round(+p.wid_yd)} yd`] as [string, string]] : []),
        ],
        text: p.comments || undefined,
        link: ["Damage Assessment Toolkit", "https://apps.dat.noaa.gov/stormdamage/damageviewer/"],
      };
    },
    note: "NWS Damage Assessment Toolkit: surveyed tornado tracks, damage points and swaths, colored by EF rating (grey EFU, blue EF0 … magenta EF5).",
  },
  {
    id: "tornadohist",
    name: "Tornado history (SPC 1950–2024)",
    group: "Severe",
    refresh: 0,
    view: "bbox",
    minzoom: 4,
    options: [
      { key: "from", label: "From", choices: ["1950", "1960", "1970", "1980", "1990", "2000", "2010", "2015", "2020", "2022", "2023", "2024"].map((y) => [y, y]), def: "2000" },
      { key: "to", label: "To", choices: ["2024", "2023", "2022", "2020", "2015", "2010", "2000", "1990", "1980", "1970"].map((y) => [y, y]), def: "2024" },
      { key: "minmag", label: "Rating", choices: [["0", "All (F/EF0+)"], ["1", "EF1+"], ["2", "EF2+"], ["3", "EF3+ (strong)"], ["4", "EF4+ (violent)"]], def: "1" },
    ],
    style: { opacity: 0.7, size: 1, labels: false },
    prepare: (fc) => efPrep(fc, "mag"),
    layers: (s, st) => [
      { id: `${s}-case`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-sort-key": ["get", "_ef"] }, paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 4, ["+", 1.5, ["*", 0.5, ["get", "_ef"]]], 10, ["+", 4, ["get", "_ef"]]], "line-opacity": 0.5 * st.opacity } } as LayerSpecification,
      { id: `${s}-track`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-sort-key": ["get", "_ef"] }, paint: { "line-color": EF, "line-width": ["interpolate", ["linear"], ["zoom"], 4, ["*", st.size, ["+", 0.8, ["*", 0.4, ["get", "_ef"]]]], 10, ["*", st.size, ["+", 2, ["*", 0.8, ["get", "_ef"]]]]], "line-opacity": st.opacity } } as LayerSpecification,
      // touchdown points for tracks without a length
      { id: `${s}-pt`, type: "circle", source: s, filter: POINT, paint: { "circle-color": EF, "circle-radius": 3 * st.size, "circle-opacity": st.opacity, "circle-stroke-color": "#000", "circle-stroke-width": 0.6 } } as LayerSpecification,
      ...(st.labels ? [{ id: `${s}-label`, type: "symbol", source: s, filter: LINE, minzoom: 8, layout: { "symbol-placement": "line-center", "text-field": ["to-string", ["get", "date"]], "text-font": font, "text-size": 10 }, paint: halo } as LayerSpecification] : []),
    ],
    click: (p) => {
      const n = efNum(p.mag);
      const yr = String(p.date ?? "").slice(0, 4);
      return {
        title: `${+yr && +yr < 2007 ? "F" : "EF"}${n < 0 ? "U" : n} tornado · ${day(p.date)}`,
        sub: `SPC tornado database${p.st ? ` · ${p.st}` : ""}`,
        color: EF_COLORS[n + 1],
        rows: [
          ["Length", p.len_mi != null ? `${(+p.len_mi).toFixed(1)} mi` : "—"],
          ["Width", p.wid_yd != null ? `${Math.round(+p.wid_yd)} yd` : "—"],
          ["Injuries", String(p.inj ?? 0)],
          ["Fatalities", String(p.fat ?? 0)],
        ],
        link: ["SPC severe weather database", "https://www.spc.noaa.gov/wcm/"],
      };
    },
    note: "SPC tornado tracks (start to end point), colored by (E)F rating. Zoom 4+. The years pick the range.",
  },
];

// ---------- Tropical ----------

// NHC wind-speed probability ramp (5% … 90%)
const WSP_COLOR: ExpressionSpecification = ["step", ["to-number", ["get", "prob"], 0], "#0f5e1f", 10, "#18862f", 20, "#4cae3f", 30, "#9ccf2b", 40, "#f2e30c", 50, "#f2b705", 60, "#f07a05", 70, "#e41b14", 80, "#a50f15", 90, "#8b2fb6"];
const tropical: OverlayDef[] = [
  {
    id: "nhcwsp",
    name: "Wind-speed probabilities (NHC)",
    group: "Tropical",
    refresh: 1800,
    options: [{ key: "kt", label: "Winds of", choices: [["34", "34 kt (tropical storm)"], ["50", "50 kt"], ["64", "64 kt (hurricane)"]], def: "34" }],
    style: { opacity: 0.55, size: 0.6, labels: true },
    prepare: (fc) => ({ ...fc, features: [...(fc?.features ?? [])].sort((a: any, b: any) => (+a.properties?.prob || 0) - (+b.properties?.prob || 0)) }),
    layers: (s, st) => [
      { id: `${s}-fill`, type: "fill", source: s, layout: { "fill-sort-key": ["to-number", ["get", "prob"], 0] }, paint: { "fill-color": WSP_COLOR, "fill-opacity": st.opacity } } as LayerSpecification,
      { id: `${s}-line`, type: "line", source: s, paint: { "line-color": WSP_COLOR, "line-width": st.size, "line-opacity": Math.min(1, st.opacity + 0.3) } } as LayerSpecification,
      ...(st.labels ? [{ id: `${s}-label`, type: "symbol", source: s, minzoom: 4, layout: { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "prob"]], "%"], "text-font": bold, "text-size": 10.5, "symbol-spacing": 300 }, paint: halo } as LayerSpecification] : []),
    ],
    click: (p) => ({ title: `${p.prob}% chance`, sub: `Winds of ${settings.value.ovl.nhcwsp?.opts?.kt ?? "34"} kt or more, next 5 days`, rows: [], color: "#f2b705", link: ["NHC wind-speed probabilities", "https://www.nhc.noaa.gov/"] }),
    note: "Chance of sustained winds of at least 34, 50 or 64 kt at any time in the next 5 days (NHC, Atlantic and East Pacific).",
  },
  {
    id: "surge",
    name: "Peak storm surge (NHC)",
    group: "Tropical",
    feed: "client",
    refresh: 0,
    style: { opacity: 0.75 },
    raster: () => arcgis("surge", ""),
    layers: (s, st) => rasterLayer(s, st),
    note: "Potential storm surge flooding (feet above ground) when a surge watch or warning is in effect. Blue < 3 ft, yellow > 3 ft, orange > 6 ft, red > 9 ft.",
  },
  {
    id: "arrival",
    name: "Arrival of tropical-storm winds",
    group: "Tropical",
    feed: "client",
    refresh: 0,
    options: [{ key: "kind", label: "Show", choices: [["likely", "Most likely arrival"], ["earliest", "Earliest reasonable"]], def: "likely" }],
    style: { opacity: 0.7 },
    raster: (o) => arcgis("arrival", `kind=${o.kind || "likely"}`),
    layers: (s, st) => rasterLayer(s, st),
    note: "When 39 mph winds may first arrive (NHC), in 6–12 h bands.",
  },
];

// ---------- Flooding ----------

const flooding: OverlayDef[] = [
  {
    id: "nwm",
    name: "High flow (National Water Model)",
    group: "Precipitation & winter",
    feed: "client",
    refresh: 0,
    options: [{ key: "range", label: "Forecast", choices: [["short", "Short range (18 h)"], ["medium", "Medium range (10 days)"]], def: "short" }],
    style: { opacity: 0.9 },
    raster: (o) => arcgis("nwm", `range=${o.range || "short"}`),
    layers: (s, st) => rasterLayer(s, st),
    note: "Streams forecast to run high (NOAA National Water Model). Yellow/orange/red/purple = higher flow percentiles. MRMS FLASH layers are in the weather layer picker → Water.",
  },
];

// ---------- Roads ----------

const ROAD_COLORS: Record<string, string> = { dry: "#22c55e", wet: "#3b82f6", snow: "#e5e7eb", ice: "#d946ef", closed: "#ef4444", other: "#f59e0b", unknown: "#6b7280" };
const ROAD_NAMES: Record<string, string> = { dry: "Dry / clear", wet: "Wet", snow: "Snow covered", ice: "Icy", closed: "Closed", other: "Partly covered / slushy", unknown: "Unknown" };
/** state 511 wording → a small set of classes */
export function roadClass(cond: any, desc?: any): string {
  const s = `${cond ?? ""} ${desc ?? ""}`.toLowerCase();
  if (/clos|impass|no travel/.test(s)) return "closed";
  if (/ice|icy|glaze|freezing|black/.test(s)) return "ice";
  if (/slush|patch|partly|partial|spots|drift|mixed/.test(s)) return "other";
  if (/snow|cover|packed/.test(s)) return "snow";
  if (/wet|rain|moist|water|flood/.test(s)) return "wet";
  if (/dry|clear|good|normal|seasonal/.test(s)) return "dry";
  return "unknown";
}
const RC: ExpressionSpecification = ["match", ["get", "_c"], ...Object.entries(ROAD_COLORS).flat(), "#6b7280"] as any;
const roads: OverlayDef[] = [
  {
    id: "roadcond",
    name: "Road conditions (511)",
    group: "Traffic",
    refresh: 900,
    view: "bbox",
    minzoom: 5,
    options: [{ key: "hide", label: "Show", choices: [["all", "All reports"], ["bad", "Only snow, ice, closed"]], def: "all" }],
    style: { opacity: 0.95, size: 1, labels: false },
    prepare: (fc, o) => {
      const feats = (fc?.features ?? [])
        .map((f: any) => ({ ...f, properties: { ...f.properties, _c: roadClass(f.properties?.cond, f.properties?.desc) } }))
        .filter((f: any) => o.hide !== "bad" || ["snow", "ice", "closed", "other"].includes(f.properties._c));
      return { ...fc, features: feats };
    },
    layers: (s, st) => [
      { id: `${s}-case`, type: "line", source: s, filter: LINE, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3 * st.size, 12, 8 * st.size], "line-opacity": 0.55 * st.opacity } } as LayerSpecification,
      {
        id: `${s}-line`,
        type: "line",
        source: s,
        filter: LINE,
        layout: { "line-cap": "butt", "line-join": "round", "line-sort-key": ["match", ["get", "_c"], "closed", 5, "ice", 4, "snow", 3, "other", 2, "wet", 1, 0] },
        paint: { "line-color": RC, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.8 * st.size, 12, 5 * st.size], "line-opacity": st.opacity, "line-dasharray": ["case", ["==", ["get", "_c"], "closed"], ["literal", [1.5, 1]], ["literal", [1, 0]]] },
      } as LayerSpecification,
      { id: `${s}-pt`, type: "circle", source: s, filter: POINT, paint: { "circle-color": RC, "circle-radius": 4 * st.size, "circle-stroke-color": "#000", "circle-stroke-width": 1, "circle-opacity": st.opacity } } as LayerSpecification,
      ...(st.labels ? [{ id: `${s}-label`, type: "symbol", source: s, filter: LINE, minzoom: 9, layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "road"], ""], "text-font": font, "text-size": 10 }, paint: halo } as LayerSpecification] : []),
    ],
    click: (p) => ({
      title: `${p.road || "Road"} · ${ROAD_NAMES[p._c] ?? p.cond ?? "—"}`,
      sub: p.source ? `${p.source} 511` : "State 511",
      color: ROAD_COLORS[p._c] ?? "#6b7280",
      rows: [["Condition", p.cond || ROAD_NAMES[p._c] || "—"], ["Reported", when(p.t)]],
      text: p.desc && p.desc !== p.cond ? p.desc : undefined,
    }),
    note: "Winter road reports from state 511 feeds: green dry, blue wet, amber partly covered, white snow, magenta ice, red dashed closed. Zoom 5+.",
  },
];

// ---------- Personal weather stations ----------

/** temperature labels in the user's unit */
const tempTxt = (k: string): ExpressionSpecification => (settings.value.units.temp === "F" ? ["to-string", ["round", ["+", ["*", ["get", k], 1.8], 32]]] : ["to-string", ["round", ["get", k]]]);
const TEMP_COL: ExpressionSpecification = ["interpolate", ["linear"], ["to-number", ["get", "temp_c"], 0], -20, "#c4b5fd", -5, "#60a5fa", 5, "#67e8f9", 15, "#86efac", 22, "#fde047", 30, "#fb923c", 38, "#f87171"];
const fT = (c: any) => (c == null || c === "" ? "—" : settings.value.units.temp === "F" ? `${Math.round(+c * 1.8 + 32)}°F` : `${Math.round(+c)}°C`);
const fW = (kt: any) => {
  if (kt == null || kt === "") return "—";
  const u = settings.value.units.speed;
  const v = u === "kt" ? +kt : u === "mph" ? +kt * 1.15078 : u === "km/h" ? +kt * 1.852 : +kt * 0.514444;
  return `${Math.round(v)} ${u}`;
};
const obs: OverlayDef[] = [
  {
    id: "pws",
    name: "Personal weather stations (CWOP)",
    group: "Surface",
    refresh: 600,
    view: "bbox",
    minzoom: 5,
    maxKm2: 2_500_000,
    options: [{ key: "show", label: "Show", choices: [["plot", "Station plots"], ["temp", "Temperature only"], ["wind", "Wind only"]], def: "plot" }],
    style: { opacity: 1, size: 1, labels: true },
    prepare: (fc) => ({ ...fc, features: (fc?.features ?? []).filter((f: any) => f.geometry?.type === "Point") }),
    layers: (s, st: Style, o) => {
      const mode = o.show || "plot";
      const out: LayerSpecification[] = [
        { id: `${s}-dot`, type: "circle", source: s, paint: { "circle-radius": 2.2 * st.size, "circle-color": mode === "wind" ? "#e5e7eb" : TEMP_COL, "circle-stroke-color": "#000", "circle-stroke-width": 0.6, "circle-opacity": st.opacity } } as LayerSpecification,
      ];
      if (mode !== "temp")
        out.push({
          id: `${s}-barb`,
          type: "symbol",
          source: s,
          filter: ["has", "wind_kt"],
          minzoom: mode === "wind" ? 5 : 7,
          layout: { "icon-image": barbIcon(["get", "wind_kt"]), "icon-rotate": ["to-number", ["get", "dir"], 0], "icon-rotation-alignment": "map", "icon-size": 0.8 * st.size, "icon-allow-overlap": true, "icon-ignore-placement": true },
          paint: { "icon-color": "#e5e7eb", "icon-opacity": st.opacity },
        } as LayerSpecification);
      if (mode !== "wind" && st.labels) {
        out.push({
          id: `${s}-text`,
          type: "symbol",
          source: s,
          filter: ["has", "temp_c"],
          layout: { "text-field": tempTxt("temp_c"), "text-font": bold, "text-size": ["interpolate", ["linear"], ["zoom"], 5, 9.5, 10, 12], "text-offset": mode === "plot" ? [-0.7, -0.75] : [0, -0.9], "text-anchor": mode === "plot" ? "right" : "bottom", "text-padding": 1 },
          paint: { "text-color": "#fca5a5", "text-halo-color": "#000", "text-halo-width": 1.2, "text-opacity": st.opacity },
        } as LayerSpecification);
        if (mode === "plot")
          out.push({
            id: `${s}-dew`,
            type: "symbol",
            source: s,
            filter: ["has", "dew_c"],
            minzoom: 8,
            layout: { "text-field": tempTxt("dew_c"), "text-font": bold, "text-size": 10.5, "text-offset": [-0.7, 0.75], "text-anchor": "right", "text-padding": 1 },
            paint: { "text-color": "#86efac", "text-halo-color": "#000", "text-halo-width": 1.2, "text-opacity": st.opacity },
          } as LayerSpecification);
      }
      return out;
    },
    click: (p) => ({
      title: p.id ?? "Weather station",
      sub: `Personal weather station · ${when(p.t)}`,
      color: "#fca5a5",
      rows: [
        ["Temperature", fT(p.temp_c)],
        ["Dewpoint", fT(p.dew_c)],
        ["Wind", p.wind_kt != null ? `${p.dir != null ? `${Math.round(+p.dir)}° ` : ""}${fW(p.wind_kt)}${p.gust_kt ? ` G${fW(p.gust_kt)}` : ""}` : "—"],
        ["Pressure", p.pres_mb != null ? `${(+p.pres_mb).toFixed(1)} mb` : "—"],
        ["Rain (24 h)", p.rain_in != null ? (settings.value.units.precip === "in" ? `${(+p.rain_in).toFixed(2)} in` : `${(+p.rain_in * 25.4).toFixed(1)} mm`) : "—"],
      ],
      link: p.id ? ["findU / CWOP", `http://www.findu.com/cgi-bin/wxpage.cgi?call=${encodeURIComponent(p.id)}`] : undefined,
    }),
    note: "CWOP/APRS citizen weather stations (unofficial; siting varies). Temperature red, dewpoint green, wind barbs in knots. Zoom 5+.",
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

place([severe[1], severe[0]], "lsr"); // history under the surveys (drawn in list order)
place(tropical, "nhc");
place(flooding, "riverflood");
place(roads, undefined, "Traffic");
place(obs, "metar");

// console / screenshot handle
(window as any).__tbwP6 = { roadClass, efNum, ovlStatus, popup, overlayDef };
