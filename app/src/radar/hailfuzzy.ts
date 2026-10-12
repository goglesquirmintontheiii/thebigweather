// radar 0.6: HSDA-like hail size discrimination (fuzzy logic on Z, ZDR, CC and height vs the
// melting level), after Ortega et al. (2016). Shared by the analysis worker and the inspector.
// Classes: 0 none, 1 small (< 1 in), 2 large (1–2 in), 3 giant (> 2 in).

type T4 = [number, number, number, number];
interface Cls {
  z: T4;
  zdr: T4;
  cc: T4;
}

const trap = (x: number, [a, b, c, d]: T4) => (x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c));

// below / within the melting layer: melting hail shows raised ZDR (small) or near-zero/negative
// ZDR with depressed CC (large / giant tumbling stones)
const WET: Record<string, Cls> = {
  rain: { z: [30, 35, 52, 56], zdr: [1.6, 2.4, 5, 6.5], cc: [0.95, 0.975, 1, 1.02] },
  small: { z: [42, 47, 57, 62], zdr: [-0.3, 0.6, 3.5, 5], cc: [0.88, 0.93, 0.99, 1.01] },
  large: { z: [49, 55, 64, 69], zdr: [-1, -0.3, 1.6, 2.6], cc: [0.8, 0.87, 0.96, 0.98] },
  giant: { z: [53, 59, 75, 80], zdr: [-2.2, -1.2, 0.4, 1.1], cc: [0.6, 0.7, 0.88, 0.93] },
};
// above the melting layer: dry hail, ZDR near zero for every size, CC falls with size
const DRY: Record<string, Cls> = {
  rain: { z: [30, 35, 48, 52], zdr: [1, 1.8, 5, 6], cc: [0.96, 0.98, 1, 1.02] },
  small: { z: [42, 47, 55, 60], zdr: [-0.6, -0.3, 0.5, 0.9], cc: [0.93, 0.96, 1, 1.01] },
  large: { z: [49, 55, 62, 67], zdr: [-0.8, -0.5, 0.4, 0.8], cc: [0.87, 0.91, 0.98, 0.99] },
  giant: { z: [54, 60, 75, 80], zdr: [-1.3, -0.9, 0.3, 0.6], cc: [0.74, 0.8, 0.93, 0.96] },
};
const ORDER = ["rain", "small", "large", "giant"] as const;

/** Hail size class at a gate. `dh` = beam height minus the 0 °C height (m). */
export function hailClass(z: number, zdr: number, cc: number, dh: number): 0 | 1 | 2 | 3 {
  if (!(z >= 45) || !Number.isFinite(zdr) || !Number.isFinite(cc) || cc < 0.7) return 0; // lower CC is debris / non-meteorological
  const set = dh > 500 ? DRY : WET;
  let best = -1;
  let bs = 0;
  for (let i = 0; i < ORDER.length; i++) {
    const c = set[ORDER[i]];
    const mz = trap(z, c.z);
    if (mz <= 0) continue;
    const s = (mz * 1 + trap(zdr, c.zdr) * 0.8 + trap(cc, c.cc) * 0.6) / 2.4;
    if (s > bs) {
      bs = s;
      best = i;
    }
  }
  if (best <= 0 || bs < 0.5) return 0;
  return best as 1 | 2 | 3;
}

export const HAIL_LABEL = ["", "< 1 in", "1–2 in", "> 2 in"];
export const HAIL_COLOR = ["", "#4ade80", "#facc15", "#ef4444"];

/** MESH (mm) colour ramp shared by the hail overlays. */
export const MESH_STOPS: [number, [number, number, number]][] = [
  [6, [74, 222, 128]],
  [13, [250, 204, 21]],
  [25, [251, 146, 60]],
  [38, [239, 68, 68]],
  [51, [217, 70, 239]],
  [76, [147, 51, 234]],
  [100, [255, 255, 255]],
];
export function meshColor(mm: number): [number, number, number] | null {
  if (!(mm >= MESH_STOPS[0][0])) return null;
  let c = MESH_STOPS[0][1];
  for (const [v, col] of MESH_STOPS) if (mm >= v) c = col;
  return c;
}
export const mmToIn = (mm: number) => mm / 25.4;
