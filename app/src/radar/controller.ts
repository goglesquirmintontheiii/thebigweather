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
export const frameIndex = signal(0);
export const playing = signal(false);
export const loading = signal(false);
export const radarError = signal<string | null>(null);
export const tilts = signal<TiltMeta[]>([]);
export const liveSweep = signal<Sweep | null>(null);
export const liveState = signal<{ key: string; radials: number; elev: number; time: number } | null>(null);
export const showRadar = signal(true);
/** Explicit frames (history browsing / opened files). null = follow latest. */
export const pinned = signal<{ key: string; time: number }[] | null>(null);

export const currentSite = computed(() => sites.value.find((s) => s.id === settings.value.radar.site));
export const currentFrame = computed(() => frames.value[frameIndex.value]);

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
const SWEEP_CACHE_MAX = 140;

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
  if (showRadar.value) {
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

let generation = 0;
let liveKey: string | null = null;

export async function reload(opts: { keepIndex?: boolean } = {}) {
  const gen = ++generation;
  const r = settings.value.radar;
  if (!api.base || !r.site) return;
  loading.value = true;
  radarError.value = null;
  try {
    let list: Frame[] = [];
    if (pinned.value && r.source === "L2") {
      list = pinned.value.map((p) => ({ key: p.key, time: p.time }));
      liveKey = null;
    } else if (r.source === "L2") {
      const res = await api.get(`/api/radar/${r.site}/latest?n=${r.frames}`);
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
      list = list.slice(-r.frames);
    } else {
      const res = await api.get(`/api/l3/${r.site}/${r.product}/list?n=${r.frames}`);
      list = res.volumes.map((v: any) => ({ key: v.key, time: v.time }));
      liveKey = null;
    }
    if (gen !== generation) return;
    if (!list.length) {
      batch(() => {
        frames.value = [];
        liveSweep.value = null;
        radarError.value = "No data for this radar/product";
      });
      return;
    }
    // reuse already-loaded frames
    const old = new Map(frames.value.map((f) => [f.key, f]));
    const next = list.map((f) => old.get(f.key) && sameProduct(old.get(f.key)!) ? old.get(f.key)! : f);
    batch(() => {
      frames.value = next;
      if (!opts.keepIndex || frameIndex.value >= next.length) frameIndex.value = next.length - 1;
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
    if (last && !last.sweep && last.error) radarError.value = last.error;
    layer?.preload(frames.value.filter((f) => f.sweep).map((f) => f.sweep!));
    if (liveKey) refreshLive(true);
  } catch (e: any) {
    if (gen === generation) radarError.value = e.message ?? String(e);
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
        const wasComplete = liveSweep.value?.complete;
        liveSweep.value = s;
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
api.on("live", (m) => {
  const r = settings.value.radar;
  if (m.site !== r.site || r.source !== "L2" || !r.live) return;
  liveState.value = { key: m.key, radials: m.radials, elev: m.elev, time: m.time };
  if (m.key !== liveKey) {
    liveKey = m.key;
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
});

// ---------- animation ----------
let animTimer: number | undefined;
function step() {
  const n = frames.value.length;
  if (!playing.value || n < 2) return;
  const next = (frameIndex.value + 1) % n;
  frameIndex.value = next;
  const s = settings.value.anim;
  const delay = next === n - 1 ? s.dwellMs : 1000 / s.fps;
  animTimer = window.setTimeout(step, delay);
}
effect(() => {
  clearTimeout(animTimer);
  if (playing.value) animTimer = window.setTimeout(step, 1000 / settings.value.anim.fps);
});

export function togglePlay() {
  if (frames.value.length < 2) {
    toast("Need at least 2 frames to animate", "info");
    return;
  }
  playing.value = !playing.value;
}

// ---------- triggers ----------
let reloadTimer: number | undefined;
let lastSig = "";
effect(() => {
  const r = settings.value.radar;
  const sig = `${r.site}|${r.source}|${r.product}|${r.tiltAngle}|${r.frames}|${r.live}|${pinned.value?.map((p) => p.key).join(",") ?? ""}`;
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
  api.watch([r.site]);
  reloadTimer = window.setTimeout(() => reload(), 120);
});

api.on("connected", async () => {
  try {
    const [s, p] = await Promise.all([api.get<Site[]>("/api/sites"), api.get<L3Product[]>("/api/l3/products")]);
    sites.value = s;
    l3Products.value = p;
  } catch {
    /* ignore */
  }
  api.watch([settings.value.radar.site]);
  reload({ keepIndex: true });
});

// periodic refresh (archive frames + L3), live handles the fast path
setInterval(() => {
  if (!playing.value && api.base && !pinned.value) reload({ keepIndex: true });
}, 60000);

/** Show history: up to `frames` volumes from a UTC day ending at `endMs` (or end of day). */
export async function loadHistory(date: string, endMs?: number) {
  const r = settings.value.radar;
  try {
    const res = await api.get(`/api/radar/${r.site}/day/${date.replace(/-/g, "")}`);
    let v: { key: string; time: number }[] = res.volumes;
    if (endMs) v = v.filter((x) => x.time <= endMs);
    v = v.slice(-r.frames);
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
}

export function selectSite(id: string) {
  update((s) => {
    s.radar.site = id;
    const site = sites.value.find((x) => x.id === id);
    if (site?.type === "TDWR" && s.radar.source === "L3" && !l3Products.value.find((p) => p.id === s.radar.product)?.tdwr) {
      s.radar.product = "TZL";
    }
  });
}

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
