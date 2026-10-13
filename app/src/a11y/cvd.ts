// panes/palette/a11y 0.8: colour-vision-safe palettes. Colours are remapped by hue onto palettes
// that stay distinct for each colour-vision deficiency (Okabe–Ito for red–green; a red/teal/purple
// set for blue–yellow), keeping roughly the original lightness. Greys are left alone.
// Applied to weather alert colours (ALERT_COLORS, so polygons, lists and panes follow), and to the
// overlay layers' paint colours on the main map (originals restored when turned off).

import type { Map as MLMap } from "maplibre-gl";
import { ALERT_COLORS, alerts } from "../alerts";

export type Cvd = "off" | "deutan" | "protan" | "tritan";

// hue anchors (degrees) → safe colour
const RG: [number, string][] = [
  [0, "#d55e00"], // red → vermillion
  [28, "#e69f00"], // orange
  [55, "#f0e442"], // yellow
  [105, "#009e73"], // green → bluish green
  [165, "#56b4e9"], // teal → sky blue
  [200, "#56b4e9"],
  [232, "#0072b2"], // blue
  [275, "#cc79a7"], // purple → reddish purple
  [315, "#cc79a7"], // magenta / pink
  [345, "#d55e00"],
];
const TRITAN: [number, string][] = [
  [0, "#d7191c"],
  [28, "#f46d43"],
  [55, "#fdae61"],
  [105, "#1a9850"],
  [165, "#35978f"],
  [200, "#01665e"],
  [232, "#2d004b"],
  [275, "#762a83"],
  [315, "#e7298a"],
  [345, "#d7191c"],
];
// protanopes see reds darker: lift them a little more
const PROT: [number, string][] = RG.map(([h, c]) => [h, h === 0 || h === 345 ? "#e8730c" : c]);

function hexToRgb(c: string): [number, number, number, number] | null {
  c = c.trim().toLowerCase();
  if (c[0] === "#") {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((x) => !Number.isFinite(x))) return null;
  return [p[0], p[1], p[2], p[3] ?? 1];
}
const NAMED: Record<string, string> = { red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", magenta: "#ff00ff", fuchsia: "#ff00ff", cyan: "#00ffff", aqua: "#00ffff", pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", teal: "#008080", navy: "#000080", maroon: "#800000", olive: "#808000", violet: "#ee82ee", darkred: "#8b0000", darkgreen: "#006400", crimson: "#dc143c", tomato: "#ff6347", orangered: "#ff4500" };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [(h + 360) % 360, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, string>();
/** Remap one CSS colour for a deficiency (non-colours and greys come back unchanged). */
export function cvdColor(c: string, t: Cvd): string {
  if (t === "off" || typeof c !== "string") return c;
  const k = `${t}|${c}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const rgb = hexToRgb(NAMED[c.toLowerCase()] ?? c);
  let out = c;
  if (rgb) {
    const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    if (s > 0.2 && l > 0.08 && l < 0.95) {
      const pal = t === "tritan" ? TRITAN : t === "protan" ? PROT : RG;
      let best = pal[0];
      let bd = 999;
      for (const a of pal) {
        const d = Math.min(Math.abs(a[0] - h), 360 - Math.abs(a[0] - h));
        if (d < bd) (bd = d), (best = a);
      }
      const p = hexToRgb(best[1])!;
      const [ph, ps, pl] = rgbToHsl(p[0], p[1], p[2]);
      // keep a hint of the original lightness (dark reds stay dark, pale fills stay pale)
      const l2 = Math.max(0.12, Math.min(0.9, pl * 0.65 + l * 0.35));
      const hex = hslToHex(ph, ps, l2);
      out = rgb[3] < 1 ? `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${rgb[3]})` : hex;
    }
  }
  cache.set(k, out);
  return out;
}

/* ---------- alerts ---------- */
let alertOrig: Record<string, string> | null = null;
let alertMode: Cvd = "off";
export function applyAlertCvd(t: Cvd): boolean {
  if (t === alertMode) return false;
  if (!alertOrig) alertOrig = { ...ALERT_COLORS };
  for (const [k, v] of Object.entries(alertOrig)) ALERT_COLORS[k] = cvdColor(v, t);
  alertMode = t;
  // re-colour alerts already loaded (lists, badges, panes)
  const m = new Map(alerts.peek());
  for (const [id, f] of m) if (f?.properties?.event) m.set(id, { ...f, properties: { ...f.properties, color: ALERT_COLORS[f.properties.event] ?? f.properties.color } });
  alerts.value = m;
  return true;
}

/* ---------- overlay layer paints ---------- */
const PAINT_PROPS = ["line-color", "fill-color", "fill-outline-color", "circle-color", "circle-stroke-color", "text-color", "text-halo-color", "icon-color", "fill-extrusion-color", "heatmap-color"];
const done = new Map<string, { orig: any; mapped: any; mode: Cvd }>();

function mapDeep(v: any, t: Cvd): any {
  if (typeof v === "string") return cvdColor(v, t);
  if (Array.isArray(v)) return v.map((x, i) => (i === 0 && typeof x === "string" && !x.startsWith("#") && !x.startsWith("rgb") ? x : mapDeep(x, t)));
  return v;
}
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/** Remap overlay layers (sources "o-…", placefiles, drawings) on the map; restores originals for "off". */
export function applyMapCvd(m: MLMap, t: Cvd) {
  const st = m.getStyle?.();
  if (!st) return;
  for (const l of st.layers as any[]) {
    const src = String(l.source ?? "");
    if (!(src.startsWith("o-") || src.startsWith("pf-") || src === "draw" || src.startsWith("ml"))) continue;
    for (const p of PAINT_PROPS) {
      const cur = l.paint?.[p];
      if (cur === undefined) continue;
      const k = `${l.id}|${p}`;
      const rec = done.get(k);
      let orig = cur;
      if (rec && same(rec.mapped, cur)) {
        if (rec.mode === t) continue;
        orig = rec.orig;
      }
      const next = t === "off" ? orig : mapDeep(orig, t);
      if (!same(next, cur))
        try {
          m.setPaintProperty(l.id, p as any, next);
        } catch {
          continue;
        }
      if (t === "off") done.delete(k);
      else done.set(k, { orig, mapped: next, mode: t });
    }
  }
}
