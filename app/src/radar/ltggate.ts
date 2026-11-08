// 0.8.3: lightning (GOES GLM) legend gate: show only flashes within an age window (newest ↔
// oldest of the layer's "Last N min"), and scale icon brightness to that window (its newest edge
// is brightest). Stored like the other legend gates (settings.gates["p:glm"], 0–1 of the span);
// a live drag updates the map with setPaintProperty / setFilter (no refetch).

import { effect } from "@preact/signals";
import { settings } from "../store";
import { gateDrag } from "../gate";
import { probGatePeek } from "../ml/probgate";
import { mapRef } from "../map/mapview";
import { paneMap } from "../map/panes";
import { LTG, ltgSpan, ltgWindow, ltgPaint, ltgFilter } from "./ltgpaint";

/** current gate of the lightning legend (live while dragging) */
export const ltgGate = () => probGatePeek(LTG);

function apply() {
  const span = ltgSpan(settings.peek().ovl[LTG]?.opts?.minutes);
  const g = ltgGate();
  const op = settings.peek().ovl[LTG]?.opacity ?? 1;
  const p = ltgPaint(ltgWindow(span, g), op);
  const f = ltgFilter(span, g);
  const maps = new Set([mapRef.value]);
  for (let i = 0; i < 9; i++) maps.add(paneMap(i));
  for (const m of maps) {
    if (!m || !m.getStyle() || !m.getLayer(`o-${LTG}-icon`)) continue;
    try {
      m.setPaintProperty(`o-${LTG}-icon`, "icon-color", p.color);
      m.setPaintProperty(`o-${LTG}-icon`, "icon-opacity", p.opacity);
      m.setFilter(`o-${LTG}-icon`, f);
    } catch {
      /* layer gone */
    }
  }
}
let raf = 0;
let last = "";
effect(() => {
  const d = gateDrag.value;
  const key = JSON.stringify([d?.key === `p:${LTG}` ? d.g : null, settings.value.gates?.[`p:${LTG}`] ?? null]);
  if (key === last) return;
  last = key;
  if (!raf) raf = requestAnimationFrame(() => ((raf = 0), apply()));
});
