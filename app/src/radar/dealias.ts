// radar 0.6: velocity dealiasing for display. A worker unfolds the VEL sweep on screen
// (best-first region growing from a low-velocity seed per echo region, using the sweep's Nyquist);
// the result is a new Sweep object the RadarLayer uploads like any other. SRV is computed from VEL in
// the shader, so it uses the dealiased values too. Only the sweep asked for is processed (latest wins).

import { signal } from "@preact/signals";
import { settings } from "../store";
import type { Sweep } from "./sweep";
import { dealiasWorker, wsweep } from "./r6data";

/** bumps when a dealiased sweep becomes ready (the controller re-renders on it) */
export const dealiasTick = signal(0);
export const dealiasState = signal<{ busy: boolean; last?: { ms: number; vn: number; comps: number }; error?: string }>({ busy: false });

/** small LRU (a dealiased copy is ~2.6 MB for a full Level II sweep) */
const done = new Map<Sweep, Sweep>();
const DONE_MAX = 24;
const failed = new WeakSet<Sweep>();
let running: Sweep | null = null;
let next: Sweep | null = null;

export function dealiasOn(): boolean {
  return !!settings.value.radar6?.dealias;
}

/** The sweep to draw/sample: the dealiased copy of a velocity sweep when ready, else the input. */
export function dealiased<T extends Sweep | undefined>(s: T): T {
  if (!s) return s;
  void dealiasTick.value;
  if (!dealiasOn() || s.product !== "VEL") return s;
  const d = done.get(s);
  if (d) {
    done.delete(s);
    done.set(s, d);
    return d as T;
  }
  // deferred: this runs inside computed signals, which mustn't write signals
  if (!failed.has(s)) queueMicrotask(() => request(s));
  return s;
}

/** Already-dealiased copy without triggering work. */
export function dealiasedIfReady(s: Sweep): Sweep {
  return (dealiasOn() && done.get(s)) || s;
}

function request(s: Sweep) {
  if (running === s || next === s) return;
  if (running) {
    next = s;
    return;
  }
  run(s);
}

async function run(s: Sweep) {
  running = s;
  dealiasState.value = { ...dealiasState.value, busy: true };
  const t0 = performance.now();
  try {
    const r = await dealiasWorker.run<{ vals: Float32Array; vn: number; comps: number }>("dealias", { s: wsweep(s), nyq: s.nyquist });
    done.set(s, encode(s, r.vals));
    while (done.size > DONE_MAX) done.delete(done.keys().next().value!);
    dealiasState.value = { busy: false, last: { ms: Math.round(performance.now() - t0), vn: r.vn, comps: r.comps } };
    dealiasTick.value++;
  } catch (e: any) {
    failed.add(s);
    dealiasState.value = { busy: false, error: e.message };
  } finally {
    running = null;
    const n = next;
    next = null;
    if (n && !done.has(n) && dealiasOn()) run(n);
  }
}

const SCALE = 2;
const OFFSET = 1000;
/** 16-bit copy (0 = no data, 1 = range folded) */
function encode(s: Sweep, vals: Float32Array): Sweep {
  const data = new Uint16Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    data[i] = Number.isNaN(v) ? 0 : v === -9999 ? 1 : Math.max(2, Math.min(65535, Math.round(v * SCALE + OFFSET)));
  }
  return { ...s, key: `${s.key}|dealias`, word: 2, lut: null, scale: SCALE, offset: OFFSET, data, bytes: data.byteLength };
}
