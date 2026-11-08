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
/** 0.8.3: scale that makes content of natural size natW × natH fit availW × availH (clamped; 2 decimals). */
export function fitScale(availW: number, availH: number, natW: number, natH: number, min = 0.75, max = 3): number {
  if (!(availW > 0) || !(availH > 0) || !(natW > 0) || !(natH > 0)) return 1;
  const f = Math.min(availW / natW, availH / natH);
  return Math.round(Math.max(min, Math.min(max, f)) * 100) / 100;
}

/* 0.8.3: keys pressed in a pop-out, passed to the main window (winkeys.ts) */
export interface KeyMsg {
  t: "key";
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}
const KEY_MODS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Dead", "Unidentified"]);
const EDIT_KEYS = new Set(["a", "c", "v", "x", "z", "y", "f", "p", "r", "w", "q", "+", "-", "=", "0"]);
type KeyLike = Pick<KeyMsg, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;
/** Should a pop-out pass this key to the main window? (`target`: what has focus there) */
export function shouldForward(k: KeyLike, target: { field: boolean; button: boolean }): boolean {
  if (KEY_MODS.has(k.key)) return false;
  const mod = k.ctrlKey || k.metaKey;
  if (mod && !k.altKey && !k.shiftKey && k.key.toLowerCase() === "k") return true; // command palette, also from text fields
  if (target.field) return false;
  if (k.key === "Escape" || k.key === "Tab") return false; // the pop-out's own
  if (target.button && (k.key === "Enter" || k.key === " ")) return false; // pressing a focused button
  if (mod && EDIT_KEYS.has(k.key.toLowerCase())) return false; // copy / paste / zoom / reload / close stay with the window
  return true;
}
/** keys that open something in the main window (it comes to the front) */
export const raisesMain = (k: Pick<KeyMsg, "key" | "ctrlKey" | "metaKey">) => k.key === "?" || ((k.ctrlKey || k.metaKey) && k.key.toLowerCase() === "k");

/** Window id for a rail button (side panels are "p:<panel>"). */
export function railWinId(railId: string): string {
  return RAIL_WIN[railId] ?? `p:${railId}`;
}
