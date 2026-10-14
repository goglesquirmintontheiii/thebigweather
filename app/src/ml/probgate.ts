// models 0.7: probability "gate" for the model layers (Model detections, model outlooks): hide
// features whose `prob` is outside [lo, hi]. Same storage and live-drag signal as the radar legend
// gate (gate.ts: settings.gates + gateDrag), keyed "p:<overlay id>", values 0–1. The map is updated
// with MapLibre setFilter on the overlay's own layers — no refetch, no re-upload.

import { effect, signal } from "@preact/signals";
import type { ExpressionSpecification } from "maplibre-gl";
import { settings, update } from "../store";
import { gateDrag, type Gate } from "../gate";
import { mapRef } from "../map/mapview";

export const PG_DET = "mldetect";
export const PG_OUT = "mloutlook";
export const pgKey = (layer: string) => `p:${layer}`;

/** current window (live while a handle is dragged) */
export function probGate(layer: string): { lo: number; hi: number; on: boolean; g: Gate } {
  const key = pgKey(layer);
  const d = gateDrag.value;
  const g: Gate = d && d.key === key ? d.g : settings.value.gates?.[key] ?? {};
  const on = !g.off && (g.lo !== undefined || g.hi !== undefined);
  return { lo: on ? g.lo ?? 0 : 0, hi: on ? g.hi ?? 1 : 1, on, g };
}
export function probGatePeek(layer: string): [number, number] | null {
  const key = pgKey(layer);
  const d = gateDrag.peek();
  const g: Gate = d && d.key === key ? d.g : settings.peek().gates?.[key] ?? {};
  if (g.off || (g.lo === undefined && g.hi === undefined)) return null;
  return [g.lo ?? 0, g.hi ?? 1];
}
export function setProbGate(layer: string, g: Gate) {
  const key = pgKey(layer);
  update((s) => {
    s.gates = { ...(s.gates ?? {}) };
    if (g.lo === undefined && g.hi === undefined && !g.off) delete s.gates[key];
    else s.gates[key] = g;
  });
}
/* 0.8.1: the detections gate filters by probability or by confidence (a switch on the gate) */
export type GateBy = "prob" | "conf";
export const gateBy = (): GateBy => (settings.peek().ml?.gateBy === "conf" ? "conf" : "prob");
export function setGateBy(v: GateBy) {
  update((s) => (s.ml = { ...(s.ml ?? {}), gateBy: v }));
}
/** the feature property a layer's gate reads (confidence: unknown counts as 1, i.e. passes) */
const gateProp = (layer: string): any[] => (layer.startsWith(PG_DET) && gateBy() === "conf" ? ["to-number", ["get", "conf"], 1] : ["to-number", ["get", "prob"], 0]);

/** true when p passes the saved gate of a layer (models 0.8: per-model gate when given the model;
 *  0.8.1: `conf` is tested instead when the detections gate filters by confidence) */
export function passesGate(layer: string, p: number, model_id?: string, conf?: number): boolean {
  if (layer === PG_DET && gateBy() === "conf") p = conf != null && Number.isFinite(conf) ? conf : 1;
  if (model_id && layer === PG_DET && perModelOn()) {
    const g = perModelWins().get(model_id);
    if (g) return p >= g[0] - 1e-9 && p <= g[1] + 1e-9;
    return true;
  }
  const w = probGatePeek(layer);
  return !w || (p >= w[0] - 1e-9 && p <= w[1] + 1e-9);
}

/* ---------- models 0.8: per-model gates for the detections layer ----------
 * Expanded legend: each model gets its own window, stored as gate "p:mldetect@<model_id>";
 * settings.ml.perModelGates switches between the combined gate and the per-model ones. */
export const pmLayer = (model_id: string) => `${PG_DET}@${model_id}`;
export const perModelOn = () => !!settings.peek().ml?.perModelGates;
export function setPerModel(on: boolean) {
  update((s) => (s.ml = { ...(s.ml ?? {}), perModelGates: on }));
}
/** model id → window, for models whose own gate is set */
function perModelWins(): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const pre = pgKey(`${PG_DET}@`);
  const d = gateDrag.peek();
  const keys = new Set([...Object.keys(settings.peek().gates ?? {}), ...(d ? [d.key] : [])]);
  for (const k of keys) {
    if (!k.startsWith(pre)) continue;
    const w = probGatePeek(k.slice(2));
    if (w) out.set(k.slice(pre.length), w);
  }
  return out;
}

/** scrub mode per layer (dragging a handle moves the whole window) */
export const scrub = signal<Record<string, boolean>>({});

// ---------- layer registry: each gated map layer remembers its own filter ----------
const base = new Map<string, { layer: string; f: any }>();
const gexpr = (w: [number, number] | null, layer = ""): ExpressionSpecification | null =>
  w ? (["all", [">=", gateProp(layer), w[0] - 1e-9], ["<=", gateProp(layer), w[1] + 1e-9]] as any) : null;
/** the layer's filter: the combined window, or (detections, expanded) one window per model */
function layerExpr(layer: string): ExpressionSpecification | null {
  if (layer !== PG_DET || !perModelOn()) return gexpr(probGatePeek(layer), layer);
  const wins = perModelWins();
  if (!wins.size) return null;
  const ids = [...wins.keys()];
  const parts: any[] = ids.map((id) => ["all", ["==", ["to-string", ["get", "model_id"]], id], gexpr(wins.get(id)!, layer)]);
  // models without their own gate: everything passes
  parts.push(["!", ["in", ["to-string", ["get", "model_id"]], ["literal", ids]]]);
  return ["any", ...parts] as any;
}
/** wrap the layers of an overlay so they carry the gate (call from OverlayDef.layers) */
export function gated<T extends { id: string; filter?: any }>(layer: string, specs: T[], skip: (s: T) => boolean = () => false): T[] {
  const g0 = layerExpr(layer);
  return specs.map((s) => {
    if (skip(s)) return s;
    base.set(s.id, { layer, f: s.filter });
    const g = g0;
    return g ? { ...s, filter: s.filter ? ["all", s.filter, g] : g } : s;
  });
}
function apply() {
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  const wins = new Map<string, any>();
  for (const [id, { layer, f }] of base) {
    if (!m.getLayer(id)) continue;
    if (!wins.has(layer)) wins.set(layer, layerExpr(layer));
    const g = wins.get(layer);
    try {
      m.setFilter(id, g ? (f ? ["all", f, g] : g) : f ?? null);
    } catch {
      /* layer gone */
    }
  }
}
let raf = 0;
effect(() => {
  // any gate change or live drag
  void gateDrag.value;
  void settings.value.gates;
  void settings.value.ml?.perModelGates; // models 0.8
  void settings.value.ml?.gateBy; // 0.8.1
  if (!raf) raf = requestAnimationFrame(() => ((raf = 0), apply()));
});
