// radar 0.6: data behind the Inspector readout — every Level II moment of the frame on screen at the
// selected tilt (plus the derived CREF/ET/VIL), fetched lazily per frame and cancelled on frame change.

import { signal, effect } from "@preact/signals";
import { settings } from "../store";
import { currentFrame, playing, DERIVED } from "./controller";
import { volMeta, sweepAt, nearestTilt, rotationFor, freezingLevels, type Levels } from "./r6data";
import type { Sweep } from "./sweep";

export const INSPECT_MOMENTS = ["REF", "VEL", "SW", "ZDR", "RHO", "PHI", "KDP", "CREF", "ET", "VIL"];

export interface InspData {
  key: string;
  sweeps: Record<string, Sweep>;
  missing: string[];
  loading: boolean;
  rot: any[];
  levels?: Levels;
}
export const inspData = signal<InspData | null>(null);

export function inspectorOn(): boolean {
  return !!settings.value.radar6?.inspector;
}

let ctl: AbortController | null = null;
let timer: number | undefined;

async function fetchAll(key: string, angle: number) {
  ctl?.abort();
  const c = new AbortController();
  ctl = c;
  await loadInto(key, angle, c, (d) => (inspData.value = d));
}

/** every moment of one volume at one tilt, published as it arrives */
async function loadInto(key: string, angle: number, c: AbortController, out: (d: InspData) => void) {
  const cur: InspData = { key, sweeps: {}, missing: [], loading: true, rot: [] };
  out(cur);
  const pub = () => !c.signal.aborted && out({ ...cur, sweeps: { ...cur.sweeps } });
  try {
    const meta = await volMeta(key);
    if (c.signal.aborted) return;
    freezingLevels(meta.lat, meta.lon).then((l) => ((cur.levels = l), pub()));
    rotationFor(key)
      .then((fc) => ((cur.rot = fc.features ?? []), pub()))
      .catch(() => {});
    await Promise.all(
      INSPECT_MOMENTS.map(async (m) => {
        const t = DERIVED.has(m) ? { index: 0, angle: angle } : nearestTilt(meta, m, angle);
        if (!t || Math.abs(t.angle - angle) > 0.7) {
          cur.missing.push(m);
          return;
        }
        try {
          const s = await sweepAt(key, t.index, m, c.signal);
          if (c.signal.aborted) return;
          cur.sweeps[m] = s;
          pub();
        } catch {
          cur.missing.push(m);
        }
      }),
    );
  } catch {
    /* meta unavailable */
  }
  if (c.signal.aborted) return;
  cur.loading = false;
  pub();
}

effect(() => {
  const active = inspectorOn();
  const r = settings.value.radar;
  const key = currentFrame.value?.key ?? "";
  const play = playing.value;
  clearTimeout(timer);
  if (!active || r.source !== "L2" || !key) {
    ctl?.abort();
    ctl = null;
    inspData.value = null;
    return;
  }
  if (inspData.peek()?.key === key) return;
  // while animating, only fetch once the loop pauses
  if (play) return;
  timer = window.setTimeout(() => fetchAll(key, r.tiltAngle), 200);
});

// the tilt changed: refetch for the same frame
let lastTilt = NaN;
effect(() => {
  const a = settings.value.radar.tiltAngle;
  if (a === lastTilt) return;
  lastTilt = a;
  if (inspectorOn() && currentFrame.value?.key && !playing.peek()) fetchAll(currentFrame.value.key, a);
});

/* ---------- 0.8.3 inspector: map panes (their own radar / time / tilt) ---------- */
/** per-pane Inspector data (pane index → data of the frame shown there) */
export const paneInspData = signal<Record<number, InspData>>({});
const paneCtl = new Map<number, { key: string; angle: number; c: AbortController; timer?: number; own: boolean }>();
const sameAsMain = (key: string, angle: number) => inspData.peek()?.key === key && Math.abs(settings.peek().radar.tiltAngle - angle) < 0.05;

/** Ask for every moment of the volume a pane shows (debounced; cancels that pane's previous load).
 * Reuses the main map's data when the pane shows the same volume and tilt. Cheap to call often. */
export function wantPaneInsp(idx: number, key: string | undefined, angle: number) {
  const prev = paneCtl.get(idx);
  if (!key || !inspectorOn()) {
    if (prev) (prev.c.abort(), clearTimeout(prev.timer), paneCtl.delete(idx));
    return;
  }
  const main = sameAsMain(key, angle);
  if (prev && prev.key === key && prev.angle === angle && (prev.own || main)) return;
  if (prev) (prev.c.abort(), clearTimeout(prev.timer));
  const c = new AbortController();
  const ent = { key, angle, c, timer: undefined as number | undefined, own: !main };
  paneCtl.set(idx, ent);
  if (main) return; // same as the main map
  ent.timer = window.setTimeout(() => {
    if (c.signal.aborted) return;
    loadInto(key, angle, c, (d) => (paneInspData.value = { ...paneInspData.peek(), [idx]: d }));
  }, 250);
}

/** the Inspector data for what a pane shows (null until loaded) */
export function paneInspFor(idx: number, key: string | undefined, angle: number): InspData | null {
  if (!key) return null;
  const main = inspData.value;
  if (main?.key === key && Math.abs(settings.value.radar.tiltAngle - angle) < 0.05) return main;
  const d = paneInspData.value[idx];
  return d?.key === key ? d : null;
}

/** forget a closed pane */
export function dropPaneInsp(idx: number) {
  const p = paneCtl.get(idx);
  if (p) (p.c.abort(), clearTimeout(p.timer), paneCtl.delete(idx));
  if (paneInspData.peek()[idx]) {
    const n = { ...paneInspData.peek() };
    delete n[idx];
    paneInspData.value = n;
  }
}

effect(() => {
  if (!inspectorOn()) for (const i of [...paneCtl.keys()]) dropPaneInsp(i);
});
