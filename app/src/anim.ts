// Shared animation state for whichever weather layer is visible.

import { signal, effect } from "@preact/signals";
import { settings, toast } from "./store";

export const frameIndex = signal(0);
export const playing = signal(false);
/** number of frames of the active weather layer (set by the active controller) */
export const frameCount = signal(0);

/** The active layer tells the loop which frames are ready to draw, so playback never shows a
 * blank frame (it skips ahead or waits instead of flickering). */
let readyFn: (i: number) => boolean = () => true;
export function setFrameReady(fn: (i: number) => boolean) {
  readyFn = fn;
}

let timer: number | undefined;
function step() {
  const n = frameCount.value;
  if (!playing.value || n < 2) return;
  const s = settings.value.anim;
  let next = -1;
  for (let k = 1; k <= n; k++) {
    const j = (frameIndex.value + k) % n;
    if (readyFn(j)) {
      next = j;
      break;
    }
  }
  if (next < 0 || next === frameIndex.value) {
    // nothing else ready yet: check again shortly
    timer = window.setTimeout(step, 120);
    return;
  }
  frameIndex.value = next;
  // dwell on the newest ready frame
  let last = n - 1;
  while (last > 0 && !readyFn(last)) last--;
  timer = window.setTimeout(step, next === last ? s.dwellMs : 1000 / s.fps);
}

effect(() => {
  clearTimeout(timer);
  if (playing.value) timer = window.setTimeout(step, 1000 / settings.value.anim.fps);
});

export function togglePlay() {
  if (frameCount.value < 2) {
    toast("Need at least 2 frames to animate", "info");
    return;
  }
  playing.value = !playing.value;
}

export function stepFrame(d: number) {
  const n = frameCount.value;
  if (!n) return;
  playing.value = false;
  frameIndex.value = (frameIndex.value + d + n) % n;
}

// ---------- frame count / time span and history (shared by all weather layers) ----------

/** History mode: newest frame time (unix ms) instead of "now". null = live. */
export const historyEnd = signal<number | null>(null);

/** How many frames to ask the server for, given the layer's cadence in minutes. */
export function framesToRequest(countSetting: number, cadenceMin: number, cap = 240): number {
  const a = settings.value.anim;
  if (a.mode === "time") return Math.max(2, Math.min(cap, Math.ceil(a.minutes / cadenceMin) + 2));
  return Math.max(1, Math.min(cap, countSetting));
}

/** In time mode keep only frames within the span ending at the newest frame. */
export function trimToSpan<T extends { time: number }>(list: T[]): T[] {
  const a = settings.value.anim;
  if (a.mode !== "time" || !list.length) return list;
  const newest = list[list.length - 1].time;
  const out = list.filter((f) => f.time >= newest - a.minutes * 60_000 - 30_000);
  return out.length ? out : list.slice(-1);
}

/** Speed steps for the 0.25–16 fps slider. */
export const FPS_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16];
