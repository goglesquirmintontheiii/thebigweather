// 0.8.4: the Layers tab's categories (same layout as Settings). Pure, so tests can load it.

export interface LayerCat {
  id: string;
  name: string;
  sub: string;
  /** layer groups inside it, in display order */
  groups: string[];
}

export const LAYER_CATS: LayerCat[] = [
  { id: "mine", name: "My layers", sub: "Weather layer, active, favourites", groups: [] },
  { id: "alerts", name: "Alerts & severe", sub: "Alerts, severe, tropical, hazards", groups: ["Alerts & warnings", "Severe", "Tropical", "Hazards"] },
  { id: "wx", name: "Weather", sub: "Precipitation, outlooks, observations", groups: ["Precipitation & winter", "Outlooks", "Observations"] },
  { id: "travel", name: "Travel", sub: "Aviation, marine, roads", groups: ["Aviation", "Marine", "Traffic & roads"] },
  { id: "env", name: "Environment", sub: "Health, space", groups: ["Environment & health", "Space"] },
  { id: "more", name: "Cameras & more", sub: "Cameras, reports, reference, files", groups: ["Cameras", "Chasers & reports", "Reference", "My files", "Fun"] },
];

/** the category for a layer group; a group no category names goes in the last one */
export function catOfGroup(group: string): string {
  return (LAYER_CATS.find((c) => c.groups.includes(group)) ?? LAYER_CATS[LAYER_CATS.length - 1]).id;
}

/** a category's groups: its own, then any unknown group that fell into it (before "Reference") */
export function groupsOfCat(cat: LayerCat, present: string[]): string[] {
  const extra = [...new Set(present)].filter((g) => !LAYER_CATS.some((c) => c.groups.includes(g)) && catOfGroup(g) === cat.id);
  if (!extra.length) return cat.groups;
  const at = cat.groups.indexOf("Reference");
  return at < 0 ? [...cat.groups, ...extra] : [...cat.groups.slice(0, at), ...extra, ...cat.groups.slice(at)];
}

/** per category: layers matching the search, and layers switched on */
export function catCounts(items: { group: string; on: boolean; text: string }[], words: string[]): Record<string, { hits: number; on: number }> {
  const out: Record<string, { hits: number; on: number }> = {};
  for (const c of LAYER_CATS) out[c.id] = { hits: 0, on: 0 };
  for (const it of items) {
    const c = out[catOfGroup(it.group)];
    if (it.on) {
      c.on++;
      out.mine.on++;
    }
    const t = it.text.toLowerCase();
    if (words.length && words.every((w) => t.includes(w))) c.hits++;
  }
  return out;
}
