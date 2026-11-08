// 0.8.3: Settings search filter (src/ui/setfilter.ts) on a fake DOM.
import assert from "node:assert/strict";
import { filterSection, filterCategory, queryWords, matchesAll, HIDE } from "../src/ui/setfilter";

class El {
  attrs = new Map<string, string>();
  children: El[];
  cls: string[];
  text: string;
  constructor(cls: string, text = "", children: El[] = [], attrs: Record<string, string> = {}) {
    this.cls = cls.split(" ").filter(Boolean);
    this.text = text;
    this.children = children;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  get classList() {
    return { contains: (c: string) => this.cls.includes(c) };
  }
  getAttribute(n: string) {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  toggleAttribute(n: string, force?: boolean) {
    const on = force ?? !this.attrs.has(n);
    if (on) this.attrs.set(n, "");
    else this.attrs.delete(n);
    return on;
  }
  get hidden() {
    return this.attrs.has(HIDE);
  }
}

const section = (label: string, rows: El[]) => new El("", "", [new El("lbl", label), ...rows]);
const wrap = (kw: string, ...secs: El[]) => new El("s83-sec", "", secs, { "data-kw": kw });

export function testWords() {
  assert.deepEqual(queryWords("  Alert   VOLUME "), ["alert", "volume"]);
  assert.deepEqual(queryWords(""), []);
  assert.ok(matchesAll(["vol", "alert"], "Alerts & sound Volume"));
  assert.ok(!matchesAll(["vol", "radar"], "Alerts & sound Volume"));
}

export function testRowFilter() {
  const vol = new El("row", "Volume");
  const desk = new El("toggle", "Desktop notifications");
  const snd = new El("toggle", "Alert sounds", [], { title: "plays a chime" });
  const w = wrap("notifications", section("Alerts & sound", [vol, desk, snd]));
  assert.equal(filterSection(w, queryWords("volume")), true);
  assert.ok(!vol.hidden && desk.hidden && snd.hidden && !w.hidden);
  // words may span the section title and a row
  filterSection(w, queryWords("alerts desktop"));
  assert.ok(vol.hidden && !desk.hidden);
  // tooltips count
  filterSection(w, queryWords("chime"));
  assert.ok(!snd.hidden && vol.hidden);
  // title / keyword match keeps the whole section
  filterSection(w, queryWords("notifications"));
  assert.ok(!vol.hidden && !desk.hidden && !snd.hidden);
  // no match hides the wrapper
  assert.equal(filterSection(w, queryWords("bandwidth")), false);
  assert.ok(w.hidden);
  // clearing shows everything again
  assert.equal(filterSection(w, []), true);
  assert.ok(!w.hidden && !vol.hidden && !desk.hidden && !snd.hidden);
}

export function testCategory() {
  const body = new El("s83-body", "", [
    wrap("bandwidth saver", section("Data use", [new El("toggle", "Bandwidth saver")])),
    wrap("fps gpu", section("Performance", [new El("row", "Quality")])),
    wrap("empty"), // a component that rendered nothing
  ]);
  assert.equal(filterCategory(body, queryWords("saver")), 1);
  assert.equal(filterCategory(body, queryWords("gpu")), 1);
  assert.equal(filterCategory(body, queryWords("quality")), 1);
  assert.equal(filterCategory(body, queryWords("zzz")), 0);
  assert.ok(body.children.every((c) => c.hidden));
  filterCategory(body, []);
  assert.ok(body.children.every((c) => !c.hidden));
}
