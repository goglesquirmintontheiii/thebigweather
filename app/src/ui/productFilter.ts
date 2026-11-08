// 0.8.2: search for the product dropdowns (pure, unit-tested in tests/panes082.test.ts).

export interface PItem {
  value: string;
  label: string;
  /** small text after the label (key hint, tilt) */
  hint?: string;
}
export interface PGroup {
  label: string;
  items: PItem[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

const words = (s: string) => norm(s).split(/[^a-z0-9.°]+/).filter(Boolean);

/** Groups whose items match every word of the query: each query word starts a word of the item's
 * name, hint, id or group name ("vel" finds Velocity, not Level II; "rot 24" finds Rotation track
 * 24h); empty groups are dropped. A query that names a group ("mrms") keeps that group's items. */
export function filterGroups(groups: PGroup[], q: string): PGroup[] {
  const qw = words(q);
  if (!qw.length) return groups.filter((g) => g.items.length);
  const out: PGroup[] = [];
  for (const g of groups) {
    const gw = words(g.label);
    const items = g.items.filter((it) => {
      const hay = [...words(it.label), ...words(it.hint ?? ""), ...gw, ...words(it.value)];
      return qw.every((w) => hay.some((h) => h.startsWith(w)));
    });
    if (items.length) out.push({ label: g.label, items });
  }
  return out;
}

/** the items in display order (for arrow keys) */
export const flatItems = (groups: PGroup[]): PItem[] => groups.flatMap((g) => g.items);

/** next index for an arrow key (wraps) */
export function stepIndex(i: number, d: number, n: number): number {
  if (n <= 0) return -1;
  if (i < 0) return d > 0 ? 0 : n - 1;
  return (i + d + n) % n;
}
