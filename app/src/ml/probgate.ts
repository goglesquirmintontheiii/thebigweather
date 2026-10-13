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
/** true when p passes the saved gate of a layer */
export function passesGate(layer: string, p: number): boolean {
  const w = probGatePeek(layer);
  return !w || (p >= w[0] - 1e-9 && p <= w[1] + 1e-9);
}

/** scrub mode per layer (dragging a handle moves the whole window) */
export const scrub = signal<Record<string, boolean>>({});

// ---------- layer registry: each gated map layer remembers its own filter ----------
const base = new Map<string, { layer: string; f: any }>();
const gexpr = (w: [number, number] | null): ExpressionSpecification | null =>
  w ? ["all", [">=", ["to-number", ["get", "prob"], 0], w[0] - 1e-9], ["<=", ["to-number", ["get", "prob"], 0], w[1] + 1e-9]] : null;
/** wrap the layers of an overlay so they carry the gate (call from OverlayDef.layers) */
export function gated<T extends { id: string; filter?: any }>(layer: string, specs: T[], skip: (s: T) => boolean = () => false): T[] {
  const w = probGatePeek(layer);
  return specs.map((s) => {
    if (skip(s)) return s;
    base.set(s.id, { layer, f: s.filter });
    const g = gexpr(w);
    return g ? { ...s, filter: s.filter ? ["all", s.filter, g] : g } : s;
  });
}
function apply() {
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  const wins = new Map<string, any>();
  for (const [id, { layer, f }] of base) {
    if (!m.getLayer(id)) continue;
    if (!wins.has(layer)) wins.set(layer, gexpr(probGatePeek(layer)));
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
  if (!raf) raf = requestAnimationFrame(() => ((raf = 0), apply()));
});
