// Appearance: accent colour, UI scale, panel opacity and (0.6) a light theme, applied as CSS
// variables on :root plus a one-time scan of the stylesheets:
// - colours written as the default accent (rgb 63,183,255) follow the chosen accent;
// - light theme: neutral (greyish) colours have their lightness inverted, so the hundreds of
//   hand-written dark-theme colours (glass, text, borders, hovers) become their light
//   counterparts without a second stylesheet. Saturated colours (alerts, accents) are kept.

import { effect, signal } from "@preact/signals";
import { settings, update } from "./store";

function shade(hex: string, f: number): string {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (!Number.isFinite(n)) return hex;
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(Math.max(0, Math.min(255, x * f))));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const ACCENTS = ["#3fb7ff", "#22d3ee", "#34d399", "#a3e635", "#fbbf24", "#fb923c", "#f472b6", "#a78bfa", "#e5e7eb"];

/* ---------- workflow 0.6: light theme ---------- */
/** effective theme (auto follows the OS) */
export const themeLight = signal(false);
const mq = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: light)") : null;
const sysLight = signal(!!mq?.matches);
mq?.addEventListener?.("change", (e) => (sysLight.value = e.matches));

const COLOR_RE = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*(?:,\s*[\d.]+\s*)?\)/gi;
const COLOR_PROPS = /^(color|background|background-color|background-image|border|border-(top|bottom|left|right)(-color)?|border-color|outline|outline-color|fill|stroke|caret-color|accent-color|--.*)$/;

function parseColor(c: string): [number, number, number, number] | null {
  if (c[0] === "#") {
    let h = c.slice(1);
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const m = c.match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  return [+m[0], +m[1], +m[2], m[3] != null ? +m[3] : 1];
}

/** Neutral colours: invert HSL lightness (keep hue and saturation). */
function lightColor(c: string): string {
  const p = parseColor(c);
  if (!p) return c;
  const [r, g, b, a] = p.map((x, i) => (i < 3 ? x / 255 : x));
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s > 0.38 && d > 0.12) return c; // a real colour: keep
  const l2 = Math.min(0.985, Math.max(0.06, 1 - l));
  // shift around the new lightness: neutral greys → grey at l2, slight tints kept
  let rr: number, gg: number, bb: number;
  if (d < 0.02) rr = gg = bb = l2;
  else {
    const f = (x: number) => Math.max(0, Math.min(1, l2 + (x - l)));
    rr = f(r);
    gg = f(g);
    bb = f(b);
  }
  const to = (x: number) => Math.round(x * 255);
  return a < 1 ? `rgba(${to(rr)}, ${to(gg)}, ${to(bb)}, ${+a.toFixed(3)})` : `rgb(${to(rr)}, ${to(gg)}, ${to(bb)})`;
}
/* ---------- end workflow 0.6 ---------- */

/** original values of every rule property that holds a colour (accent or neutral) */
const originals = new Map<CSSStyleRule, Record<string, string>>();
let scanned = false;
function scan() {
  if (scanned) return;
  for (const sh of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sh.cssRules;
    } catch {
      continue;
    }
    const walk = (list: CSSRuleList) => {
      for (const r of Array.from(list)) {
        if (r instanceof CSSMediaRule) {
          walk(r.cssRules);
          continue;
        }
        if (!(r instanceof CSSStyleRule)) continue;
        const sel = r.selectorText;
        // MapLibre's own control styles and explicit light-theme rules are left alone
        if (sel.includes("data-theme") || (sel.includes("maplibregl") && !sel.includes(".app"))) continue;
        // things drawn on the map itself (markers, labels) and switch knobs keep their colours
        if (/marker|toggle i|ks-|wf6-flash|me-marker|site-|point-/.test(sel)) continue;
        const st = r.style;
        for (let i = 0; i < st.length; i++) {
          const prop = st[i];
          const v = st.getPropertyValue(prop);
          if (v.includes("63, 183, 255") || (COLOR_PROPS.test(prop) && COLOR_RE.test(v))) (originals.get(r) ?? originals.set(r, {}).get(r)!)[prop] = v;
          COLOR_RE.lastIndex = 0;
        }
      }
    };
    walk(rules);
  }
  scanned = originals.size > 0;
}

let applied = "";
function retintSheets(acc: string, light: boolean) {
  const sig = `${acc}|${light}`;
  if (sig === applied) return;
  if (!applied && !light && acc.toLowerCase() === "#3fb7ff") return; // stylesheet defaults
  scan();
  if (!scanned) return;
  applied = sig;
  const n = parseInt(acc.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  for (const [r, props] of originals)
    for (const [prop, v0] of Object.entries(props)) {
      let v = light && COLOR_PROPS.test(prop) && !v0.includes("63, 183, 255") ? v0.replace(COLOR_RE, lightColor) : v0;
      v = v.replaceAll("63, 183, 255", rgb);
      r.style.setProperty(prop, v, r.style.getPropertyPriority(prop));
    }
}

/* ---------- workflow 0.6: pair the basemap with the theme ---------- */
const PAIR: Record<string, string> = { dark: "light", darkroad: "road" };
let lastLight: boolean | null = null;
function pairBasemap(light: boolean) {
  if (lastLight === null || lastLight === light) return void (lastLight = light);
  lastLight = light;
  const b = settings.peek().basemap;
  const to = light ? PAIR[b] : Object.keys(PAIR).find((k) => PAIR[k] === b);
  if (to) update((s) => (s.basemap = to as any));
}
/* ---------- end workflow 0.6 ---------- */

let lastScale = 0;
effect(() => {
  const t = settings.value.theme ?? { accent: "#3fb7ff", scale: 1, panelOpacity: 0.9 };
  const mode = settings.value.wf6?.themeMode ?? "dark"; // workflow 0.6
  const light = mode === "light" || (mode === "auto" && sysLight.value);
  themeLight.value = light;
  const root = document.documentElement;
  root.dataset.theme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
  pairBasemap(light);
  const r = root.style;
  const acc = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : "#3fb7ff";
  r.setProperty("--accent", acc);
  r.setProperty("--accent-2", shade(acc, 0.8));
  r.setProperty("--accent-soft", rgba(acc, 0.18));
  if (document.readyState === "complete") retintSheets(acc, light);
  else window.addEventListener("load", () => retintSheets(acc, light), { once: true });
  const op = Math.max(0.5, Math.min(1, t.panelOpacity));
  r.setProperty("--glass", light ? `rgba(250, 251, 253, ${op})` : `rgba(14, 18, 24, ${op})`);
  r.setProperty("--glass-2", light ? `rgba(240, 243, 247, ${Math.min(1, op + 0.02)})` : `rgba(22, 28, 37, ${Math.min(1, op + 0.02)})`);
  const sc = Math.max(0.9, Math.min(1.25, t.scale || 1));
  if (sc !== lastScale) {
    lastScale = sc;
    const io = (window as any).tbw?.setZoom;
    // Electron: page zoom keeps the map's pixels crisp (it follows devicePixelRatio)
    // (browsers: use the browser's own zoom; CSS zoom would break map mouse positions)
    io?.(sc);
  }
});
