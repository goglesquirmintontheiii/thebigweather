// workflow 0.6: animated precipitation-type texture — light snowflakes / rain streaks drawn on a
// 2D canvas over the map, only where the MRMS Precipitation Type layer (grid "ptype") shows snow
// or rain, and only while that layer is the visible weather layer and the setting is on.
// Cheap: ~700 particles, the type under each particle is looked up once per respawn.

import type { Map as MLMap } from "maplibre-gl";
import { effect } from "@preact/signals";
import { settings } from "../store";
import { gridRaster } from "../grid/controller";
import { rasterValue } from "../grid/raster";

interface P {
  x: number;
  y: number;
  kind: 0 | 1 | 2; // 0 none, 1 rain, 2 snow
  life: number;
  ph: number;
}

export function attachPrecipFx(map: MLMap) {
  let cv: HTMLCanvasElement | null = null;
  let raf = 0;
  let parts: P[] = [];
  let lastT = 0;
  let moving = false;
  const container = map.getContainer();

  const typeAt = (x: number, y: number): 0 | 1 | 2 => {
    const r = gridRaster.value;
    if (!r) return 0;
    const ll = map.unproject([x, y]);
    const v = rasterValue(r, ll.lat, ll.lng);
    if (!(v > 0)) return 0;
    return Math.round(v) === 3 ? 2 : 1;
  };
  const spawn = (p: P, w: number, h: number) => {
    // a few tries to land on precipitation
    for (let k = 0; k < 4; k++) {
      p.x = Math.random() * w;
      p.y = Math.random() * h;
      p.kind = typeAt(p.x, p.y);
      if (p.kind) break;
    }
    p.life = 40 + Math.random() * 80;
    p.ph = Math.random() * Math.PI * 2;
  };

  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    cv?.remove();
    cv = null;
    parts = [];
  };
  const start = () => {
    if (cv) return;
    cv = document.createElement("canvas");
    cv.className = "wf6-precipfx";
    container.appendChild(cv);
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - lastT < 33 || !cv) return; // ~30 fps
      lastT = t;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = container.clientWidth, h = container.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const g = cv.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (moving) return;
      const want = Math.min(900, Math.round((w * h) / 2200));
      while (parts.length < want) {
        const p: P = { x: 0, y: 0, kind: 0, life: 0, ph: 0 };
        spawn(p, w, h);
        parts.push(p);
      }
      parts.length = Math.min(parts.length, want);
      g.lineCap = "round";
      for (const p of parts) {
        p.life--;
        if (p.kind === 2) {
          p.y += 0.6;
          p.x += Math.sin(t / 700 + p.ph) * 0.35;
        } else if (p.kind === 1) {
          p.y += 5;
          p.x += 1.1;
        }
        if (p.life <= 0 || p.y > h || p.x > w) {
          spawn(p, w, h);
          continue;
        }
        if (!p.kind) continue;
        const a = Math.min(1, p.life / 20);
        if (p.kind === 2) {
          g.fillStyle = `rgba(255,255,255,${0.85 * a})`;
          g.beginPath();
          g.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
          g.fill();
        } else {
          g.strokeStyle = `rgba(200,225,255,${0.55 * a})`;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(p.x, p.y);
          g.lineTo(p.x - 2.2, p.y - 10);
          g.stroke();
        }
      }
    };
    raf = requestAnimationFrame(tick);
  };

  // re-sample positions after the map moves (particles are in screen space)
  map.on("movestart", () => (moving = true));
  map.on("moveend", () => {
    moving = false;
    for (const p of parts) p.life = 0;
  });
  effect(() => {
    const w = settings.value.weather;
    const on = settings.value.wf6.precipFx && w.kind === "grid" && w.id === "ptype";
    void gridRaster.value;
    if (on) {
      start();
      for (const p of parts) p.life = Math.min(p.life, 5);
    } else stop();
  });
}
