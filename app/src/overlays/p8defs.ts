// data 0.8: hazard & emergency overlays — lightning jumps, GOES fire detections (FDC), overshooting
// tops / cloud-top cooling, USGS ShakeMap intensity, tsunami messages, shelters, hospitals and
// cooling / warming centres — plus the radar beam-blockage map (image or GeoJSON from
// /api/radar/blockage). Spliced into OVERLAYS next to their groups. Imported once from App.tsx.

import { signal, effect } from "@preact/signals";
import type { LayerSpecification, ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef } from "./defs";
import { settings } from "../store";
import { api } from "../api";
import { mapRef } from "../map/mapview";
import { currentSite } from "../radar/controller";
import { shakeOpen } from "../shake";

const font = ["Noto Sans Regular"];
const bold = ["Noto Sans Bold"];
const halo = { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 };
const POLY: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINE: ExpressionSpecification = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];
const num = (v: any) => (v == null || v === "" || !Number.isFinite(+v) ? null : +v);
const f1 = (v: any, d = 1) => (num(v) == null ? "—" : (+v).toFixed(d));
const when = (v: any) => {
  if (v == null || v === "") return "—";
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : /^\d+$/.test(String(v)) ? +v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : String(v);
};
const ago = (v: any) => {
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

// ---------- Severe: lightning jumps, overshooting tops ----------

const JUMP_COLOR: ExpressionSpecification = ["case", ["to-boolean", ["get", "jump"]], ["step", ["to-number", ["get", "sigma"], 0], "#facc15", 3, "#f97316", 4, "#ef4444", 6, "#d946ef"], "#94a3b8"];
const ljump: OverlayDef = {
  id: "ljump",
  name: "Lightning jumps",
  group: "Severe",
  refresh: 120,
  options: [{ key: "show", label: "Show", choices: [["jumps", "Jumps only"], ["all", "All tracked cells"]], def: "jumps" }],
  style: { opacity: 0.95, size: 1, labels: true },
  prepare: (fc, o) => ({ ...fc, features: (fc?.features ?? []).filter((f: any) => o.show === "all" || f.properties?.jump === true || f.properties?.jump === 1 || f.properties?.jump === "true").map((f: any) => ({ ...f, properties: { ...f.properties, jump: f.properties?.jump === true || f.properties?.jump === 1 || f.properties?.jump === "true" } })) }),
  layers: (s, st) => [
    { id: `${s}-halo`, type: "circle", source: s, filter: ["to-boolean", ["get", "jump"]], paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 9 * st.size, 9, 18 * st.size], "circle-stroke-color": JUMP_COLOR, "circle-stroke-width": 2.5, "circle-stroke-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, paint: { "circle-color": JUMP_COLOR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3.5 * st.size, 9, 6.5 * st.size], "circle-opacity": st.opacity, "circle-stroke-color": "#000", "circle-stroke-width": 1 } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 5.5, layout: { "text-field": ["case", ["to-boolean", ["get", "jump"]], ["concat", "JUMP ", ["to-string", ["round", ["to-number", ["get", "sigma"], 0]]], "σ"], ["concat", ["to-string", ["round", ["to-number", ["get", "rate_fpm"], 0]]], "/min"]], "text-font": bold, "text-size": 10.5, "text-offset": [0, 1.5], "text-anchor": "top" }, paint: halo } as LayerSpecification] : []),
  ],
  click: (p) => ({
    title: p.jump ? `Lightning jump · ${f1(p.sigma)}σ` : "Lightning rate",
    sub: `Cell ${p.cell_id ?? "—"} · ${ago(p.t)}`,
    color: p.jump ? "#f97316" : "#94a3b8",
    rows: [
      ["Total flash rate", `${f1(p.rate_fpm, 0)} /min`],
      ["Rate change (dFRDT)", `${f1(p.dfrdt)} /min²`],
      ["Jump size", `${f1(p.sigma)} σ`],
      ["Time", when(p.t)],
    ],
    text: "A sudden rise in total lightning (≥ 2σ above the cell's recent trend) often precedes severe weather by 10–30 minutes.",
  }),
  note: "2σ lightning-jump algorithm on GLM total lightning per tracked storm cell. Rings: jump (yellow 2σ, orange 3σ, red 4σ, magenta 6σ+).",
};

const COOL: ExpressionSpecification = ["interpolate", ["linear"], ["abs", ["to-number", ["coalesce", ["get", "cooling_k15"], ["get", "dT"]], 0]], 0, "#60a5fa", 5, "#22d3ee", 10, "#facc15", 20, "#f97316", 30, "#ef4444", 45, "#d946ef"];
const ot: OverlayDef = {
  id: "ot",
  name: "Overshooting tops / cooling",
  group: "Severe",
  refresh: 300,
  style: { opacity: 0.9, size: 1, labels: true },
  layers: (s, st) => [
    { id: `${s}-glow`, type: "circle", source: s, paint: { "circle-color": COOL, "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 7 * st.size, 9, 15 * st.size], "circle-opacity": 0.25 * st.opacity, "circle-blur": 0.6 } } as LayerSpecification,
    { id: `${s}-pt`, type: "symbol", source: s, layout: { "text-field": "▲", "text-font": bold, "text-size": ["interpolate", ["linear"], ["zoom"], 4, 13 * st.size, 9, 20 * st.size], "text-allow-overlap": true }, paint: { "text-color": COOL, "text-halo-color": "#000", "text-halo-width": 1.2, "text-opacity": st.opacity } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 6, layout: { "text-field": ["concat", ["to-string", ["round", ["to-number", ["get", "tb"], 0]]], " K"], "text-font": font, "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top" }, paint: halo } as LayerSpecification] : []),
  ],
  click: (p) => ({
    title: "Overshooting top",
    sub: `GOES · ${ago(p.t)}`,
    color: "#f97316",
    rows: [
      ["Cloud-top brightness temp.", `${f1(p.tb)} K (${f1(num(p.tb) != null ? +p.tb - 273.15 : null)} °C)`],
      ["Colder than anvil by", `${f1(p.dT)} K`],
      ["Cooling, last 15 min", `${f1(p.cooling_k15)} K`],
      ["Time", when(p.t)],
    ],
    text: "Overshooting tops mark very strong updrafts punching into the stratosphere; rapid cloud-top cooling means a storm is intensifying.",
  }),
  note: "GOES ABI overshooting-top detections and 15-minute cloud-top cooling rate (▲ coloured by cooling: blue weak → magenta ≥ 45 K).",
};

// ---------- Hazards: fires, ShakeMap, tsunami ----------

const goesfire: OverlayDef = {
  id: "goesfire",
  name: "GOES fire detections (FDC)",
  group: "Hazards",
  refresh: 600,
  options: [{ key: "conf", label: "Confidence", choices: [["all", "All"], ["high", "Processed / saturated only"]], def: "all" }],
  style: { opacity: 0.9, size: 1, labels: false },
  prepare: (fc, o) => ({ ...fc, features: (fc?.features ?? []).filter((f: any) => o.conf !== "high" || [10, 11, 30, 31].includes(+f.properties?.mask)) }),
  layers: (s, st) => [
    {
      id: `${s}-pt`,
      type: "circle",
      source: s,
      layout: { "circle-sort-key": ["to-number", ["get", "frp"], 0] },
      paint: {
        "circle-color": ["interpolate", ["linear"], ["to-number", ["get", "frp"], 0], 0, "#fde047", 50, "#fb923c", 200, "#ef4444", 1000, "#b91c1c"],
        "circle-radius": ["interpolate", ["linear"], ["sqrt", ["max", 1, ["to-number", ["get", "frp"], 1]]], 1, 3 * st.size, 10, 6 * st.size, 30, 11 * st.size],
        "circle-opacity": st.opacity,
        "circle-stroke-color": "#450a0a",
        "circle-stroke-width": 1,
      },
    } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 8, layout: { "text-field": ["concat", ["to-string", ["round", ["to-number", ["get", "frp"], 0]]], " MW"], "text-font": font, "text-size": 10, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: halo } as LayerSpecification] : []),
  ],
  click: (p) => ({
    title: `Fire hotspot · ${f1(p.frp, 0)} MW`,
    sub: `GOES Fire Detection & Characterization · ${ago(p.t)}`,
    color: "#ef4444",
    rows: [
      ["Fire radiative power", `${f1(p.frp)} MW`],
      ["Fire temperature", num(p.temp) != null ? `${f1(p.temp, 0)} K` : "—"],
      ["Mask", FDC_MASK[+p.mask] ?? String(p.mask ?? "—")],
      ["Time", when(p.t)],
    ],
  }),
  note: "GOES-East/West ABI fire detections every 5–10 minutes (circle size and colour by fire radiative power). Geostationary pixels are ~2 km: positions are approximate.",
};
const FDC_MASK: Record<number, string> = { 10: "Processed fire", 11: "Saturated fire", 12: "Cloud-contaminated", 13: "High probability", 14: "Medium probability", 15: "Low probability", 30: "Processed (temporally filtered)", 31: "Saturated (filtered)", 33: "High prob. (filtered)", 34: "Medium prob. (filtered)", 35: "Low prob. (filtered)" };

export const MMI_COLORS = ["#ffffff", "#ffffff", "#bfccff", "#a0e6ff", "#80ffff", "#7aff93", "#ffff00", "#ffc800", "#ff9100", "#ff0000", "#c80000"]; // index = MMI (0..10)
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X+"];
const MMI_C: ExpressionSpecification = ["interpolate", ["linear"], ["to-number", ["get", "mmi"], 0], 1, MMI_COLORS[1], 2, MMI_COLORS[2], 3, MMI_COLORS[3], 4, MMI_COLORS[4], 5, MMI_COLORS[5], 6, MMI_COLORS[6], 7, MMI_COLORS[7], 8, MMI_COLORS[8], 9, MMI_COLORS[9], 10, MMI_COLORS[10]];
const MMI_WORDS = ["", "Not felt", "Weak", "Weak", "Light", "Moderate", "Strong", "Very strong", "Severe", "Violent", "Extreme"];
const shakemap: OverlayDef = {
  id: "shakemap",
  name: "ShakeMap intensity (USGS)",
  group: "Hazards",
  refresh: 600,
  params: { recent: "1" },
  style: { opacity: 0.55, size: 1, labels: true },
  prepare: (fc) => {
    // the event (epicentre) arrives as a Point feature with kind:"event", or as fc.event
    const ev = fc?.event;
    const feats = [...(fc?.features ?? [])].sort((a: any, b: any) => (+a.properties?.mmi || 0) - (+b.properties?.mmi || 0));
    if (ev && ev.lon != null && ev.lat != null) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [+ev.lon, +ev.lat] }, properties: { ...ev, kind: "event" } });
    return { ...fc, features: feats };
  },
  layers: (s, st) => [
    { id: `${s}-fill`, type: "fill", source: s, filter: POLY, paint: { "fill-color": MMI_C, "fill-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: ["any", POLY, LINE], paint: { "line-color": ["case", ["==", ["geometry-type"], "Polygon"], "rgba(0,0,0,0.35)", MMI_C], "line-width": ["case", ["==", ["geometry-type"], "Polygon"], 0.6, 2.2 * st.size] } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-label`, type: "symbol", source: s, filter: ["any", POLY, LINE], minzoom: 5, layout: { "symbol-placement": "line", "text-field": ["match", ["round", ["to-number", ["get", "mmi"], 0]], ...ROMAN.slice(1).flatMap((r, i) => [i + 1, r]), ""] as any, "text-font": bold, "text-size": 11, "symbol-spacing": 260 }, paint: halo } as LayerSpecification] : []),
    { id: `${s}-epi`, type: "symbol", source: s, filter: ["all", POINT, ["==", ["get", "kind"], "event"]], layout: { "text-field": "★", "text-font": bold, "text-size": 24 * st.size, "text-allow-overlap": true }, paint: { "text-color": "#ef4444", "text-halo-color": "#000", "text-halo-width": 1.5 } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-epit`, type: "symbol", source: s, filter: ["all", POINT, ["==", ["get", "kind"], "event"]], layout: { "text-field": ["concat", "M", ["to-string", ["get", "mag"]], "\n", ["coalesce", ["get", "place"], ""]], "text-font": bold, "text-size": 11.5, "text-offset": [0, 1.4], "text-anchor": "top" }, paint: halo } as LayerSpecification] : []),
  ],
  click: (p) => {
    if (p.kind === "event")
      return {
        title: `M${p.mag ?? "?"} earthquake`,
        sub: p.place ?? "",
        color: "#ef4444",
        rows: [
          ["Time", when(p.time ?? p.t)],
          ["Depth", p.depth != null ? `${f1(p.depth)} km` : "—"],
          ["Max intensity", p.mmi != null ? `${ROMAN[Math.min(10, Math.round(+p.mmi))]} (${MMI_WORDS[Math.min(10, Math.round(+p.mmi))]})` : "—"],
          ["Event", String(p.id ?? p.event ?? "—")],
        ],
        link: ["Seismographs near this quake", `tbw:shake?lat=${p.lat ?? ""}&lon=${p.lon ?? ""}`],
        links: p.url ? [["USGS event page", String(p.url)]] : undefined,
      };
    const m = Math.min(10, Math.max(1, Math.round(+p.mmi || 1)));
    return { title: `Intensity ${ROMAN[m]} · ${MMI_WORDS[m]}`, sub: "USGS ShakeMap (Modified Mercalli)", color: MMI_COLORS[m], rows: [["MMI", f1(p.mmi)]], link: ["Open Seismographs", "tbw:shake"] };
  },
  note: "USGS ShakeMap shaking intensity (Modified Mercalli, I–X+) for recent significant earthquakes. Click the ★ for the event and to open the Seismographs window.",
};

const TSU_COLOR: ExpressionSpecification = ["match", ["downcase", ["to-string", ["get", "level"]]], "warning", "#ef4444", "advisory", "#f97316", "watch", "#facc15", "threat", "#d946ef", "information", "#60a5fa", "info", "#60a5fa", "#94a3b8"];
const tsunami: OverlayDef = {
  id: "tsunami",
  name: "Tsunami messages",
  group: "Hazards",
  refresh: 300,
  style: { opacity: 0.6, size: 1, labels: true },
  layers: (s, st) => [
    { id: `${s}-fill`, type: "fill", source: s, filter: POLY, paint: { "fill-color": TSU_COLOR, "fill-opacity": st.opacity * 0.6 } } as LayerSpecification,
    { id: `${s}-line`, type: "line", source: s, filter: ["any", POLY, LINE], paint: { "line-color": TSU_COLOR, "line-width": ["case", ["==", ["geometry-type"], "Polygon"], 1.2, 4 * st.size], "line-opacity": 0.95 } } as LayerSpecification,
    { id: `${s}-pt`, type: "circle", source: s, filter: POINT, paint: { "circle-color": TSU_COLOR, "circle-radius": 7 * st.size, "circle-stroke-color": "#000", "circle-stroke-width": 1.2, "circle-opacity": 0.95 } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, filter: POINT, layout: { "text-field": ["concat", "Tsunami ", ["to-string", ["get", "level"]]], "text-font": bold, "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top" }, paint: halo } as LayerSpecification] : []),
  ],
  click: (p) => ({
    title: `Tsunami ${String(p.level ?? "message").replace(/^./, (c) => c.toUpperCase())}`,
    sub: `${p.center ?? "Tsunami Warning Center"} · issued ${when(p.issued)}`,
    color: { warning: "#ef4444", advisory: "#f97316", watch: "#facc15", threat: "#d946ef" }[String(p.level).toLowerCase()] ?? "#60a5fa",
    rows: [["Issued", when(p.issued)], ["Center", String(p.center ?? "—")]],
    text: p.message ? String(p.message).slice(0, 1600) : undefined,
    link: ["tsunami.gov", "https://www.tsunami.gov/"],
  }),
  note: "NTWC / PTWC tsunami warnings, advisories, watches and threat messages: coastal areas and the source point (red warning, orange advisory, yellow watch, magenta threat, blue information).",
};

// ---------- Emergency: shelters, hospitals, cooling/warming centres ----------

function placeLayers(s: string, st: { opacity: number; size: number; labels: boolean }, color: string, glyph: string): LayerSpecification[] {
  return [
    { id: `${s}-pt`, type: "circle", source: s, paint: { "circle-color": color, "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 5 * st.size, 12, 9 * st.size], "circle-opacity": st.opacity, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } } as LayerSpecification,
    { id: `${s}-glyph`, type: "symbol", source: s, minzoom: 7, layout: { "text-field": glyph, "text-font": bold, "text-size": ["interpolate", ["linear"], ["zoom"], 7, 8 * st.size, 12, 11 * st.size], "text-allow-overlap": true }, paint: { "text-color": "#fff" } } as LayerSpecification,
    ...(st.labels ? [{ id: `${s}-text`, type: "symbol", source: s, minzoom: 9, layout: { "text-field": ["coalesce", ["get", "name"], ""], "text-font": font, "text-size": 10.5, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true }, paint: halo } as LayerSpecification] : []),
  ];
}
function placeClick(kind: string, color: string) {
  return (p: any) => ({
    title: p.name ?? kind,
    sub: [kind, p.status ?? p.open ?? ""].filter(Boolean).join(" · "),
    color,
    rows: [
      ...(p.address ? [["Address", String(p.address)] as [string, string]] : []),
      ...(p.city || p.state ? [["Place", [p.city, p.state].filter(Boolean).join(", ")] as [string, string]] : []),
      ...(p.phone ? [["Phone", String(p.phone)] as [string, string]] : []),
      ...(p.capacity != null ? [["Capacity", `${p.capacity}${p.population != null ? ` (${p.population} there)` : ""}`] as [string, string]] : []),
      ...(p.beds != null ? [["Beds", String(p.beds)] as [string, string]] : []),
      ...(p.trauma ? [["Trauma level", String(p.trauma)] as [string, string]] : []),
      ...(p.type ? [["Type", String(p.type)] as [string, string]] : []),
      ...(p.hours ? [["Hours", String(p.hours)] as [string, string]] : []),
      ...(p.pets != null ? [["Pets", p.pets ? "Allowed" : "No"] as [string, string]] : []),
      ...(p.updated ? [["Updated", when(p.updated)] as [string, string]] : []),
    ],
    link: p.url ? (["More", String(p.url)] as [string, string]) : undefined,
  });
}
const shelters: OverlayDef = { id: "shelters", name: "Shelters (open)", group: "Emergency services", refresh: 900, view: "bbox", minzoom: 5, style: { opacity: 0.95, size: 1, labels: true }, layers: (s, st) => placeLayers(s, st, "#16a34a", "S"), click: placeClick("Shelter", "#16a34a"), note: "Open emergency shelters (FEMA / American Red Cross National Shelter System), loaded for the map view." };
const hospitals: OverlayDef = { id: "hospitals", name: "Hospitals", group: "Emergency services", refresh: 86400, view: "bbox", minzoom: 6, style: { opacity: 0.95, size: 1, labels: true }, layers: (s, st) => placeLayers(s, st, "#dc2626", "H"), click: placeClick("Hospital", "#dc2626"), note: "Hospitals (HIFLD), loaded for the map view." };
const centers: OverlayDef = {
  id: "centers",
  name: "Cooling / warming centres",
  group: "Emergency services",
  refresh: 1800,
  view: "bbox",
  minzoom: 5,
  style: { opacity: 0.95, size: 1, labels: true },
  layers: (s, st) => [
    ...placeLayers(s, st, "#0ea5e9", "C").map((l) => (l.id === `${s}-pt` ? ({ ...l, paint: { ...(l as any).paint, "circle-color": ["match", ["downcase", ["to-string", ["coalesce", ["get", "kind"], ["get", "type"], ""]]], "warming", "#f97316", "cooling", "#0ea5e9", "#a855f7"] } } as LayerSpecification) : l)),
  ],
  click: (p) => placeClick(/warm/i.test(p.kind ?? p.type ?? "") ? "Warming centre" : /cool/i.test(p.kind ?? p.type ?? "") ? "Cooling centre" : "Cooling / warming centre", /warm/i.test(p.kind ?? p.type ?? "") ? "#f97316" : "#0ea5e9")(p),
  note: "Cooling centres (blue) and warming centres (orange) published by states and cities, loaded for the map view.",
};

// ---------- splice into the catalog ----------
function insertAfterGroup(def: OverlayDef, group: string, after?: string) {
  if (overlayDef(def.id)) return;
  let i = after ? OVERLAYS.findIndex((o) => o.id === after) : -1;
  if (i < 0) i = OVERLAYS.reduce((a, o, k) => (o.group === group ? k : a), -1);
  if (i < 0) i = OVERLAYS.length - 1;
  OVERLAYS.splice(i + 1, 0, def);
}
insertAfterGroup(ljump, "Severe", "glm");
insertAfterGroup(ot, "Severe");
insertAfterGroup(goesfire, "Hazards", "fires");
insertAfterGroup(shakemap, "Hazards", "shake");
insertAfterGroup(tsunami, "Hazards");
insertAfterGroup(shelters, "Emergency services");
insertAfterGroup(hospitals, "Emergency services", "shelters");
insertAfterGroup(centers, "Emergency services", "hospitals");

// popup links "tbw:shake?lat=&lon=" open the Seismographs window (and fly to the quake)
const wopen = window.open.bind(window);
window.open = ((url?: string | URL, ...rest: any[]) => {
  const u = String(url ?? "");
  if (u.startsWith("tbw:shake")) {
    const q = new URLSearchParams(u.split("?")[1] ?? "");
    const lat = parseFloat(q.get("lat") ?? ""), lon = parseFloat(q.get("lon") ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) mapRef.value?.flyTo({ center: [lon, lat], zoom: Math.max(mapRef.value.getZoom(), 6) });
    shakeOpen.value = true;
    return null;
  }
  return wopen(url as any, ...rest);
}) as typeof window.open;

// ---------- beam blockage (radar panel toggle) ----------

export const blockageState = signal<{ loading?: boolean; error?: string; note?: string }>({});
const B_SRC = "p8-blockage";
const B_IMG = "p8-blockage-img";
let bData: { kind: "img"; url: string; coords: [number, number][] } | { kind: "geo"; fc: any } | null = null;
let bSig = "";
const BLOCK_COLOR: ExpressionSpecification = ["interpolate", ["linear"], ["to-number", ["coalesce", ["get", "pct"], ["*", 100, ["to-number", ["coalesce", ["get", "frac"], ["get", "blocked"], ["get", "value"]], 0]]], 0], 0, "rgba(0,0,0,0)", 10, "#facc15", 30, "#f97316", 50, "#ef4444", 90, "#7f1d1d"];

function clearB(m: MLMap) {
  for (const id of [`${B_SRC}-fill`, `${B_SRC}-line`, `${B_IMG}-r`]) if (m.getLayer(id)) m.removeLayer(id);
  for (const id of [B_SRC, B_IMG]) if (m.getSource(id)) m.removeSource(id);
}
function drawB(m: MLMap) {
  if (!m.getStyle()) return;
  clearB(m);
  if (!bData || !settings.value.p8?.blockage) return;
  const before = m.getLayer("ovl-counties") ? "ovl-counties" : undefined;
  if (bData.kind === "img") {
    m.addSource(B_IMG, { type: "image", url: bData.url, coordinates: bData.coords as any });
    m.addLayer({ id: `${B_IMG}-r`, type: "raster", source: B_IMG, paint: { "raster-opacity": 0.65, "raster-fade-duration": 0 } }, before);
  } else {
    m.addSource(B_SRC, { type: "geojson", data: bData.fc });
    m.addLayer({ id: `${B_SRC}-fill`, type: "fill", source: B_SRC, filter: POLY, paint: { "fill-color": BLOCK_COLOR, "fill-opacity": 0.55 } }, before);
    m.addLayer({ id: `${B_SRC}-line`, type: "line", source: B_SRC, filter: ["any", POLY, LINE], paint: { "line-color": BLOCK_COLOR, "line-width": 0.6 } }, before);
  }
}
/** bounds header "w,s,e,n" (or a square of the radar's range around it) → image corners */
function corners(h: Headers, lat: number, lon: number): [number, number][] {
  const b = (h.get("x-bounds") ?? h.get("x-bbox") ?? "").split(",").map(Number);
  let [w, s, e, n] = b.length === 4 && b.every(Number.isFinite) ? b : [NaN, NaN, NaN, NaN];
  if (!Number.isFinite(w)) {
    const km = +(h.get("x-range-km") ?? 230);
    const dy = km / 111.195, dx = dy / Math.cos((lat * Math.PI) / 180);
    [w, s, e, n] = [lon - dx, lat - dy, lon + dx, lat + dy];
  }
  return [[w, n], [e, n], [e, s], [w, s]];
}
async function loadB() {
  const on = !!settings.value.p8?.blockage;
  const site = settings.value.radar.site;
  const tilt = settings.value.radar.tiltAngle;
  const sig = on ? `${api.base}|${site}|${tilt}` : "";
  if (sig === bSig) return;
  bSig = sig;
  const m = mapRef.value;
  if (!on) {
    bData = null;
    blockageState.value = {};
    if (m) clearB(m);
    return;
  }
  blockageState.value = { loading: true };
  try {
    const r = await fetch(`${api.base}/api/radar/blockage?site=${encodeURIComponent(site)}&tilt=${tilt}`, { headers: api.token ? { Authorization: `Bearer ${api.token}` } : {} });
    if (sig !== bSig) return;
    if (!r.ok) throw new Error(r.status === 404 ? "not available on this server" : `HTTP ${r.status}`);
    const ct = r.headers.get("content-type") ?? "";
    const cs = currentSite.value;
    if (/json/.test(ct)) {
      const fc = await r.json();
      bData = { kind: "geo", fc: fc?.type === "FeatureCollection" ? fc : { type: "FeatureCollection", features: [] } };
      blockageState.value = { note: `${site} ${tilt.toFixed(1)}°: ${(fc?.features ?? []).length} blocked sectors (yellow 10 %, orange 30 %, red ≥ 50 % of the beam).` };
    } else {
      const blob = await r.blob();
      if (bData?.kind === "img") URL.revokeObjectURL(bData.url);
      bData = { kind: "img", url: URL.createObjectURL(blob), coords: corners(r.headers, cs?.lat ?? 35, cs?.lon ?? -97) };
      blockageState.value = { note: `${site} ${tilt.toFixed(1)}° beam blockage (server image).` };
    }
    if (m) drawB(m);
  } catch (e: any) {
    if (sig === bSig) blockageState.value = { error: e.message };
  }
}
let hooked: MLMap | null = null;
// deferred: this module can be evaluated while map/mapview.ts is still initialising (import cycle)
setTimeout(() => effect(() => {
  void settings.value.p8?.blockage;
  void settings.value.radar.site;
  void settings.value.radar.tiltAngle;
  void api.base;
  const m = mapRef.value;
  if (m && hooked !== m) {
    hooked = m;
    m.on("style.load", () => setTimeout(() => drawB(m), 80));
  }
  loadB();
}), 0);

// console / screenshot handle
(window as any).__tbwP8 = { blockageState, MMI_COLORS };
