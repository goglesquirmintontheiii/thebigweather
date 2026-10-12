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
  const cur: InspData = { key, sweeps: {}, missing: [], loading: true, rot: [] };
  inspData.value = cur;
  const pub = () => !c.signal.aborted && (inspData.value = { ...cur, sweeps: { ...cur.sweeps } });
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
