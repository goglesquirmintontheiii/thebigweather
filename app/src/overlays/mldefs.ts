// Detection models: "Model detections" map layer (Severe group). Detections come from the runner on
// the server and/or the app's built-in server (ml/client.ts polls /api/ml/detections every 30 s and
// listens for `ml_detection` on the WebSocket). Each detection is drawn as: a soft halo and a
// probability ring coloured by level (low/med/high), the target's icon (funnel, rotating updraft,
// hailstone, …), the cell outline when the server sends a polygon, a 30-minute motion arrow, and a
// "TOR 82%" label at higher zooms. "High" detections pulse (animated only while visible).

import { effect, signal } from "@preact/signals";
import type { LayerSpecification, ExpressionSpecification, Map as MLMap } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef, type OptionDef, type Popup } from "./defs";
import { setData, isOn, popup } from "./manager";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { destination, fmtTime, fmtAge, compass, bearing } from "../util";
import { detections, startDetections, ensureModels, detMaxAgeMin, models, catalog, loadRun, runState, mlOpen, mlTab, selModel, detEnd, modelsEps } from "../ml/client";
import { summarize, confText, confOf, CONF_HELP, summaryFmt } from "../ml/summary"; // 0.8.1
import { gated } from "../ml/probgate"; // models 0.7: probability gate
import { tmeta, LEVEL_COLOR, LEVEL_NAME, TARGETS, strengthColor } from "../ml/targets";
import { stoppedModels, detTime, detsAt, timeSync, timeDets } from "../ml/m8"; // models 0.8
import type { Detection } from "../ml/types";

const ID = "mldetect";
summaryFmt.time = (ms) => fmtTime(ms); // 0.8.1: summaries use the app's time format
const bold = ["Noto Sans Bold"];
const POINT: ExpressionSpecification = ["==", ["geometry-type"], "Point"];
const POLY: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];
const LINE: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
const BOX: ExpressionSpecification = ["all", POLY, ["==", ["get", "kind"], "box"]];
const AREA: ExpressionSpecification = ["all", POLY, ["==", ["get", "kind"], "area"]];
/* models 0.8: storm-track cone / path / lead-time ticks */
const CONE: ExpressionSpecification = ["all", POLY, ["==", ["get", "kind"], "cone"]];
const TRK: ExpressionSpecification = ["all", LINE, ["==", ["get", "kind"], "trk"]];
const MVL: ExpressionSpecification = ["all", LINE, ["!=", ["get", "kind"], "trk"]];
const TICK: ExpressionSpecification = ["all", POINT, ["==", ["get", "kind"], "tick"]];
/** models 0.7: probabilities of the features currently drawn (before the gate), for the gate's counts */
export const detProbs = signal<number[]>([]);
/** models 0.8: the same per model (for the per-model gates); 0.8.1: + confidences, stale = model deleted */
export const detProbsBy = signal<{ model_id: string; name: string; target: string; probs: number[]; confs: number[]; ep: string }[]>([]);
/** 0.8.1: confidences of the features drawn (gate by confidence) */
export const detConfs = signal<number[]>([]);
/** side-by-side slots when several models flag the same cell */
const OFF = (px: number): ExpressionSpecification => ["match", ["get", "slot"], -1, ["literal", [-px, 0]], 1, ["literal", [px, 0]], ["literal", [0, 0]]];
const LVL: ExpressionSpecification = ["match", ["get", "level"], "high", LEVEL_COLOR.high, "med", LEVEL_COLOR.med, LEVEL_COLOR.low];
/** 0.8.1: hovered or selected detection (feature-state on the shared `fid`) */
const HOT: ExpressionSpecification = ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "sel"], false]];
/** 0.8.1: models whose cell / area is filled to show the storm or area the detection is about */
const HL_TARGETS = new Set(["storm_intensify", "storm_track"]);

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
/** units of a regression detection's value */
const unitOf = (t: string) => (t === "temp_forecast" ? "°C" : t === "precip_forecast" ? "mm" : t === "storm_forecast" ? "dBZ" : "");
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
      { key: "minc", label: "Min confidence", choices: [["0", "Any"], ["30", "30%+"], ["50", "50%+"], ["70", "70%+"]], def: "0" }, // 0.8.1
      { key: "age", label: "Show last", choices: [["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["360", "6 hours"]], def: "60" },
      { key: "pulse", label: "Pulse high", choices: [["1", "On"], ["0", "Off"]], def: "1" },
      { key: "areas", label: "Forecast areas", choices: [["1", "Show"], ["0", "Hide"]], def: "1" },
      { key: "sync", label: "Follow the timeline", choices: [["1", "On (animate)"], ["0", "Off (newest)"]], def: "1" }, // models 0.8
      { key: "tracks", label: "Storm tracks", choices: [["1", "Track + cone"], ["2", "Track only"], ["0", "Hide"]], def: "1" },
    ];
  },
  style: { opacity: 1, size: 1, labels: true },
  source: { promoteId: "fid" }, // 0.8.1: hover / selection highlight (feature-state)
  layers: (s, st) => gated(ID, [
    // models 0.7: grid models' areas (flood / tropical / instability), coloured by probability
    { id: `${s}-area`, type: "fill", source: s, filter: AREA, layout: { "fill-sort-key": ["get", "prob"] }, paint: { "fill-color": ["get", "color"], "fill-opacity": ["*", st.opacity, ["case", HOT, 0.5, ["interpolate", ["linear"], ["get", "prob"], 0, 0.08, 1, 0.38]]] } } as LayerSpecification,
    { id: `${s}-arealine`, type: "line", source: s, filter: AREA, layout: { "line-join": "round" }, paint: { "line-color": LVL, "line-width": ["case", HOT, 3.6, ["match", ["get", "level"], "high", 2.6, "med", 2, 1.4]], "line-opacity": st.opacity, "line-dasharray": ["case", ["==", ["get", "level"], "low"], ["literal", [3, 2]], ["literal", [1, 0]]] } } as LayerSpecification,
    // models 0.8: storm-track cone and path coloured by predicted strength
    { id: `${s}-cone`, type: "fill", source: s, filter: CONE, paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 * st.opacity } } as LayerSpecification,
    { id: `${s}-coneline`, type: "line", source: s, filter: CONE, layout: { "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 1.2, "line-opacity": 0.75 * st.opacity, "line-dasharray": [3, 2] } } as LayerSpecification,
    { id: `${s}-trkcase`, type: "line", source: s, filter: TRK, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": 5.5 * st.size, "line-opacity": 0.6 * st.opacity } } as LayerSpecification,
    { id: `${s}-trk`, type: "line", source: s, filter: TRK, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "scol"], "line-width": 3 * st.size, "line-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-tick`, type: "circle", source: s, filter: TICK, paint: { "circle-radius": 4.5 * st.size, "circle-color": ["get", "scol"], "circle-stroke-color": "#000", "circle-stroke-width": 1.5, "circle-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-ticklbl`, type: "symbol", source: s, filter: TICK, minzoom: 5.5, layout: { "text-field": ["get", "tl"], "text-font": bold, "text-size": 10.5, "text-anchor": "left", "text-offset": [0.9, 0], "text-optional": true, "text-allow-overlap": false }, paint: { "text-color": ["get", "scol"], "text-halo-color": "#000", "text-halo-width": 1.5, "text-opacity": st.opacity } } as LayerSpecification,
    { id: `${s}-box`, type: "fill", source: s, filter: BOX, paint: { "fill-color": ["get", "color"], "fill-opacity": ["*", st.opacity, ["case", HOT, 0.42, ["==", ["get", "hl"], 1], 0.24, 0.1]] } } as LayerSpecification,
    { id: `${s}-boxcase`, type: "line", source: s, filter: BOX, layout: { "line-join": "round" }, paint: { "line-color": "#000", "line-width": 4 * st.size, "line-opacity": 0.55 * st.opacity, "line-blur": 1 } } as LayerSpecification,
    { id: `${s}-boxline`, type: "line", source: s, filter: BOX, layout: { "line-join": "round" }, paint: { "line-color": LVL, "line-width": ["case", HOT, 3.6, ["==", ["get", "hl"], 1], 2.6, ["match", ["get", "level"], "high", 2.4, "med", 2, 1.5]], "line-opacity": st.opacity, "line-dasharray": ["case", ["==", ["get", "level"], "low"], ["literal", [2, 1.5]], ["literal", [1, 0]]] } } as LayerSpecification,
    { id: `${s}-mvcase`, type: "line", source: s, filter: MVL, minzoom: 6, layout: { "line-cap": "round" }, paint: { "line-color": "#000", "line-width": 4 * st.size, "line-opacity": 0.6 * st.opacity } } as LayerSpecification,
    { id: `${s}-mv`, type: "line", source: s, filter: MVL, minzoom: 6, layout: { "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 1.8 * st.size, "line-opacity": 0.9 * st.opacity, "line-dasharray": [2, 1.4] } } as LayerSpecification,
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
              "text-field": ["step", ["zoom"], "", 6, ["concat", ["get", "code"], " ", ["get", "vtxt"]]],
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
  ]),
  click: (p): Popup => {
    ensureModels();
    const t = tmeta(p.target);
    const pct = Math.round(+p.prob * 100);
    const hasVal = p.value != null && p.value !== "" && Number.isFinite(+p.value);
    let tf: { id: string; value: number; contribution: number }[] = [];
    try {
      tf = JSON.parse(p._tf || "[]");
    } catch {
      /* none */
    }
    // 0.8.1: probability (the model's output) and confidence (how far to trust it), separately
    const conf = p.conf != null && p.conf !== "" && Number.isFinite(+p.conf) ? +p.conf : undefined;
    let parts: Record<string, number> = {};
    try {
      parts = JSON.parse(p._cp || "{}");
    } catch {
      /* none */
    }
    const PART: Record<string, string> = { skill: "skill", calibration: "calibration", inputs: "inputs", coverage: "coverage", agreement: "agreement" };
    const partTxt = Object.entries(parts).filter(([k]) => PART[k]).map(([k, v]) => `${PART[k]} ${Math.round(+v * 100)}%`).join(" · ");
    const isTrack = p.target === "storm_track";
    const rows: [string, string][] = [
      ["Model", String(p.model_name)],
      hasVal && !isTrack ? ["Max forecast value", `${fmtV(+p.value)} ${unitOf(p.target)}`] : isTrack ? ["Prediction", "Storm track"] : ["Probability", `${pct}% · ${LEVEL_NAME[p.level as "low"] ?? p.level}`],
      ["Confidence", confText(conf)],
      ["Radar", p.site || "—"],
      ["Time", `${fmtTime(+p.t, true)} (${fmtAge(+p.t)})`],
    ];
    if (partTxt) rows.splice(3, 0, ["Confidence from", partTxt]);
    if (p.cells && +p.cells > 1) rows.push(["Storm", `${p.cells} radar cells`]);
    selectDetection(p.fid != null && p.fid !== "" ? +p.fid : null);
    if (p.area) {
      rows.splice(rows.findIndex((r) => r[0] === "Radar"), 1);
      if (p.vf) rows.push(["Valid", `${fmtTime(+p.vf, true)}${p.vt ? ` → ${fmtTime(+p.vt, true)}` : ""}`]);
    }
    // models 0.8: storm track forecast
    let trk: any[] = [];
    try {
      trk = JSON.parse(p._trk || "[]");
    } catch {
      /* none */
    }
    for (const x of trk) rows.push([`+${Math.round(x.lead_min)} min`, `${x.speed_kt != null ? `${Math.round(x.speed_kt)} kt` : ""}${x.strength != null ? ` · ${fmtStr(x.strength, x.strength_units)}` : ""}${x.cone_km ? ` · ±${Math.round(x.cone_km)} km` : ""}`]);
    if (p.mdir !== undefined && p.mdir !== null && p.mdir !== "") rows.push(["Motion", `${compass(+p.mdir)} (${Math.round(+p.mdir)}°) at ${Math.round(+p.mkt)} kt`]);
    for (const f of tf.slice(0, 6)) {
      const [n, u] = featName(f.id);
      const c = +f.contribution;
      rows.push([n, `${fmtV(+f.value)}${u ? ` ${u}` : ""}  ${Number.isFinite(c) ? `(${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(2)})` : ""}`]);
    }
    return {
      title: `${t.name} · ${isTrack ? `${conf != null ? `${Math.round(conf * 100)}% conf.` : "track"}` : hasVal ? `${fmtV(+p.value)} ${unitOf(p.target)}` : `${pct}%`}`,
      // 0.8.1: the summary sentence on top
      sub: `${p._sum || p.model_name}${String(p.model_id ?? "").startsWith("ensemble:") ? " (ensemble)" : ""}${tf.length ? " Top factors (contribution) below." : ""}`,
      color: t.color,
      rows,
    };
  },
  note: `Detections from your detection models (Detection models → a model → Run). Follows the timeline: scrub or play to see detections at each frame (history mode: Run on this range). Icon = what the model detects; ring = probability (yellow low, orange moderate, red high; the arc fills with the probability); box = the storm outline (filled for intensification / track models; brighter on hover and when selected); arrow = 30-minute motion. High-probability detections pulse. ${CONF_HELP}`,
};

// ---------- data ----------
function opts() {
  const o = settings.value.ovl[ID]?.opts ?? {};
  return { model: o.model ?? "", target: o.target ?? "", minp: +(o.minp ?? "0") / 100, minc: +(o.minc ?? "0") / 100, age: +(o.age ?? "60"), pulse: (o.pulse ?? "1") === "1", areas: (o.areas ?? "1") === "1", sync: (o.sync ?? "1") === "1", tracks: o.tracks ?? "1" };
}
/** models 0.8: "EF2", "62 kt", "55 dBZ", "70%" */
export function fmtStr(v: number, u?: string): string {
  const uu = (u ?? "").trim();
  if (/^ef$/i.test(uu)) return `EF${Math.round(v)}`;
  if (uu === "%" || /^prob/i.test(uu)) return `${Math.round(v > 1 ? v : v * 100)}%`;
  return `${Math.abs(v) >= 10 ? Math.round(v) : v.toFixed(1)}${uu ? ` ${uu}` : ""}`;
}
/** models 0.8: storm-track features: path segments coloured by strength, the cone, lead-time ticks */
function trackFeats(d: Detection, props: any, mode: string): any[] {
  const pts = [{ lead_min: 0, lat: d.lat, lon: d.lon, cone_km: 0, speed_kt: d.motion?.kt, strength: d.track![0]?.strength, strength_units: d.track![0]?.strength_units }, ...d.track!.filter((x) => x.lead_min > 0)];
  if (pts.length < 2) return [];
  const out: any[] = [];
  const base = { prob: d.prob, level: d.level, model_id: d.model_id, conf: props.conf, fid: props.fid };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    out.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }, properties: { ...base, kind: "trk", scol: strengthColor(b.strength, b.strength_units) } });
    if ([15, 30, 45, 60].includes(Math.round(b.lead_min)) || i === pts.length - 1) {
      const tl = `+${Math.round(b.lead_min)}′${b.speed_kt != null ? ` ${Math.round(b.speed_kt)} kt` : ""}${b.strength != null ? ` · ${fmtStr(b.strength, b.strength_units)}` : ""}`;
      out.push({ type: "Feature", geometry: { type: "Point", coordinates: [b.lon, b.lat] }, properties: { ...base, kind: "tick", tl, scol: strengthColor(b.strength, b.strength_units) } });
    }
  }
  if (mode === "1" && pts.some((p) => (p.cone_km ?? 0) > 0)) {
    const L: [number, number][] = [], Rr: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      const brg = i < pts.length - 1 ? bearing(p.lat, p.lon, q.lat, q.lon) : bearing(o.lat, o.lon, p.lat, p.lon);
      const r = Math.max(1.5, p.cone_km ?? 0) * 1000;
      L.push(destination(p.lat, p.lon, brg - 90, r));
      Rr.push(destination(p.lat, p.lon, brg + 90, r));
      if (i === pts.length - 1) for (let k = -80; k <= 80; k += 20) L.push(destination(p.lat, p.lon, brg + k, r));
    }
    const ring = [...L, ...Rr.reverse()];
    ring.push(ring[0]);
    const last = pts[pts.length - 1];
    out.unshift({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { ...props, kind: "cone", color: strengthColor(last.strength, last.strength_units) } });
  }
  return out;
}
let hasHigh = false;
function build(list: Detection[], all = false) {
  const o = opts();
  const cut = Date.now() - o.age * 60_000;
  const feats: any[] = [];
  hasHigh = false;
  // models 0.8: hide stopped / disabled models (their test runs still show)
  const stopped = all ? new Set<string>() : stoppedModels.value;
  const T = all ? null : detTime.value;
  // 0.8.1: detections of deleted models (their endpoint's list loaded without them) are stale
  const eps = modelsEps.value;
  const known = new Set(models.value.map((m) => `${m.ep}|${m.id}`));
  // 0.8.1: live view: a grid model's areas of the current window only (not every future frame)
  const now = Date.now();
  const curWin = new Map<string, number>();
  if (T == null && !all)
    for (const d of list) {
      if (d.kind !== "area" || d.test) continue;
      const k = `${d.ep}|${d.model_id}`;
      const vf = d.valid_to != null && d.valid_to < now ? Infinity : d.valid_from ?? d.t;
      if (vf <= (curWin.get(k) ?? Infinity)) curWin.set(k, vf);
    }
  for (const d of list) {
    if (!all && !d.test && !d.hist && stopped.has(`${d.ep}|${d.model_id}`)) continue;
    if (!all && !d.test && eps.has(d.ep) && !d.model_id.startsWith("ensemble:") && !known.has(`${d.ep}|${d.model_id}`)) continue;
    if (!all && ((T == null && detEnd(d) < cut) || d.prob < o.minp || confOf(d) < o.minc || (o.model && d.model_id !== o.model) || (o.target && d.target !== o.target) || (d.kind === "area" && !o.areas))) continue;
    if (T == null && !all && d.kind === "area" && !d.test && curWin.has(`${d.ep}|${d.model_id}`) && (d.valid_from ?? d.t) !== curWin.get(`${d.ep}|${d.model_id}`)) continue;
    const t = tmeta(d.target);
    const props = {
      fid: fidOf(d.key), // 0.8.1: one stable id for all of a detection's features (hover / selection)
      conf: confOf(d), // 0.8.1: gate by confidence
      _cp: d.conf_parts ? JSON.stringify(d.conf_parts) : undefined,
      _sum: summarize(d),
      cells: d.storm_cells,
      hl: HL_TARGETS.has(d.target) ? 1 : 0,
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
      _ep: d.ep,
      area: d.kind === "area" ? 1 : 0,
      // regression areas (storm dBZ…) carry a value instead of a probability
      value: d.value,
      vtxt: d.value != null ? `${Math.round(d.value)}${unitOf(d.target)}` : `${Math.round(d.prob * 100)}%`,
      vf: d.valid_from,
      vt: d.valid_to,
      _trk: d.track?.length ? JSON.stringify(d.track) : undefined, // models 0.8
    };
    if (d.confidence == null) delete (props as any).conf;
    if (d.level === "high") hasHigh = true;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [d.lon, d.lat] }, properties: props });
    if (d.poly?.length) feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: d.poly }, properties: { ...props, kind: d.kind === "area" ? "area" : "box" } });
    if (d.track?.length && o.tracks !== "0") feats.push(...trackFeats(d, props, o.tracks));
    else if (d.motion && d.motion.kt > 2) {
      const km = d.motion.kt * 1.852 * 0.5; // 30 minutes
      const end = destination(d.lat, d.lon, d.motion.dir, km * 1000);
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[d.lon, d.lat], end] }, properties: { kind: "mv", level: d.level, prob: d.prob, conf: props.conf, fid: props.fid, model_id: d.model_id } });
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: end }, properties: { kind: "head", dir: d.motion.dir, level: d.level, prob: d.prob, conf: props.conf, fid: props.fid, model_id: d.model_id } });
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

/* ---------- 0.8.1: hover / selection highlight (feature-state on `fid`) ---------- */
const fids = new Map<string, number>();
let fidSeq = 0;
/** a stable numeric id per detection key (feature-state survives setData) */
function fidOf(key: string): number {
  let v = fids.get(key);
  if (v == null) {
    if (fids.size > 20_000) fids.clear();
    fids.set(key, (v = ++fidSeq));
  }
  return v;
}
let selFid: number | null = null;
let hovFid: number | null = null;
function fstate(fid: number | null, key: "hover" | "sel", on: boolean) {
  const m = mapRef.peek();
  const src = `o-${ID}`;
  if (!m || fid == null || !m.getSource(src)) return;
  try {
    m.setFeatureState({ source: src, id: fid }, { [key]: on });
  } catch {
    /* source reloading */
  }
}
/** highlight the storm / area of the detection whose popup is open */
export function selectDetection(fid: number | null) {
  if (selFid === fid) return;
  fstate(selFid, "sel", false);
  selFid = fid;
  fstate(fid, "sel", true);
}
effect(() => {
  const p = popup.value;
  if (!p || p.overlay !== ID) selectDetection(null);
});
const HOVER_LAYERS = ["icon", "halo", "box", "area", "trk", "cone"].map((k) => `o-${ID}-${k}`);
const hooked = new WeakSet<object>();
effect(() => {
  const m = mapRef.value;
  if (!m || hooked.has(m)) return;
  hooked.add(m);
  let last = 0;
  const setHover = (fid: number | null) => {
    if (fid === hovFid) return;
    fstate(hovFid, "hover", false);
    hovFid = fid;
    fstate(fid, "hover", true);
  };
  m.on("mousemove", (e) => {
    const now = performance.now();
    if (now - last < 50) return;
    last = now;
    if (!isOn(ID)) return setHover(null);
    const layers = HOVER_LAYERS.filter((l) => m.getLayer(l));
    if (!layers.length) return setHover(null);
    const f = m.queryRenderedFeatures(e.point, { layers })[0];
    const id = f?.properties?.fid;
    setHover(id != null && id !== "" ? +id : null);
  });
  m.getCanvas().addEventListener("mouseleave", () => setHover(null));
});

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
let lastSig = "";
effect(() => {
  void settings.value.ovl[ID];
  detMaxAgeMin.value = Math.max(detMaxAgeMin.value, opts().age);
  timeSync.value = opts().sync; // models 0.8
  // models 0.8: follow the timeline: detections at the frame time (history runs, the live loop)
  const T = detTime.value;
  void timeDets.value;
  const src = T == null ? detections.value : [...detsAt(T), ...detections.value.filter((d) => d.test)];
  const sig = T == null ? "" : `${JSON.stringify(settings.value.ovl[ID] ?? {})}|${[...stoppedModels.value].join(",")}|${src.map((d) => d.key).sort().join(",")}`;
  if (T != null && sig === lastSig && isOn(ID)) return;
  lastSig = sig;
  const fc = build(src);
  if (isOn(ID)) setData(ID, fc);
  detProbs.value = fc.features.filter((f: any) => f.properties.kind === "det").map((f: any) => f.properties.prob);
  detConfs.value = fc.features.filter((f: any) => f.properties.kind === "det").map((f: any) => f.properties.conf ?? 1);
  const by = new Map<string, { model_id: string; name: string; target: string; probs: number[]; confs: number[]; ep: string }>();
  for (const f of fc.features as any[]) {
    if (f.properties.kind !== "det") continue;
    const id = String(f.properties.model_id);
    if (!by.has(id)) by.set(id, { model_id: id, name: f.properties.model_name, target: f.properties.target, probs: [], confs: [], ep: f.properties._ep ?? "main" });
    by.get(id)!.probs.push(f.properties.prob);
    by.get(id)!.confs.push(f.properties.conf ?? 1);
  }
  detProbsBy.value = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  kickPulse();
});
// re-filter ageing detections once a minute
setInterval(() => isOn(ID) && detTime.peek() == null && setData(ID, build(detections.value)), 60_000);

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

// models 0.7: model outlook layer (registered after this one in the Severe group)
import "../ml/outlook";
