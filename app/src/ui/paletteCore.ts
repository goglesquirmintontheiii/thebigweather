// 0.8.3: command palette entry registry — pure helpers (no DOM / store), shared by CommandPalette.tsx and
// the tests. Weather-product entries are generated from the actual catalogs (radar moments, Level III
// products, the server's grid catalog: MRMS / GOES bands / models / NDFD / ensembles / severe …, NASA GIBS +
// EUMETSAT imagery incl. Himawari-9 and Meteosat, world radars, composites), so every product is findable.
// Plugin entries come from the plugin host (manifest `commands` + runtime registrations).

/** what an entry does when run (CommandPalette maps it to the real call) */
export type WxAct =
  | { t: "radar"; src: "L2" | "L3"; product: string }
  | { t: "grid"; id: string }
  | { t: "gibs"; id: string }
  | { t: "intl"; id: string }
  | { t: "comp"; id: string };
export interface WxEntry {
  id: string;
  label: string;
  hint: string;
  kw: string;
  act: WxAct;
}

/* structural copies of the catalog types (weather.ts / radar/controller.ts / intl/radar.ts) */
export interface CatGrid {
  id: string;
  name: string;
  group: string;
  source?: string;
  model?: string;
  units?: string;
}
export interface CatGibs {
  id: string;
  name: string;
  group: string;
  sat: string;
  layer?: string;
}
export interface CatL3 {
  id: string;
  code: number;
  name: string;
  tilt: number;
  group: string;
  tdwr?: boolean;
}
export interface CatIntl {
  id: string;
  name: string;
  region: string;
  country?: string;
  /** "All … radars" pseudo source this one belongs to */
  allId?: string;
  allName?: string;
}
export interface Catalogs {
  l2: { id: string; name: string }[];
  l3: CatL3[];
  grid: CatGrid[];
  gibs: CatGibs[];
  intl: CatIntl[];
  composites: { id: string; name: string }[];
  /** radar site shown in hints */
  site?: string;
}

/** search aliases per satellite family (so "japan", "eumetsat", "abi" … find the right imagery) */
const SAT_KW: Record<string, string> = {
  "19": "goes goes-19 goes-east east abi noaa",
  "18": "goes goes-18 goes-west west abi noaa",
  himawari: "himawari himawari-9 h9 jma japan asia pacific australia ahi",
  meteosat: "meteosat eumetsat europe africa mtg msg seviri fci",
  polar: "polar orbiter global nasa viirs modis",
};
const satKwFromGroup = (g: string) => {
  const l = g.toLowerCase();
  return l.includes("goes-19") ? SAT_KW["19"] : l.includes("goes-18") ? SAT_KW["18"] : l.includes("himawari") ? SAT_KW.himawari : l.includes("meteosat") ? SAT_KW.meteosat : "";
};
/** "Satellite · GOES-19 (East) composites" → "GOES-19 (East)"; "Models · HRRR" → "HRRR" */
export function groupShort(g: string): string {
  return g
    .replace(/^(Satellite|Models|MRMS) · /, "")
    .replace(/ composites$/, "")
    .trim();
}
const SOURCE_KW: Record<string, string> = {
  mrms: "mrms mosaic radar",
  model: "model forecast",
  ndfd: "ndfd nws forecast",
  metar: "surface obs observations analysis",
  goes: "satellite goes band abi",
  future: "future radar forecast simulated",
  opera: "europe radar opera",
  cwa: "taiwan radar",
  nowcast: "nowcast extrapolated",
  mlpred: "my model prediction ml",
};

/** One entry per product in every catalog. Ids: wx:r:<moment>, wx:3:<l3 id>, wx:g:<grid id>, wx:s:<gibs id>, wx:i:<intl id>, wx:c:<composite id>. */
export function weatherEntries(c: Catalogs): WxEntry[] {
  const out: WxEntry[] = [];
  const site = c.site ? ` · ${c.site}` : "";
  for (const m of c.l2) out.push({ id: `wx:r:${m.id}`, label: `Radar · ${m.name}`, hint: `Level II${site}`, kw: `${m.id} nexrad level ii l2 radar`, act: { t: "radar", src: "L2", product: m.id } });
  // Level III: one entry per product id (tilts named when a product has more than one)
  const fam = new Map<string, number>();
  for (const p of c.l3) fam.set(`${p.code}|${p.name}|${!!p.tdwr}`, (fam.get(`${p.code}|${p.name}|${!!p.tdwr}`) ?? 0) + 1);
  for (const p of c.l3) {
    const multi = (fam.get(`${p.code}|${p.name}|${!!p.tdwr}`) ?? 0) > 1;
    out.push({
      id: `wx:3:${p.id}`,
      label: `Level III · ${p.name}${multi ? ` (tilt ${p.tilt + 1})` : ""}`,
      hint: `Level III · ${p.group}${p.tdwr ? " · TDWR" : ""}`,
      kw: `${p.id} ${p.code} ${p.group} nexrad level iii l3 radar${p.tdwr ? " tdwr" : ""}`,
      act: { t: "radar", src: "L3", product: p.id },
    });
  }
  // grid catalog: names repeat across groups (Band 13 in 8 GOES sectors, 2 m temperature in every model) → add the group
  const n = new Map<string, number>();
  for (const d of c.grid) n.set(d.name, (n.get(d.name) ?? 0) + 1);
  for (const d of c.grid) {
    const short = groupShort(d.group);
    const dup = (n.get(d.name) ?? 0) > 1 && short && !d.name.includes(short);
    out.push({
      id: `wx:g:${d.id}`,
      label: dup ? `${d.name} · ${short}` : d.name,
      hint: d.group,
      kw: `${d.group} ${d.id} ${d.model ?? ""} ${SOURCE_KW[d.source ?? ""] ?? ""} ${satKwFromGroup(d.group)} ${d.units ?? ""}`,
      act: { t: "grid", id: d.id },
    });
  }
  // imagery (NASA GIBS / EUMETView): GOES composites, Himawari-9, Meteosat, polar & global
  for (const g of c.gibs) {
    const short = groupShort(g.group);
    const label = g.sat === "polar" || g.name.toLowerCase().startsWith(short.toLowerCase()) ? g.name : g.sat === "meteosat" ? `Meteosat · ${g.name}` : `${short} · ${g.name}`;
    out.push({ id: `wx:s:${g.id}`, label, hint: `${short} · imagery`, kw: `${g.group} ${g.id} ${g.layer ?? ""} satellite imagery ${SAT_KW[g.sat] ?? ""}`, act: { t: "gibs", id: g.id } });
  }
  // world radars + their "All … radars" groups
  const alls = new Map<string, CatIntl>();
  for (const x of c.intl) {
    out.push({ id: `wx:i:${x.id}`, label: x.name, hint: `World radar · ${x.region}`, kw: `${x.id} ${x.country ?? ""} ${x.region} international world radar ${x.allName ?? ""}`, act: { t: "intl", id: x.id } });
    if (x.allId && !alls.has(x.allId)) alls.set(x.allId, x);
  }
  for (const [id, x] of alls) out.push({ id: `wx:i:${id}`, label: x.allName ?? id, hint: `World radar · ${x.region}`, kw: `${id} ${x.country ?? ""} ${x.region} international world radar all group`, act: { t: "intl", id } });
  for (const k of c.composites) out.push({ id: `wx:c:${k.id}`, label: k.name, hint: "Composite · fill + contours", kw: `${k.id} composite severe contours overlay`, act: { t: "comp", id: k.id } });
  return out;
}

/** palette ids every catalog product must have (the test checks weatherEntries covers them) */
export function catalogIds(c: Catalogs): string[] {
  return [
    ...c.l2.map((m) => `wx:r:${m.id}`),
    ...c.l3.map((p) => `wx:3:${p.id}`),
    ...c.grid.map((d) => `wx:g:${d.id}`),
    ...c.gibs.map((g) => `wx:s:${g.id}`),
    ...c.intl.map((x) => `wx:i:${x.id}`),
    ...c.composites.map((k) => `wx:c:${k.id}`),
  ];
}

/* ---------- matching (moved from CommandPalette.tsx so the tests can use it) ---------- */
const isWordStart = (s: string, i: number) => i === 0 || /[\s\-_/·(.,:]/.test(s[i - 1]);
/** fuzzy score of `q` (lower case) against a label, or -1 */
export function fuzzy(q: string, s: string): number {
  s = s.toLowerCase();
  let total = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const i = s.indexOf(w);
    if (i >= 0) {
      total += 60 + w.length * 4 - Math.min(i, 30) + (isWordStart(s, i) ? 30 : 0) + (i === 0 ? 20 : 0);
      continue;
    }
    let si = 0,
      score = 0,
      last = -2;
    for (const ch of w) {
      const j = s.indexOf(ch, si);
      if (j < 0) return -1;
      score += j === last + 1 ? 5 : isWordStart(s, j) ? 4 : 0.5;
      last = j;
      si = j + 1;
    }
    total += score;
  }
  return total;
}
/** keywords: every word must appear as a substring (no loose subsequences) */
export function sub(q: string, s: string): number {
  s = s.toLowerCase();
  let t = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const i = s.indexOf(w);
    if (i < 0) return -1;
    t += 20 + w.length * 3 + (isWordStart(s, i) ? 15 : 0);
  }
  return t;
}
/** score of an entry for a query: label (fuzzy) + label/keywords/hint (every word somewhere) */
export function scoreEntry(q: string, it: { label: string; kw?: string; hint?: string }, catName = ""): number {
  let sc = fuzzy(q, it.label);
  const kw = sub(q, `${it.label} ${it.kw ?? ""} ${it.hint ?? ""} ${catName}`);
  if (sc < 0 && kw >= 0) sc = kw * 0.5;
  else if (sc >= 0 && kw > 0) sc += kw * 0.15;
  return sc;
}

/* ---------- plugins ---------- */
export interface PlgInfo {
  id: string;
  name: string;
  on: boolean;
  running: boolean;
  summary?: string;
  tags?: string[];
  /** manifest-declared palette commands */
  commands?: { id: string; title: string; keywords?: string }[];
}
export interface PlgReg {
  pid: string;
  id: string;
  title: string;
  kw?: string;
}
export type PlgAct =
  | { t: "open"; pid: string }
  | { t: "toggle"; pid: string; on: boolean }
  | { t: "market"; key: string }
  | { t: "panel"; pid: string; id: string }
  | { t: "layer"; pid: string; id: string }
  | { t: "cmd"; pid: string; id: string }
  | { t: "set"; pid: string; id: string; value?: any };
export interface PlgEntry {
  id: string;
  cat: "plugin" | "command" | "panel" | "layer" | "setting";
  label: string;
  hint: string;
  kw: string;
  on?: boolean;
  act: PlgAct;
}
export interface PlgSetting extends PlgReg {
  /** current value */
  value: any;
  /** choices (select settings); booleans have none */
  options?: { label: string; value: any }[];
}

/** Palette entries for plugins: each plugin (open / enable / disable), marketplace plugins, and everything they register. */
export function pluginEntries(o: { plugins: PlgInfo[]; market?: { key: string; id: string; name: string; summary?: string; tags?: string[] }[]; panels: (PlgReg & { open: boolean })[]; layers: (PlgReg & { visible: boolean })[]; commands: PlgReg[]; settings: PlgSetting[] }): PlgEntry[] {
  const out: PlgEntry[] = [];
  const name = new Map(o.plugins.map((p) => [p.id, p.name]));
  const pn = (pid: string) => name.get(pid) ?? "Plugin";
  for (const p of o.plugins) {
    const kw = `plugin ${p.summary ?? ""} ${(p.tags ?? []).join(" ")}`;
    out.push({ id: `plg:${p.id}`, cat: "plugin", label: p.name, hint: `Plugin · ${p.on ? "enabled" : "disabled"}`, kw: `${kw} installed details`, on: p.on, act: { t: "open", pid: p.id } });
    out.push({ id: `plg:${p.id}:toggle`, cat: "plugin", label: `${p.on ? "Disable" : "Enable"} ${p.name}`, hint: "Plugin", kw: `${kw} enable disable turn on off`, on: p.on, act: { t: "toggle", pid: p.id, on: !p.on } });
    // manifest commands: listed even before the plugin runs (running one enables the plugin first)
    for (const c of p.commands ?? []) out.push({ id: `plg:${p.id}:cmd:${c.id}`, cat: "command", label: `${p.name}: ${c.title}`, hint: p.on ? "Plugin command" : "Plugin command · enables it", kw: `${kw} ${c.keywords ?? ""}`, act: { t: "cmd", pid: p.id, id: c.id } });
  }
  const installed = new Set(o.plugins.map((p) => p.id));
  for (const m of o.market ?? []) if (!installed.has(`mk.${m.id}`)) out.push({ id: `plg:mk:${m.id}`, cat: "plugin", label: m.name, hint: "Marketplace · install", kw: `plugin marketplace install ${m.summary ?? ""} ${(m.tags ?? []).join(" ")}`, act: { t: "market", key: m.key } });
  for (const x of o.panels) out.push({ id: `plg:${x.pid}:panel:${x.id}`, cat: "panel", label: x.title, hint: `${pn(x.pid)} · panel`, kw: `plugin ${pn(x.pid)} panel menu window ${x.kw ?? ""}`, on: x.open, act: { t: "panel", pid: x.pid, id: x.id } });
  for (const x of o.layers) out.push({ id: `plg:${x.pid}:layer:${x.id}`, cat: "layer", label: x.title, hint: `${pn(x.pid)} · layer`, kw: `plugin ${pn(x.pid)} layer overlay ${x.kw ?? ""}`, on: x.visible, act: { t: "layer", pid: x.pid, id: x.id } });
  const seen = new Set(out.filter((e) => e.act.t === "cmd").map((e) => e.id));
  for (const x of o.commands) {
    const id = `plg:${x.pid}:cmd:${x.id}`;
    if (seen.has(id)) {
      // the running plugin's title wins over the manifest's
      const e = out.find((y) => y.id === id)!;
      e.label = `${pn(x.pid)}: ${x.title}`;
      e.hint = "Plugin command";
      continue;
    }
    out.push({ id, cat: "command", label: `${pn(x.pid)}: ${x.title}`, hint: "Plugin command", kw: `plugin ${pn(x.pid)} ${x.kw ?? ""}`, act: { t: "cmd", pid: x.pid, id: x.id } });
  }
  for (const s of o.settings) {
    if (!s.options) out.push({ id: `plg:${s.pid}:set:${s.id}`, cat: "setting", label: s.title, hint: `${pn(s.pid)} · toggle`, kw: `plugin ${pn(s.pid)} setting option ${s.kw ?? ""}`, on: !!s.value, act: { t: "set", pid: s.pid, id: s.id } });
    else
      for (const c of s.options)
        out.push({ id: `plg:${s.pid}:set:${s.id}=${String(c.value)}`, cat: "setting", label: `${s.title}: ${c.label}`, hint: `${pn(s.pid)} · setting`, kw: `plugin ${pn(s.pid)} setting option ${s.kw ?? ""}`, on: s.value === c.value, act: { t: "set", pid: s.pid, id: s.id, value: c.value } });
  }
  return out;
}
