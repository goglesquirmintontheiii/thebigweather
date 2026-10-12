// One shared animation clock for overlay effects (spinning cyclones, pulsing rings).
// p7: driven by requestAnimationFrame with a frame-time accumulator (steady ~30 fps, no setInterval
// drift), runs only while some registered animation is active and the window is visible, and asks
// MapLibre to repaint after each step (map.updateImage alone does not schedule a render, so icons
// only moved while the map was being dragged).

import type { Map as MLMap } from "maplibre-gl";
import { mapRef } from "../map/mapview";

type Anim = { active: () => boolean; frame: (m: MLMap, t: number) => void };

const anims: Anim[] = [];
let raf: number | undefined;
export const TICK_FPS = 30;
const STEP = 1000 / TICK_FPS;
let acc = 0;
let last = 0;
/** frames drawn (for diagnostics/tests) */
export const tickStats = { frames: 0, repaints: 0 };

function loop(now: number) {
  raf = undefined;
  const live = anims.filter((a) => a.active());
  if (!live.length) return; // stops by itself; wakeTicker() restarts it
  if (document.hidden) return; // visibilitychange wakes it again
  raf = requestAnimationFrame(loop);
  const m = mapRef.value;
  if (!m || !m.getStyle()) return;
  const dt = last ? Math.min(now - last, 250) : STEP;
  last = now;
  acc += dt;
  if (acc < STEP - 1) return; // rAF runs at the display rate; draw at TICK_FPS
  acc = acc % STEP;
  for (const a of live) {
    try {
      a.frame(m, now);
    } catch {
      /* layer gone mid-frame */
    }
  }
  tickStats.frames++;
  m.triggerRepaint();
  tickStats.repaints++;
}

export function addAnim(a: Anim) {
  anims.push(a);
  wakeTicker();
}

/** Start the clock (call when something that animates turns on; it stops by itself). */
export function wakeTicker() {
  if (raf === undefined && !document.hidden && anims.some((a) => a.active())) {
    last = 0;
    acc = 0;
    raf = requestAnimationFrame(loop);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wakeTicker();
});
// safety net: an animation that became active without calling wakeTicker() still starts
setInterval(wakeTicker, 2000);

/** Pulse a circle layer's radius/opacity (0..1 phase, period ms). */
export function pulse(m: MLMap, layer: string, t: number, period: number, r0: number, r1: number) {
  if (!m.getLayer(layer)) return;
  const k = (t % period) / period;
  m.setPaintProperty(layer, "circle-radius", r0 + (r1 - r0) * k);
  m.setPaintProperty(layer, "circle-stroke-opacity", 1 - k);
}
