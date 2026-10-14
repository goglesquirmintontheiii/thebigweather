// 0.8.1 perf: performance presets and their resolved values (pure, no DOM: unit-tested).

export type PerfPreset = "auto" | "quality" | "balanced" | "low";
export type RadarQ = "high" | "med" | "low";
export type Prefetch = "all" | "near" | "none";

/** What the app actually uses. */
export interface PerfValues {
  /** fraction of the screen's pixel density the maps render at (0.5 … 1) */
  pixelRatio: number;
  /** 0 = unlimited */
  maxFps: number;
  /** animated effects: wind particles, pulsing, CSS transitions */
  anim: boolean;
  /** extra map panes beyond the main map that may be open (1 + this = maps) */
  maxPanes: number;
  /** longest side (px) of a satellite / gridded image */
  imgRes: number;
  /** decoded image frames kept in memory, all maps together (MB) */
  cacheMB: number;
  /** radar smoothing ceiling: high = as set, med = light, low = off */
  radarQ: RadarQ;
  /** stop drawing while the window is hidden or minimised */
  pauseHidden: boolean;
  /** frames loaded ahead for animation */
  prefetch: Prefetch;
}

/** The stored choice: a preset plus any options set by hand. */
export interface PerfCfg {
  preset: PerfPreset;
  over: Partial<PerfValues>;
  /** small FPS / memory readout */
  hud: boolean;
}

export const PRESETS: Record<Exclude<PerfPreset, "auto">, PerfValues> = {
  // today's behaviour: nothing reduced (caches are bounded, which never changes the picture)
  quality: { pixelRatio: 1, maxFps: 0, anim: true, maxPanes: 8, imgRes: 2400, cacheMB: 1024, radarQ: "high", pauseHidden: false, prefetch: "all" },
  balanced: { pixelRatio: 1, maxFps: 60, anim: true, maxPanes: 3, imgRes: 1600, cacheMB: 512, radarQ: "med", pauseHidden: true, prefetch: "near" },
  low: { pixelRatio: 0.6, maxFps: 30, anim: false, maxPanes: 1, imgRes: 1024, cacheMB: 192, radarQ: "low", pauseHidden: true, prefetch: "none" },
};

export const DEFAULT_PERF: PerfCfg = { preset: "auto", over: {}, hud: false };

export interface Hardware {
  cores?: number;
  /** GB (navigator.deviceMemory, capped at 8 by browsers) */
  memGB?: number;
  /** unmasked WebGL renderer string */
  gpu?: string;
}

/** Software rasterisers (no GPU): SwiftShader, llvmpipe, Microsoft Basic Render, … */
export function softwareGpu(gpu: string | undefined): boolean {
  return !!gpu && /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|subzero/i.test(gpu);
}

/** Auto preset from the hardware. A strong PC (or anything unknown) gets Quality = today's behaviour. */
export function autoPreset(h: Hardware): Exclude<PerfPreset, "auto"> {
  if (softwareGpu(h.gpu)) return "low";
  const cores = h.cores ?? 8;
  const mem = h.memGB ?? 8;
  if (cores <= 2 || mem <= 2) return "low";
  if (cores <= 4 || mem < 8) return "balanced";
  return "quality";
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Preset values with the hand-set options on top (sanitised). */
export function resolvePerf(c: PerfCfg, h: Hardware, safe = false): PerfValues & { preset: Exclude<PerfPreset, "auto"> } {
  const preset = safe ? "low" : c.preset === "auto" ? autoPreset(h) : c.preset;
  const base = PRESETS[preset] ?? PRESETS.quality;
  const o = safe ? {} : c.over ?? {};
  const v: PerfValues = { ...base, ...o };
  v.pixelRatio = clamp(Number(v.pixelRatio) || 1, 0.5, 1);
  v.maxFps = [0, 30, 60].includes(Number(v.maxFps)) ? Number(v.maxFps) : base.maxFps;
  v.maxPanes = clamp(Math.round(Number(v.maxPanes) || 0), 0, 8);
  v.imgRes = clamp(Math.round(Number(v.imgRes) || base.imgRes), 512, 2400);
  v.cacheMB = clamp(Math.round(Number(v.cacheMB) || base.cacheMB), 64, 4096);
  if (!["high", "med", "low"].includes(v.radarQ)) v.radarQ = base.radarQ;
  if (!["all", "near", "none"].includes(v.prefetch)) v.prefetch = base.prefetch;
  v.anim = !!v.anim;
  v.pauseHidden = !!v.pauseHidden;
  return { ...v, preset };
}

/** Radar smoothing actually drawn. */
export function radarSmooth(set: number, q: RadarQ): number {
  return q === "low" ? 0 : q === "med" ? Math.min(set, 0.5) : set;
}

/** Image size for a viewport so that `frames` frames of `bpp` bytes per pixel fit into `budget` bytes
 * and the longest side stays within `cap`. Keeps the aspect ratio; never below 64 px. */
export function fitImage(w: number, h: number, cap: number, frames: number, bpp: number, budget: number): { w: number; h: number } {
  let s = Math.min(1, cap / Math.max(w, h, 1));
  const per = budget / Math.max(1, frames);
  const bytes = w * h * s * s * bpp;
  if (bytes > per) s *= Math.sqrt(per / bytes);
  return { w: Math.max(64, Math.round(w * s)), h: Math.max(64, Math.round(h * s)) };
}
