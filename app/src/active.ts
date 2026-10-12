// The visible weather layer, abstracted for header, timeline, legend and readouts.

import { computed } from "@preact/signals";
import { settings } from "./store";
import { frameIndex } from "./anim";
import { frames, currentFrame, activeTable, loading, radarError, liveSweep, displaySweep } from "./radar/controller";
import { gridFrames, gridLoading, gridError, gridTableActive, gridRaster, gridReady } from "./grid/controller";
import { gibsTimes } from "./grid/gibs";
import { gridDef } from "./weather";
import { intlTimes, intlReady, intlBad, intlError, intlListLoading } from "./intl/radar"; // intl & forecast tools
import type { ColorTable } from "./radar/colormaps";

export interface ActiveFrame {
  key: string;
  time: number;
  label?: string;
  state: "ok" | "err" | "wait";
  live?: boolean;
}

export const activeFrames = computed<ActiveFrame[]>(() => {
  const w = settings.value.weather;
  if (w.kind === "radar") return frames.value.map((f) => ({ key: f.key, time: f.sweep?.start ?? f.time, state: f.sweep ? "ok" : f.error ? "err" : "wait", live: f.live }));
  if (w.kind === "gibs") return gibsTimes.value.map((t) => ({ key: String(t), time: t, state: "ok" }));
  if (w.kind === "intl") {
    const rd = intlReady.value, bad = intlBad.value;
    return intlTimes.value.map((t, i) => ({ key: String(t), time: t, state: bad.has(i) ? "err" : rd.has(i) ? "ok" : "wait" }));
  }
  const ready = gridReady.value;
  return gridFrames.value.map((f) => ({ key: f.key, time: f.time, label: f.label || undefined, state: f.error ? "err" : ready.has(f.key) ? "ok" : "wait" }));
});

export const activeFrame = computed(() => activeFrames.value[frameIndex.value]);

/** Valid time of what's on screen. */
export const activeTime = computed(() => {
  const w = settings.value.weather;
  if (w.kind === "radar") {
    const s = displaySweep.value;
    return s?.start ?? currentFrame.value?.time ?? 0;
  }
  return activeFrame.value?.time ?? 0;
});

/** true when the picture is a forecast (model/NDFD) rather than an observation */
export const isForecast = computed(() => {
  const w = settings.value.weather;
  if (w.kind !== "grid") return false;
  const s = gridDef(w.id)?.source;
  return s === "model" || s === "ndfd" || s === "future";
});

export const activeLegend = computed<{ table: ColorTable; units: string; grid: boolean } | null>(() => {
  const w = settings.value.weather;
  if (w.kind === "radar") return displaySweep.value || liveSweep.value ? { table: activeTable.value, units: activeTable.value.units, grid: false } : null;
  if (w.kind === "grid") {
    const t = gridTableActive.value;
    const d = gridDef(w.id);
    return t && gridRaster.value ? { table: t, units: d?.units ?? t.units, grid: true } : null;
  }
  return null;
});

export const activeLoading = computed(() => (settings.value.weather.kind === "radar" ? loading.value : settings.value.weather.kind === "grid" ? gridLoading.value : settings.value.weather.kind === "intl" ? intlListLoading.value && !intlTimes.value.length : false));
export const activeError = computed(() => (settings.value.weather.kind === "radar" ? radarError.value : settings.value.weather.kind === "grid" ? gridError.value : settings.value.weather.kind === "intl" ? intlError.value : null));

/** Loading progress for the timeline bars: frames ready / total, and whether the frame on screen is still loading. */
export const loadProgress = computed(() => {
  const fs = activeFrames.value;
  const done = fs.filter((f) => f.state !== "wait").length;
  const cur = fs[Math.min(frameIndex.value, fs.length - 1)];
  return { done, total: fs.length, current: activeLoading.value || (!!cur && cur.state === "wait") };
});
