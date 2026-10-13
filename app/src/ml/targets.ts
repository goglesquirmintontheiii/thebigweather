// Detection targets: short codes, colours and canvas-drawn icons (shared by the map layer and the
// Detection models window, so a tornado model looks the same everywhere).

import type { Map as MLMap } from "maplibre-gl";

export interface TargetMeta {
  code: string;
  name: string;
  color: string;
}
export const TARGETS: Record<string, TargetMeta> = {
  tornado: { code: "TOR", name: "Tornado", color: "#ef4444" },
  supercell: { code: "SUP", name: "Supercell", color: "#f97316" },
  hail: { code: "HAIL", name: "Large hail", color: "#67e8f9" },
  sighail: { code: "SIGH", name: "Significant hail", color: "#22d3ee" },
  wind: { code: "WIND", name: "Damaging wind", color: "#60a5fa" },
  debris: { code: "TDS", name: "Tornado debris", color: "#c084fc" },
  flash_flood: { code: "FFW", name: "Flash flood", color: "#3b82f6" },
  tropical_genesis: { code: "TCG", name: "Tropical genesis", color: "#f472b6" },
  tropical_possible: { code: "TC?", name: "Possible TC formation", color: "#fb7185" },
  wildfire: { code: "FIRE", name: "Wildfire", color: "#fb923c" },
  custom: { code: "DET", name: "Custom", color: "#a3e635" },
  // models 0.7
  storm_intensify: { code: "INT+", name: "Storm intensification", color: "#f59e0b" },
  instability: { code: "INST", name: "Atmospheric instability", color: "#eab308" },
  temp_forecast: { code: "TMP", name: "Temperature forecast", color: "#f87171" },
  precip_forecast: { code: "QPF", name: "Precipitation forecast", color: "#22c55e" },
  storm_forecast: { code: "STRM", name: "Storm forecast", color: "#a78bfa" },
  tropical_forecast: { code: "TCF", name: "Tropical development", color: "#f472b6" },
  outlook: { code: "OTLK", name: "Severe outlook", color: "#facc15" },
  flood_forecast: { code: "FLD", name: "Flood forecast", color: "#0ea5e9" },
  // models 0.8
  storm_track: { code: "TRK", name: "Storm track", color: "#e879f9" },
};
/** models 0.7: what running a model produces when the catalog/model doesn't say */
const OUTPUT: Record<string, "detections" | "grid" | "outlook"> = { instability: "grid", temp_forecast: "grid", precip_forecast: "grid", storm_forecast: "grid", tropical_forecast: "grid", flood_forecast: "grid", outlook: "outlook" };
export const outputOf = (t: string, given?: string): "detections" | "grid" | "outlook" => (given === "grid" || given === "outlook" || given === "detections" ? given : OUTPUT[normTarget(t)] ?? "detections");
const REGRESSION = new Set(["temp_forecast", "precip_forecast"]);
export const taskOf = (t: string, given?: string): "classification" | "regression" => (given === "regression" || given === "classification" ? given : REGRESSION.has(normTarget(t)) ? "regression" : "classification");
/** older client ids → the server's target ids */
const ALIAS: Record<string, string> = { flashflood: "flash_flood", tc_genesis: "tropical_genesis", tc_possible: "tropical_possible" };
export const normTarget = (t: string) => ALIAS[t] ?? t;
export const tmeta = (t: string): TargetMeta => TARGETS[normTarget(t)] ?? { code: (t || "DET").slice(0, 4).toUpperCase(), name: t || "Custom", color: "#a3e635" };
export const LEVEL_COLOR = { low: "#facc15", med: "#fb923c", high: "#f43f5e" } as const;
export const LEVEL_NAME = { low: "Low", med: "Moderate", high: "High" } as const;
export const levelOf = (p: number, thr = 0.5): "low" | "med" | "high" => (p >= Math.max(0.75, thr + 0.25) ? "high" : p >= Math.max(0.5, thr) ? "med" : "low");

type Draw = (c: CanvasRenderingContext2D, s: number) => void;

function disc(c: CanvasRenderingContext2D, s: number, fill: string) {
  c.fillStyle = fill;
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(s / 2, s / 2, s / 2 - 1.5, 0, Math.PI * 2);
  c.fill();
  c.stroke();
}

/** tornado: red inverted triangle with a white funnel */
const tornado: Draw = (c, s) => {
  c.fillStyle = "#dc2626";
  c.strokeStyle = "rgba(0,0,0,.85)";
  c.lineWidth = 1.6;
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(2, 3.5);
  c.lineTo(s - 2, 3.5);
  c.lineTo(s / 2, s - 2);
  c.closePath();
  c.fill();
  c.stroke();
  c.strokeStyle = "#fff";
  c.lineWidth = 1.7;
  c.lineCap = "round";
  const lines: [number, number, number][] = [
    [0.27, 0.73, 0.3],
    [0.33, 0.66, 0.42],
    [0.4, 0.6, 0.54],
    [0.45, 0.55, 0.66],
  ];
  for (const [a, b, y] of lines) {
    c.beginPath();
    c.moveTo(s * a, s * y);
    c.lineTo(s * b, s * y);
    c.stroke();
  }
};
/** supercell: rotating updraft — orange disc with a curved counter-clockwise arrow */
const supercell: Draw = (c, s) => {
  disc(c, s, "#ea580c");
  const cx = s / 2, cy = s / 2, r = s * 0.27;
  c.strokeStyle = "#fff";
  c.lineWidth = 2;
  c.lineCap = "round";
  c.beginPath();
  c.arc(cx, cy, r, Math.PI * 0.15, Math.PI * 1.75);
  c.stroke();
  const a = Math.PI * 1.75;
  const ex = cx + r * Math.cos(a), ey = cy + r * Math.sin(a);
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(ex + 4, ey + 1);
  c.lineTo(ex - 2, ey - 3.5);
  c.lineTo(ex - 1.5, ey + 3.5);
  c.closePath();
  c.fill();
  c.beginPath();
  c.arc(cx, cy, 2, 0, Math.PI * 2);
  c.fill();
};
/** hail: white/cyan hailstone with facets */
const hailstone = (core: string): Draw => (c, s) => {
  const g = c.createRadialGradient(s * 0.4, s * 0.38, 1, s / 2, s / 2, s / 2);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, core);
  disc(c, s, "#0e7490");
  c.fillStyle = g;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.32, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "rgba(14,116,144,.7)";
  c.lineWidth = 1;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.18, 0, Math.PI * 2);
  c.stroke();
};
/** wind: arrow burst */
const wind: Draw = (c, s) => {
  disc(c, s, "#1d4ed8");
  c.strokeStyle = "#fff";
  c.fillStyle = "#fff";
  c.lineWidth = 1.8;
  c.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x1 = s / 2 + Math.cos(a) * s * 0.1, y1 = s / 2 + Math.sin(a) * s * 0.1;
    const x2 = s / 2 + Math.cos(a) * s * 0.33, y2 = s / 2 + Math.sin(a) * s * 0.33;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.beginPath();
    c.moveTo(x2 + Math.cos(a) * 2.5, y2 + Math.sin(a) * 2.5);
    c.lineTo(x2 + Math.cos(a + 2.4) * 3.5, y2 + Math.sin(a + 2.4) * 3.5);
    c.lineTo(x2 + Math.cos(a - 2.4) * 3.5, y2 + Math.sin(a - 2.4) * 3.5);
    c.closePath();
    c.fill();
  }
};
/** debris: purple diamond */
const debris: Draw = (c, s) => {
  c.fillStyle = "#9333ea";
  c.strokeStyle = "rgba(0,0,0,.85)";
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(s / 2, 1.5);
  c.lineTo(s - 1.5, s / 2);
  c.lineTo(s / 2, s - 1.5);
  c.lineTo(1.5, s / 2);
  c.closePath();
  c.fill();
  c.stroke();
  c.fillStyle = "#f5d0fe";
  for (const [x, y] of [[0.42, 0.4], [0.58, 0.47], [0.46, 0.6], [0.55, 0.33]]) {
    c.fillRect(s * x - 1.2, s * y - 1.2, 2.4, 2.4);
  }
};
/** flash flood: blue waves */
const flood: Draw = (c, s) => {
  c.fillStyle = "#1d4ed8";
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1.5;
  c.beginPath();
  c.roundRect(1.5, 1.5, s - 3, s - 3, 5);
  c.fill();
  c.stroke();
  c.strokeStyle = "#bfdbfe";
  c.lineWidth = 1.8;
  c.lineCap = "round";
  for (const y of [0.36, 0.55, 0.74]) {
    c.beginPath();
    for (let x = 0.2; x <= 0.8001; x += 0.05) {
      const yy = s * y + Math.sin((x - 0.2) * Math.PI * 3.3) * 1.8;
      if (x === 0.2) c.moveTo(s * x, yy);
      else c.lineTo(s * x, yy);
    }
    c.stroke();
  }
};
/** tropical genesis: cyclone symbol outline (dashed for "possible") */
const cyclone = (col: string, dashed: boolean): Draw => (c, s) => {
  const cx = s / 2, cy = s / 2;
  c.lineCap = "round";
  c.setLineDash(dashed ? [2.5, 2] : []);
  for (const [w, st] of [[4.2, "rgba(0,0,0,.75)"], [2.2, col]] as const) {
    c.strokeStyle = st;
    c.lineWidth = w;
    c.beginPath();
    c.arc(cx, cy, s * 0.22, 0, Math.PI * 2);
    c.stroke();
    // two spiral arms
    for (const k of [0, 1]) {
      c.beginPath();
      const a0 = k * Math.PI;
      c.arc(cx + Math.cos(a0) * s * 0.14, cy + Math.sin(a0) * s * 0.14, s * 0.33, a0 + Math.PI * 1.05, a0 + Math.PI * 1.55);
      c.stroke();
    }
  }
  c.setLineDash([]);
  c.fillStyle = col;
  c.beginPath();
  c.arc(cx, cy, 2.2, 0, Math.PI * 2);
  c.fill();
};
/** wildfire: flame */
const flame: Draw = (c, s) => {
  disc(c, s, "#431407");
  const path = (k: number, col: string) => {
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(s * 0.5, s * (0.16 + (1 - k) * 0.3));
    c.bezierCurveTo(s * (0.5 + 0.34 * k), s * 0.42, s * (0.5 + 0.3 * k), s * 0.8, s * 0.5, s * 0.82);
    c.bezierCurveTo(s * (0.5 - 0.3 * k), s * 0.8, s * (0.5 - 0.32 * k), s * 0.5, s * (0.5 - 0.08 * k), s * 0.42);
    c.bezierCurveTo(s * 0.47, s * 0.52, s * 0.44, s * 0.3, s * 0.5, s * (0.16 + (1 - k) * 0.3));
    c.fill();
  };
  path(1, "#f97316");
  path(0.6, "#fde047");
};
/** custom: target reticle */
const reticle: Draw = (c, s) => {
  disc(c, s, "#3f6212");
  c.strokeStyle = "#ecfccb";
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.22, 0, Math.PI * 2);
  c.moveTo(s / 2, s * 0.16);
  c.lineTo(s / 2, s * 0.84);
  c.moveTo(s * 0.16, s / 2);
  c.lineTo(s * 0.84, s / 2);
  c.stroke();
};

/* ---------- models 0.7 icons ---------- */
function rounded(c: CanvasRenderingContext2D, s: number, fill: string) {
  c.fillStyle = fill;
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1.5;
  c.beginPath();
  c.roundRect(1.5, 1.5, s - 3, s - 3, 5);
  c.fill();
  c.stroke();
}
function cloudPath(c: CanvasRenderingContext2D, s: number, y: number, k = 1) {
  c.beginPath();
  c.arc(s * 0.36, s * y, s * 0.16 * k, Math.PI * 0.5, Math.PI * 1.5);
  c.arc(s * 0.5, s * (y - 0.1 * k), s * 0.19 * k, Math.PI * 1.1, Math.PI * 1.95);
  c.arc(s * 0.66, s * y, s * 0.15 * k, Math.PI * 1.5, Math.PI * 0.5);
  c.closePath();
}
/** storm intensification: storm cell with a rising arrow */
const intensify: Draw = (c, s) => {
  disc(c, s, "#78350f");
  c.fillStyle = "rgba(251,191,36,.35)";
  c.strokeStyle = "#fbbf24";
  c.lineWidth = 1.3;
  c.beginPath();
  c.ellipse(s / 2, s * 0.56, s * 0.3, s * 0.22, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.strokeStyle = "#fff";
  c.fillStyle = "#fff";
  c.lineWidth = 2.2;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(s / 2, s * 0.74);
  c.lineTo(s / 2, s * 0.32);
  c.stroke();
  c.beginPath();
  c.moveTo(s / 2, s * 0.16);
  c.lineTo(s * 0.68, s * 0.38);
  c.lineTo(s * 0.32, s * 0.38);
  c.closePath();
  c.fill();
};
/** instability: gauge with the needle in the red */
const gauge: Draw = (c, s) => {
  disc(c, s, "#1c1917");
  const cx = s / 2, cy = s * 0.62, r = s * 0.32;
  const seg = [["#22c55e", 1, 1.33], ["#eab308", 1.33, 1.66], ["#ef4444", 1.66, 2]] as const;
  c.lineWidth = 3;
  for (const [col, a, b] of seg) {
    c.strokeStyle = col;
    c.beginPath();
    c.arc(cx, cy, r, Math.PI * a, Math.PI * b);
    c.stroke();
  }
  const a = Math.PI * 1.82;
  c.strokeStyle = "#fff";
  c.lineWidth = 1.8;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
  c.stroke();
  c.fillStyle = "#fff";
  c.beginPath();
  c.arc(cx, cy, 2, 0, Math.PI * 2);
  c.fill();
};
/** temperature: thermometer */
const thermo: Draw = (c, s) => {
  rounded(c, s, "#450a0a");
  const x = s / 2;
  c.fillStyle = "#fee2e2";
  c.beginPath();
  c.roundRect(x - s * 0.08, s * 0.14, s * 0.16, s * 0.5, s * 0.08);
  c.fill();
  c.beginPath();
  c.arc(x, s * 0.7, s * 0.15, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#ef4444";
  c.fillRect(x - s * 0.035, s * 0.34, s * 0.07, s * 0.34);
  c.beginPath();
  c.arc(x, s * 0.7, s * 0.1, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = "#fecaca";
  c.lineWidth = 1;
  for (const y of [0.24, 0.34, 0.44]) {
    c.beginPath();
    c.moveTo(x + s * 0.12, s * y);
    c.lineTo(x + s * 0.2, s * y);
    c.stroke();
  }
};
/** precipitation: raindrop */
const drop: Draw = (c, s) => {
  rounded(c, s, "#052e16");
  const g = c.createLinearGradient(0, s * 0.15, 0, s * 0.85);
  g.addColorStop(0, "#86efac");
  g.addColorStop(1, "#16a34a");
  c.fillStyle = g;
  c.strokeStyle = "rgba(0,0,0,.6)";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(s / 2, s * 0.14);
  c.bezierCurveTo(s * 0.62, s * 0.36, s * 0.76, s * 0.5, s * 0.76, s * 0.62);
  c.arc(s / 2, s * 0.62, s * 0.26, 0, Math.PI);
  c.bezierCurveTo(s * 0.24, s * 0.5, s * 0.38, s * 0.36, s / 2, s * 0.14);
  c.fill();
  c.stroke();
  c.fillStyle = "rgba(255,255,255,.75)";
  c.beginPath();
  c.ellipse(s * 0.42, s * 0.62, s * 0.05, s * 0.1, -0.4, 0, Math.PI * 2);
  c.fill();
};
/** storms: cloud with a bolt */
const stormCloud: Draw = (c, s) => {
  rounded(c, s, "#2e1065");
  c.fillStyle = "#e9d5ff";
  cloudPath(c, s, 0.46);
  c.fill();
  c.fillStyle = "#facc15";
  c.strokeStyle = "rgba(0,0,0,.6)";
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(s * 0.52, s * 0.5);
  c.lineTo(s * 0.4, s * 0.7);
  c.lineTo(s * 0.5, s * 0.7);
  c.lineTo(s * 0.44, s * 0.88);
  c.lineTo(s * 0.64, s * 0.62);
  c.lineTo(s * 0.54, s * 0.62);
  c.lineTo(s * 0.6, s * 0.5);
  c.closePath();
  c.fill();
  c.stroke();
};
/** tropical forecast: cyclone + small clock */
const cycloneClock: Draw = (c, s) => {
  cyclone("#f9a8d4", false)(c, s);
  const cx = s * 0.76, cy = s * 0.76, r = s * 0.2;
  c.fillStyle = "#0f172a";
  c.strokeStyle = "#fff";
  c.lineWidth = 1.2;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx, cy - r * 0.65);
  c.moveTo(cx, cy);
  c.lineTo(cx + r * 0.5, cy);
  c.stroke();
};
/** outlook: map tile with nested outlook bands */
const outlookMap: Draw = (c, s) => {
  rounded(c, s, "#14532d");
  const bands: [string, number][] = [["#c1e9c1", 0.36], ["#66a366", 0.29], ["#ffe066", 0.21], ["#ffa366", 0.14], ["#e06666", 0.08]];
  for (const [col, r] of bands) {
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(s * 0.52, s * 0.54, s * r * 1.15, s * r * 0.85, -0.5, 0, Math.PI * 2);
    c.fill();
  }
};
/** flood forecast: staff gauge in rising water */
const floodGauge: Draw = (c, s) => {
  rounded(c, s, "#082f49");
  c.fillStyle = "#e2e8f0";
  c.fillRect(s * 0.42, s * 0.14, s * 0.16, s * 0.62);
  c.fillStyle = "#ef4444";
  for (const y of [0.18, 0.3, 0.42]) c.fillRect(s * 0.42, s * y, s * 0.09, s * 0.05);
  c.fillStyle = "rgba(56,189,248,.9)";
  c.beginPath();
  c.moveTo(s * 0.1, s * 0.56);
  for (let x = 0.1; x <= 0.9001; x += 0.05) c.lineTo(s * x, s * 0.56 + Math.sin((x - 0.1) * Math.PI * 4) * s * 0.03);
  c.lineTo(s * 0.9, s * 0.88);
  c.lineTo(s * 0.1, s * 0.88);
  c.closePath();
  c.fill();
};
/* ---------- end models 0.7 icons ---------- */
/** models 0.8: storm track: a cell with a forecast cone */
const trackIcon: Draw = (c, s) => {
  rounded(c, s, "#3b0764");
  c.fillStyle = "rgba(232,121,249,.35)";
  c.beginPath();
  c.moveTo(s * 0.26, s * 0.7);
  c.lineTo(s * 0.86, s * 0.14);
  c.lineTo(s * 0.92, s * 0.42);
  c.closePath();
  c.fill();
  c.strokeStyle = "#f5d0fe";
  c.lineWidth = s * 0.07;
  c.setLineDash([s * 0.1, s * 0.07]);
  c.beginPath();
  c.moveTo(s * 0.26, s * 0.7);
  c.lineTo(s * 0.86, s * 0.3);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = "#f43f5e";
  c.beginPath();
  c.arc(s * 0.26, s * 0.7, s * 0.13, 0, Math.PI * 2);
  c.fill();
};
/** models 0.8: colour of a predicted storm strength (EF / kt / dBZ / probability scales) */
export function strengthColor(v: number | undefined, units = ""): string {
  if (v == null || !Number.isFinite(v)) return "#e5e7eb";
  const u = units.toLowerCase();
  const f = u === "ef" ? v / 5 : u === "kt" || u === "mph" ? (v - (u === "kt" ? 30 : 35)) / (u === "kt" ? 80 : 90) : u === "dbz" ? (v - 40) / 30 : u === "%" || u === "prob" ? (v > 1 ? v / 100 : v) : u === "in" ? v / 3 : v > 1 ? v / 100 : v;
  const x = Math.max(0, Math.min(1, f));
  const stops: [number, string][] = [[0, "#22c55e"], [0.3, "#facc15"], [0.55, "#fb923c"], [0.8, "#ef4444"], [1, "#e879f9"]];
  for (let i = 1; i < stops.length; i++) if (x <= stops[i][0]) return stops[i - (x - stops[i - 1][0] < stops[i][0] - x ? 1 : 0)][1];
  return stops[stops.length - 1][1];
}

const DRAW: Record<string, Draw> = {
  tornado,
  supercell,
  hail: hailstone("#a5f3fc"),
  sighail: hailstone("#22d3ee"),
  wind,
  debris,
  flash_flood: flood,
  tropical_genesis: cyclone("#f9a8d4", false),
  tropical_possible: cyclone("#fda4af", true),
  wildfire: flame,
  custom: reticle,
  storm_intensify: intensify,
  instability: gauge,
  temp_forecast: thermo,
  precip_forecast: drop,
  storm_forecast: stormCloud,
  tropical_forecast: cycloneClock,
  outlook: outlookMap,
  flood_forecast: floodGauge,
  storm_track: trackIcon, // models 0.8
};
export const drawFor = (t: string): Draw => DRAW[normTarget(t)] ?? reticle;
export const ICON_TARGETS = Object.keys(DRAW);

const R = 2;
function raster(size: number, draw: Draw): ImageData {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size * R;
  const c = cv.getContext("2d")!;
  c.scale(R, R);
  draw(c, size);
  return c.getImageData(0, 0, size * R, size * R);
}

const urls = new Map<string, string>();
/** data: URL of a target icon for the UI */
export function targetIconUrl(t: string, size = 22): string {
  const k = `${t}|${size}`;
  let u = urls.get(k);
  if (!u) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size * R;
    const c = cv.getContext("2d")!;
    c.scale(R, R);
    drawFor(t)(c, size);
    u = cv.toDataURL();
    urls.set(k, u);
  }
  return u;
}

/** Probability ring: faint full track + an arc proportional to the probability (decile steps). */
function ring(level: "low" | "med" | "high", dec: number): Draw {
  return (c, s) => {
    const r = s / 2 - 3;
    c.lineWidth = 3.2;
    c.strokeStyle = "rgba(0,0,0,.55)";
    c.beginPath();
    c.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    c.stroke();
    c.lineWidth = 2.6;
    c.strokeStyle = "rgba(255,255,255,.18)";
    c.beginPath();
    c.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = LEVEL_COLOR[level];
    c.lineCap = "round";
    c.beginPath();
    c.arc(s / 2, s / 2, r, -Math.PI / 2, -Math.PI / 2 + (Math.max(0.04, dec / 10) * Math.PI * 2));
    c.stroke();
  };
}
/** arrowhead (points up; rotated per feature) */
const arrowHead: Draw = (c, s) => {
  c.fillStyle = "#fff";
  c.strokeStyle = "rgba(0,0,0,.85)";
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(s / 2, 1.5);
  c.lineTo(s - 2, s - 2.5);
  c.lineTo(s / 2, s - 5.5);
  c.lineTo(2, s - 2.5);
  c.closePath();
  c.fill();
  c.stroke();
};

function add(map: MLMap, name: string, size: number, draw: Draw) {
  if (map.hasImage(name)) return;
  const img = raster(size, draw);
  map.addImage(name, { width: size * R, height: size * R, data: new Uint8Array(img.data.buffer) }, { pixelRatio: R });
}

/** Called from overlays/icons.ts registerIcons (every style load). */
export function registerMlIcons(map: MLMap) {
  for (const t of ICON_TARGETS) add(map, `ml-${t}`, 24, DRAW[t]);
  for (const l of ["low", "med", "high"] as const) for (let d = 0; d <= 10; d++) add(map, `ml-ring-${l}-${d}`, 44, ring(l, d));
  add(map, "ml-arrow", 14, arrowHead);
}
