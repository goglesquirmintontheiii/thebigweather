// Pure time helpers shared by the radar/grid controllers and history mode (no app imports, so
// they can be unit-tested with plain node).

export interface TimedVol {
  key: string;
  time: number;
}

/** Index of the item whose time is nearest `t` in a time-sorted list (-1 when empty). */
export function nearestIndex(times: number[], t: number): number {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/** For each target time (the main radar's frames) pick the nearest candidate volume within
 * `tolMs`. Returns the unique picked volumes, sorted by time. */
export function matchVolumes<T extends TimedVol>(targets: number[], cands: T[], tolMs: number): T[] {
  const sorted = cands.slice().sort((a, b) => a.time - b.time);
  const times = sorted.map((c) => c.time);
  const picked = new Set<number>();
  for (const t of targets) {
    const i = nearestIndex(times, t);
    if (i >= 0 && Math.abs(times[i] - t) <= tolMs) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
}

/** The item nearest `t` (by `time`) within `tolMs`, ignoring items without a time. */
export function nearestWithin<T>(list: T[], t: number, time: (x: T) => number | undefined, tolMs: number): T | undefined {
  let best: T | undefined;
  let bd = Infinity;
  for (const x of list) {
    const tx = time(x);
    if (tx == null) continue;
    const d = Math.abs(tx - t);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  return bd <= tolMs ? best : undefined;
}

/** Keep at most `cap` items, evenly spaced, always including the first and the last. */
export function thinEven<T>(list: T[], cap: number): T[] {
  if (cap <= 0 || list.length <= cap) return list;
  if (cap === 1) return [list[list.length - 1]];
  const out: T[] = [];
  let last = -1;
  for (let k = 0; k < cap; k++) {
    const i = Math.round((k * (list.length - 1)) / (cap - 1));
    if (i !== last) out.push(list[i]);
    last = i;
  }
  return out;
}

/** UTC days (YYYYMMDD) touched by [start, end]. */
export function utcDays(start: number, end: number, max = 10): string[] {
  const out: string[] = [];
  let d = Math.floor(start / 86400_000) * 86400_000;
  while (d <= end && out.length < max) {
    out.push(new Date(d).toISOString().slice(0, 10).replace(/-/g, ""));
    d += 86400_000;
  }
  return out;
}
