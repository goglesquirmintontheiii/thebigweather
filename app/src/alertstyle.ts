// Weather alert categories, per-type styling, visibility, sounds and flashing.

import type { Map as MLMap } from "maplibre-gl";
import { settings, type AlertTypeCfg } from "./store";
import { alertColor } from "./alerts";
import { regionOf, type AlertRegion } from "./alertlist"; // 0.8.2

export const ALERT_CATS = ["Tornado & severe", "Flood", "Tropical & marine", "Winter & cold", "Heat & fire", "Wind & dust", "Other"] as const;
export type AlertCat = (typeof ALERT_CATS)[number];

export function alertCategory(event: string): AlertCat {
  const e = event.toLowerCase();
  if (/freezing (rain|drizzle)/.test(e)) return "Winter & cold"; // 0.8.2
  if (/flood|hydrologic|rain/.test(e)) return "Flood"; // 0.8.2: rain (international types)
  if (/tornado|thunderstorm|extreme wind|severe weather|hail/.test(e)) return "Tornado & severe";
  if (/hurricane|tropical|typhoon|storm surge|marine|gale|small craft|storm warning|storm watch|hazardous seas|rip current|beach|tsunami|surf|seas|low water|brisk wind|freezing spray/.test(e)) return "Tropical & marine";
  if (/winter|blizzard|ice|snow|freeze|frost|chill|cold|lake effect|sleet|avalanche|low temperature/.test(e)) return "Winter & cold";
  if (/heat|red flag|fire|high temperature/.test(e)) return "Heat & fire";
  if (/wind|dust/.test(e)) return "Wind & dust";
  return "Other";
}

export function alertKind(event: string): "warning" | "watch" | "other" {
  return event.endsWith("Warning") || event.endsWith("Emergency") ? "warning" : event.endsWith("Watch") ? "watch" : "other";
}

/** Defaults before any user overrides. */
function base(event: string, own?: string): Required<AlertTypeCfg> {
  const k = alertKind(event);
  const c = own ?? alertColor(event);
  return {
    color: c,
    border: c,
    width: k === "warning" ? 2.4 : 1.4,
    line: k === "watch" ? "dashed" : "solid",
    fill: "solid",
    fillOpacity: k === "warning" ? 0.14 : 0.07,
    sound: "off",
    flash: event === "Tornado Warning" ? 60 : 0,
  };
}

/** Effective style for an event: defaults ← category settings ← type settings. `own` (0.8.2) is
 * the alert's own default colour (Canada / international: by awareness level). */
export function alertStyle(event: string, own?: string): Required<AlertTypeCfg> {
  const cfg = settings.value.alertCfg;
  const out: any = { ...base(event, own) };
  const cat = cfg.cats[alertCategory(event)] ?? {};
  const t = cfg.types[event] ?? {};
  for (const src of [cat, t]) for (const [k, v] of Object.entries(src)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  // a category color only sets the fill, the border follows unless set separately
  if (t.color && !t.border) out.border = t.color;
  return out;
}

export function alertVisible(event: string): boolean {
  const cfg = settings.value.alertCfg;
  return !cfg.hidden.includes(event) && !cfg.hiddenCats.includes(alertCategory(event));
}

/** 0.8.2: per-country switches (alert layer options); all on by default */
export function regionOn(r: AlertRegion): boolean {
  return settings.value.alertCfg.regions?.[r] !== false;
}
/** 0.8.2: drawn on the map: type / category shown and its region switched on */
export function alertShown(p: any): boolean {
  return alertVisible(p.event) && regionOn(regionOf(p));
}

/** Pattern image id for striped / checkered fills (drawn on demand by registerPatterns). */
export function patternId(fill: string, color: string, opacity: number) {
  if (fill !== "stripes" && fill !== "checker") return "";
  const a = Math.round(Math.min(1, Math.max(0.05, opacity * 2.4)) * 100);
  return `apat-${fill}-${color.replace("#", "").toLowerCase()}-${a}`;
}

function hexRgb(h: string): [number, number, number] {
  const x = h.replace("#", "");
  const v = x.length === 3 ? x.split("").map((c) => c + c).join("") : x.padEnd(6, "0");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Draw `apat-…` pattern images whenever the map asks for one it doesn't have. */
export function registerPatterns(map: MLMap) {
  map.on("styleimagemissing", (e: any) => {
    const id: string = e.id;
    if (!id.startsWith("apat-") || map.hasImage(id)) return;
    const [, kind, hex, a] = id.split("-");
    const [r, g, b] = hexRgb(hex);
    const alpha = Math.round((+a / 100) * 255);
    const n = 16;
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const on = kind === "stripes" ? (x + y) % 8 < 3 : (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
        if (!on) continue;
        const i = (y * n + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = alpha;
      }
    map.addImage(id, { width: n, height: n, data }, { pixelRatio: 1 });
  });
}
