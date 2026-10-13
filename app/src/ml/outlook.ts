// models 0.7: "Model outlook" map layer — SPC-style categorical outlooks produced by my outlook
// models (GET /api/ml/outlook). Drawn with SPC colours and stacking (TSTM under MRGL under SLGT …),
// category labels, a hazard switch (any / tornado / wind / hail), a day selector (1, 2, 3, 4–7 or a
// custom valid range) and an optional probability grid (the model's prob_layer as the weather layer).
// The probability gate (probgate.ts) filters polygons by their `prob`.

import { effect, signal, computed } from "@preact/signals";
import type { LayerSpecification } from "maplibre-gl";
import { OVERLAYS, overlayDef, type OverlayDef, type OptionDef, type Popup } from "../overlays/defs";
import { setData, isOn } from "../overlays/manager";
import { settings, update, type WeatherSel } from "../store";
import { fmtTime } from "../util";
import { models, mlReq, ensureModels, refreshGridCatalog, mkey, loadModel } from "./client";
import { gated, PG_OUT } from "./probgate";
import type { Ep, Model } from "./types";

export const OUT_ID = PG_OUT;
export const CATS = ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"] as const;
export type Cat = (typeof CATS)[number];
export const CAT_NAME: Record<Cat, string> = { TSTM: "General thunder", MRGL: "Marginal", SLGT: "Slight", ENH: "Enhanced", MDT: "Moderate", HIGH: "High" };
export const CAT_FILL: Record<Cat, string> = { TSTM: "#c1e9c1", MRGL: "#66a366", SLGT: "#ffe066", ENH: "#ffa366", MDT: "#e06666", HIGH: "#ff66ff" };
export const CAT_LINE: Record<Cat, string> = { TSTM: "#55bb55", MRGL: "#005500", SLGT: "#ddaa00", ENH: "#ff6600", MDT: "#cc0000", HIGH: "#cc00cc" };
export const HAZARDS: [string, string][] = [["any", "Any severe"], ["tornado", "Tornado"], ["wind", "Wind"], ["hail", "Hail"]];
export const DAYS: [string, string][] = [["1", "Day 1"], ["2", "Day 2"], ["3", "Day 3"], ["4-7", "Day 4–7"], ["custom", "Custom range"]];
const rank = (c: string) => Math.max(0, CATS.indexOf(String(c).toUpperCase() as Cat));
// the server sends each category's SPC colour (`color`); the table is the fallback
const fillExpr: any = ["coalesce", ["get", "color"], ["match", ["get", "cat"], ...CATS.flatMap((c) => [c, CAT_FILL[c]]), "#888"]];
const lineExpr: any = ["match", ["get", "cat"], ...CATS.flatMap((c) => [c, CAT_LINE[c]]), "#555"];

export const outlookModels = computed(() => models.value.filter((m) => m.output === "outlook" || m.target === "outlook"));
/** an outlook model predicts one hazard (spec.target_params.hazard); the server refuses another */
export function hazardOf(m: Model): string {
  const h = (m.spec as any)?.target_params?.hazard;
  if (typeof h === "string" && h) return h;
  const ls: string[] = Array.isArray(m.spec?.label_source) ? (m.spec!.label_source as string[]) : [];
  if (ls.length === 1) return ls[0].replace(/^spc_/, "");
  return /tornado/i.test(m.name) ? "tornado" : /\bwind/i.test(m.name) ? "wind" : /\bhail/i.test(m.name) ? "hail" : "any";
}
/** what the overlay shows: "ep|id" of the model, day, hazard, custom range. The hazard switch picks
 *  among the outlook models of that hazard (a model only answers for its own hazard). */
export function outOpts() {
  const o = settings.value.ovl[OUT_ID]?.opts ?? {};
  const list = outlookModels.value;
  const hz: string | undefined = o.hazard;
  const cur = o.model ? list.find((m) => mkey(m) === o.model || m.id === o.model) : undefined;
  const pick = cur && (!hz || hazardOf(cur) === hz) ? cur : hz ? list.find((m) => hazardOf(m) === hz) : list[0];
  const mk = pick ? mkey(pick) : "";
  return { model: mk, day: o.day ?? "1", hazard: pick ? hazardOf(pick) : hz ?? "any", want: hz ?? "", from: o.from ? +o.from : undefined, to: o.to ? +o.to : undefined, labels: (o.labels ?? "1") === "1" };
}
// the model list has no specs: fetch outlook models' details once so their hazard is known
const specAsked = new Set<string>();
effect(() => {
  for (const m of outlookModels.value) if (!m.spec && !specAsked.has(mkey(m))) (specAsked.add(mkey(m)), loadModel(m.ep, m.id));
});
export function setOutOpt(k: string, v: string | undefined) {
  update((s) => {
    const cur = s.ovl[OUT_ID] ?? { on: false };
    const opts = { ...(cur.opts ?? {}) };
    if (v === undefined) delete opts[k];
    else opts[k] = v;
    // choosing a model also chooses its hazard (and vice versa, see outOpts)
    if (k === "model" && v) {
      const m = outlookModels.peek().find((x) => mkey(x) === v);
      if (m) opts.hazard = hazardOf(m);
    }
    s.ovl[OUT_ID] = { ...cur, opts };
  });
}
export function showOutlook(m?: Model, day?: string) {
  update((s) => {
    const cur = s.ovl[OUT_ID] ?? { on: false };
    s.ovl[OUT_ID] = { ...cur, on: true, opts: { ...(cur.opts ?? {}), ...(m ? { model: mkey(m) } : {}), ...(day ? { day } : {}) } };
  });
}

const def: OverlayDef = {
  id: OUT_ID,
  name: "Model outlook (my outlook models)",
  group: "Severe",
  feed: "client",
  refresh: 0,
  get options(): OptionDef[] {
    return [
      { key: "model", label: "Model", choices: outlookModels.value.map((m) => [mkey(m), m.name] as [string, string]), def: "" },
      { key: "day", label: "Day", choices: DAYS, def: "1" },
      { key: "hazard", label: "Hazard", choices: HAZARDS, def: "any" },
      { key: "labels", label: "Category labels", choices: [["1", "On"], ["0", "Off"]], def: "1" },
    ];
  },
  style: { opacity: 0.55, size: 1.6, labels: true },
  layers: (s, st) =>
    gated(OUT_ID, [
      { id: `${s}-fill`, type: "fill", source: s, layout: { "fill-sort-key": ["get", "rank"] }, paint: { "fill-color": fillExpr, "fill-opacity": st.opacity } } as LayerSpecification,
      { id: `${s}-line`, type: "line", source: s, layout: { "line-join": "round", "line-sort-key": ["get", "rank"] }, paint: { "line-color": lineExpr, "line-width": 1.4 * st.size, "line-opacity": Math.min(1, st.opacity + 0.35) } } as LayerSpecification,
      ...(st.labels
        ? [
            {
              id: `${s}-lbl`,
              type: "symbol",
              source: s,
              minzoom: 3.5,
              layout: { "symbol-sort-key": ["-", 10, ["get", "rank"]], "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-padding": 20 },
              paint: { "text-color": lineExpr, "text-halo-color": "#fff", "text-halo-width": 1.6 },
            } as LayerSpecification,
          ]
        : []),
    ]),
  click: (p): Popup => {
    const c = String(p.cat).toUpperCase() as Cat;
    const rows: [string, string][] = [
      ["Category", `${CAT_NAME[c] ?? c} (${c})`],
      ["Probability", p.prob != null && p.prob !== "" ? `≥ ${Math.round(+p.prob * (+p.prob <= 1 ? 100 : 1))}%${p.max_prob != null && p.max_prob !== "" ? ` (max ${Math.round(+p.max_prob * 100)}%)` : ""}` : "—"],
      ["Hazard", HAZARDS.find(([k]) => k === p.hazard)?.[1] ?? p.hazard ?? "Any"],
      ["Day", String(p.day ?? "—")],
    ];
    if (p.valid_from) rows.push(["Valid", `${fmtTime(+p.valid_from, true)}${p.valid_to ? ` → ${fmtTime(+p.valid_to, true)}` : ""}`]);
    if (p.model_name) rows.push(["Model", String(p.model_name)]);
    return { title: `${CAT_NAME[c] ?? c} risk${p.label && p.label !== c ? ` · ${p.label}` : ""}`, sub: "My outlook model (not an official SPC product)", color: CAT_FILL[c] ?? "#888", rows };
  },
  note: "Outlooks from your outlook models (Detection models → Run). SPC colours: TSTM light green, MRGL dark green, SLGT yellow, ENH orange, MDT red, HIGH magenta. Not an official SPC product.",
};
if (!overlayDef(OUT_ID)) {
  const j = OVERLAYS.findIndex((o) => o.id === "mldetect");
  const i = j >= 0 ? j : OVERLAYS.reduce((a, o, k) => (o.group === "Severe" ? k : a), -1);
  OVERLAYS.splice(i < 0 ? OVERLAYS.length : i + 1, 0, def);
}

// ---------- data ----------
export const outlookData = signal<{ fc: any; prob_layer?: string; err?: string; loading?: boolean; t?: number; valid_from?: number; valid_to?: number; issued?: number; computed_now?: boolean; hazard?: string; levels?: { prob: number; cat: string }[] }>({ fc: { type: "FeatureCollection", features: [] } });
export const outProbs = computed(() => (outlookData.value.fc?.features ?? []).map((f: any) => +f.properties?.prob || 0));
const tms = (v: any) => (v == null || v === "" ? undefined : typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Date.parse(v) || undefined);

let seq = 0;
export async function loadOutlook() {
  const o = outOpts();
  if (!o.model) {
    const hz = HAZARDS.find(([k]) => k === o.want)?.[1];
    outlookData.value = { fc: { type: "FeatureCollection", features: [] }, err: outlookModels.value.length && hz ? `No ${hz.toLowerCase()} outlook model — train one (Train → Outlook, hazard ${hz})` : "No outlook model yet — train one (Train → Outlook)" };
    if (isOn(OUT_ID)) setData(OUT_ID, outlookData.value.fc);
    return;
  }
  const [ep, id] = o.model.includes("|") ? (o.model.split("|") as [Ep, string]) : (["main", o.model] as [Ep, string]);
  // the model decides the hazard; sending another one is refused (400)
  const q = new URLSearchParams({ model: id });
  if (o.day === "custom") {
    if (o.from) q.set("from", String(o.from));
    if (o.to) q.set("to", String(o.to));
  } else q.set("day", o.day);
  const my = ++seq;
  outlookData.value = { ...outlookData.value, loading: true };
  try {
    const r = await mlReq<any>(ep, "GET", `/api/ml/outlook?${q}`);
    if (my !== seq) return;
    const name = models.value.find((m) => m.id === id)?.name ?? "";
    const feats = (Array.isArray(r?.features) ? r.features : [])
      .filter((f: any) => f?.geometry)
      .map((f: any) => {
        const p = f.properties ?? {};
        const cat = String(p.cat ?? "TSTM").toUpperCase();
        let prob = +p.prob;
        if (!Number.isFinite(prob)) prob = (rank(cat) + 1) / 7;
        if (prob > 1) prob /= 100;
        return { ...f, properties: { ...p, cat, rank: rank(cat), label: p.label || cat, prob, hazard: p.hazard ?? o.hazard, valid_from: tms(p.valid_from), valid_to: tms(p.valid_to), model_name: name } };
      })
      .sort((a: any, b: any) => a.properties.rank - b.properties.rank);
    const fc = { type: "FeatureCollection", features: feats };
    const vf = feats.map((f: any) => f.properties.valid_from).filter(Boolean);
    const vt = feats.map((f: any) => f.properties.valid_to).filter(Boolean);
    outlookData.value = { fc, prob_layer: r?.prob_layer || undefined, t: Date.now(), valid_from: tms(r?.valid_from) ?? (vf.length ? Math.min(...vf) : undefined), valid_to: tms(r?.valid_to) ?? (vt.length ? Math.max(...vt) : undefined), issued: tms(r?.issued), computed_now: !!r?.computed_now, hazard: r?.hazard, levels: Array.isArray(r?.levels) ? r.levels : undefined };
    if (r?.prob_layer) refreshGridCatalog();
  } catch (e: any) {
    if (my !== seq) return;
    outlookData.value = { fc: { type: "FeatureCollection", features: [] }, err: e.message };
  }
  if (isOn(OUT_ID)) setData(OUT_ID, outlookData.value.fc);
}

let lastSig = "";
effect(() => {
  const on = isOn(OUT_ID);
  if (!on) return void (lastSig = "");
  ensureModels();
  const sig = JSON.stringify(outOpts());
  if (sig === lastSig) return void setData(OUT_ID, outlookData.peek().fc);
  lastSig = sig;
  loadOutlook();
});
// new model runs: refresh every 10 minutes while shown
setInterval(() => isOn(OUT_ID) && document.visibilityState !== "hidden" && loadOutlook(), 10 * 60_000);

// ---------- probability grid toggle (prob_layer as the weather layer) ----------
let prevWeather: WeatherSel | null = null;
export const probGridOn = computed(() => {
  const w = settings.value.weather;
  const pl = outlookData.value.prob_layer;
  return !!pl && w.kind === "grid" && w.id === pl;
});
export function toggleProbGrid() {
  const pl = outlookData.peek().prob_layer;
  if (!pl) return;
  update((s) => {
    if (s.weather.kind === "grid" && s.weather.id === pl) s.weather = prevWeather ?? { kind: "radar" };
    else {
      prevWeather = s.weather;
      s.weather = { kind: "grid", id: pl };
    }
  });
}
