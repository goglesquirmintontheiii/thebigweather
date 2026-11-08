// 0.8.3: command palette — every catalog product has a palette entry and is searchable; plugin entries;
// plugin manifest card background / commands.
import { readFileSync } from "node:fs";
import { weatherEntries, catalogIds, scoreEntry, pluginEntries, groupShort, type Catalogs } from "../src/ui/paletteCore";
import { validateManifest, cardBgUrl, isCardBg } from "../src/plugins/marketcore";

const assert = (c: any, m = "assertion failed") => {
  if (!c) throw new Error(m);
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** the GIBS / EUMETSAT imagery list, read from weather.ts itself (so products added there are covered) */
function gibsFromSource() {
  const s = src("../src/weather.ts");
  const m = /export const GIBS: GibsLayer\[\] = (\[[\s\S]*?\n\]);/.exec(s);
  assert(m, "GIBS list not found in weather.ts");
  const eum = /const EUM = "([^"]+)"/.exec(s)?.[1] ?? "";
  return new Function("EUM", `return ${m![1]};`)(eum) as { id: string; name: string; group: string; sat: string; layer: string }[];
}
function l2FromSource() {
  const s = src("../src/radar/controller.ts");
  const m = /export const L2_MOMENTS = (\[[\s\S]*?\n\]);/.exec(s);
  assert(m, "L2_MOMENTS not found");
  return new Function(`return ${m![1]};`)() as { id: string; name: string }[];
}
function catalogs(): Catalogs {
  const fx = JSON.parse(src("./fixtures/catalog083.json"));
  return {
    site: "KTLX",
    l2: l2FromSource(),
    l3: fx.l3,
    grid: fx.grid,
    gibs: gibsFromSource(),
    intl: [
      { id: "jma", name: "Japan radar (JMA nowcast)", region: "Japan" },
      { id: "eccc_xft", name: "Franktown", region: "Canada", country: "Canada", allId: "eccc_all", allName: "All Canada radars" },
    ],
    composites: fx.composites,
  };
}

export function testEveryCatalogProductHasAnEntry() {
  const c = catalogs();
  assert(c.gibs.length >= 25 && c.grid.length > 500 && c.l3.length > 20 && c.l2.length > 10, "fixture / sources look incomplete");
  const ids = new Set(weatherEntries(c).map((e) => e.id));
  const missing = catalogIds(c).filter((id) => !ids.has(id));
  assert(!missing.length, `no palette entry for ${missing.slice(0, 10).join(", ")}`);
  assert(ids.has("wx:i:eccc_all"), "radar group entry");
}

export function testEntryIdsUnique() {
  const e = weatherEntries(catalogs());
  const seen = new Set<string>();
  for (const x of e) {
    assert(!seen.has(x.id), `duplicate ${x.id}`);
    seen.add(x.id);
  }
}

/** search the way the palette does: entries with a score ≥ 0 */
const find = (q: string, c = catalogs()) => weatherEntries(c).filter((e) => scoreEntry(q.toLowerCase(), e, "Weather") >= 0);

export function testSatellitesSearchable() {
  const c = catalogs();
  const him = c.gibs.filter((g) => g.sat === "himawari");
  const met = c.gibs.filter((g) => g.sat === "meteosat");
  assert(him.length >= 3 && met.length >= 5, "catalog has Himawari + Meteosat");
  for (const [q, list] of [["himawari", him], ["himawari-9", him], ["meteosat", met], ["eumetsat", met]] as const) {
    const got = new Set(find(q, c).map((e) => e.id));
    for (const g of list) assert(got.has(`wx:s:${g.id}`), `"${q}" doesn't find ${g.id}`);
  }
  // GOES bands of every sector, and imagery by satellite name
  const b13 = find("goes-19 band 13", c).map((e) => e.id);
  assert(b13.filter((id) => /^wx:g:goes\/19\/[a-z0-9]+\/13$/.test(id)).length === 4, `GOES-19 band 13 sectors: ${b13.join(",")}`);
  assert(!b13.some((id) => id.startsWith("wx:g:goes/18/")), "GOES-18 not matched by goes-19");
  assert(find("geocolor goes-18", c).some((e) => e.id === "wx:s:goes-west-geocolor"), "GOES-West GeoColor");
  assert(find("japan", c).some((e) => e.id === "wx:s:himawari-ir"), "alias japan → Himawari");
}

export function testEveryProductSearchableByItsName() {
  const c = catalogs();
  const all = weatherEntries(c);
  for (const e of all) {
    // its own label always finds it
    assert(scoreEntry(e.label.toLowerCase(), e) >= 0, `label search misses ${e.id}`);
  }
  // grid products by name + group (e.g. "2 m temperature hrrr")
  for (const d of c.grid) {
    const q = `${d.name} ${groupShort(d.group)}`.toLowerCase();
    const e = all.find((x) => x.id === `wx:g:${d.id}`)!;
    assert(scoreEntry(q, e) >= 0, `"${q}" misses ${d.id}`);
  }
  // duplicate names get their group in the label
  const labels = new Map<string, number>();
  for (const e of all.filter((x) => x.id.startsWith("wx:g:"))) labels.set(e.label, (labels.get(e.label) ?? 0) + 1);
  const dups = [...labels].filter(([, n]) => n > 1);
  assert(dups.length < 5, `ambiguous grid labels: ${dups.slice(0, 5).map((d) => d[0]).join(" | ")}`);
}

export function testLevel3TiltLabels() {
  const e = weatherEntries(catalogs());
  const n0b = e.find((x) => x.id === "wx:3:N0B")!;
  const n1b = e.find((x) => x.id === "wx:3:N1B")!;
  assert(n0b && n1b && n0b.label !== n1b.label, "tilts are told apart");
  assert(n0b.act.t === "radar" && n0b.act.src === "L3" && n0b.act.product === "N0B", "action");
}

export function testPluginEntries() {
  const e = pluginEntries({
    plugins: [
      { id: "mk.hail-legend", name: "Hail size quick legend", on: true, running: true, summary: "Hail sizes", tags: ["hail"], commands: [{ id: "open", title: "Open the legend" }] },
      { id: "p2", name: "Off plugin", on: false, running: false },
    ],
    market: [
      { key: "r#hail-legend", id: "hail-legend", name: "Hail size quick legend" },
      { key: "r#other", id: "other", name: "Other one", summary: "does things" },
    ],
    panels: [{ pid: "mk.hail-legend", id: "mk.hail-legend:Hail size legend", title: "Hail size legend", open: false }],
    layers: [{ pid: "mk.hail-legend", id: "cells", title: "Cells", visible: true }],
    commands: [{ pid: "mk.hail-legend", id: "open", title: "Show legend" }, { pid: "p2", id: "x", title: "Do X" }],
    settings: [
      { pid: "p2", id: "loud", title: "Loud", value: true },
      { pid: "p2", id: "min", title: "Chime within", value: 15, options: [{ label: "10 min", value: 10 }, { label: "15 min", value: 15 }] },
    ],
  });
  const by = (id: string) => e.find((x) => x.id === id);
  assert(by("plg:mk.hail-legend")?.cat === "plugin", "plugin entry");
  assert(by("plg:p2:toggle")?.label === "Enable Off plugin", "enable entry");
  assert(!by("plg:mk:hail-legend"), "installed marketplace plugin is not listed twice");
  assert(by("plg:mk:other")?.act.t === "market", "marketplace plugin");
  assert(by("plg:mk.hail-legend:panel:mk.hail-legend:Hail size legend")?.on === false, "closed panel");
  assert(by("plg:mk.hail-legend:layer:cells")?.cat === "layer", "layer");
  const cmd = e.filter((x) => x.id === "plg:mk.hail-legend:cmd:open");
  assert(cmd.length === 1 && cmd[0].label === "Hail size quick legend: Show legend", "runtime title replaces the manifest's");
  assert(by("plg:p2:set:loud")?.on === true, "bool setting");
  assert(by("plg:p2:set:min=15")?.on === true && by("plg:p2:set:min=10")?.on === false, "option settings");
  // searchable
  assert(scoreEntry("hail legend", by("plg:mk.hail-legend:panel:mk.hail-legend:Hail size legend")!) >= 0, "panel by name");
  assert(scoreEntry("plugin", by("plg:mk:other")!) >= 0, "'plugin' finds marketplace entries");
}

export function testManifestCardAndCommands() {
  const base = { id: "x", name: "X", version: "1.0.0", entry: "main.js" };
  const m = validateManifest({ ...base, card: { background: "card.webp" }, commands: [{ id: "open", title: "Open", keywords: "show" }] });
  assert(m.card?.background === "card.webp" && m.commands?.length === 1, "kept");
  assert(cardBgUrl(m, "https://h/p/") === "https://h/p/card.webp", "asset url");
  assert(cardBgUrl(validateManifest({ ...base, card: { background: "https://img.example/a.png" } }), "https://h/p/") === "https://img.example/a.png", "https url");
  for (const bad of [{ card: { background: "../x.png" } }, { card: { background: "x.js" } }, { card: { background: "http://a/b.png" } }, { card: "x.png" }, { commands: [{ id: "", title: "a" }] }, { commands: [{ id: "a" }] }, { commands: {} }]) {
    let threw = false;
    try {
      validateManifest({ ...base, ...bad });
    } catch {
      threw = true;
    }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
  assert(isCardBg("img/bg.png") && !isCardBg("javascript:alert(1)") && !isCardBg('https://a/b.png")'), "isCardBg");
}

export function testRepoPluginsHaveCardBackgrounds() {
  for (const id of ["hail-legend", "storm-eta-chime"]) {
    const m = validateManifest(JSON.parse(src(`../../plugins/${id}/plugin.json`)));
    assert(m.card?.background, `${id}: no card.background`);
    const size = readFileSync(new URL(`../../plugins/${id}/${m.card!.background}`, import.meta.url)).length;
    assert(size > 1000 && size < 80 * 1024, `${id}: background is ${size} bytes`);
    assert(m.commands?.length, `${id}: no palette commands`);
  }
}
