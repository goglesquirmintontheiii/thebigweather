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
  const x = h.replace("#", "");
  const n = parseInt(x.slice(0, 6), 16);
  const alpha = x.length === 8 ? parseInt(x.slice(6, 8), 16) : a;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
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

// ---------- gridded products (Phase 2) ----------
const T = (id: string, name: string, units: string, min: number, max: number, stops: Stop[], extra: Partial<ColorTable> = {}): ColorTable => ({ id, name, units, min, max, stops, ...extra });
const cat = (id: string, name: string, entries: [number, string, string][]): ColorTable => ({
  id,
  name,
  units: "class",
  min: Math.min(...entries.map((e) => e[0])) - 0.5,
  max: Math.max(...entries.map((e) => e[0])) + 0.5,
  stops: entries.map(([v, c]) => ({ v: v - 0.5, c: hex(c), solid: true })).concat([{ v: Math.max(...entries.map((e) => e[0])) + 0.5, c: hex("#000000", 0), solid: true }]),
  labels: Object.fromEntries(entries.map(([v, , l]) => [v, l])),
});

Object.assign(BUILTIN, {
  TEMP: T("TEMP", "Temperature", "°C", -45, 50, [S(-45, "#e8e8ff"), S(-35, "#c9a7f2"), S(-28, "#8b4fd6"), S(-20, "#3b2aa8"), S(-12, "#1f5fd6"), S(-6, "#3fa0f0"), S(0, "#8fd9f5"), S(0.01, "#5fd18a"), S(5, "#2ea84a"), S(10, "#9ccf2b"), S(15, "#f2e30c"), S(20, "#f2a105"), S(25, "#e8650a"), S(30, "#d6150f"), S(35, "#9e0b2a"), S(40, "#ff4fd8"), S(45, "#ffffff"), S(50, "#d0d0d0")]),
  DEW: T("DEW", "Dewpoint", "°C", -30, 30, [S(-30, "#6b4423"), S(-15, "#a6713d"), S(-5, "#c9a26b"), S(0, "#d9cfa0"), S(5, "#9fd18a"), S(10, "#3fae4f"), S(15, "#1f7a3a"), S(18, "#1f9fbf"), S(21, "#2b5fd6"), S(24, "#7b3fd6"), S(27, "#c03fd6"), S(30, "#ff9df5")]),
  SPREAD: T("SPREAD", "T/Td Spread", "°C", 0, 25, [S(0, "#1f9f3a"), S(2, "#7fd15a"), S(5, "#f2e30c"), S(10, "#f2a105"), S(15, "#d6150f"), S(25, "#6b0b2a")]),
  RH: T("RH", "Relative Humidity", "%", 0, 100, [S(0, "#7a4a1f"), S(15, "#b5763d"), S(30, "#d9b26b"), S(45, "#e6dfa8"), S(60, "#9fd18a"), S(75, "#3fae4f"), S(90, "#1f7a8a"), S(100, "#2b5fd6")]),
  WIND: T("WIND", "Wind Speed", "m/s", 0, 50, [S(0, "#2b3a4a", 120), S(3, "#3f6f9f"), S(6, "#3fa0c0"), S(9, "#3fbf8a"), S(12, "#9ccf2b"), S(15, "#f2e30c"), S(20, "#f2a105"), S(25, "#e8650a"), S(30, "#d6150f"), S(38, "#b02be3"), S(50, "#ffffff")]),
  JET: T("JET", "Jet Stream Wind", "m/s", 0, 90, [S(0, "#1a1f2a", 0), S(20, "#2b4a6a", 120), S(30, "#3f8fbf"), S(40, "#3fbf8a"), S(50, "#f2e30c"), S(60, "#f2a105"), S(70, "#d6150f"), S(80, "#b02be3"), S(90, "#ffffff")]),
  MSLP: T("MSLP", "Pressure", "hPa", 960, 1050, [S(960, "#6b0b6b"), S(980, "#b02be3"), S(990, "#2b5fd6"), S(1000, "#3fa0f0"), S(1008, "#8fd9f5"), S(1013, "#e6e6e6"), S(1020, "#f2e30c"), S(1030, "#f2a105"), S(1040, "#d6150f"), S(1050, "#6b0b2a")]),
  HGT500: T("HGT500", "500 mb Height", "m", 5000, 6000, [S(5000, "#6b0b6b"), S(5300, "#2b5fd6"), S(5500, "#3fa0f0"), S(5640, "#9fd18a"), S(5760, "#f2e30c"), S(5880, "#f2a105"), S(6000, "#d6150f")]),
  CAPE: T("CAPE", "CAPE", "J/kg", 0, 6000, [S(0, "#000000", 0), S(100, "#3b4d5c", 90), S(250, "#2f6fa8"), S(500, "#2fb6d9"), S(1000, "#16c45a"), S(1500, "#9ccf2b"), S(2000, "#f2e30c"), S(2500, "#f2a105"), S(3000, "#e8650a"), S(4000, "#d6150f"), S(5000, "#ff2ab4"), S(6000, "#ffffff")]),
  SRH: T("SRH", "Storm-Relative Helicity", "m²/s²", 0, 600, [S(0, "#000000", 0), S(50, "#3b4d5c", 100), S(100, "#2f6fa8"), S(150, "#2fb6d9"), S(200, "#16c45a"), S(250, "#f2e30c"), S(300, "#f2a105"), S(400, "#d6150f"), S(500, "#ff2ab4"), S(600, "#ffffff")]),
  UH: T("UH", "Updraft Helicity", "m²/s²", 0, 200, [S(0, "#000000", 0), S(10, "#2f6fa8", 140), S(25, "#16c45a"), S(50, "#f2e30c"), S(75, "#f2a105"), S(100, "#d6150f"), S(150, "#ff2ab4"), S(200, "#ffffff")]),
  PWAT: T("PWAT", "Precipitable Water", "mm", 0, 75, [S(0, "#7a4a1f"), S(10, "#c9a26b"), S(20, "#e6dfa8"), S(30, "#9fd18a"), S(40, "#3fae4f"), S(50, "#1f9fbf"), S(60, "#2b5fd6"), S(75, "#b02be3")]),
  PRECIPMM: T("PRECIPMM", "Precipitation", "mm", 0, 250, [S(0, "#000000", 0), S(0.25, "#bfe8ff", 140), S(2.5, "#5ac8fa"), S(6, "#1f7ae0"), S(12, "#16c45a"), S(25, "#0a7a2a"), S(38, "#f2e30c"), S(50, "#f07a05"), S(75, "#e41b14"), S(100, "#b50d0d"), S(150, "#ff2ab4"), S(200, "#b02be3"), S(250, "#ffffff")]),
  PRATE: T("PRATE", "Precip Rate", "mm/h", 0, 100, [S(0, "#000000", 0), S(0.1, "#bfe8ff", 140), S(1, "#5ac8fa"), S(2.5, "#16c45a"), S(5, "#0a7a2a"), S(10, "#f2e30c"), S(20, "#f07a05"), S(40, "#e41b14"), S(60, "#ff2ab4"), S(100, "#ffffff")]),
  SNOWCM: T("SNOWCM", "Snowfall", "cm", 0, 100, [S(0, "#000000", 0), S(0.5, "#c9e6ff", 150), S(2.5, "#8fc8f2"), S(5, "#5a9fe0"), S(10, "#2b5fd6"), S(15, "#5a3fd6"), S(25, "#9b3fd6"), S(40, "#d63fbf"), S(60, "#ff7ad6"), S(100, "#ffffff")]),
  VISKM: T("VISKM", "Visibility", "km", 0, 16, [S(0, "#ff2ab4"), S(0.4, "#d6150f"), S(1.6, "#f2a105"), S(5, "#f2e30c"), S(8, "#9ccf2b"), S(12, "#3f6f5f", 120), S(16, "#000000", 0)]),
  CLOUD: T("CLOUD", "Cloud Cover", "%", 0, 100, [S(0, "#000000", 0), S(10, "#808080", 30), S(50, "#b0b0b0", 140), S(100, "#ffffff", 230)]),
  PROB: T("PROB", "Probability", "%", 0, 100, [S(0, "#000000", 0), S(5, "#3b4d5c", 120), S(15, "#2f6fa8"), S(30, "#16c45a"), S(45, "#f2e30c"), S(60, "#f2a105"), S(75, "#d6150f"), S(90, "#ff2ab4"), S(100, "#ffffff")]),
  MESH: T("MESH", "Hail Size", "mm", 0, 100, [S(0, "#000000", 0), S(2, "#2fb6d9", 150), S(10, "#16c45a"), S(19, "#f2e30c"), S(25, "#f2a105"), S(38, "#e41b14"), S(51, "#ff2ab4"), S(64, "#b02be3"), S(100, "#ffffff")]),
  ROT: T("ROT", "Rotation", "1/s", 0, 0.02, [S(0, "#000000", 0), S(0.002, "#3b4d5c", 100), S(0.004, "#2fb6d9"), S(0.006, "#16c45a"), S(0.008, "#f2e30c"), S(0.01, "#f2a105"), S(0.012, "#e41b14"), S(0.015, "#ff2ab4"), S(0.02, "#ffffff")]),
  AZSHEAR: T("AZSHEAR", "Azimuthal Shear", "1/s", -0.015, 0.015, [S(-0.015, "#0a1f8a"), S(-0.008, "#1b6cff"), S(-0.003, "#5ac8fa", 160), S(0, "#000000", 0), S(0.003, "#f2e30c", 160), S(0.008, "#f2a105"), S(0.012, "#e41b14"), S(0.015, "#ff2ab4")]),
  SMOKE: T("SMOKE", "Smoke", "µg/m³", 0, 250, [S(0, "#000000", 0), S(1, "#d9d2c0", 60), S(4, "#c2b58f", 120), S(12, "#b0915a"), S(35, "#9a6a3a"), S(55, "#7f4a2a"), S(150, "#5a2a2a"), S(250, "#2a1010")]),
  ETKM: T("ETKM", "Echo Tops", "km", 0, 20, [S(0, "#000000", 0), S(2, "#4a6d85"), S(5, "#2fb6d9"), S(8, "#16c45a"), S(11, "#f2e30c"), S(14, "#f07a05"), S(17, "#e41b14"), S(20, "#ffffff")]),
  PTYPE: cat("PTYPE", "Precip Type", [
    [0, "#00000000", "None"],
    [1, "#3fbf5a", "Warm rain"],
    [3, "#4fa3ff", "Snow"],
    [6, "#f2a105", "Convective rain"],
    [7, "#e41b14", "Rain + hail"],
    [10, "#9fd18a", "Cold rain"],
    [91, "#2fb6d9", "Tropical stratiform"],
    [96, "#ff2ab4", "Tropical convective"],
  ]),
  IR: T("IR", "Infrared", "K", 170, 320, [S(170, "#ffffff"), S(185, "#000000"), S(195, "#ff2ab4"), S(205, "#e41b14"), S(212, "#f2a105"), S(219, "#f2e30c"), S(226, "#16c45a"), S(233, "#1f5fd6"), S(240, "#7fd4ff"), S(242, "#d8d8d8"), S(320, "#0a0a0a")]),
  WV: T("WV", "Water Vapor", "K", 180, 280, [S(180, "#ffffff"), S(200, "#b02be3"), S(210, "#2b5fd6"), S(220, "#3fa0f0"), S(228, "#e6e6e6"), S(238, "#7f7f7f"), S(248, "#f2e30c"), S(258, "#e8650a"), S(268, "#6b2a0b"), S(280, "#000000")]),
  SWIR: T("SWIR", "Shortwave IR", "K", 200, 350, [S(200, "#ffffff"), S(240, "#a0a0a0"), S(280, "#404040"), S(300, "#101010"), S(310, "#f2e30c"), S(325, "#e41b14"), S(350, "#ffffff")]),
  VISGRAY: T("VISGRAY", "Reflectance", "", 0, 1.1, [S(0, "#000000"), S(0.15, "#3a3a3a"), S(0.4, "#9a9a9a"), S(0.8, "#e6e6e6"), S(1.1, "#ffffff")]),
  /* ---------- data 0.6: flooding & marine ---------- */
  FLASH: T("FLASH", "Unit Streamflow", "m³/s/km²", 0, 20, [S(0, "#000000", 0), S(0.2, "#3b4d5c", 90), S(0.5, "#2f6fa8", 160), S(1, "#2fb6d9"), S(2, "#16c45a"), S(3, "#f2e30c"), S(5, "#f2a105"), S(7, "#e41b14"), S(10, "#ff2ab4"), S(15, "#b02be3"), S(20, "#ffffff")]),
  FLASHRP: T("FLASHRP", "Return Period", "yr", 0, 100, [S(0, "#000000", 0), S(1, "#2f6fa8", 140), S(2, "#16c45a"), S(5, "#f2e30c"), S(10, "#f2a105"), S(25, "#e41b14"), S(50, "#ff2ab4"), S(100, "#ffffff")]),
  WAVE: T("WAVE", "Wave Height", "m", 0, 15, [S(0, "#0b1d3a", 120), S(0.5, "#123a6b"), S(1, "#1f5fd6"), S(1.5, "#3fa0f0"), S(2, "#3fbf8a"), S(3, "#9ccf2b"), S(4, "#f2e30c"), S(5, "#f2a105"), S(6, "#e8650a"), S(8, "#d6150f"), S(10, "#b02be3"), S(15, "#ffffff")]),
  WAVEPER: T("WAVEPER", "Wave Period", "s", 0, 25, [S(0, "#0b1d3a", 120), S(4, "#1f5fd6"), S(7, "#3fa0f0"), S(10, "#3fbf8a"), S(13, "#f2e30c"), S(16, "#f2a105"), S(19, "#d6150f"), S(25, "#ff2ab4")]),
  WAVEDIR: T("WAVEDIR", "Wave Direction", "°", 0, 360, [S(0, "#d6150f"), S(90, "#f2e30c"), S(180, "#16c45a"), S(270, "#2b5fd6"), S(360, "#d6150f")]),
  SSTA: T("SSTA", "SST Anomaly", "°C", -5, 5, [S(-5, "#2a0b6b"), S(-3, "#2b5fd6"), S(-1.5, "#3fa0f0"), S(-0.5, "#cfe8f5"), S(0, "#f2f2f2"), S(0.5, "#f5e3c0"), S(1.5, "#f2a105"), S(3, "#d6150f"), S(5, "#6b0b2a")]),
  // QPE / flash flood guidance: 1.0 = rain equals guidance; transparent below ~0.5
  FFGRATIO: T("FFGRATIO", "QPE / FFG", "ratio", 0, 3, [S(0, "#000000", 0), S(0.49, "#000000", 0), S(0.5, "#2f6fa8", 130), S(0.75, "#16c45a", 200), S(1, "#f2e30c"), S(1.25, "#f2a105"), S(1.5, "#e41b14"), S(2, "#ff2ab4"), S(3, "#ffffff")]),
  STREAMFLOW: T("STREAMFLOW", "Streamflow", "m³/s", 0, 5000, [S(0, "#000000", 0), S(10, "#2f6fa8", 140), S(100, "#2fb6d9"), S(500, "#16c45a"), S(1000, "#f2e30c"), S(2000, "#f2a105"), S(3500, "#e41b14"), S(5000, "#ff2ab4")]),
  /* ---------- end data 0.6 ---------- */
});

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
  if (p === "DVL" || p === "VIL") return "VIL";
  if (p === "CREF") return "REF";
  if (p === "ET") return "ETKM";
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
