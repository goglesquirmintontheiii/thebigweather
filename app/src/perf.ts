// 0.8.1 perf: Settings → Performance (preset + options), safe mode after a crash, and the hooks that
// apply them to every MapLibre map (main map and panes). Stored apart from the main settings
// ("tbw.perf.v1") so a bad layout can be reset without losing these, and vice versa.

import { signal, computed, effect } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { DEFAULT_PERF, resolvePerf, type Hardware, type PerfCfg, type PerfValues } from "./perfcore";
import { rasterBudget } from "./grid/budget";

const KEY = "tbw.perf.v1";
const tbw = () => (window as any).tbw as any;

/** a preset forced from outside (TBW_PERF, automated screenshots = Quality): used, not saved */
const forced = (() => {
  try {
    const f = tbw()?.perfForce;
    return ["auto", "quality", "balanced", "low"].includes(f) ? (f as PerfCfg["preset"]) : null;
  } catch {
    return null;
  }
})();

function load(): PerfCfg {
  if (forced) return { ...structuredClone(DEFAULT_PERF), preset: forced };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && typeof v === "object") return { ...DEFAULT_PERF, ...v, over: { ...(v.over ?? {}) } };
  } catch {
    /* defaults */
  }
  return structuredClone(DEFAULT_PERF);
}

export const perfCfg = signal<PerfCfg>(load());
effect(() => {
  const v = perfCfg.value;
  if (forced) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
});
export function setPerf(fn: (c: PerfCfg) => void) {
  const c = structuredClone(perfCfg.value);
  fn(c);
  perfCfg.value = c;
}

/* ---------- hardware (for Auto) ---------- */
let hw: Hardware | null = null;
export function hardware(): Hardware {
  if (hw) return hw;
  const n = navigator as any;
  let gpu = "";
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext(); // don't keep a WebGL context for this
    }
  } catch {
    /* unknown */
  }
  hw = { cores: n.hardwareConcurrency, memGB: n.deviceMemory, gpu };
  return hw;
}

/* ---------- safe mode (decided by the desktop app; the preload already trimmed the layout) ---------- */
export interface SafeInfo {
  active: boolean;
  reason?: string;
  /** the layout from before safe mode can be restored */
  backup?: boolean;
}
function readSafe(): SafeInfo | null {
  try {
    return tbw()?.safe?.info?.() ?? null;
  } catch {
    return null;
  }
}
export const safeInfo = signal<SafeInfo | null>(readSafe());
/** the banner was answered */
export const safeAnswered = signal(false);
export function restoreLayout() {
  tbw()?.safe?.restore?.(); // puts the saved layout back and reloads normally
}
export function keepSafe() {
  tbw()?.safe?.keep?.();
  safeAnswered.value = true;
}

/** Everything the app uses (safe mode = Low-end until the next normal start). */
export const perf = computed<PerfValues & { preset: string }>(() => resolvePerf(perfCfg.value, perfCfg.value.preset === "auto" ? hardware() : {}, !!safeInfo.value?.active));
export const perfNow = () => perf.peek();

/* ---------- global effects ---------- */
effect(() => rasterBudget.setCap(perf.value.cacheMB * 1024 * 1024));

let noAnimStyle: HTMLStyleElement | null = null;
effect(() => {
  const off = !perf.value.anim;
  if (off && !noAnimStyle) {
    noAnimStyle = document.createElement("style");
    noAnimStyle.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition:none!important}";
    document.head.appendChild(noAnimStyle);
  } else if (!off && noAnimStyle) {
    noAnimStyle.remove();
    noAnimStyle = null;
  }
});

effect(() => {
  const p = perf.value.pauseHidden;
  try {
    tbw()?.perf?.setThrottle?.(p);
  } catch {
    /* not the desktop app */
  }
});

/** the main map lost its WebGL context and it didn't come back */
export const glLost = signal(false);

/* ---------- per-map: render resolution and frame-rate cap ---------- */
export function applyPerfToMap(m: MLMap) {
  const orig = m.triggerRepaint.bind(m);
  let last = 0;
  let timer = 0;
  m.on("render", () => void (last = performance.now()));
  (m as any).triggerRepaint = () => {
    const cap = perf.peek().maxFps;
    if (!cap) return orig();
    const wait = 1000 / cap - (performance.now() - last);
    if (wait <= 2) return orig();
    if (!timer)
      timer = window.setTimeout(() => {
        timer = 0;
        orig();
      }, wait);
  };
  let applied = 1;
  const stop = effect(() => {
    const pr = perf.value.pixelRatio;
    if (pr === applied) return;
    applied = pr;
    try {
      m.setPixelRatio((window.devicePixelRatio || 1) * pr);
    } catch {
      /* removed */
    }
  });
  m.once("remove", () => (stop(), clearTimeout(timer)));
}

/** pauses work for maps the user can't see (Settings → Performance → pause hidden) */
export const pageHidden = signal(typeof document !== "undefined" && document.visibilityState === "hidden");
document.addEventListener("visibilitychange", () => (pageHidden.value = document.visibilityState === "hidden"));
export const pausedNow = () => perf.peek().pauseHidden && pageHidden.peek();
