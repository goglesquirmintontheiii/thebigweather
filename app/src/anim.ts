// Shared animation state for whichever weather layer is visible.

import { signal, effect } from "@preact/signals";
import { settings, toast } from "./store";

export const frameIndex = signal(0);
export const playing = signal(false);
/** number of frames of the active weather layer (set by the active controller) */
export const frameCount = signal(0);

let timer: number | undefined;
function step() {
  const n = frameCount.value;
  if (!playing.value || n < 2) return;
  const next = (frameIndex.value + 1) % n;
  frameIndex.value = next;
  const s = settings.value.anim;
  timer = window.setTimeout(step, next === n - 1 ? s.dwellMs : 1000 / s.fps);
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
