// Value filter ("gate") for the weather layer: hide values below a low and/or above a high limit.
// Limits are stored per legend key in native product units; the GPU layers read them every frame,
// so dragging a handle on the legend updates the map without re-uploading data.

import { signal, computed, effect } from "@preact/signals";
import { settings } from "./store";
import { tableKeyFor } from "./radar/controller";

export interface Gate {
  lo?: number;
  hi?: number;
  /** compare |v| (velocity: hide low speeds both ways) */
  abs?: boolean;
  off?: boolean;
}

/** handle being dragged on the legend: live value until pointerup commits it to settings */
export const gateDrag = signal<{ key: string; g: Gate } | null>(null);

export function radarGateKey(product: string) {
  return `r:${tableKeyFor(product)}`;
}
export function gridGateKey(layerId: string) {
  return `g:${layerId}`;
}
/** key of the main window's weather layer (when the layer has no key of its own) */
export function mainGridKey() {
  const w = settings.peek().weather;
  return w.kind === "grid" ? gridGateKey(w.id) : "";
}

/** The gate to draw with ([min, max, abs]) or null when nothing is filtered. */
export function gateFor(key: string): [number, number, boolean] | null {
  if (!key) return null;
  const d = gateDrag.peek();
  const g = d && d.key === key ? d.g : settings.peek().gates?.[key];
  if (!g || g.off || (g.lo === undefined && g.hi === undefined)) return null;
  return [g.lo ?? -1e30, g.hi ?? 1e30, !!g.abs];
}

export function gateActive(key: string): boolean {
  return gateFor(key) !== null;
}

// repaint layers whenever any gate changes
const sig = computed(() => JSON.stringify(settings.value.gates ?? {}) + JSON.stringify(gateDrag.value));
const listeners = new Set<() => void>();
effect(() => {
  void sig.value;
  for (const f of listeners) f();
});
export function onGateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
