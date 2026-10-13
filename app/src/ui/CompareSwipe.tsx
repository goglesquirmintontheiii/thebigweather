// data 0.6: swipe compare. The second pane (map/panes.ts) lies over the main map, clipped to one
// side of a divider the user drags; the main map stays interactive and the pane follows its view
// and the timeline. Chosen from the panes menu ("Swipe").
// panes 0.8: vertical, horizontal or diagonal divider (drag the round handle to rotate it), and
// both product selectors stay centred over the part of their map that is visible.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { GripVertical, RotateCw } from "lucide-preact";
import { settings, update, openPanel } from "../store";
import { resizePanes } from "../map/panes";

type Pt = [number, number];
/** clip path for the pane, and where each side's selector goes (px in the .panes box) */
export const swipeGeom = signal<{ clip: string; main: { x: number; y: number } | null; pane: { x: number; y: number } | null } | null>(null);

export type SwipeMode = "v" | "h" | "d";
export const swipeAngleOf = (mode: SwipeMode, a?: number) => (mode === "v" ? 0 : mode === "h" ? 90 : a ?? 35);

/** Sutherland–Hodgman: keep the part of a convex polygon where sign·((q−p)·n) ≥ 0 */
function clipHalf(poly: Pt[], p: Pt, n: Pt, sign: number): Pt[] {
  const f = (q: Pt) => sign * ((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1]);
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function area(poly: Pt[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function centroid(poly: Pt[]): Pt {
  const A = area(poly);
  if (Math.abs(A) < 1e-6) return poly[0] ?? [0, 0];
  let cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const k = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * k;
    cy += (a[1] + b[1]) * k;
  }
  return [cx / (6 * A), cy / (6 * A)];
}
/** vertical extent of a convex polygon at x */
function yRange(poly: Pt[], x: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] - x) * (b[0] - x) > 0) continue;
    const ys = a[0] === b[0] ? [a[1], b[1]] : [a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
    for (const y of ys) (lo = Math.min(lo, y)), (hi = Math.max(hi, y));
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Selector spot: horizontally at the visible part's centroid, vertically just below its top edge
 * (below the header for the top row, below the divider otherwise), sampled across the selector's width. */
function labelSpot(poly: Pt[], hdrB: number, hw = 110): { x: number; y: number } | null {
  if (poly.length < 3 || Math.abs(area(poly)) < 3000) return null;
  const xs = poly.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const c = centroid(poly);
  const half = Math.max(20, Math.min(hw + 6, (x1 - x0) / 2 - 4));
  const x = Math.max(x0 + half + 4, Math.min(x1 - half - 4, c[0]));
  let top = -Infinity;
  for (const sx of [x - half, x, x + half]) {
    const r = yRange(poly, sx);
    if (r) top = Math.max(top, r[0]);
  }
  const mid = yRange(poly, x);
  if (!mid || !Number.isFinite(top)) return { x: c[0], y: c[1] };
  let y = top < hdrB - 6 ? hdrB : top + 14;
  if (y > mid[1] - 40) y = Math.max(mid[0] + 6, c[1] - 15);
  return { x, y };
}

export function computeSwipe(W: number, H: number, px: number, py: number, angle: number, leftInset: number, hdrB: number, hwMain = 110, hwPane = 110) {
  const P: Pt = [px * W, py * H];
  const th = (angle * Math.PI) / 180;
  const n: Pt = [Math.cos(th), Math.sin(th)];
  const rect: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const paneSide = clipHalf(rect, P, n, 1);
  const mainSide = clipHalf(rect, P, n, -1);
  const clip = paneSide.length >= 3 ? `polygon(${paneSide.map((q) => `${q[0].toFixed(1)}px ${q[1].toFixed(1)}px`).join(", ")})` : "polygon(0 0, 0 0, 0 0)";
  const vis = (poly: Pt[]) => (leftInset > 0 ? clipHalf(poly, [leftInset, 0], [1, 0], 1) : poly);
  return { clip, main: labelSpot(vis(mainSide), hdrB, hwMain), pane: labelSpot(vis(paneSide), hdrB, hwPane) };
}

export function SwipeDivider() {
  const p0 = settings.value.panes;
  const mode: SwipeMode = p0.swipeMode ?? "v";
  const [pos, setPos] = useState<[number, number]>([p0.swipeX ?? 0.5, p0.swipeY ?? 0.5]);
  const [ang, setAng] = useState(p0.swipeAngle ?? 35);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  const ref = useRef<HTMLDivElement>(null);
  const angle = swipeAngleOf(mode, ang);
  const panel = openPanel.value;
  // geometry → signal (clip path + selector spots), recomputed on any change and every second
  // (header height and the side panel can change without notice)
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>(".panes");
    if (!host) return;
    const calc = () => {
      const r = host.getBoundingClientRect();
      if (!r.width) return;
      if (r.width !== box[0] || r.height !== box[1]) setBox([r.width, r.height]);
      const sp = document.querySelector(".side-panel");
      const inset = sp ? Math.max(0, sp.getBoundingClientRect().right - r.left + 6) : 0;
      const hdr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr-b")) || 62;
      // selector half-widths (they are centred on their spot)
      const hw = (sel: string) => (host.querySelector<HTMLElement>(sel)?.offsetWidth ?? 220) / 2;
      const g = computeSwipe(r.width, r.height, pos[0], pos[1], angle, inset, hdr - r.top, hw(".pane.main > .pane-head"), hw(".pane:not(.main) > .pane-head"));
      const cur = swipeGeom.peek();
      if (JSON.stringify(cur) !== JSON.stringify(g)) swipeGeom.value = g;
    };
    calc();
    const t1 = setTimeout(calc, 260);
    const iv = setInterval(calc, 1000);
    const ro = new ResizeObserver(calc);
    ro.observe(host);
    return () => (clearTimeout(t1), clearInterval(iv), ro.disconnect());
  }, [pos[0], pos[1], angle, panel, box[0], box[1]]);
  useEffect(() => {
    const t = setTimeout(resizePanes, 50);
    return () => {
      clearTimeout(t);
      swipeGeom.value = null;
    };
  }, []);
  const save = (p: [number, number], a: number) =>
    update((s) => {
      s.panes.swipeX = +p[0].toFixed(4);
      s.panes.swipeY = +p[1].toFixed(4);
      if (mode === "d") s.panes.swipeAngle = Math.round(a);
    });
  const host = () => ref.current!.closest<HTMLElement>(".panes")!.getBoundingClientRect();
  const drag = (e: PointerEvent, rotate: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const b = host();
    let lp = pos, la = ang;
    const move = (ev: PointerEvent) => {
      if (rotate) {
        const dx = ev.clientX - (b.left + pos[0] * b.width), dy = ev.clientY - (b.top + pos[1] * b.height);
        la = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
        if (!ev.shiftKey) la = Math.round(la / 5) * 5; // 5° steps (Shift: free)
        setAng(la);
        return;
      }
      const x = Math.max(0.02, Math.min(0.98, (ev.clientX - b.left) / b.width));
      const y = Math.max(0.02, Math.min(0.98, (ev.clientY - b.top) / b.height));
      lp = [mode === "h" ? lp[0] : x, mode === "v" ? lp[1] : y];
      setPos(lp);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      save(lp, la);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent) => {
    const st = e.shiftKey ? 0.05 : 0.01;
    let p = pos, a = ang;
    if (e.key === "ArrowLeft" && mode !== "h") p = [Math.max(0.02, p[0] - st), p[1]];
    else if (e.key === "ArrowRight" && mode !== "h") p = [Math.min(0.98, p[0] + st), p[1]];
    else if (e.key === "ArrowUp" && mode !== "v") p = [p[0], Math.max(0.02, p[1] - st)];
    else if (e.key === "ArrowDown" && mode !== "v") p = [p[0], Math.min(0.98, p[1] + st)];
    else if ((e.key === "r" || e.key === "]") && mode === "d") a = (a + 5) % 360;
    else if ((e.key === "R" || e.key === "[") && mode === "d") a = (a + 355) % 360;
    else return;
    e.preventDefault();
    e.stopPropagation();
    setPos(p);
    setAng(a);
    save(p, a);
  };
  const [W, H] = box;
  const cx = pos[0] * W, cy = pos[1] * H;
  const len = Math.hypot(W, H) * 2 + 10;
  const th = (angle * Math.PI) / 180;
  const rx = cx + Math.sin(th) * 90, ry = cy - Math.cos(th) * 90;
  return (
    <div ref={ref} class="sw8">
      {W > 0 && (
        <>
          <div class="sw8-line" style={{ left: `${cx}px`, top: `${cy}px`, width: `${len}px`, transform: `translate(-50%, -50%) rotate(${angle + 90}deg)` }} />
          <button
            class="d6-swipe-knob sw8-knob glass"
            style={{ left: `${cx}px`, top: `${cy}px`, cursor: mode === "v" ? "ew-resize" : mode === "h" ? "ns-resize" : "move" }}
            title={mode === "d" ? "Drag to move the divider · arrow keys move it · R / Shift+R rotate" : "Drag to compare the two layers · arrow keys move it"}
            aria-label="Swipe divider"
            role="slider"
            aria-valuemin={2}
            aria-valuemax={98}
            aria-valuenow={Math.round((mode === "h" ? pos[1] : pos[0]) * 100)}
            aria-orientation={mode === "h" ? "vertical" : "horizontal"}
            onPointerDown={(e) => drag(e as any, false)}
            onKeyDown={key as any}
          >
            <GripVertical size={16} style={{ transform: `rotate(${angle}deg)` }} />
          </button>
          {mode === "d" && (
            <button class="sw8-rot glass" style={{ left: `${rx}px`, top: `${ry}px` }} title={`Drag to rotate the divider (${Math.round(angle)}°) · Shift for free angle`} aria-label="Rotate swipe divider" onPointerDown={(e) => drag(e as any, true)} onKeyDown={key as any}>
              <RotateCw size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
