// data 0.6: swipe compare. The second pane (map/panes.ts) lies over the main map, clipped to the
// right of a divider the user drags; the main map stays interactive and the pane follows its view
// and the timeline. Chosen from the panes menu ("Swipe").

import { useEffect, useRef, useState } from "preact/hooks";
import { GripVertical } from "lucide-preact";
import { settings, update } from "../store";
import { resizePanes } from "../map/panes";

export function SwipeDivider() {
  const [x, setX] = useState(settings.value.panes.swipeX ?? 0.5);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.closest<HTMLElement>(".panes");
    el?.style.setProperty("--swipe-x", `${(x * 100).toFixed(2)}%`);
  }, [x]);
  useEffect(() => {
    const t = setTimeout(resizePanes, 50);
    return () => {
      clearTimeout(t);
      ref.current?.closest<HTMLElement>(".panes")?.style.removeProperty("--swipe-x");
    };
  }, []);
  const down = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = ref.current!.closest<HTMLElement>(".panes")!.getBoundingClientRect();
    let last = x;
    const move = (ev: PointerEvent) => {
      last = Math.max(0.02, Math.min(0.98, (ev.clientX - box.left) / box.width));
      setX(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      update((s) => (s.panes.swipeX = +last.toFixed(4)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} class="d6-swipe" style={{ left: `${x * 100}%` }}>
      <div class="d6-swipe-line" />
      <button class="d6-swipe-knob glass" title="Drag to compare the two layers" onPointerDown={down as any}>
        <GripVertical size={16} />
      </button>
    </div>
  );
}
