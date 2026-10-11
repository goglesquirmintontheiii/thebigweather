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

export function registerIcons(map: MLMap) {
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
}
