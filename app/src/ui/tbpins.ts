// 0.8.2: toolbar pins (items from the "…" menu shown as toolbar buttons). Pure helpers, unit-tested.

/** pin an item (appended at the end) or unpin it */
export function togglePin(pins: readonly string[], id: string): string[] {
  return pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
}

/** move a pinned item d places (-1 = left, +1 = right), clamped */
export function movePin(pins: readonly string[], id: string, d: number): string[] {
  const i = pins.indexOf(id);
  if (i < 0) return [...pins];
  const j = Math.max(0, Math.min(pins.length - 1, i + d));
  const out = [...pins];
  out.splice(i, 1);
  out.splice(j, 0, id);
  return out;
}

/** drop unknown ids and duplicates (keeps order) */
export function cleanPins(pins: readonly string[] | undefined, known: (id: string) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pins ?? []) if (!seen.has(p) && known(p)) seen.add(p), out.push(p);
  return out;
}

/** how many pinned buttons fit: `avail` px for the whole bar, `base` px used by the fixed buttons,
 *  `per` px per pinned button, `n` pinned items */
export function fitCount(avail: number, base: number, per: number, n: number): number {
  if (!(per > 0) || !Number.isFinite(avail) || !Number.isFinite(base)) return n;
  return Math.max(0, Math.min(n, Math.floor((avail - base + 0.5) / per)));
}
