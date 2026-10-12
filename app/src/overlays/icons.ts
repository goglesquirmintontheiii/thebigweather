// Map icons drawn on canvas (no image assets): camera types, aircraft, ships, wind barbs, front pips…

import type { Map as MLMap } from "maplibre-gl";

type Draw = (c: CanvasRenderingContext2D, s: number) => void;

const R = 2; // pixel ratio for crisp icons

function make(map: MLMap, name: string, size: number, draw: Draw, sdf = false) {
  if (map.hasImage(name)) return;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size * R;
  const c = cv.getContext("2d")!;
  c.scale(R, R);
  draw(c, size);
  const img = c.getImageData(0, 0, size * R, size * R);
  map.addImage(name, { width: size * R, height: size * R, data: new Uint8Array(img.data.buffer) }, { pixelRatio: R, sdf });
}

function badge(c: CanvasRenderingContext2D, s: number, fill: string, shape: "circle" | "round" | "square" = "circle") {
  c.fillStyle = fill;
  c.strokeStyle = "rgba(0,0,0,.75)";
  c.lineWidth = 1.5;
  c.beginPath();
  if (shape === "circle") c.arc(s / 2, s / 2, s / 2 - 1.5, 0, Math.PI * 2);
  else {
    const r = shape === "round" ? 5 : 2;
    c.roundRect(1.5, 3.5, s - 3, s - 7, r);
  }
  c.fill();
  c.stroke();
}

/** Camera icons by type: still = camera, video = play triangle, YouTube = rounded red,
 * buoy = ring buoy, link = globe-ish. Shapes differ, not just colors. */
const camera: Draw = (c, s) => {
  badge(c, s, "#1f2937");
  c.fillStyle = "#e5e7eb";
  c.fillRect(s * 0.25, s * 0.38, s * 0.42, s * 0.3);
  c.beginPath();
  c.moveTo(s * 0.67, s * 0.45);
  c.lineTo(s * 0.8, s * 0.38);
  c.lineTo(s * 0.8, s * 0.68);
  c.lineTo(s * 0.67, s * 0.61);
  c.fill();
};
const video: Draw = (c, s) => {
  badge(c, s, "#0e7490");
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(s * 0.38, s * 0.3);
  c.lineTo(s * 0.74, s * 0.5);
  c.lineTo(s * 0.38, s * 0.7);
  c.closePath();
  c.fill();
};
const youtube: Draw = (c, s) => {
  badge(c, s, "#dc2626", "round");
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(s * 0.4, s * 0.33);
  c.lineTo(s * 0.68, s * 0.5);
  c.lineTo(s * 0.4, s * 0.67);
  c.closePath();
  c.fill();
};
const buoycam: Draw = (c, s) => {
  badge(c, s, "#f59e0b");
  c.strokeStyle = "#1f2937";
  c.lineWidth = 2;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = "#1f2937";
  c.fillRect(s * 0.44, s * 0.22, s * 0.12, s * 0.14);
};
const pageLink: Draw = (c, s) => {
  badge(c, s, "#4b5563", "square");
  c.strokeStyle = "#fff";
  c.lineWidth = 1.6;
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.2, 0, Math.PI * 2);
  c.moveTo(s * 0.3, s * 0.5);
  c.lineTo(s * 0.7, s * 0.5);
  c.stroke();
};

const plane: Draw = (c, s) => {
  c.translate(s / 2, s / 2);
  c.fillStyle = "#fff";
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1.2;
  c.beginPath();
  const k = s / 24;
  const pts = [0, -10, 1.6, -3, 9, 2, 9, 3.6, 1.6, 1.4, 1.2, 7, 3.6, 9, 3.6, 10, 0, 9, -3.6, 10, -3.6, 9, -1.2, 7, -1.6, 1.4, -9, 3.6, -9, 2, -1.6, -3];
  c.moveTo(pts[0] * k, pts[1] * k);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i] * k, pts[i + 1] * k);
  c.closePath();
  c.fill();
  c.stroke();
};

const ship: Draw = (c, s) => {
  c.translate(s / 2, s / 2);
  const k = s / 20;
  c.fillStyle = "#fff";
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(0, -8 * k);
  c.lineTo(4 * k, 6 * k);
  c.lineTo(0, 4 * k);
  c.lineTo(-4 * k, 6 * k);
  c.closePath();
  c.fill();
  c.stroke();
};

const waffle: Draw = (c, s) => {
  c.fillStyle = "#facc15";
  c.strokeStyle = "#111";
  c.lineWidth = 1.5;
  c.fillRect(2, 2, s - 4, s - 4);
  c.strokeRect(2, 2, s - 4, s - 4);
  c.strokeStyle = "rgba(0,0,0,.55)";
  c.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    c.beginPath();
    c.moveTo(2 + (i * (s - 4)) / 4, 3);
    c.lineTo(2 + (i * (s - 4)) / 4, s - 3);
    c.moveTo(3, 2 + (i * (s - 4)) / 4);
    c.lineTo(s - 3, 2 + (i * (s - 4)) / 4);
    c.stroke();
  }
};

const satellite: Draw = (c, s) => {
  c.translate(s / 2, s / 2);
  c.rotate(-Math.PI / 4);
  c.fillStyle = "#e5e7eb";
  c.strokeStyle = "rgba(0,0,0,.8)";
  c.lineWidth = 1;
  c.fillRect(-3, -3, 6, 6);
  c.strokeRect(-3, -3, 6, 6);
  c.fillStyle = "#3b82f6";
  c.fillRect(-s * 0.45, -2, s * 0.3, 4);
  c.fillRect(s * 0.15, -2, s * 0.3, 4);
  c.strokeRect(-s * 0.45, -2, s * 0.3, 4);
  c.strokeRect(s * 0.15, -2, s * 0.3, 4);
};

const tide: Draw = (c, s) => {
  badge(c, s, "#0369a1");
  c.strokeStyle = "#fff";
  c.lineWidth = 1.6;
  c.beginPath();
  for (let x = 0; x <= 10; x++) {
    const px = s * 0.22 + (x / 10) * s * 0.56;
    const py = s * 0.52 + Math.sin((x / 10) * Math.PI * 2) * s * 0.1;
    if (x === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.stroke();
};

const buoy: Draw = (c, s) => {
  c.fillStyle = "#fde047";
  c.strokeStyle = "#111";
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(s / 2, 2);
  c.lineTo(s - 3, s - 3);
  c.lineTo(3, s - 3);
  c.closePath();
  c.fill();
  c.stroke();
};

const office: Draw = (c, s) => {
  badge(c, s, "#1d4ed8", "square");
  c.fillStyle = "#fff";
  c.font = `bold ${s * 0.42}px sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("NWS", s / 2, s / 2 + 0.5);
};

const airport: Draw = (c, s) => {
  badge(c, s, "#6d28d9");
  c.strokeStyle = "#fff";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(s * 0.3, s * 0.7);
  c.lineTo(s * 0.7, s * 0.3);
  c.stroke();
};

/** Tropical cyclone symbol (hurricane = filled, storm = open). */
function cyclone(fill: boolean): Draw {
  return (c, s) => {
    c.translate(s / 2, s / 2);
    c.strokeStyle = "#111";
    c.fillStyle = fill ? "#ef4444" : "#f97316";
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(0, 0, s * 0.22, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.lineWidth = 3;
    c.strokeStyle = fill ? "#ef4444" : "#f97316";
    c.beginPath();
    c.arc(0, -s * 0.22, s * 0.22, Math.PI * 1.0, Math.PI * 1.5);
    c.stroke();
    c.beginPath();
    c.arc(0, s * 0.22, s * 0.22, 0, Math.PI * 0.5);
    c.stroke();
  };
}

/** Front pips: drawn pointing "up" (toward the left side of the line direction). */
const pipCold: Draw = (c, s) => {
  c.fillStyle = "#2563eb";
  c.beginPath();
  c.moveTo(s * 0.2, s * 0.62);
  c.lineTo(s * 0.5, s * 0.18);
  c.lineTo(s * 0.8, s * 0.62);
  c.closePath();
  c.fill();
};
const pipWarm: Draw = (c, s) => {
  c.fillStyle = "#dc2626";
  c.beginPath();
  c.arc(s / 2, s * 0.62, s * 0.3, Math.PI, 0);
  c.fill();
};
const pipOccl: Draw = (c, s) => {
  c.fillStyle = "#9333ea";
  c.beginPath();
  c.moveTo(s * 0.05, s * 0.62);
  c.lineTo(s * 0.27, s * 0.22);
  c.lineTo(s * 0.49, s * 0.62);
  c.fill();
  c.beginPath();
  c.arc(s * 0.74, s * 0.62, s * 0.2, Math.PI, 0);
  c.fill();
};

/** Wind barb for `kt` (rounded to 5), staff pointing north (rotate by direction). */
function barb(kt: number): Draw {
  return (c, s) => {
    c.translate(s / 2, s / 2);
    c.strokeStyle = "#fff";
    c.fillStyle = "#fff";
    c.lineWidth = 1.4;
    c.shadowColor = "rgba(0,0,0,.9)";
    c.shadowBlur = 2;
    if (kt < 3) {
      c.beginPath();
      c.arc(0, 0, 3.5, 0, Math.PI * 2);
      c.stroke();
      return;
    }
    const len = s * 0.45;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, -len);
    c.stroke();
    let y = -len;
    let rem = Math.round(kt / 5) * 5;
    const step = 3.2;
    while (rem >= 50) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(8, y + 2.5);
      c.lineTo(0, y + 5);
      c.fill();
      y += 6.5;
      rem -= 50;
    }
    while (rem >= 10) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(8, y - 3);
      c.stroke();
      y += step;
      rem -= 10;
    }
    if (rem >= 5) {
      if (y === -len) y += step;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(4.5, y - 1.6);
      c.stroke();
    }
  };
}

const lightning: Draw = (c, s) => {
  c.strokeStyle = "#fff";
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(s / 2, 2);
  c.lineTo(s / 2, s - 2);
  c.moveTo(2, s / 2);
  c.lineTo(s - 2, s / 2);
  c.stroke();
};


/** Lightning bolt (SDF so color and fade come from the layer). */
const bolt: Draw = (c, s) => {
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(s * 0.58, s * 0.04);
  c.lineTo(s * 0.2, s * 0.56);
  c.lineTo(s * 0.46, s * 0.56);
  c.lineTo(s * 0.36, s * 0.96);
  c.lineTo(s * 0.8, s * 0.4);
  c.lineTo(s * 0.53, s * 0.4);
  c.closePath();
  c.fill();
};

/** Wind direction arrow pointing up (rotated by the layer to where the wind blows toward). */
const arrow: Draw = (c, s) => {
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(s / 2, s * 0.06);
  c.lineTo(s * 0.8, s * 0.5);
  c.lineTo(s * 0.58, s * 0.46);
  c.lineTo(s * 0.58, s * 0.94);
  c.lineTo(s * 0.42, s * 0.94);
  c.lineTo(s * 0.42, s * 0.46);
  c.lineTo(s * 0.2, s * 0.5);
  c.closePath();
  c.fill();
};

/** Storm report badges: colored circle with a white glyph per report type. */
function lsr(fill: string, glyph: (c: CanvasRenderingContext2D, s: number) => void): Draw {
  return (c, s) => {
    badge(c, s, fill);
    c.strokeStyle = "#fff";
    c.fillStyle = "#fff";
    c.lineWidth = 1.8;
    c.lineCap = "round";
    c.lineJoin = "round";
    glyph(c, s);
  };
}
const gTornado = (c: CanvasRenderingContext2D, s: number) => {
  const rows = [[0.26, 0.74, 0.3], [0.32, 0.68, 0.42], [0.38, 0.6, 0.54], [0.43, 0.55, 0.66], [0.47, 0.52, 0.76]];
  c.beginPath();
  for (const [a, b, y] of rows) {
    c.moveTo(s * a, s * y);
    c.lineTo(s * b, s * y);
  }
  c.stroke();
};
const gFunnel = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.moveTo(s * 0.26, s * 0.3);
  c.lineTo(s * 0.74, s * 0.3);
  c.lineTo(s * 0.5, s * 0.62);
  c.closePath();
  c.stroke();
};
const gHail = (c: CanvasRenderingContext2D, s: number) => {
  for (const [x, y, r] of [[0.38, 0.4, 0.11], [0.62, 0.42, 0.09], [0.48, 0.64, 0.12]]) {
    c.beginPath();
    c.arc(s * x, s * y, s * r, 0, Math.PI * 2);
    c.fill();
  }
};
const gWind = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.moveTo(s * 0.22, s * 0.38);
  c.lineTo(s * 0.62, s * 0.38);
  c.arc(s * 0.62, s * 0.3, s * 0.08, Math.PI / 2, -Math.PI, true);
  c.moveTo(s * 0.22, s * 0.52);
  c.lineTo(s * 0.76, s * 0.52);
  c.moveTo(s * 0.22, s * 0.66);
  c.lineTo(s * 0.56, s * 0.66);
  c.arc(s * 0.56, s * 0.74, s * 0.08, -Math.PI / 2, Math.PI, false);
  c.stroke();
};
const gFlood = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  for (const y of [0.4, 0.56, 0.72]) {
    c.moveTo(s * 0.22, s * y);
    c.bezierCurveTo(s * 0.34, s * (y - 0.08), s * 0.42, s * (y + 0.08), s * 0.5, s * y);
    c.bezierCurveTo(s * 0.58, s * (y - 0.08), s * 0.66, s * (y + 0.08), s * 0.78, s * y);
  }
  c.stroke();
};
const gSnow = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    c.moveTo(s / 2 + Math.cos(a) * s * 0.26, s / 2 + Math.sin(a) * s * 0.26);
    c.lineTo(s / 2 - Math.cos(a) * s * 0.26, s / 2 - Math.sin(a) * s * 0.26);
  }
  c.stroke();
};
const gIce = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.moveTo(s * 0.5, s * 0.22);
  c.lineTo(s * 0.72, s * 0.5);
  c.lineTo(s * 0.5, s * 0.78);
  c.lineTo(s * 0.28, s * 0.5);
  c.closePath();
  c.stroke();
};
const gRain = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.moveTo(s * 0.5, s * 0.22);
  c.bezierCurveTo(s * 0.62, s * 0.42, s * 0.7, s * 0.52, s * 0.7, s * 0.6);
  c.arc(s * 0.5, s * 0.6, s * 0.2, 0, Math.PI, false);
  c.bezierCurveTo(s * 0.3, s * 0.52, s * 0.38, s * 0.42, s * 0.5, s * 0.22);
  c.fill();
};
const gBolt = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.moveTo(s * 0.56, s * 0.2);
  c.lineTo(s * 0.34, s * 0.54);
  c.lineTo(s * 0.48, s * 0.54);
  c.lineTo(s * 0.42, s * 0.8);
  c.lineTo(s * 0.68, s * 0.44);
  c.lineTo(s * 0.53, s * 0.44);
  c.closePath();
  c.fill();
};
const gDot = (c: CanvasRenderingContext2D, s: number) => {
  c.beginPath();
  c.arc(s / 2, s / 2, s * 0.1, 0, Math.PI * 2);
  c.fill();
};

/* ---------- layers 0.5 ---------- */

/** Saffir-Simpson colors: TD, TS, Cat 1–5. */
export const TC_CATS: [string, string][] = [
  ["td", "#5ebaff"],
  ["ts", "#00faf4"],
  ["c1", "#ffffcc"],
  ["c2", "#ffe775"],
  ["c3", "#ffc140"],
  ["c4", "#ff8f20"],
  ["c5", "#ff6060"],
];
export const TC_NOW_SIZE = 60;

/** symbol radius by intensity (fraction of the canvas half-width) */
const TC_SCALE: Record<string, number> = { td: 0.76, ts: 0.82, c1: 0.85, c2: 0.89, c3: 0.93, c4: 0.97, c5: 1 };

/** Current-position cyclone symbol: two tapered spiral bands around a ringed eye, category
 * colour with a dark outline and soft glow, "TD"/"TS"/1–5 upright in the centre; larger for
 * stronger storms. `ang` (radians) turns only the bands; mirrored in the south. */
export function drawTcNow(c: CanvasRenderingContext2D, s: number, cat: string, south: boolean, ang: number) {
  const color = TC_CATS.find((x) => x[0] === cat)?.[1] ?? "#ffffff";
  const hurricane = cat.startsWith("c");
  const k = TC_SCALE[cat] ?? 0.8;
  const R = (s / 2 - 5) * k; // outer reach of the bands (room left for the glow)
  const eye = R * (hurricane ? 0.37 : 0.45);
  c.save();
  c.translate(s / 2, s / 2);
  c.save();
  c.rotate(ang);
  if (south) c.scale(-1, 1);
  // one band: a log-ish spiral from the eye wall outwards, ~0.8 turn-halves long, wide at the
  // base and tapering to a point; built as a closed outline so it can be filled and stroked
  const band = (k0: number) => {
    const N = 28;
    const L: [number, number][] = [];
    const Rr: [number, number][] = [];
    const sweep = Math.PI * 0.8;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const rho = eye * 0.92 + (R - eye * 0.92) * Math.pow(t, 0.85);
      const a = -Math.PI / 2 + k0 * Math.PI + t * sweep;
      const w = R * (hurricane ? 0.34 : 0.27) * Math.pow(1 - t, 1.25) + 0.25; // half-width, tapering to the tip
      // normal ~ radial direction for a slowly opening spiral
      const nx = Math.cos(a), ny = Math.sin(a);
      L.push([nx * (rho - w), ny * (rho - w)]);
      Rr.push([nx * (rho + w * 0.55), ny * (rho + w * 0.55)]);
    }
    c.beginPath();
    c.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) c.lineTo(L[i][0], L[i][1]);
    for (let i = Rr.length - 1; i >= 0; i--) c.lineTo(Rr[i][0], Rr[i][1]);
    c.closePath();
  };
  c.lineJoin = "round";
  // glow + dark casing
  c.shadowColor = hurricane ? color : "rgba(0,0,0,.6)";
  c.shadowBlur = hurricane ? 7 : 4;
  c.fillStyle = "rgba(8,12,18,.9)";
  c.strokeStyle = "rgba(8,12,18,.9)";
  c.lineWidth = 3;
  for (const k0 of [0, 1]) {
    band(k0);
    c.stroke();
    c.fill();
  }
  c.shadowBlur = 0;
  c.shadowColor = "transparent";
  // the bands: colour with a lighter leading edge
  const g = c.createRadialGradient(0, 0, eye * 0.6, 0, 0, R);
  g.addColorStop(0, color);
  g.addColorStop(1, hurricane ? color : `${color}cc`);
  c.fillStyle = g;
  for (const k0 of [0, 1]) {
    band(k0);
    c.fill();
  }
  c.restore();
  // eye (upright): filled for hurricanes, dark with a coloured ring for storms/depressions
  c.beginPath();
  c.arc(0, 0, eye, 0, Math.PI * 2);
  c.fillStyle = hurricane ? color : "rgba(12,18,26,.92)";
  c.fill();
  c.lineWidth = 2.2;
  c.strokeStyle = "rgba(8,12,18,.95)";
  c.stroke();
  if (!hurricane) {
    c.beginPath();
    c.arc(0, 0, eye - 1.6, 0, Math.PI * 2);
    c.lineWidth = 1.6;
    c.strokeStyle = color;
    c.stroke();
  }
  const label = hurricane ? cat.slice(1) : cat.toUpperCase();
  c.font = `800 ${Math.round(eye * (hurricane ? 1.25 : 0.92))}px "Inter", "Noto Sans", system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = hurricane ? "#0b0f14" : color;
  c.fillText(label, 0, eye * 0.06);
  c.restore();
}

/** Volcano: triangle colored by the aviation color code. */
function volcano(fill: string): Draw {
  return (c, s) => {
    c.fillStyle = fill;
    c.strokeStyle = "rgba(0,0,0,.85)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(s / 2, 2.5);
    c.lineTo(s - 2, s - 3);
    c.lineTo(2, s - 3);
    c.closePath();
    c.fill();
    c.stroke();
    c.fillStyle = "rgba(0,0,0,.55)";
    c.beginPath();
    c.moveTo(s / 2 - 2.2, 4.5);
    c.lineTo(s / 2 + 2.2, 4.5);
    c.lineTo(s / 2, 7.5);
    c.fill();
  };
}

/** Storm cell markers: TVS inverted red triangle, hail green triangle. */
const tvsIcon: Draw = (c, s) => {
  c.fillStyle = "#ef1b1b";
  c.strokeStyle = "#fff";
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(2, 3);
  c.lineTo(s - 2, 3);
  c.lineTo(s / 2, s - 2);
  c.closePath();
  c.fill();
  c.stroke();
};
const hailIcon: Draw = (c, s) => {
  c.fillStyle = "#22c55e";
  c.strokeStyle = "rgba(0,0,0,.85)";
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(s / 2, 2);
  c.lineTo(s - 2, s - 3);
  c.lineTo(2, s - 3);
  c.closePath();
  c.fill();
  c.stroke();
};
/** Arrowhead (SDF) pointing up, rotated to the storm motion. */
const head: Draw = (c, s) => {
  c.fillStyle = "#fff";
  c.beginPath();
  c.moveTo(s / 2, 1);
  c.lineTo(s - 2, s - 2);
  c.lineTo(s / 2, s * 0.7);
  c.lineTo(2, s - 2);
  c.closePath();
  c.fill();
};

function registerIcons05(map: MLMap) {
  for (const [cat] of TC_CATS)
    for (const south of [false, true]) {
      const name = `tc-now-${cat}-${south ? "s" : "n"}`;
      make(map, name, TC_NOW_SIZE, (c, s) => drawTcNow(c, s, cat, south, 0));
    }
  for (const [k, col] of [["green", "#22c55e"], ["yellow", "#facc15"], ["orange", "#f97316"], ["red", "#ef4444"], ["unassigned", "#9ca3af"]]) make(map, `volc-${k}`, 20, volcano(col));
  make(map, "sa-tvs", 20, tvsIcon);
  make(map, "sa-hail", 14, hailIcon);
  make(map, "sa-head", 14, head, true);
}
/* ---------- end layers 0.5 ---------- */

/** AQI marker: EPA category colour disc with a dark ring (the value is drawn as text on top). */
const AQI_COLORS = ["#9ca3af", "#00e400", "#ffff00", "#ff7e00", "#ff0000", "#8f3f97", "#7e0023"];
function aqiDot(fill: string): Draw {
  return (c, s) => {
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 1.6, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.globalAlpha = 0.92;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 1.6;
    c.strokeStyle = "rgba(0,0,0,.75)";
    c.stroke();
  };
}

export function registerIcons(map: MLMap) {
  registerIcons05(map);
  AQI_COLORS.forEach((col, i) => make(map, `aqi-${i}`, 26, aqiDot(col)));
  make(map, "cam-img", 22, camera);
  make(map, "cam-hls", 22, video);
  make(map, "cam-yt", 22, youtube);
  make(map, "cam-buoy", 22, buoycam);
  make(map, "cam-page", 22, pageLink);
  make(map, "plane", 24, plane);
  make(map, "ship", 20, ship);
  make(map, "waffle", 16, waffle);
  make(map, "satellite", 26, satellite);
  make(map, "tide", 18, tide);
  make(map, "buoy", 14, buoy);
  make(map, "office", 22, office);
  make(map, "airport", 16, airport);
  make(map, "tc-h", 26, cyclone(true));
  make(map, "tc-s", 26, cyclone(false));
  make(map, "pip-cold", 14, pipCold);
  make(map, "pip-warm", 14, pipWarm);
  make(map, "pip-occl", 18, pipOccl);
  make(map, "plus", 12, lightning, true);
  for (let k = 0; k <= 150; k += 5) make(map, `barb-${k}`, 34, barb(k));
  make(map, "bolt", 24, bolt, true);
  make(map, "arrow", 20, arrow, true);
  make(map, "lsr-tornado", 26, lsr("#dc2626", gTornado));
  make(map, "lsr-funnel", 26, lsr("#f87171", gFunnel));
  make(map, "lsr-hail", 26, lsr("#16a34a", gHail));
  make(map, "lsr-wind", 26, lsr("#2563eb", gWind));
  make(map, "lsr-flood", 26, lsr("#0f766e", gFlood));
  make(map, "lsr-snow", 26, lsr("#6366f1", gSnow));
  make(map, "lsr-ice", 26, lsr("#a855f7", gIce));
  make(map, "lsr-rain", 26, lsr("#0891b2", gRain));
  make(map, "lsr-lightning", 26, lsr("#ca8a04", gBolt));
  make(map, "lsr-other", 26, lsr("#6b7280", gDot));
}
