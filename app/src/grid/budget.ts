// 0.8.1 perf: one memory budget for decoded image frames across the main map and every pane.
// Least recently used entries are evicted first; an owner can refuse (the frame on screen).

export interface BudgetEntry {
  bytes: number;
  /** drop the frame; return false to keep it (it is on screen) */
  evict: () => boolean | void;
}

export class ByteLRU {
  private m = new Map<string, BudgetEntry>();
  total = 0;
  constructor(public cap: number) {}

  get size() {
    return this.m.size;
  }
  has(id: string) {
    return this.m.has(id);
  }
  /** add or replace (a replaced entry is not evicted: its owner already swapped it) */
  set(id: string, bytes: number, evict: BudgetEntry["evict"]) {
    this.delete(id);
    this.m.set(id, { bytes, evict });
    this.total += bytes;
    this.trim(id);
  }
  /** mark as recently used */
  touch(id: string) {
    const e = this.m.get(id);
    if (!e) return;
    this.m.delete(id);
    this.m.set(id, e);
  }
  delete(id: string) {
    const e = this.m.get(id);
    if (!e) return;
    this.m.delete(id);
    this.total -= e.bytes;
  }
  /** forget every entry whose id starts with prefix (an owner going away) */
  deletePrefix(prefix: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.delete(k);
  }
  setCap(cap: number) {
    this.cap = cap;
    this.trim();
  }
  /** evict oldest first until under the cap; `keep` (just added) and refusing owners stay */
  trim(keep?: string) {
    if (this.total <= this.cap) return;
    const kept: [string, BudgetEntry][] = [];
    for (const [k, e] of [...this.m]) {
      if (this.total <= this.cap) break;
      if (k === keep) continue;
      this.m.delete(k);
      this.total -= e.bytes;
      let gone: boolean | void = true;
      try {
        gone = e.evict();
      } catch {
        /* owner gone */
      }
      if (gone === false) kept.push([k, e]);
    }
    // refused entries stay (as most recently used, so the next trim tries others first)
    for (const [k, e] of kept) {
      this.m.set(k, e);
      this.total += e.bytes;
    }
  }
}

/** All decoded raster frames (main map + panes). The cap follows Settings → Performance. */
export const rasterBudget = new ByteLRU(1024 * 1024 * 1024);
