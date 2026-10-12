// Bandwidth-saver mode: one switch (settings.saver) read from a few central places —
// live frame counts capped at 12 (anim.framesToRequest), overlay refresh ×3 and no polling while
// the window is hidden (overlays/manager.ts), RapidSweep off and 3D at low resolution (settings,
// restored when the mode is turned off).

import { effect } from "@preact/signals";
import { settings, update } from "./store";
import { setLiveFrameCap } from "./anim";
import { reload } from "./radar/controller";

export const SAVER_FRAMES = 12;
export const SAVER_REFRESH_MUL = 3;

export const saverOn = () => !!settings.value.saver;
/** multiplier for overlay refresh intervals */
export const refreshMul = () => (saverOn() ? SAVER_REFRESH_MUL : 1);
/** skip a background poll right now (hidden window in saver mode) */
export const pollPaused = () => saverOn() && typeof document !== "undefined" && document.hidden;

setLiveFrameCap(() => (saverOn() ? SAVER_FRAMES : Infinity));

const PREV = "tbw.saver.prev";
let last: boolean | null = null;
effect(() => {
  const on = settings.value.saver;
  if (last === null) {
    last = on;
    return;
  }
  if (on === last) return;
  last = on;
  if (on) {
    const s = settings.value;
    try {
      localStorage.setItem(PREV, JSON.stringify({ live: s.radar.live, res: s.view3d.res }));
    } catch {
      /* ignore */
    }
    update((x) => {
      x.radar.live = false;
      x.view3d.res = "lo";
    });
  } else {
    let prev: any = null;
    try {
      prev = JSON.parse(localStorage.getItem(PREV) || "null");
    } catch {
      /* ignore */
    }
    if (prev) update((x) => ((x.radar.live = !!prev.live), (x.view3d.res = prev.res === "hi" ? "hi" : "lo")));
  }
  // frame caps changed: reload the active layer
  queueMicrotask(() => reload({ keepIndex: false }));
});

/** Turn RapidSweep back off if something enables it while saving bandwidth. */
effect(() => {
  const s = settings.value;
  if (s.saver && s.radar.live) queueMicrotask(() => update((x) => (x.radar.live = false)));
});
