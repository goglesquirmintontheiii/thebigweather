// Tropical extras: spinning current-position symbol for NHC storms, and ATCF model tracks
// ("spaghetti") helpers.

import type { LayerSpecification, ExpressionSpecification } from "maplibre-gl";
import { effect } from "@preact/signals";
import { settings } from "../store";
import { addAnim, wakeTicker } from "./ticker";
import { drawTcNow, TC_NOW_SIZE } from "./icons";
import type { Style, Popup, OptionDef } from "./defs";

const font = ["Noto Sans Regular"];
const bold = ["Noto Sans Bold"];
const on = (id: string) => !!settings.value.ovl[id]?.on;
const fmtWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });

// ---------- NHC current position ----------

/** Category from max wind (kt). */
export function tcCat(kt: number | null | undefined): string {
  const w = Number(kt ?? 0);
  return w < 34 ? "td" : w < 64 ? "ts" : w < 83 ? "c1" : w < 96 ? "c2" : w < 113 ? "c3" : w < 137 ? "c4" : "c5";
}

/** image names used by the current storms (only these get redrawn while spinning) */
const inUse = new Set<string>();

/** Adds one `_kind: "now"` point per storm at its advisory position (from the `_s` summary). */
export function nhcPrepare(fc: any) {
  const seen = new Map<string, any>();
  for (const f of fc?.features ?? []) {
    let s = f.properties?._s;
    if (typeof s === "string") {
      try {
        s = JSON.parse(s);
      } catch {
        s = null;
      }
    }
    if (!s || s.lat == null || s.lon == null) continue;
    const id = s.id ?? s.name;
    if (seen.has(id)) continue;
    const cat = tcCat(s.wind);
    const img = `tc-now-${cat}-${s.lat < 0 ? "s" : "n"}`;
    seen.set(id, {
      type: "Feature",
      geometry: { type: "Point", coordinates: [+s.lon, +s.lat] },
      properties: { _kind: "now", _img: img, _cat: cat, stormname: s.name ?? f.properties.stormname, _s: s, advisnum: s.advnum },
    });
  }
  inUse.clear();
  for (const f of seen.values()) inUse.add(f.properties._img);
  wakeTicker();
  return { ...fc, features: [...(fc?.features ?? []), ...seen.values()], _count: fc?.features?.length ?? 0 };
}

export function nhcNowLayers(s: string, st: Style): LayerSpecification[] {
  return [
    {
      id: `${s}-now`,
      type: "symbol",
      source: s,
      filter: ["==", ["get", "_kind"], "now"],
      layout: {
        "icon-image": ["get", "_img"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.68 * (st.size / 2), 6, 0.95 * (st.size / 2)],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "text-field": st.labels !== false ? ["get", "stormname"] : "",
        "text-font": bold,
        "text-size": 12,
        "text-offset": [0, 1.9],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.5, "icon-opacity": st.opacity },
    } as LayerSpecification,
  ];
}

/** spin the current-position symbols: counter-clockwise north of the equator, clockwise south.
 * The two bands repeat every half turn, so FRAMES rotations over 180° are pre-rendered once per
 * symbol and the ticker only swaps images (no canvas work per tick). */
const FRAMES = 36; // p7: 5° steps; one frame per ~33 ms tick at the 30 fps clock
const R = 2;
const PERIOD = 2400; // ms per full turn
const frameCache = new Map<string, Uint8Array[]>();
/** p7 diagnostics: image swaps so far (the ticker repaints after each step) */
export const tcSpin = { updates: 0 };
const lastFrame = new Map<string, number>();
function framesFor(name: string): Uint8Array[] {
  let f = frameCache.get(name);
  if (f) return f;
  const [, , cat, h] = name.split("-");
  const cv = document.createElement("canvas");
  cv.width = cv.height = TC_NOW_SIZE * R;
  const c = cv.getContext("2d", { willReadFrequently: true })!;
  f = [];
  for (let i = 0; i < FRAMES; i++) {
    const ang = (i / FRAMES) * Math.PI;
    c.setTransform(R, 0, 0, R, 0, 0);
    c.clearRect(0, 0, TC_NOW_SIZE, TC_NOW_SIZE);
    drawTcNow(c, TC_NOW_SIZE, cat, h === "s", h === "s" ? ang : -ang);
    f.push(new Uint8Array(c.getImageData(0, 0, cv.width, cv.height).data.buffer));
  }
  frameCache.set(name, f);
  return f;
}
addAnim({
  active: () => on("nhc") && inUse.size > 0,
  frame: (m, t) => {
    const i = Math.floor(((t % (PERIOD / 2)) / (PERIOD / 2)) * FRAMES) % FRAMES;
    for (const name of inUse) {
      if (!m.hasImage(name)) continue;
      if (lastFrame.get(name) === i) continue;
      lastFrame.set(name, i);
      const w = TC_NOW_SIZE * R;
      m.updateImage(name, { width: w, height: w, data: framesFor(name)[i] });
      tcSpin.updates++;
    }
  },
});
effect(() => {
  if (on("nhc")) wakeTicker();
});

// ---------- ATCF model tracks ----------

export const KIND_COLOR: Record<string, string> = { official: "#ffffff", consensus: "#f472b6", dynamical: "#38bdf8", statistical: "#facc15", ensemble: "#94a3b8" };
const KIND_EXPR: ExpressionSpecification = ["match", ["get", "kind"], "official", "#ffffff", "consensus", "#f472b6", "dynamical", "#38bdf8", "statistical", "#facc15", "#94a3b8"];
const KINDS: Record<string, string[]> = {
  all: ["official", "consensus", "dynamical", "statistical", "ensemble"],
  noens: ["official", "consensus", "dynamical", "statistical"],
  main: ["official", "consensus"],
  dyn: ["official", "dynamical"],
  ens: ["official", "ensemble"],
};

/** every storm seen in the feed (keeps the storm picker complete while one is filtered) */
const storms = new Map<string, string>();
/** last feed, for listing a storm's models in the info panel */
let lastTracks: any[] = [];

export const atcfStormOpt: OptionDef = { key: "storm", label: "Storm", choices: [["", "All storms"]], def: "" };

/** Adds an end-of-line label point for each model track and refreshes the storm list. */
export function atcfPrepare(fc: any) {
  const feats = fc?.features ?? [];
  const ends: any[] = [];
  const lines: any[] = [];
  for (const f of feats) {
    const p = f.properties ?? {};
    if (p.storm && !storms.has(p.storm)) storms.set(p.storm, p.name ?? "");
    if (f.geometry?.type !== "LineString") continue;
    lines.push(p);
    const c = f.geometry.coordinates;
    if (c?.length) ends.push({ type: "Feature", geometry: { type: "Point", coordinates: c[c.length - 1] }, properties: { ...p, _end: 1 } });
  }
  lastTracks = lines;
  atcfStormOpt.choices = [["", "All storms"], ...[...storms].sort().map(([id, n]) => [id, n ? `${n} (${id})` : id] as [string, string])];
  return { ...fc, features: [...feats, ...ends], _count: lines.length };
}

export function atcfLayers(s: string, st: Style, o: Record<string, string>): LayerSpecification[] {
  const kinds = KINDS[o.kinds] ?? KINDS.all;
  const kf: any = ["in", ["get", "kind"], ["literal", kinds]];
  const line: any = ["==", ["geometry-type"], "LineString"];
  const pt: any = ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "_end"]], kf];
  const w = st.size;
  return [
    // official forecast: bold white with a black casing
    { id: `${s}-casing`, type: "line", source: s, filter: ["all", line, ["==", ["get", "kind"], "official"], kf], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": w * 3.4, "line-opacity": st.opacity } },
    {
      id: `${s}-line`,
      type: "line",
      source: s,
      filter: ["all", line, kf],
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["match", ["get", "kind"], "official", 5, "consensus", 4, "dynamical", 3, "statistical", 2, 1] },
      paint: {
        "line-color": KIND_EXPR,
        "line-width": ["match", ["get", "kind"], "official", w * 2, "consensus", w * 1.4, "dynamical", w * 1.1, "statistical", w * 0.9, w * 0.6],
        "line-opacity": ["*", st.opacity, ["match", ["get", "kind"], "ensemble", 0.45, "statistical", 0.75, 0.95]],
        "line-dasharray": ["match", ["get", "kind"], "statistical", ["literal", [2, 1.5]], ["literal", [1, 0]]],
      },
    } as LayerSpecification,
    {
      id: `${s}-pt`,
      type: "circle",
      source: s,
      minzoom: 4,
      filter: ["all", pt, ["!=", ["get", "kind"], "ensemble"]],
      paint: { "circle-color": KIND_EXPR, "circle-radius": ["match", ["get", "kind"], "official", 3.6, 2.2], "circle-stroke-color": "#000", "circle-stroke-width": 1, "circle-opacity": st.opacity },
    } as LayerSpecification,
    ...(st.labels
      ? ([
          {
            id: `${s}-tau-text`,
            type: "symbol",
            source: s,
            minzoom: 5,
            filter: ["all", pt, ["==", ["get", "kind"], "official"], [">", ["get", "tau"], 0], ["==", ["%", ["get", "tau"], 24], 0]],
            layout: { "text-field": ["concat", "+", ["to-string", ["get", "tau"]], "h"], "text-font": font, "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top" },
            paint: { "text-color": "#e5e7eb", "text-halo-color": "#000", "text-halo-width": 1.2 },
          } as LayerSpecification,
          {
            id: `${s}-text`,
            type: "symbol",
            source: s,
            filter: ["all", ["has", "_end"], kf, ["any", ["!=", ["get", "kind"], "ensemble"], [">=", ["zoom"], 6]]],
            layout: { "text-field": ["get", "tech"], "text-font": bold, "text-size": ["match", ["get", "kind"], "official", 12, 10], "text-anchor": "left", "text-offset": [0.5, 0], "text-padding": 1, "symbol-sort-key": ["match", ["get", "kind"], "official", 0, "consensus", 1, 2] },
            paint: { "text-color": KIND_EXPR, "text-halo-color": "#000", "text-halo-width": 1.4 },
          } as LayerSpecification,
        ] as LayerSpecification[])
      : []),
  ];
}

const kt = (v: any) => (v != null && v !== "" ? `${v} kt` : "—");
export function atcfClick(p: any): Popup {
  const init = Number(p.init);
  const color = KIND_COLOR[p.kind] ?? "#94a3b8";
  if (p.tau != null && p.tau !== "")
    return {
      title: `${p.tech} · +${p.tau} h`,
      sub: `${p.name || p.storm} · ${p.kind} model`,
      color,
      rows: [["Valid", fmtWhen(init + p.tau * 3600000)], ["Max wind", kt(p.vmax)], ["Pressure", p.mslp ? `${p.mslp} mb` : "—"], ["Run", fmtWhen(init)]],
    };
  const mine = lastTracks.filter((x) => x.storm === p.storm);
  const order = ["official", "consensus", "dynamical", "statistical", "ensemble"];
  const text = order
    .map((k) => {
      const t = mine.filter((x) => x.kind === k).map((x) => x.tech);
      return t.length ? `${k[0].toUpperCase()}${k.slice(1)} (${t.length}): ${t.join(" ")}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return {
    title: `${p.name || p.storm} · model tracks`,
    sub: `${p.storm} · ${mine.length} models`,
    color,
    rows: [["Clicked", `${p.tech} (${p.kind})`], ["Run", fmtWhen(init)]],
    text,
    link: ["NHC model guidance", "https://ftp.nhc.noaa.gov/atcf/aid_public/"],
  };
}
