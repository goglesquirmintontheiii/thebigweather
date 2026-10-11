// Radar data flow: frame lists, fetching, animation loop, RapidSweep live overlay.

import { signal, computed, effect, batch } from "@preact/signals";
import { api } from "../api";
import { settings, update, toast } from "../store";
import { parseSweep, type Sweep } from "./sweep";
import { BUILTIN, COLORBLIND, defaultTableFor, parsePal, type ColorTable } from "./colormaps";
import type { RadarLayer } from "./RadarLayer";
import { playSweepSound } from "../sound";

export interface Site {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  elev_m: number;
  type: "NEXRAD" | "TDWR";
}
export interface TiltMeta {
  index: number;
  angle: number;
  moments: string[];
  time: number;
  complete: boolean;
}
export interface VolMeta {
  key: string;
  site: string;
  vcp: number;
  lat: number;
  lon: number;
  time: number;
  end: number;
  complete: boolean;
  tilts: TiltMeta[];
}
export interface Frame {
  key: string;
  time: number;
  sweep?: Sweep;
  error?: string;
  live?: boolean;
}
export interface L3Product {
  id: string;
  code: number;
  name: string;
  tilt: number;
  group: string;
  cmap: string;
  tdwr?: boolean;
}

export const L2_MOMENTS = [
  { id: "REF", name: "Reflectivity" },
  { id: "VEL", name: "Velocity" },
  { id: "SW", name: "Spectrum Width" },
  { id: "ZDR", name: "Diff. Reflectivity" },
  { id: "RHO", name: "Correlation Coef." },
  { id: "PHI", name: "Diff. Phase" },
  { id: "CFP", name: "Clutter Filter Power" },
];

export const sites = signal<Site[]>([]);
export const l3Products = signal<L3Product[]>([]);
export const frames = signal<Frame[]>([]);
import { frameIndex, playing, frameCount, setFrameReady, framesToRequest, trimToSpan, historyEnd } from "../anim";
export { frameIndex, playing };
export const loading = signal(false);
export const radarError = signal<string | null>(null);
export const tilts = signal<TiltMeta[]>([]);
export const liveSweep = signal<Sweep | null>(null);
export const liveState = signal<{ key: string; radials: number; elev: number; time: number; az?: number; lat?: number; lon?: number; complete?: boolean } | null>(null);
/** Extra radars drawn alongside the main one (ctrl+click). site -> frames */
export const extraFrames = signal<Record<string, Frame[]>>({});
export interface LiveMsg {
  key: string;
  radials: number;
  elev: number;
  time: number;
  az?: number;
  lat?: number;
  lon?: number;
  complete?: boolean;
}
/** RapidSweep for the extra radars: live message + partial sweep per site */
export const extraLive = signal<Record<string, { state: LiveMsg; sweep: Sweep | null }>>({});
export const showRadar = signal(true);
/** Explicit frames (history browsing / opened files). null = follow latest. */
export const pinned = signal<{ key: string; time: number; product?: string }[] | null>(null);
/** title of the recording being played (shown in the header) */
export const playingRec = signal<string | null>(null);

export const currentSite = computed(() => sites.value.find((s) => s.id === settings.value.radar.site));
/** The frame on screen: if the selected one has no data (still loading, or this volume lacks the
 * tilt), hold the nearest earlier frame that does instead of going blank. */
export const currentFrame = computed(() => {
  const fs = frames.value;
  const i = Math.min(frameIndex.value, fs.length - 1);
  if (i < 0) return undefined;
  if (fs[i]?.sweep) return fs[i];
  for (let k = i - 1; k >= 0; k--) if (fs[k].sweep) return fs[k];
  for (let k = i + 1; k < fs.length; k++) if (fs[k].sweep) return fs[k];
  return fs[i];
});

/** The sweep under the user's eye: live partial overlay wins when on the newest frame. */
export const displaySweep = computed<Sweep | undefined>(() => {
  const f = currentFrame.value;
  if (liveSweep.value && frameIndex.value === frames.value.length - 1) return liveSweep.value;
  return f?.sweep;
});

// ---------- color tables ----------
const palCache = new Map<string, ColorTable>();
export function tableById(id: string): ColorTable {
  if (id.startsWith("custom:")) {
    const name = id.slice(7);
    const text = settings.value.customPals[name];
    if (text) {
      let t = palCache.get(text);
      if (!t) {
        try {
          t = parsePal(text, name);
          palCache.set(text, t);
        } catch {
          t = BUILTIN.REF;
        }
      }
      return t;
    }
  }
  if (settings.value.colorblind && COLORBLIND[id]) return COLORBLIND[id];
  return BUILTIN[id] ?? BUILTIN.REF;
}

export function tableKeyFor(product: string): string {
  const l3 = l3Products.value.find((p) => p.id === product);
  return l3 ? l3.cmap : defaultTableFor(product);
}

export const activeTable = computed<ColorTable>(() => {
  const product = settings.value.radar.product;
  const base = tableKeyFor(product);
  const chosen = settings.value.tables[base];
  // touch colorblind so the computed updates
  void settings.value.colorblind;
  void settings.value.customPals;
  return tableById(chosen || base);
});

// ---------- caches ----------
const metaCache = new Map<string, VolMeta>();
const sweepCache = new Map<string, Sweep>();
const SWEEP_CACHE_MAX = 60;

function cacheSweep(k: string, s: Sweep) {
  sweepCache.set(k, s);
  if (sweepCache.size > SWEEP_CACHE_MAX) {
    const first = sweepCache.keys().next().value!;
    const old = sweepCache.get(first);
    sweepCache.delete(first);
    if (old && layer) layer.release(old);
  }
}

let layer: RadarLayer | null = null;
export function attachLayer(l: RadarLayer) {
  layer = l;
  pushToLayer();
}

function pushToLayer() {
  if (!layer) return;
  const items = [];
  const op = settings.value.radar.opacity;
  const t = activeTable.value;
  const f = currentFrame.value;
  if (showRadar.value && settings.value.weather.kind === "radar") {
    // extra radars first so the main radar draws on top where they overlap
    const tMain = f?.sweep?.start ?? f?.time ?? 0;
    for (const site of settings.value.extraSites) {
      const fs = extraFrames.value[site];
      if (!fs?.length) continue;
      let best: Frame | undefined;
      for (const x of fs) if (x.sweep && (!best || Math.abs(x.sweep.start - tMain) < Math.abs(best.sweep!.start - tMain))) best = x;
      if (best?.sweep && (!tMain || Math.abs(best.sweep.start - tMain) < 15 * 60_000)) items.push({ sweep: best.sweep, table: t, opacity: op });
      // RapidSweep partial for this radar, drawn over its last complete frame while on the newest frame
      const lv = extraLive.value[site]?.sweep;
      if (lv && frameIndex.value >= frames.value.length - 1 && settings.value.radar.live) items.push({ sweep: lv, table: t, opacity: op });
    }
    if (f?.sweep) items.push({ sweep: f.sweep, table: t, opacity: op });
    if (liveSweep.value && frameIndex.value === frames.value.length - 1) items.push({ sweep: liveSweep.value, table: t, opacity: op });
  }
  layer.smooth = settings.value.radar.smooth;
  layer.setItems(items);
}

effect(() => {
  // re-render when any of these change
  void currentFrame.value;
  void liveSweep.value;
  void activeTable.value;
  void showRadar.value;
  void settings.value.radar.opacity;
  void settings.value.radar.smooth;
  void settings.value.weather;
  void extraFrames.value;
  void extraLive.value;
  pushToLayer();
});

// ---------- loading ----------
function pickTilt(meta: VolMeta, moment: string, angle: number): TiltMeta | undefined {
  let best: TiltMeta | undefined;
  for (const t of meta.tilts) {
    if (!t.moments.includes(moment)) continue;
    if (!best || Math.abs(t.angle - angle) < Math.abs(best.angle - angle)) best = t;
  }
  return best;
}

async function getMeta(key: string, fresh = false): Promise<VolMeta> {
  if (!fresh) {
    const m = metaCache.get(key);
    if (m) return m;
  }
  const m = await api.get<VolMeta>(`/api/radar/meta?key=${encodeURIComponent(key)}`);
  if (m.complete && !key.startsWith("live:")) metaCache.set(key, m);
  return m;
}

async function loadL2Sweep(key: string, moment: string, angle: number, fresh = false): Promise<Sweep | undefined> {
  const meta = await getMeta(key, fresh);
  const t = pickTilt(meta, moment, angle);
  if (!t) return undefined;
  const ck = `${key}|${t.index}|${moment}`;
  if (!fresh) {
    const c = sweepCache.get(ck);
    if (c) return c;
  }
  const buf = await api.bin(`/api/radar/sweep?key=${encodeURIComponent(key)}&tilt=${t.index}&moment=${moment}`);
  const s = parseSweep(buf, ck);
  if (!key.startsWith("live:")) cacheSweep(ck, s);
  return s;
}

async function loadL3(key: string): Promise<Sweep> {
  const c = sweepCache.get(key);
  if (c) return c;
  const buf = await api.bin(`/api/l3/data?key=${encodeURIComponent(key)}`);
  const s = parseSweep(buf, key);
  if (!key.startsWith("tgftp:")) cacheSweep(key, s);
  return s;
}

/** Turn transport errors into something a person can act on. */
export function friendlyError(msg: string, site: string, product: string): string {
  const name = productName(product);
  if (/HTTP 40[34]|NoSuchKey|not found/i.test(msg)) return `${site} isn't publishing ${name} right now`;
  if (/timed? ?out|connect/i.test(msg)) return `Couldn't reach the data source (${msg})`;
  return msg;
}

export function productName(id: string): string {
  return L2_MOMENTS.find((m) => m.id === id)?.name ?? l3Products.value.find((p) => p.id === id)?.name ?? id;
}

/** Equivalent L3 product for a NEXRAD or TDWR site (they publish different product sets). */
export function l3For(product: string, tdwr: boolean): string {
  const all = l3Products.value;
  const p = all.find((x) => x.id === product);
  if (!p) return tdwr ? "TZL" : "N0B";
  if (!!p.tdwr === tdwr) return product;
  const same = all.filter((x) => !!x.tdwr === tdwr && x.cmap === p.cmap);
  if (!same.length) return tdwr ? "TZL" : "N0B";
  same.sort((a, b) => Math.abs(a.tilt - p.tilt) - Math.abs(b.tilt - p.tilt));
  return same[0].id;
}

let generation = 0;
let liveKey: string | null = null;

export async function reload(opts: { keepIndex?: boolean } = {}) {
  const gen = ++generation;
  const r = settings.value.radar;
  if (!api.base || !r.site || settings.value.weather.kind !== "radar") return;
  loading.value = true;
  radarError.value = null;
  try {
    let list: Frame[] = [];
    if (pinned.value && (r.source === "L2" || pinned.value.some((p) => p.product))) {
      list = pinned.value.filter((p) => r.source === "L2" || !p.product || p.product === r.product).map((p) => ({ key: p.key, time: p.time }));
      liveKey = null;
    } else if (r.source === "L2") {
      const n = framesToRequest(r.frames, 4, 200);
      const res = await api.get(`/api/radar/${r.site}/latest?n=${n}`);
      list = res.volumes.map((v: any) => ({ key: v.key, time: v.time }));
      const live = res.live;
      // completed live volumes are newer than the archive bucket's latest
      if (live?.complete?.length) {
        for (const k of live.complete) {
          try {
            const m = await getMeta(k);
            if (!list.some((f) => Math.abs(f.time - m.time) < 15000)) list.push({ key: k, time: m.time, live: true });
          } catch {
            /* expired */
          }
        }
      }
      liveKey = r.live && live?.current ? live.current : null;
      if (!list.length && liveKey) {
        // TDWRs and brand-new sites may only exist in the live feed
        const m = await getMeta(liveKey, true);
        list.push({ key: liveKey, time: m.time, live: true });
      }
      list.sort((a, b) => a.time - b.time);
      list = settings.value.anim.mode === "time" ? trimToSpan(list) : list.slice(-r.frames);
    } else {
      const n = framesToRequest(r.frames, 4, 200);
      const res = await api.get(`/api/l3/${r.site}/${r.product}/list?n=${n}`);
      list = trimToSpan(res.volumes.map((v: any) => ({ key: v.key, time: v.time })));
      liveKey = null;
    }
    if (gen !== generation) return;
    if (!list.length) {
      batch(() => {
        frames.value = [];
        liveSweep.value = null;
        radarError.value = r.source === "L2" ? `No recent Level II data from ${r.site} — the radar may be offline` : `${r.site} isn't publishing ${productName(r.product)} right now`;
      });
      return;
    }
    const prevLen = frames.value.length;
    // reuse already-loaded frames
    const old = new Map(frames.value.map((f) => [f.key, f]));
    const next = list.map((f) => old.get(f.key) && sameProduct(old.get(f.key)!) ? old.get(f.key)! : f);
    batch(() => {
      frames.value = next;
      // stay on the newest frame unless the user deliberately stepped back
      const wasLatest = prevLen === 0 || frameIndex.value >= prevLen - 1;
      if (!opts.keepIndex || wasLatest || frameIndex.value >= next.length) frameIndex.value = next.length - 1;
      if (!liveKey) liveSweep.value = null;
    });
    // newest first so the current picture appears fast
    const order = [...next.keys()].reverse();
    let i = 0;
    const worker = async () => {
      while (i < order.length) {
        const idx = order[i++];
        const f = next[idx];
        if (f.sweep) continue;
        try {
          const s = r.source === "L2" ? await loadL2Sweep(f.key, r.product, r.tiltAngle) : await loadL3(f.key);
          if (gen !== generation) return;
          if (!s) {
            setFrame(f.key, { error: "product not in this volume" });
            continue;
          }
          setFrame(f.key, { sweep: s, time: r.source === "L3" || f.time < 1e12 ? s.start : f.time });
          if (idx === next.length - 1 && r.source === "L2") updateTilts(f.key);
        } catch (e: any) {
          if (gen !== generation) return;
          setFrame(f.key, { error: e.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (gen !== generation) return;
    const last = frames.value[frames.value.length - 1];
    if (last && !last.sweep && last.error) radarError.value = friendlyError(last.error, r.site, r.product);
    layer?.preload(frames.value.filter((f) => f.sweep).map((f) => f.sweep!));
    if (liveKey) refreshLive(true);
  } catch (e: any) {
    if (gen === generation) radarError.value = friendlyError(e.message ?? String(e), r.site, r.product);
  } finally {
    if (gen === generation) loading.value = false;
  }
}

/** Replace a frame immutably so computed signals notice. */
function setFrame(key: string, patch: Partial<Frame>) {
  const arr = frames.value;
  const j = arr.findIndex((x) => x.key === key);
  if (j < 0) return;
  const copy = arr.slice();
  copy[j] = { ...arr[j], ...patch };
  frames.value = copy;
}

function sameProduct(f: Frame): boolean {
  const r = settings.value.radar;
  if (!f.sweep) return true;
  if (r.source === "L3") return true;
  return f.sweep.product === r.product && Math.abs(f.sweep.elevation - r.tiltAngle) < 0.6;
}

async function updateTilts(key: string) {
  try {
    const m = await getMeta(key);
    tilts.value = m.tilts;
  } catch {
    /* ignore */
  }
}

// ---------- live (RapidSweep) ----------
let liveBusy = false;
let liveQueued = false;
async function refreshLive(force = false) {
  const r = settings.value.radar;
  if (!liveKey || r.source !== "L2" || !r.live) return;
  if (liveBusy) {
    liveQueued = true;
    return;
  }
  liveBusy = true;
  try {
    const key = liveKey;
    const meta = await getMeta(key, true);
    const t = pickTilt(meta, r.product, r.tiltAngle);
    // only overlay if the live tilt is newer than the newest complete frame
    const newest = frames.value[frames.value.length - 1];
    if (t && (!newest?.sweep || t.time > newest.sweep.start + 30000 || newest.key === key)) {
      const s = await loadL2Sweep(key, r.product, r.tiltAngle, true);
      if (s && key === liveKey) {
        const prev = liveSweep.value;
        const wasComplete = prev?.complete;
        liveSweep.value = s;
        // live sweeps are replaced every second or so: free the old GPU copy right away
        if (prev && prev !== s && layer) layer.release(prev);
        if (s.complete && !wasComplete && !force) playSweepSound();
      }
    } else if (force) {
      liveSweep.value = null;
    }
  } catch {
    /* live volume may have rolled over */
  } finally {
    liveBusy = false;
    if (liveQueued) {
      liveQueued = false;
      setTimeout(() => refreshLive(), 250);
    }
  }
}

let liveThrottle: number | undefined;
const extraThrottle = new Map<string, number>();
const extraBusy = new Set<string>();

async function refreshExtraLive(site: string) {
  const r = settings.value.radar;
  const e = extraLive.value[site];
  if (!e || extraBusy.has(site)) return;
  extraBusy.add(site);
  try {
    const key = e.state.key;
    const meta = await getMeta(key, true);
    const t = pickTilt(meta, r.product, r.tiltAngle);
    const fs = extraFrames.value[site] ?? [];
    const newest = fs[fs.length - 1]?.sweep;
    if (!t || (newest && t.time <= newest.start + 30000)) return;
    const sw = await loadL2Sweep(key, r.product, r.tiltAngle, true);
    const cur = extraLive.value[site];
    if (!sw || !cur || cur.state.key !== key) return;
    const prev = cur.sweep;
    extraLive.value = { ...extraLive.value, [site]: { ...cur, sweep: sw } };
    if (prev && prev !== sw && layer) layer.release(prev);
  } catch {
    /* volume rolled over */
  } finally {
    extraBusy.delete(site);
  }
}

api.on("live", (m) => {
  const r = settings.value.radar;
  if (r.source !== "L2" || !r.live) return;
  if (m.site !== r.site) {
    // an extra (ctrl+clicked) radar
    if (!settings.value.extraSites.includes(m.site)) return;
    const prev = extraLive.value[m.site];
    const state: LiveMsg = { key: m.key, radials: m.radials, elev: m.elev, time: m.time, az: m.az, lat: m.lat, lon: m.lon, complete: m.complete };
    if (prev && prev.state.key !== m.key && prev.sweep && layer) layer.release(prev.sweep);
    extraLive.value = { ...extraLive.value, [m.site]: { state, sweep: prev && prev.state.key === m.key ? prev.sweep : null } };
    if (!extraThrottle.get(m.site)) {
      extraThrottle.set(
        m.site,
        window.setTimeout(() => {
          extraThrottle.delete(m.site);
          refreshExtraLive(m.site);
        }, 900),
      );
    }
    return;
  }
  liveState.value = { key: m.key, radials: m.radials, elev: m.elev, time: m.time, az: m.az, lat: m.lat, lon: m.lon, complete: m.complete };
  if (m.key !== liveKey) {
    liveKey = m.key;
    if (liveSweep.value && layer) layer.release(liveSweep.value);
    liveSweep.value = null;
  }
  if (liveThrottle) return;
  liveThrottle = window.setTimeout(() => {
    liveThrottle = undefined;
    refreshLive();
  }, 600);
});
api.on("live_volume", (m) => {
  if (m.site === settings.value.radar.site) setTimeout(() => reload({ keepIndex: true }), 500);
  else if (settings.value.extraSites.includes(m.site)) setTimeout(() => reloadExtras(), 800);
});

/** Live feeds wanted: the main radar, plus the extras when RapidSweep is on. */
export function watchSites() {
  const r = settings.value.radar;
  api.watch([r.site, ...(r.live && r.source === "L2" ? settings.value.extraSites : [])]);
}

// ---------- animation ----------
export { togglePlay } from "../anim";
effect(() => {
  if (settings.value.weather.kind === "radar") {
    frameCount.value = frames.value.length;
    setFrameReady((i) => !!frames.value[i]?.sweep);
  }
});

// ---------- triggers ----------
let reloadTimer: number | undefined;
let lastSig = "";
effect(() => {
  const r = settings.value.radar;
  const a = settings.value.anim;
  const sig = `${r.site}|${r.source}|${r.product}|${r.tiltAngle}|${r.frames}|${r.live}|${pinned.value?.map((p) => p.key).join(",") ?? ""}|${settings.value.weather.kind === "radar"}|${a.mode}|${a.minutes}`;
  void api.base;
  if (sig === lastSig) return;
  const siteChanged = lastSig.split("|")[0] !== r.site;
  lastSig = sig;
  clearTimeout(reloadTimer);
  if (siteChanged) {
    if (pinned.value && !pinned.value.some((p) => p.key.includes(r.site))) pinned.value = null;
    batch(() => {
      frames.value = [];
      liveSweep.value = null;
      tilts.value = [];
      liveState.value = null;
    });
  } else {
    // product/tilt changed: drop loaded sweeps but keep the frame times
    frames.value = frames.value.map((f) => ({ key: f.key, time: f.time, live: f.live }));
    liveSweep.value = null;
  }
  watchSites();
  reloadTimer = window.setTimeout(() => reload(), 120);
});

api.on("connected", async () => {
  try {
    const [s, p] = await Promise.all([api.get<Site[]>("/api/sites"), api.get<L3Product[]>("/api/l3/products")]);
    sites.value = s;
    l3Products.value = p;
    // older settings may hold a product this site type doesn't publish
    const r = settings.value.radar;
    if (r.source === "L3") {
      const want = l3For(r.product, s.find((x) => x.id === r.site)?.type === "TDWR");
      if (want !== r.product) update((st) => (st.radar.product = want));
    }
  } catch {
    /* ignore */
  }
  watchSites();
  reload({ keepIndex: true });
});

// periodic refresh (archive frames + L3), live handles the fast path
setInterval(() => {
  if (!playing.value && api.base && !pinned.value) {
    reload({ keepIndex: true });
    reloadExtras();
  }
}, 60000);

/** Show history: up to `frames` volumes from a UTC day ending at `endMs` (or end of day). */
export async function loadHistory(date: string, endMs?: number) {
  const r = settings.value.radar;
  try {
    const res = await api.get(`/api/radar/${r.site}/day/${date.replace(/-/g, "")}`);
    let v: { key: string; time: number }[] = res.volumes;
    if (endMs) v = v.filter((x) => x.time <= endMs);
    // time spans can reach back into the previous day
    if (settings.value.anim.mode === "time" && v.length && v[0].time > (endMs ?? v[v.length - 1].time) - settings.value.anim.minutes * 60_000) {
      try {
        const prev = new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
        const r2 = await api.get(`/api/radar/${r.site}/day/${prev}`);
        v = [...r2.volumes, ...v];
      } catch {
        /* no earlier day */
      }
    }
    v = settings.value.anim.mode === "time" ? trimToSpan(v) : v.slice(-r.frames);
    if (!v.length) {
      toast("No volumes for that time", "warn");
      return;
    }
    update((s) => (s.radar.source = "L2"));
    pinned.value = v.map((x) => ({ key: x.key, time: x.time }));
  } catch (e: any) {
    toast(`History: ${e.message}`, "error");
  }
}

export function backToLatest() {
  pinned.value = null;
  playingRec.value = null;
  historyEnd.value = null;
}

// the timeline's history picker drives radar history too
let lastHist: number | null = null;
effect(() => {
  const end = historyEnd.value;
  const a = settings.value.anim;
  const sig = `${a.mode}|${a.minutes}|${settings.value.radar.frames}|${settings.value.radar.site}`;
  const radar = settings.value.weather.kind === "radar";
  const was = lastHist;
  lastHist = end;
  if (!radar) return;
  if (end) loadHistory(new Date(end).toISOString().slice(0, 10), end);
  else if (was) pinned.value = null;
  void sig;
});

/** Plain click: show only this radar. Ctrl/Cmd+click: add/remove it as an extra radar. */
export function selectSite(id: string, additive = false) {
  update((s) => {
    if (additive && id !== s.radar.site) {
      s.extraSites = s.extraSites.includes(id) ? s.extraSites.filter((x) => x !== id) : [...s.extraSites, id].slice(-8);
      return;
    }
    s.extraSites = [];
    s.radar.site = id;
    s.weather = { kind: "radar" };
    const site = sites.value.find((x) => x.id === id);
    if (s.radar.source === "L3") s.radar.product = l3For(s.radar.product, site?.type === "TDWR");
  });
}

// ---------- extra radars ----------
let extraGen = 0;
async function loadSiteFrames(site: string, gen: number): Promise<Frame[]> {
  const r = settings.value.radar;
  const n = Math.min(framesToRequest(r.frames, 4, 200), 30);
  let list: Frame[];
  let product = r.product;
  if (r.source === "L2") {
    const res = await api.get(`/api/radar/${site}/latest?n=${n}`);
    list = res.volumes.map((v: any) => ({ key: v.key, time: v.time }));
  } else {
    product = l3For(r.product, sites.value.find((x) => x.id === site)?.type === "TDWR");
    const res = await api.get(`/api/l3/${site}/${product}/list?n=${n}`);
    list = res.volumes.map((v: any) => ({ key: v.key, time: v.time }));
  }
  const out: Frame[] = [];
  for (const f of list.reverse()) {
    if (gen !== extraGen) break;
    try {
      const s = r.source === "L2" ? await loadL2Sweep(f.key, product, r.tiltAngle) : await loadL3(f.key);
      if (s) out.unshift({ ...f, sweep: s, time: s.start });
    } catch {
      /* skip */
    }
    // publish progressively so the newest picture shows quickly
    if (gen === extraGen && (out.length === 1 || out.length === list.length)) extraFrames.value = { ...extraFrames.value, [site]: out.slice() };
  }
  return out;
}

export async function reloadExtras() {
  const gen = ++extraGen;
  const extra = settings.value.extraSites;
  const keep: Record<string, Frame[]> = {};
  for (const k of extra) if (extraFrames.value[k]) keep[k] = extraFrames.value[k];
  extraFrames.value = keep;
  if (!api.base || settings.value.weather.kind !== "radar") return;
  for (const site of extra) {
    try {
      const fs = await loadSiteFrames(site, gen);
      if (gen !== extraGen) return;
      extraFrames.value = { ...extraFrames.value, [site]: fs };
    } catch {
      /* site offline */
    }
  }
}

let extraSig = "";
effect(() => {
  const st = settings.value;
  const r = st.radar;
  const sig = `${st.extraSites.join(",")}|${r.source}|${r.product}|${r.tiltAngle}|${r.frames}|${st.weather.kind}|${r.live}`;
  void api.base;
  if (sig === extraSig) return;
  const sitesOnly = extraSig.split("|").slice(1).join("|") === sig.split("|").slice(1).join("|");
  extraSig = sig;
  if (!sitesOnly) extraFrames.value = {};
  // drop live state for radars no longer shown
  const keep: Record<string, any> = {};
  for (const [k, v] of Object.entries(extraLive.value)) {
    if (st.extraSites.includes(k) && r.live && sitesOnly) keep[k] = v;
    else if (v.sweep && layer) layer.release(v.sweep);
  }
  extraLive.value = keep;
  watchSites();
  setTimeout(reloadExtras, 150);
});

/** Open a local Level II file: upload to the server and show it. */
export async function openLocalFile(file: File) {
  toast(`Uploading ${file.name}…`);
  try {
    const res = await api.send("POST", `/api/radar/upload?name=${encodeURIComponent(file.name)}`, file, false);
    const meta: VolMeta = res.meta;
    metaCache.set(res.key, meta);
    update((s) => {
      s.radar.source = "L2";
      if (meta.site) s.radar.site = meta.site;
    });
    pinned.value = [{ key: res.key, time: meta.time }];
    toast(`Opened ${meta.site} ${new Date(meta.time).toISOString().slice(0, 16).replace("T", " ")}Z`);
  } catch (e: any) {
    toast(`Couldn't open file: ${e.message}`, "error");
  }
}

/** Sweep for any volume key (used by the extra map panes). */
export async function fetchSweep(key: string, source: "L2" | "L3", product: string, tilt: number): Promise<Sweep | undefined> {
  return source === "L2" ? loadL2Sweep(key, product, tilt) : loadL3(key);
}
