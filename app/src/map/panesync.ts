// 0.8.2: pure helpers for map panes (layer resolution, frame picking, preload order), kept free of
// map/UI imports so they can be unit-tested (tests/panes082.test.ts).

/** Is a layer shown in a pane? Linked layers follow the main map; a per-pane override wins.
 * Unlinked panes show only what `unlinkedDefault` says (state lines) unless overridden. */
export function paneLayerOn(mainOn: boolean, linked: boolean, override: boolean | undefined, unlinkedDefault = false): boolean {
  if (override !== undefined) return override;
  return linked ? mainOn : unlinkedDefault;
}

/** Frame nearest to time t (t = 0: the newest). Frames sorted by time. */
export function nearestFrame<T extends { time: number }>(fs: T[], t: number): T | undefined {
  if (!fs.length) return undefined;
  if (!t) return fs[fs.length - 1];
  let best = fs[0];
  for (const f of fs) if (Math.abs(f.time - t) < Math.abs(best.time - t)) best = f;
  return best;
}

/** Of the frames that are ready, the one nearest to time t (shown while the wanted one loads). */
export function nearestReady<T extends { time: number }>(fs: T[], t: number, ready: (f: T) => boolean): T | undefined {
  return nearestFrame(fs.filter(ready), t || (fs.length ? fs[fs.length - 1].time : 0));
}

export type Prefetch = "all" | "near" | "none";

/** Which frames to preload, in order: the ones the loop plays next first (wrapping around).
 * "none" = only the next frame, "near" = the next 6, "all" = every frame (long runs: a window of
 * 3 back / 30 ahead, like the main map). */
export function preloadOrder(n: number, cur: number, mode: Prefetch): number[] {
  if (n <= 0) return [];
  if (cur < 0 || cur >= n) cur = n - 1;
  const out: number[] = [];
  const max = mode === "none" ? 1 : mode === "near" ? 6 : n > 40 ? 30 : n - 1;
  for (let k = 1; k <= Math.min(max, n - 1); k++) out.push((cur + k) % n);
  if (mode === "all" && n > 40) for (let k = 1; k <= 3; k++) if (cur - k >= 0) out.push(cur - k);
  return out;
}

/** Per-pane records keyed by pane number after pane `idx` is removed (later panes move up one). */
export function dropPane<V>(rec: Record<string, V> | undefined, idx: number): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(rec ?? {})) if (+k < idx) out[k] = v;
  else if (+k > idx) out[+k - 1] = v;
  return out;
}
