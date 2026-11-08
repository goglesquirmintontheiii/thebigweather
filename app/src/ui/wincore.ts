// 0.8.2 windows: pure helpers for the shared window frame (winframe.tsx) and the pop-out settings
// sync (winsync.ts). No DOM / store imports, so tests can load them.

/** Moves `id` to the top of the window stack (adds it when missing). */
export function raise(stack: readonly string[], id: string): string[] {
  return [...stack.filter((x) => x !== id), id];
}

/** The topmost window that is open and not minimized, or null. */
export function topOf(stack: readonly string[], skip: (id: string) => boolean): string | null {
  for (let i = stack.length - 1; i >= 0; i--) if (!skip(stack[i])) return stack[i];
  return null;
}

/** Window id of a centre window: the first class name (every CenterModal has a unique one), else the title. */
export function centerId(cls: string, title: unknown): string {
  const c = cls.trim().split(/\s+/)[0];
  return `c:${c || (typeof title === "string" ? title : "window")}`;
}

/** Top-level settings keys whose value changed since `snap` (JSON per key). Returns the changed values
 * and the new snapshot. `snap` is not modified. */
export function changedKeys(snap: Readonly<Record<string, string>>, obj: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): { changed: Record<string, unknown>; snap: Record<string, string> } {
  const next: Record<string, string> = { ...snap };
  const changed: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (skip.has(k)) continue;
    let j: string;
    try {
      j = JSON.stringify(obj[k]) ?? "null";
    } catch {
      continue;
    }
    if (snap[k] !== j) {
      changed[k] = obj[k];
      next[k] = j;
    }
  }
  return { changed, snap: next };
}

/** Peers (pop-out windows) still alive: seen within `ttl` ms. */
export function livePeers<T extends { at: number }>(peers: Readonly<Record<string, T>>, now: number, ttl = 8000): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(peers)) if (now - v.at < ttl) out[k] = v;
  return out;
}

/** Rail button → the window it opens (for minimize / pop-out aware clicks). */
export const RAIL_WIN: Record<string, string> = {
  forecast: "c:fcc",
  radio: "c:rc",
  seismo: "c:sk",
  hist: "c:hstorm",
  ml: "c:mlcenter",
  space: "c:d6-space",
  dash: "c:dash",
  timeline: "c:atl",
};
/** Window id for a rail button (side panels are "p:<panel>"). */
export function railWinId(railId: string): string {
  return RAIL_WIN[railId] ?? `p:${railId}`;
}
