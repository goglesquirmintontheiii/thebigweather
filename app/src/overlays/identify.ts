// 0.8.1: "Identify" a layer's items on the map: pulsing rings around them for ~5 s. Rings have a
// fixed pixel size (visible when zoomed far out); when there are many items they're grouped in
// screen space and one ring (sized by count) pulses per group. One 2D canvas over the map, only
// re-projected when the map moves. Reduced motion (Settings → Accessibility): static rings.

import { signal } from "@preact/signals";
import { overlayData, overlayMap, isOn } from "./manager";
import { overlayDef } from "./defs";
import { fileOverlays } from "./files";
import { toast } from "../store";
import { a11y } from "../a11y/a11y";
import { collectPoints, extentOf, gridCluster, ringRadius, cellFor, type Cluster } from "./identifyCore";

export const DURATION_MS = 5000;

/** What identify is doing: rings on screen, or nothing in view (the UI offers "Zoom to"). */
export const identifying = signal<{ id: string; state: "on" | "none"; inView: number; total: number; ext?: [number, number, number, number] } | null>(null);

let stopFn: (() => void) | null = null;
let noneTimer: number | undefined;

function layerName(id: string): string {
  if (id.startsWith("file:")) return fileOverlays.value.find((f) => `file:${f.id}` === id)?.name ?? "File";
  return overlayDef(id)?.name ?? id;
}

function features(id: string): any[] {
  const fc = overlayData(id);
  if (fc && typeof fc === "object" && Array.isArray(fc.features)) return fc.features;
  // files (blob URLs) and tiled sources: what MapLibre has loaded, deduplicated across tiles
  const m = overlayMap();
  if (!m) return [];
  try {
    const seen = new Set<string>();
    return m.querySourceFeatures(`o-${id}`).filter((f: any) => {
      const k = `${f.id ?? ""}|${JSON.stringify(f.geometry?.coordinates ?? "").slice(0, 80)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return [];
  }
}

export function stopIdentify() {
  stopFn?.();
  stopFn = null;
  clearTimeout(noneTimer);
  identifying.value = null;
}

/** Toggle the pulse for one layer (a second click stops it). */
export function identify(id: string) {
  const cur = identifying.value;
  stopIdentify();
  if (cur?.id === id && cur.state === "on") return;
  const m = overlayMap();
  if (!m) return;
  const name = layerName(id);
  const { pts, wts, n, total } = collectPoints(features(id));
  if (!n) {
    toast(`${name}: no items loaded${overlayDef(id)?.minzoom ? ` (from zoom ${overlayDef(id)!.minzoom})` : ""}`);
    return;
  }
  const ext = extentOf(pts, n) ?? undefined;
  const xy = new Float32Array(n * 2);
  const project = () => {
    for (let i = 0; i < n; i++) {
      const p = m.project([pts[i * 2], pts[i * 2 + 1]]);
      xy[i * 2] = p.x;
      xy[i * 2 + 1] = p.y;
    }
  };
  project();
  const cont = m.getContainer();
  const inView = () => {
    const W = cont.clientWidth, H = cont.clientHeight;
    let k = 0;
    for (let i = 0; i < n; i++) if (xy[i * 2] >= 0 && xy[i * 2 + 1] >= 0 && xy[i * 2] <= W && xy[i * 2 + 1] <= H) k += wts[i];
    return Math.round(k);
  };
  const v0 = inView();
  if (!v0) {
    identifying.value = { id, state: "none", inView: 0, total, ext };
    toast(`No ${name} in view — use "Zoom to" to find them`);
    noneTimer = window.setTimeout(() => identifying.value?.state === "none" && identifying.value.id === id && (identifying.value = null), 15000);
    return;
  }
  identifying.value = { id, state: "on", inView: v0, total, ext };

  const cv = document.createElement("canvas");
  cv.className = "identify-canvas";
  cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:1";
  cont.appendChild(cv);
  const ctx = cv.getContext("2d")!;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3fb7ff";
  const still = a11y().reduceMotion;
  let dirty = true;
  let clusters: Cluster[] = [];
  let raf = 0;
  const t0 = performance.now();
  const onMove = () => {
    dirty = true;
    if (still) raf ||= requestAnimationFrame(frame);
  };
  m.on("move", onMove);
  m.on("resize", onMove);

  function frame(now: number) {
    raf = 0;
    const t = now - t0;
    if (t > DURATION_MS || !isOn(id)) return stopIdentify();
    const dpr = window.devicePixelRatio || 1;
    const W = cont.clientWidth, H = cont.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      dirty = true;
    }
    if (dirty) {
      project();
      const vis = inView();
      clusters = gridCluster(xy, wts, n, W, H, cellFor(vis));
      dirty = false;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // fade out over the last 0.5 s
    const fade = Math.min(1, (DURATION_MS - t) / 500);
    for (const c of clusters) {
      const r = ringRadius(c.n);
      if (!still) {
        for (const off of [0, 0.5]) {
          const p = (t / 1300 + off) % 1;
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + 4 + p * 26, 0, Math.PI * 2);
          ctx.strokeStyle = accent;
          ctx.globalAlpha = (1 - p) * 0.8 * fade;
          ctx.lineWidth = 3 - p * 1.5;
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.45 * fade;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // steady ring: dark halo + accent
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(4,10,18,0.75)";
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (c.n > 1) {
        const txt = c.n >= 10000 ? `${Math.round(c.n / 1000)}k` : c.n >= 1000 ? `${(c.n / 1000).toFixed(1)}k` : String(c.n);
        ctx.font = "600 11px system-ui, sans-serif";
        const tw = ctx.measureText(txt).width;
        const bx = c.x + r * 0.7, by = c.y - r * 0.7;
        ctx.fillStyle = "rgba(4,10,18,0.85)";
        ctx.beginPath();
        ctx.roundRect(bx - tw / 2 - 5, by - 8, tw + 10, 16, 8);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(txt, bx, by + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    if (!still) raf = requestAnimationFrame(frame);
    else if (!endTimer) endTimer = window.setTimeout(() => stopIdentify(), DURATION_MS - t);
  }
  let endTimer: number | undefined;
  raf = requestAnimationFrame(frame);
  stopFn = () => {
    cancelAnimationFrame(raf);
    clearTimeout(endTimer);
    m.off("move", onMove);
    m.off("resize", onMove);
    cv.remove();
  };
}

/** Fit the map to the layer's items, then pulse them. */
export function zoomToLayer(id: string) {
  const m = overlayMap();
  const st = identifying.value;
  const ext = st?.id === id ? st.ext : extentOf(...(() => {
    const c = collectPoints(features(id));
    return [c.pts, c.n] as const;
  })());
  if (!m || !ext) return;
  stopIdentify();
  const [w, s, e, n] = ext;
  const pad = w === e && s === n ? 0.05 : 0;
  m.once("moveend", () => window.setTimeout(() => identify(id), 50));
  m.fitBounds([[w - pad, s - pad], [e + pad, n + pad]], { padding: 80, maxZoom: 11, duration: 900 });
}
