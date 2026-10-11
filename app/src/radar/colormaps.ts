// Color tables. Values are in the product's native units (dBZ, m/s, dB, ...).
// A table is a list of stops; between stops colors blend unless `solid` is set.
// Custom tables can be imported from GR/RadarScope-style .pal files.

export interface Stop {
  v: number;
  c: [number, number, number, number]; // rgba 0-255
  /** optional end color for this band (pal "Color: v r g b r2 g2 b2") */
  c2?: [number, number, number, number];
  solid?: boolean;
}

export interface ColorTable {
  id: string;
  name: string;
  units: string;
  min: number;
  max: number;
  stops: Stop[];
  /** color for range-folded gates */
  rf?: [number, number, number, number];
  /** categorical labels (HCA) */
  labels?: Record<number, string>;
}

const hex = (h: string, a = 255): [number, number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};
const S = (v: number, h: string, a = 255): Stop => ({ v, c: hex(h, a) });

export const BUILTIN: Record<string, ColorTable> = {
  REF: {
    id: "REF",
    name: "Reflectivity",
    units: "dBZ",
    min: -30,
    max: 80,
    stops: [
      S(-30, "#000000", 0),
      S(0, "#3b4d5c", 0),
      S(5, "#4a6d85", 120),
      S(10, "#3d8fb8", 200),
      S(15, "#2fb6d9"),
      S(20, "#16c45a"),
      S(25, "#0aa23a"),
      S(30, "#0a7a2a"),
      S(35, "#f2e30c"),
      S(40, "#f2b705"),
      S(45, "#f07a05"),
      S(50, "#e41b14"),
      S(55, "#b50d0d"),
      S(60, "#ff2ab4"),
      S(65, "#b02be3"),
      S(70, "#ffffff"),
      S(75, "#9ef2ff"),
      S(80, "#5ae0ff"),
    ],
    rf: hex("#7a2a9e", 170),
  },
  VEL: {
    id: "VEL",
    name: "Velocity",
    units: "m/s",
    min: -64,
    max: 64,
    stops: [
      S(-64, "#ff00ff"),
      S(-45, "#7f00ff"),
      S(-36, "#0a1f8a"),
      S(-28, "#1b6cff"),
      S(-20, "#00e5ff"),
      S(-12, "#00d61e"),
      S(-6, "#0b7a12"),
      S(-1.5, "#3a4a3a"),
      S(0, "#555555"),
      S(1.5, "#4a3a3a"),
      S(6, "#7d0d0d"),
      S(12, "#e00b0b"),
      S(20, "#ff7a1a"),
      S(28, "#ffd21a"),
      S(36, "#fff5a6"),
      S(45, "#ffffff"),
      S(64, "#ff9df5"),
    ],
    rf: hex("#7a2a9e", 170),
  },
  SW: {
    id: "SW",
    name: "Spectrum Width",
    units: "m/s",
    min: 0,
    max: 20,
    stops: [S(0, "#202020", 0), S(1, "#3a3a3a"), S(3, "#4f81bd"), S(6, "#2ecc71"), S(9, "#f1c40f"), S(12, "#e67e22"), S(15, "#e74c3c"), S(20, "#ffffff")],
    rf: hex("#7a2a9e", 170),
  },
  ZDR: {
    id: "ZDR",
    name: "Diff. Reflectivity",
    units: "dB",
    min: -4,
    max: 8,
    stops: [S(-4, "#2b2b2b"), S(-2, "#5a5a8a"), S(-0.5, "#8fa3c8"), S(0, "#c8c8c8"), S(0.5, "#7fd1ff"), S(1, "#21b0ff"), S(1.5, "#1a8f3a"), S(2, "#5fd13a"), S(2.5, "#f2e30c"), S(3, "#f2a105"), S(4, "#e41b14"), S(5, "#b50d0d"), S(6, "#ff6ad5"), S(8, "#ffffff")],
    rf: hex("#7a2a9e", 170),
  },
  RHO: {
    id: "RHO",
    name: "Correlation Coef.",
    units: "",
    min: 0.2,
    max: 1.05,
    stops: [S(0.2, "#101060"), S(0.45, "#1d2bb8"), S(0.6, "#2b8cd9"), S(0.7, "#27b3a0"), S(0.8, "#2aa84a"), S(0.85, "#9ccf2b"), S(0.9, "#f2e30c"), S(0.93, "#f2a105"), S(0.95, "#e8650a"), S(0.97, "#d6150f"), S(0.99, "#8f0b2e"), S(1.0, "#e6c3ff"), S(1.05, "#ffffff")],
    rf: hex("#7a2a9e", 170),
  },
  PHI: {
    id: "PHI",
    name: "Differential Phase",
    units: "°",
    min: 0,
    max: 360,
    stops: [S(0, "#1a1a6e"), S(60, "#2b8cd9"), S(120, "#2aa84a"), S(180, "#f2e30c"), S(240, "#e8650a"), S(300, "#d6150f"), S(360, "#ffffff")],
    rf: hex("#7a2a9e", 170),
  },
  CFP: {
    id: "CFP",
    name: "Clutter Filter Power",
    units: "dB",
    min: -20,
    max: 50,
    stops: [S(-20, "#202060"), S(0, "#4f81bd"), S(10, "#2ecc71"), S(20, "#f1c40f"), S(30, "#e67e22"), S(50, "#ffffff")],
  },
  KDP: {
    id: "KDP",
    name: "Specific Diff. Phase",
    units: "°/km",
    min: -2,
    max: 10,
    stops: [S(-2, "#5a2a5a"), S(-0.5, "#6f6f8f"), S(0, "#9a9a9a", 0), S(0.25, "#5aa0d9"), S(0.75, "#1fb34a"), S(1.5, "#f2e30c"), S(2.5, "#f2a105"), S(4, "#e41b14"), S(6, "#ff2ab4"), S(10, "#ffffff")],
    rf: hex("#7a2a9e", 170),
  },
  HCA: {
    id: "HCA",
    name: "Hydrometeor Class",
    units: "",
    min: 0,
    max: 16,
    stops: [
      { v: 0, c: hex("#000000", 0), solid: true },
      { v: 1, c: hex("#9c9c9c"), solid: true },
      { v: 2, c: hex("#767676"), solid: true },
      { v: 3, c: hex("#f3b0ff"), solid: true },
      { v: 4, c: hex("#00f5ff"), solid: true },
      { v: 5, c: hex("#00c3ff"), solid: true },
      { v: 6, c: hex("#2ca02c"), solid: true },
      { v: 7, c: hex("#a7f205"), solid: true },
      { v: 8, c: hex("#ffd400"), solid: true },
      { v: 9, c: hex("#ff7a00"), solid: true },
      { v: 10, c: hex("#ff0000"), solid: true },
      { v: 11, c: hex("#b5003f"), solid: true },
      { v: 12, c: hex("#ff3dff"), solid: true },
      { v: 13, c: hex("#000000", 0), solid: true },
      { v: 14, c: hex("#4d1c80"), solid: true },
      { v: 15, c: hex("#7a2a9e"), solid: true },
      { v: 16, c: hex("#000000", 0), solid: true },
    ],
    labels: { 1: "Biological", 2: "Ground clutter", 3: "Ice crystals", 4: "Dry snow", 5: "Wet snow", 6: "Rain", 7: "Heavy rain", 8: "Big drops", 9: "Graupel", 10: "Hail/rain", 11: "Large hail", 12: "Giant hail", 14: "Unknown", 15: "Range folded" },
  },
  VIL: {
    id: "VIL",
    name: "VIL",
    units: "kg/m²",
    min: 0,
    max: 80,
    stops: [S(0, "#000000", 0), S(1, "#4a6d85"), S(5, "#2fb6d9"), S(10, "#16c45a"), S(20, "#0a7a2a"), S(30, "#f2e30c"), S(40, "#f07a05"), S(50, "#e41b14"), S(60, "#ff2ab4"), S(70, "#b02be3"), S(80, "#ffffff")],
  },
  ET: {
    id: "ET",
    name: "Echo Tops",
    units: "kft",
    min: 0,
    max: 70,
    stops: [S(0, "#000000", 0), S(5, "#4a6d85"), S(15, "#2fb6d9"), S(25, "#16c45a"), S(35, "#f2e30c"), S(45, "#f07a05"), S(55, "#e41b14"), S(65, "#ff2ab4"), S(70, "#ffffff")],
  },
  PRECIP: {
    id: "PRECIP",
    name: "Precipitation",
    units: "in",
    min: 0,
    max: 10,
    stops: [S(0, "#000000", 0), S(0.01, "#bfe8ff", 150), S(0.1, "#5ac8fa"), S(0.25, "#1f7ae0"), S(0.5, "#16c45a"), S(1, "#0a7a2a"), S(1.5, "#f2e30c"), S(2, "#f07a05"), S(3, "#e41b14"), S(4, "#b50d0d"), S(6, "#ff2ab4"), S(8, "#b02be3"), S(10, "#ffffff")],
  },
  SRV: {
    id: "SRV",
    name: "Storm Rel. Velocity",
    units: "m/s",
    min: -64,
    max: 64,
    stops: [],
  },
};
BUILTIN.SRV.stops = BUILTIN.VEL.stops;
BUILTIN.SRV.rf = BUILTIN.VEL.rf;

/** Colorblind-friendly alternatives (blue/orange diverging, cividis-like sequential). */
export const COLORBLIND: Record<string, ColorTable> = {
  REF: {
    ...BUILTIN.REF,
    id: "REF_CB",
    name: "Reflectivity (colorblind)",
    stops: [S(-30, "#000000", 0), S(0, "#00204c", 0), S(5, "#00306f", 140), S(15, "#2a4f8f"), S(25, "#575d6d"), S(35, "#7d7c78"), S(45, "#a69d75"), S(50, "#d3c164"), S(55, "#f5e04a"), S(60, "#fff27a"), S(65, "#ffffff"), S(80, "#cfe8ff")],
  },
  VEL: {
    ...BUILTIN.VEL,
    id: "VEL_CB",
    name: "Velocity (colorblind)",
    stops: [S(-64, "#00153d"), S(-36, "#0b3c8c"), S(-20, "#3a8bd6"), S(-8, "#a6cff2"), S(0, "#555555"), S(8, "#f7c38d"), S(20, "#e7812f"), S(36, "#a64105"), S(64, "#3b1500")],
  },
};

/** Which table a product uses by default. */
export function defaultTableFor(product: string): string {
  const p = product.toUpperCase();
  if (["REF", "N0B", "N1B", "N2B", "N3B", "N0Q", "TZL", "TZ0"].includes(p)) return "REF";
  if (["VEL", "N0G", "N1G", "N2G", "N3G", "N0U", "TV0", "TV1", "TV2"].includes(p)) return "VEL";
  if (p === "N0S") return "SRV";
  if (["SW"].includes(p)) return "SW";
  if (["ZDR", "N0X", "N1X"].includes(p)) return "ZDR";
  if (["RHO", "N0C", "N1C"].includes(p)) return "RHO";
  if (["KDP", "N0K"].includes(p)) return "KDP";
  if (["N0H", "HHC"].includes(p)) return "HCA";
  if (p === "PHI") return "PHI";
  if (p === "CFP") return "CFP";
  if (p === "DVL") return "VIL";
  if (p === "EET") return "ET";
  if (["DAA", "DTA", "N1P", "NTP"].includes(p)) return "PRECIP";
  return "REF";
}

export const TEX_SIZE = 1024;

/** Rasterize a table to RGBA over [min, max]. */
export function rasterize(t: ColorTable): Uint8Array {
  const out = new Uint8Array(TEX_SIZE * 4);
  const stops = [...t.stops].sort((a, b) => a.v - b.v);
  for (let i = 0; i < TEX_SIZE; i++) {
    const v = t.min + ((i + 0.5) / TEX_SIZE) * (t.max - t.min);
    let c: number[];
    if (v <= stops[0].v) c = stops[0].c;
    else if (v >= stops[stops.length - 1].v) c = stops[stops.length - 1].c;
    else {
      let k = 0;
      while (k < stops.length - 1 && stops[k + 1].v <= v) k++;
      const a = stops[k], b = stops[k + 1];
      if (a.solid) c = a.c;
      else {
        const f = (v - a.v) / (b.v - a.v);
        const end = a.c2 ?? b.c;
        c = [0, 1, 2, 3].map((j) => a.c[j] + (end[j] - a.c[j]) * f);
      }
    }
    out.set(c.map((x) => Math.round(x)), i * 4);
  }
  return out;
}

export function colorAt(t: ColorTable, v: number): [number, number, number, number] {
  const r = rasterize(t);
  const i = Math.max(0, Math.min(TEX_SIZE - 1, Math.floor(((v - t.min) / (t.max - t.min)) * TEX_SIZE)));
  return [r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]];
}

/**
 * Parse a GR2Analyst / RadarScope style palette (.pal).
 * Supports: Product, Units, Scale, Offset, Step, Color, Color4, SolidColor, SolidColor4, RF.
 */
export function parsePal(text: string, name = "Custom"): ColorTable {
  let units = "";
  let scale = 1;
  let offset = 0;
  let product = "";
  const stops: Stop[] = [];
  let rf: [number, number, number, number] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rest = m[2].trim();
    const nums = rest.split(/[\s,]+/).map(Number).filter((x) => !Number.isNaN(x));
    switch (key) {
      case "product":
        product = rest;
        break;
      case "units":
        units = rest;
        break;
      case "scale":
        scale = nums[0] || 1;
        break;
      case "offset":
        offset = nums[0] || 0;
        break;
      case "rf":
        if (nums.length >= 3) rf = [nums[0], nums[1], nums[2], 255];
        break;
      case "color":
      case "solidcolor":
        if (nums.length >= 4) {
          const s: Stop = { v: nums[0], c: [nums[1], nums[2], nums[3], 255], solid: key === "solidcolor" };
          if (nums.length >= 7) s.c2 = [nums[4], nums[5], nums[6], 255];
          stops.push(s);
        }
        break;
      case "color4":
      case "solidcolor4":
        if (nums.length >= 5) {
          const s: Stop = { v: nums[0], c: [nums[1], nums[2], nums[3], nums[4]], solid: key === "solidcolor4" };
          if (nums.length >= 9) s.c2 = [nums[5], nums[6], nums[7], nums[8]];
          stops.push(s);
        }
        break;
    }
  }
  if (stops.length < 2) throw new Error("palette has fewer than 2 colors");
  // convert file units to native units
  let conv = 1;
  const u = units.toLowerCase();
  if (u.startsWith("kt") || u === "kts" || u === "knots") conv = 1 / 1.943844;
  else if (u === "mph") conv = 1 / 2.236936;
  for (const s of stops) s.v = (s.v * scale + offset) * conv;
  stops.sort((a, b) => a.v - b.v);
  const min = stops[0].v;
  const max = stops[stops.length - 1].v;
  return {
    id: "custom:" + name,
    name: name + (product ? ` (${product})` : ""),
    units: conv !== 1 ? "m/s" : units,
    min,
    max: max > min ? max : min + 1,
    stops,
    rf,
  };
}
