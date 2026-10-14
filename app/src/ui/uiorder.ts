// 0.8.1: pure helpers for the rearrangeable rail (Sidebar.tsx) and the resizable merged stats
// panel (StatsPanel.tsx). No DOM / store imports, so tests can load them.

/** The saved order with unknown ids dropped and any id missing from it (new in a later version)
 * inserted at its default spot (its index in the default order). */
export function mergeOrder(saved: readonly string[] | undefined | null, defaults: readonly string[]): string[] {
  if (!saved?.length) return defaults.slice();
  const known = new Set(defaults);
  const out: string[] = [];
  for (const id of saved) if (known.has(id) && !out.includes(id)) out.push(id);
  // new ids go to their default index (in default order, so several new ones keep their spacing)
  for (let i = 0; i < defaults.length; i++) {
    const id = defaults[i];
    if (!out.includes(id)) out.splice(Math.min(i, out.length), 0, id);
  }
  return out;
}

/** Moves `id` by `delta` places (clamped). */
export function moveBy(order: readonly string[], id: string, delta: number): string[] {
  const i = order.indexOf(id);
  if (i < 0) return order.slice();
  const j = Math.max(0, Math.min(order.length - 1, i + delta));
  return moveTo(order, id, j);
}

/** Moves `id` to index `to` (index in the list after removal). */
export function moveTo(order: readonly string[], id: string, to: number): string[] {
  const out = order.filter((x) => x !== id);
  if (out.length === order.length) return order.slice();
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}

/** Drop target: dragging `id` onto `target`, before or after it. */
export function dropAt(order: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target) return order.slice();
  const rest = order.filter((x) => x !== id);
  const t = rest.indexOf(target);
  if (t < 0) return order.slice();
  rest.splice(after ? t + 1 : t, 0, id);
  return rest;
}

/** Same order as the default? (then nothing needs saving) */
export function isDefaultOrder(order: readonly string[], defaults: readonly string[]): boolean {
  return order.length === defaults.length && order.every((x, i) => x === defaults[i]);
}

export type MergedLayout = "mini" | "compact" | "full";
/** Merged stats panel: the layout for a panel height (px). Short = one line, medium = the
 * dense grid, tall = the original full view (System / Server process / App sections). */
export const MINI_MAX_H = 64;
export const COMPACT_MAX_H = 230;
export function mergedLayout(h: number | null | undefined, mini: boolean): MergedLayout {
  if (h == null) return mini ? "mini" : "compact";
  return h < MINI_MAX_H ? "mini" : h < COMPACT_MAX_H ? "compact" : "full";
}
