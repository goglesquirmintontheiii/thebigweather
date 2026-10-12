// Appearance: accent colour, UI scale and panel opacity, applied as CSS variables on :root.

import { effect } from "@preact/signals";
import { settings } from "./store";

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

/** Stylesheet colours written as the default accent (rgb 63,183,255) follow the chosen accent. */
const originals = new Map<CSSStyleRule, Record<string, string>>();
let scanned = false;
function retintSheets(acc: string) {
  if (!scanned && acc.toLowerCase() === "#3fb7ff") return;
  const n = parseInt(acc.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  if (!scanned) {
    for (const sh of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      for (const r of Array.from(rules)) {
        if (!(r instanceof CSSStyleRule)) continue;
        const st = r.style;
        for (let i = 0; i < st.length; i++) {
          const prop = st[i];
          const v = st.getPropertyValue(prop);
          if (v.includes("63, 183, 255")) (originals.get(r) ?? originals.set(r, {}).get(r)!)[prop] = v;
        }
      }
    }
    scanned = originals.size > 0;
  }
  for (const [r, props] of originals) for (const [prop, v] of Object.entries(props)) r.style.setProperty(prop, v.replaceAll("63, 183, 255", rgb), r.style.getPropertyPriority(prop));
}

let lastScale = 0;
effect(() => {
  const t = settings.value.theme ?? { accent: "#3fb7ff", scale: 1, panelOpacity: 0.9 };
  const r = document.documentElement.style;
  const acc = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : "#3fb7ff";
  r.setProperty("--accent", acc);
  r.setProperty("--accent-2", shade(acc, 0.8));
  r.setProperty("--accent-soft", rgba(acc, 0.18));
  if (document.readyState === "complete") retintSheets(acc);
  else window.addEventListener("load", () => retintSheets(acc), { once: true });
  const op = Math.max(0.5, Math.min(1, t.panelOpacity));
  r.setProperty("--glass", `rgba(14, 18, 24, ${op})`);
  r.setProperty("--glass-2", `rgba(22, 28, 37, ${Math.min(1, op + 0.02)})`);
  const sc = Math.max(0.9, Math.min(1.25, t.scale || 1));
  if (sc !== lastScale) {
    lastScale = sc;
    const io = (window as any).tbw?.setZoom;
    // Electron: page zoom keeps the map's pixels crisp (it follows devicePixelRatio)
    // (browsers: use the browser's own zoom; CSS zoom would break map mouse positions)
    io?.(sc);
  }
});
