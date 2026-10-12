// Detection models: "Model detections" map layer (Severe group). Detections come from the runner on
// the server and/or the app's built-in server (ml/client.ts polls /api/ml/detections every 30 s and
// listens for `ml_detection` on the WebSocket). Each detection is drawn as: a soft halo and a
// probability ring coloured by level (low/med/high), the target's icon (funnel, rotating updraft,
// hailstone, …), the cell outline when the server sends a polygon, a 30-minute motion arrow, and a
// "TOR 82%" label at higher zooms. "High" detections pulse (animated only while visible).

import { effect } from "@preact/signals";
import type { LayerSpecification, ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef, type OptionDef, type Popup } from "./defs";
import { setData, isOn, popup } from "./manager";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { destination, fmtTime, fmtAge, compass } from "../util";
import { detections, startDetections, ensureModels, detMaxAgeMin, models, catalog, loadRun, runState, mlOpen, mlTab, selModel } from "../ml/client";
import { tmeta, LEVEL_COLOR, LEVEL_NAME, TARGETS } from "../ml/targets";
import type { Detection } from "../ml/types";

const ID = "mldetect";
const bold = ["Noto Sans Bold"];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];
const POLY: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];
const LINE: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
/** side-by-side slots when several models flag the same cell */
const OFF = (px: number): ExpressionSpecification => ["match", ["get", "slot"], -1, ["literal", [-px, 0]], 1, ["literal", [px, 0]], ["literal", [0, 0]]];
const LVL: ExpressionSpecification = ["match", ["get", "level"], "high", LEVEL_COLOR.high, "med", LEVEL_COLOR.med, LEVEL_COLOR.low];

function featName(id: string): [string, string] {
  for (const m of models.value) {
    const f = m.feature_schema?.find((x) => x.id === id);
    if (f) return [f.name, f.unit ?? ""];
  }
  for (const c of catalog.value?.candidates ?? []) {
    const f = c.features.find((x) => x.id === id);
    if (f) return [f.name, f.unit ?? ""];
  }
  return [id, ""];
}
const fmtV = (v: number) => (!Number.isFinite(v) ? "—" : Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 || v === 0 ? v.toFixed(2) : v.toPrecision(2));

const def: OverlayDef = {
  id: ID,
  name: "Model detections (my detection models)",
  group: "Severe",
  feed: "client",
  refresh: 0,
  get options(): OptionDef[] {
    const ms = models.value;
    return [
      { key: "model", label: "Model", choices: [["", "All models"], ...ms.map((m) => [m.id, `${m.name} (${tmeta(m.target).code})`] as [string, string])], def: "" },
      { key: "target", label: "Detects", choices: [["", "Everything"], ...Object.entries(TARGETS).map(([k, t]) => [k, t.name] as [string, string])], def: "" },
      { key: "minp", label: "Min probability", choices: [["0", "Any"], ["30", "30%+"], ["50", "50%+"], ["70", "70%+"], ["85", "85%+"]], def: "0" },
      { key: "age", label: "Show last", choices: [["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["360", "6 hours"]], def: "60" },
      { key: "pulse", label: "Pulse high", choices: [["1", "On"], ["0", "Off"]], def: "1" },
    ];
  },
  style: { opacity: 1, size: 1, labels: true },
  layers: (s, st) => [
    { id: `${s}-box`, type: "fill", source: s, filter: POLY, paint: { "fill-color": ["get", "color"], "fill-opacity": 0.1 * st.opacity } } as LayerSpecification,
    { id: `${s}-boxcase`, type: "line", source: s, filter: POLY, layout: { "line-join": "round" }, paint: { "line-color": "#000", "line-width": 4 * st.size, "line-opacity": 0.55 * st.opacity, "line-blur": 1 } } as LayerSpecification,
    { id: `${s}-boxline`, type: "line", source: s, filter: POLY, layout: { "line-join": "round" }, paint: { "line-color": LVL, "line-width": ["match", ["get", "level"], "high", 2.4, "med", 2, 1.5], "line-opacity": st.opacity, "line-dasharray": ["case", ["==", ["get", "level"], "low"], ["literal", [2, 1.5]], ["literal", [1, 0]]] } } as LayerSpecification,
    { id: `${s}-mvcase`, type: "line", source: s, filter: LINE, minzoom: 6, layout: { "line-cap": "round" }, paint: { "line-color": "#000", "line-width": 4 * st.size, "line-opacity": 0.6 * st.opacity } } as LayerSpecification,
    { id: `${s}-mv`, type: "line", source: s, filter: LINE, minzoom: 6, layout: { "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 1.8 * st.size, "line-opacity": 0.9 * st.opacity, "line-dasharray": [2, 1.4] } } as LayerSpecification,
    { id: `${s}-mvhead`, type: "symbol", source: s, filter: ["all", POINT, ["==", ["get", "kind"], "head"]], minzoom: 6, layout: { "icon-image": "ml-arrow", "icon-rotate": ["get", "dir"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-size": st.size }, paint: { "icon-opacity": st.opacity } } as LayerSpecification,
    // animated ring for "high" (paint driven by the pulse loop below)
    { id: `${s}-pulse`, type: "circle", source: s, filter: ["all", POINT, ["==", ["get", "kind"], "det"], ["==", ["get", "level"], "high"]], paint: { "circle-radius": 18 * st.size, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": LEVEL_COLOR.high, "circle-stroke-width": 2, "circle-stroke-opacity": 0 } } as LayerSpecification,
    { id: `${s}-halo`, type: "circle", source: s, filter: ["all", POINT, ["==", ["get", "kind"], "det"]], layout: { "circle-sort-key": ["get", "prob"] }, paint: { "circle-radius": ["*", st.size, ["match", ["get", "level"], "high", 30, "med", 25, 20]], "circle-color": LVL, "circle-opacity": ["*", st.opacity, ["match", ["get", "level"], "high", 0.42, "med", 0.32, 0.22]], "circle-blur": 0.65 } } as LayerSpecification,
    {
      id: `${s}-ring`,
      type: "symbol",
      source: s,
      filter: ["all", POINT, ["==", ["get", "kind"], "det"]],
      layout: { "symbol-sort-key": ["get", "prob"], "icon-image": ["concat", "ml-ring-", ["get", "level"], "-", ["to-string", ["get", "dec"]]], "icon-offset": OFF(22), "icon-size": ["*", st.size, ["match", ["get", "level"], "high", 1, "med", 0.88, 0.78]], "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-opacity": st.opacity },
    } as LayerSpecification,
    {
      id: `${s}-icon`,
      type: "symbol",
      source: s,
      filter: ["all", POINT, ["==", ["get", "kind"], "det"]],
      layout: {
        "symbol-sort-key": ["get", "prob"],
        "icon-image": ["concat", "ml-", ["get", "target"]],
        "icon-offset": OFF(23),
        "icon-size": ["*", st.size, ["match", ["get", "level"], "high", 1, "med", 0.9, 0.8]],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        ...(st.labels
          ? {
              "text-field": ["step", ["zoom"], "", 6, ["concat", ["get", "code"], " ", ["to-string", ["round", ["*", 100, ["get", "prob"]]]], "%"]],
              "text-font": bold,
              "text-size": 11,
              "text-offset": ["match", ["get", "slot"], -1, ["literal", [-1.6, 1.9]], 1, ["literal", [1.6, 1.9]], ["literal", [0, 1.9]]],
              "text-anchor": "top",
              "text-optional": true,
            }
          : {}),
      },
      paint: { "icon-opacity": st.opacity, "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.4 },
    } as LayerSpecification,
  ],
  click: (p): Popup => {
    ensureModels();
    const t = tmeta(p.target);
    const pct = Math.round(+p.prob * 100);
    let tf: { id: string; value: number; contribution: number }[] = [];
    try {
      tf = JSON.parse(p._tf || "[]");
    } catch {
      /* none */
    }
    const rows: [string, string][] = [
      ["Model", String(p.model_name)],
      ["Probability", `${pct}% · ${LEVEL_NAME[p.level as "low"] ?? p.level}`],
      ["Radar", p.site || "—"],
      ["Time", `${fmtTime(+p.t, true)} (${fmtAge(+p.t)})`],
    ];
    if (p.mdir !== undefined && p.mdir !== null && p.mdir !== "") rows.push(["Motion", `${compass(+p.mdir)} (${Math.round(+p.mdir)}°) at ${Math.round(+p.mkt)} kt`]);
    for (const f of tf.slice(0, 6)) {
      const [n, u] = featName(f.id);
      const c = +f.contribution;
      rows.push([n, `${fmtV(+f.value)}${u ? ` ${u}` : ""}  ${Number.isFinite(c) ? `(${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(2)})` : ""}`]);
    }
    return {
      title: `${t.name} · ${pct}%`,
      sub: `${p.model_name}${p.site ? ` · ${p.site}` : ""}${tf.length ? " · top factors (contribution) below" : ""}`,
      color: t.color,
      rows,
    };
  },
  note: "Detections from your detection models (Detection models → Run). Icon = what the model detects; ring = probability (yellow low, orange moderate, red high; the arc fills with the probability); box = the cell outline; arrow = 30-minute motion. High-probability detections pulse.",
};

// ---------- data ----------
function opts() {
  const o = settings.value.ovl[ID]?.opts ?? {};
  return { model: o.model ?? "", target: o.target ?? "", minp: +(o.minp ?? "0") / 100, age: +(o.age ?? "60"), pulse: (o.pulse ?? "1") === "1" };
}
let hasHigh = false;
function build(list: Detection[], all = false) {
  const o = opts();
  const cut = Date.now() - o.age * 60_000;
  const feats: any[] = [];
  hasHigh = false;
  for (const d of list) {
    if (!all && (d.t < cut || d.prob < o.minp || (o.model && d.model_id !== o.model) || (o.target && d.target !== o.target))) continue;
    const t = tmeta(d.target);
    const props = {
      kind: "det",
      model_id: d.model_id,
      model_name: d.model_name,
      target: TARGETS[d.target] ? d.target : "custom",
      code: t.code,
      color: t.color,
      prob: d.prob,
      dec: Math.max(0, Math.min(10, Math.round(d.prob * 10))),
      level: d.level,
      site: d.site,
      t: d.t,
      mdir: d.motion?.dir,
      mkt: d.motion?.kt,
      _tf: JSON.stringify(d.top_features ?? []),
      _key: d.key,
    };
    if (d.level === "high") hasHigh = true;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [d.lon, d.lat] }, properties: props });
    if (d.poly?.length) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: d.poly }, properties: { ...props, kind: "box" } });
    if (d.motion && d.motion.kt > 2) {
      const km = d.motion.kt * 1.852 * 0.5; // 30 minutes
      const end = destination(d.lat, d.lon, d.motion.dir, km * 1000);
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[d.lon, d.lat], end] }, properties: { kind: "mv", level: d.level } });
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: end }, properties: { kind: "head", dir: d.motion.dir, level: d.level } });
    }
  }
  const groups = new Map<string, any[]>();
  for (const f of feats) {
    if (f.properties.kind !== "det") continue;
    const [x, y] = f.geometry.coordinates;
    const k = `${Math.round(x / 0.04)}|${Math.round(y / 0.04)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.properties.target.localeCompare(b.properties.target));
    const slots = g.length === 2 ? [-1, 1] : [-1, 0, 1];
    g.forEach((f, i) => (f.properties.slot = slots[i] ?? 0));
  }
  // draw order: low first, high on top (sort keys handle symbols; circles follow feature order)
  feats.sort((a, b) => (a.properties.prob ?? 0) - (b.properties.prob ?? 0));
  return { type: "FeatureCollection", features: feats };
}

/** fly to a detection and open its popup */
export function showDetection(d: Detection) {
  const m = mapRef.value;
  if (!m) return;
  enableDetectionLayer();
  const fc = build([d], true);
  const props = fc.features.find((f: any) => f.properties.kind === "det")?.properties ?? {};
  m.flyTo({ center: [d.lon, d.lat], zoom: Math.max(m.getZoom(), 8.5), duration: 900 });
  m.once("moveend", () => {
    const pt = m.project([d.lon, d.lat]);
    popup.value = { x: pt.x, y: pt.y, lng: d.lon, lat: d.lat, p: def.click!({ ...props, t: d.t }), overlay: ID };
  });
}

if (!overlayDef(ID)) {
  const i = OVERLAYS.reduce((a, o, k) => (o.group === "Severe" ? k : a), -1);
  OVERLAYS.splice(i < 0 ? OVERLAYS.length : i + 1, 0, def);
}

let stopPoll: (() => void) | null = null;
effect(() => {
  const on = isOn(ID);
  if (on && !stopPoll) {
    stopPoll = startDetections();
    ensureModels();
  }
  if (!on && stopPoll) {
    stopPoll();
    stopPoll = null;
  }
});
effect(() => {
  void settings.value.ovl[ID];
  detMaxAgeMin.value = Math.max(detMaxAgeMin.value, opts().age);
  const fc = build(detections.value);
  if (isOn(ID)) setData(ID, fc);
  kickPulse();
});
// re-filter ageing detections once a minute
setInterval(() => isOn(ID) && setData(ID, build(detections.value)), 60_000);

// ---------- pulse (only while there is something to pulse and the window is visible) ----------
let raf = 0;
let lastFrame = 0;
function frame(ts: number) {
  raf = 0;
  const m: MLMap | null = mapRef.value;
  const layer = `o-${ID}-pulse`;
  if (!m || !isOn(ID) || !hasHigh || !opts().pulse || document.visibilityState === "hidden" || !m.getLayer(layer)) {
    if (m?.getLayer(layer)) m.setPaintProperty(layer, "circle-stroke-opacity", 0);
    return;
  }
  if (ts - lastFrame > 40) {
    lastFrame = ts;
    const ph = (ts % 1600) / 1600;
    const sz = settings.value.ovl[ID]?.size ?? 1;
    m.setPaintProperty(layer, "circle-radius", (16 + ph * 26) * sz);
    m.setPaintProperty(layer, "circle-stroke-opacity", 0.9 * (1 - ph));
    m.setPaintProperty(layer, "circle-stroke-width", 3 - ph * 2);
    m.triggerRepaint();
  }
  raf = requestAnimationFrame(frame);
}
function kickPulse() {
  if (!raf && hasHigh) raf = requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", kickPulse);
setInterval(kickPulse, 2000); // after style reloads / layer re-adds

// ---------- turn the layer on when a runner is enabled (unless the user turned it off) ----------
setTimeout(async () => {
  if (settings.value.ovl[ID] !== undefined) return;
  await loadRun();
  if (Object.values(runState.value).some((r) => r?.enabled)) update((s) => (s.ovl[ID] = { ...(s.ovl[ID] ?? {}), on: true }));
}, 6000);
export function enableDetectionLayer() {
  if (!isOn(ID)) update((s) => (s.ovl[ID] = { ...(s.ovl[ID] ?? {}), on: true }));
}
/** open the model behind a detection */
export function openDetectionModel(model_id: string, ep = "main") {
  selModel.value = `${ep}|${model_id}`;
  mlTab.value = "models";
  mlOpen.value = true;
}

(window as any).__tbwMLmap = { showDetection, build }; // console / screenshots
