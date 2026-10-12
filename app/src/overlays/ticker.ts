// One shared ~20 fps animation clock for overlay effects (spinning cyclones, pulsing rings).
// Runs only while some registered animation is active and the window is visible.

import type { Map as MLMap } from "maplibre-gl";
import { mapRef } from "../map/mapview";

type Anim = { active: () => boolean; frame: (m: MLMap, t: number) => void };

const anims: Anim[] = [];
let timer: number | undefined;
const FPS = 20;

function tick() {
  const m = mapRef.value;
  const live = anims.filter((a) => a.active());
  if (!live.length) {
    clearInterval(timer);
    timer = undefined;
    return;
  }
  // window hidden/minimized: skip the frame (no redraws)
  if (!m || document.hidden || !m.getStyle()) return;
  const t = performance.now();
  for (const a of live) {
    try {
      a.frame(m, t);
    } catch {
      /* layer gone mid-frame */
    }
  }
}

export function addAnim(a: Anim) {
  anims.push(a);
}

/** Start the clock (call when something that animates turns on; it stops by itself). */
export function wakeTicker() {
  if (timer === undefined && anims.some((a) => a.active())) timer = window.setInterval(tick, 1000 / FPS);
}

/** Pulse a circle layer's radius/opacity (0..1 phase, period ms). */
export function pulse(m: MLMap, layer: string, t: number, period: number, r0: number, r1: number) {
  if (!m.getLayer(layer)) return;
  const k = (t % period) / period;
  m.setPaintProperty(layer, "circle-radius", r0 + (r1 - r0) * k);
  m.setPaintProperty(layer, "circle-stroke-opacity", 1 - k);
}
