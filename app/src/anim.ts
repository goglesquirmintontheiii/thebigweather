// Shared animation state for whichever weather layer is visible.

import { signal, effect, computed, batch } from "@preact/signals";
import { thinEven } from "./timematch";
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
  const s = playback();
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
  if (playing.value) timer = window.setTimeout(step, 1000 / playback().fps);
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
/** History mode: oldest frame time (unix ms). */
export const historyStart = signal<number | null>(null);
/** Default history length when only an end time is given (never taken from the live loop settings). */
export const HIST_DEFAULT_MS = 3 * 3600_000;

/** The history window, or null when live. */
export const histRange = computed<{ start: number; end: number } | null>(() => {
  const end = historyEnd.value;
  if (end == null) return null;
  return { start: historyStart.value ?? end - HIST_DEFAULT_MS, end };
});

/** Playback speed / pause-on-last: the live loop's (`anim`) or, while history mode is on, history's own. */
export function playback(): { fps: number; dwellMs: number } {
  const s = settings.value;
  return histRange.value ? { fps: s.hist?.fps ?? s.anim.fps, dwellMs: s.hist?.dwellMs ?? s.anim.dwellMs } : s.anim;
}

/** Live play state saved on entering history (restored on exit, with the live loop settings that
 * history never touches). */
let livePlaying: boolean | null = null;

/** Enter (or change) history mode for [start, end]; null leaves it. */
export function setHistory(start: number | null, end: number | null) {
  batch(() => {
    const wasHist = historyEnd.peek() != null;
    if (end != null && !wasHist) livePlaying = playing.peek();
    playing.value = end == null && wasHist ? !!livePlaying : false;
    if (end == null) livePlaying = null;
    historyStart.value = end == null ? null : start ?? end - HIST_DEFAULT_MS;
    historyEnd.value = end;
  });
}

/* ---------- workflow: bandwidth saver caps live frame counts (saver.ts sets this) ---------- */
let liveFrameCap: () => number = () => Infinity;
export function setLiveFrameCap(fn: () => number) {
  liveFrameCap = fn;
}
/* ---------- end workflow ---------- */

/** Most frames any layer loads for a history window by default (history settings → Max frames). */
export const HIST_CAP = 200;

/** How many frames to ask the server for, given the layer's cadence in minutes. Live: the loop
 * settings (count or time span, saver cap). History: enough to cover the window (thinned later). */
export function framesToRequest(countSetting: number, cadenceMin: number, cap = 240): number {
  const h = histRange.value;
  if (h) return Math.max(2, Math.min(cap, Math.ceil((h.end - h.start) / 60_000 / cadenceMin) + 2));
  cap = Math.min(cap, liveFrameCap()); // workflow: bandwidth saver
  const a = settings.value.anim;
  if (a.mode === "time") return Math.max(2, Math.min(cap, Math.ceil(a.minutes / cadenceMin) + 2));
  return Math.max(1, Math.min(cap, countSetting));
}

/** Live frame list → the loop's frames: last `count` (count mode) or the time span (time mode),
 * capped by the bandwidth saver. */
export function liveLoop<T extends { time: number }>(list: T[], countSetting: number): T[] {
  const a = settings.value.anim;
  const out = a.mode === "time" ? spanOf(list, a.minutes) : list.slice(-Math.max(1, countSetting));
  const cap = liveFrameCap();
  return Number.isFinite(cap) ? out.slice(-Math.max(1, cap)) : out;
}

function spanOf<T extends { time: number }>(list: T[], minutes: number): T[] {
  if (!list.length) return list;
  const newest = list[list.length - 1].time;
  const out = list.filter((f) => f.time >= newest - minutes * 60_000 - 30_000);
  return out.length ? out : list.slice(-1);
}

/** History frames: keep one frame per `step` minutes (0 = every volume/frame), then at most
 * `maxFrames`, evenly spaced (first and last always kept). */
export function histThin<T extends { time: number }>(list: T[], cap?: number): T[] {
  const hs = settings.value.hist;
  const stepMs = Math.max(0, hs?.step ?? 0) * 60_000;
  let out = list;
  if (stepMs > 0 && list.length > 2) {
    out = [];
    let next = -Infinity;
    for (const f of list) {
      if (f.time >= next - 30_000) {
        out.push(f);
        next = Math.ceil((f.time + 1) / stepMs) * stepMs; // aligned to the step (e.g. :00, :10, :20)
      }
    }
    if (out[out.length - 1] !== list[list.length - 1] && list[list.length - 1].time - out[out.length - 1].time > stepMs / 2) out.push(list[list.length - 1]);
  }
  const max = Math.max(2, Math.min(cap ?? Infinity, hs?.maxFrames || HIST_CAP));
  return thinEven(out, max);
}

/** Live: in time mode keep only frames within the span ending at the newest frame (count mode is
 * left to the server's `n`), capped by the saver. History: the frames inside the window, thinned by
 * the history frame step / max frames. */
export function trimToSpan<T extends { time: number }>(list: T[], cap?: number): T[] {
  const h = histRange.value;
  if (h) return histThin(list.filter((f) => f.time >= h.start - 30_000 && f.time <= h.end + 30_000), cap);
  const a = settings.value.anim;
  const out = a.mode === "time" ? spanOf(list, a.minutes) : list;
  const lc = liveFrameCap();
  return Number.isFinite(lc) ? out.slice(-Math.max(1, lc)) : out;
}

/** Speed steps for the 0.25–16 fps slider. */
export const FPS_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16];
