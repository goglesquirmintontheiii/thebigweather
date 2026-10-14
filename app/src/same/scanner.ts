// radio/dash 0.8: weather-radio scanner. The server monitors every picked station at once for SAME
// headers and 1050 Hz / EAS tones (PUT/GET /api/radio/monitor, GET /api/radio/same, WS "same");
// the app plays one station at a time — cycling with a dwell time or holding a favourite — and
// jumps to a station that fires, showing the alert and its map outline. When the server can't
// decode (no ffmpeg, older server), up to MAX_CLIENT streams are decoded here instead (one muted
// player + tap + SAME decoder each).
// 0.8.1: "Watch all for SAME" (one click: monitor every station, audio muted or on one station),
// and a "Mix" mode that plays several stations at once with per-station volume / mute / solo.

import { signal, computed } from "@preact/signals";
import { api } from "../api";
import { toast, settings } from "../store";
import { mixPlan, setMix, type MixEntry } from "./mixplan"; // 0.8.1
import { playStream, stopStream, nowPlaying, LivePlayer, type Stream } from "../radio";
import { parseHeader, buildHeader, type SameHeader } from "./parse";
import { eventInfo } from "./codes";
import { sameHitListeners, sameToneListeners, sameAutoMap, mapHeader, areaList, type SameHit } from "./monitor";
import { hideCounties, sameShown, sameKey } from "./mapshow";
import { playAlertSound } from "../sound";
import { sameSound } from "./monitor";

export const MAX_CLIENT = 4;

export interface ScanStation {
  id: string;
  url: string;
  name: string;
  call?: string;
}
export interface ScanCfg {
  stations: ScanStation[];
  /** seconds on each station while cycling */
  dwell: number;
  mode: "cycle" | "hold" | "mix";
  /** station held in "hold" mode */
  fav: string | null;
  /** jump to (and stay on) a station that fires */
  jump: boolean;
  /** minutes to stay on it */
  stayMin: number;
  /** play audio at all (off = silent monitoring) */
  audio: boolean;
  /** leave the stations on the server's 24/7 monitor after stopping (SAME rules, notifications) */
  keepServer?: boolean;
  /** 0.8.1: stations in the audio mix (mode "mix") with their volume / mute */
  mix?: Record<string, MixEntry>;
  /** 0.8.1: mix: only this station is heard */
  solo?: string | null;
}
export interface StStatus {
  connected: boolean;
  level_db: number | null;
  last_audio: number | null;
  tone: boolean;
  last_same?: { t: number; event: string; code?: string } | null;
  note?: string;
}
export interface ScanAlert {
  key: string;
  station: string;
  label: string;
  header: SameHeader | null;
  raw: string;
  at: number;
  test: boolean;
  source: "server" | "client";
}

const KEY = "tbw.scanner";
const DEF: ScanCfg = { stations: [], dwell: 15, mode: "cycle", fav: null, jump: true, stayMin: 5, audio: true };
function load(): ScanCfg {
  try {
    return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || "{}") || {}) };
  } catch {
    return { ...DEF };
  }
}
export const scanCfg = signal<ScanCfg>(load());
export function setScan(fn: (c: ScanCfg) => void) {
  const c = structuredClone(scanCfg.value);
  fn(c);
  c.dwell = Math.max(5, Math.min(300, Math.round(c.dwell) || 15));
  if (c.fav && !c.stations.some((s) => s.id === c.fav)) c.fav = null;
  if (c.mix) for (const id of Object.keys(c.mix)) if (!c.stations.some((s) => s.id === id)) delete c.mix[id];
  if (c.solo && !c.mix?.[c.solo]) c.solo = null;
  scanCfg.value = c;
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* */
  }
  if (scanOn.value) {
    syncMonitors();
    step();
  }
}
export const inScan = (id: string) => scanCfg.value.stations.some((s) => s.id === id);
const toScan = (s: Stream): ScanStation => ({ id: s.id, url: s.url, name: s.city ? `${s.city}, ${s.state}` : s.name, call: s.call });
/** 0.8.1: add several stations at once (a state, the favourites…); the server takes up to 64 */
export function addToScan(list: Stream[]) {
  let n = 0;
  setScan((c) => {
    for (const s of list) {
      if (!s.url || c.stations.some((x) => x.id === s.id) || c.stations.length >= 64) continue;
      c.stations.push(toScan(s));
      n++;
    }
  });
  if (n) toast(`${n} station${n === 1 ? "" : "s"} added to the scanner`);
  else if (scanCfg.value.stations.length >= 64) toast("The scanner holds up to 64 stations", "warn");
}
/** 0.8.1: one click: watch every scanner station for SAME / alert tones; audio muted, or on one station */
export async function watchAll(audioOn: string | null) {
  setScan((c) => {
    c.jump = true;
    if (audioOn) {
      c.audio = true;
      c.mode = "hold";
      c.fav = audioOn;
    } else c.audio = false;
  });
  if (!scanOn.value) await startScan();
}
/** 0.8.1: mix: put stations in / take them out of the mix */
export function mixStations(ids: string[], on: boolean) {
  setScan((c) => {
    c.mix = setMix(c.mix, ids, on);
    if (on) {
      c.mode = "mix";
      c.audio = true;
    }
  });
}
export function setMixEntry(id: string, p: Partial<MixEntry>) {
  setScan((c) => {
    c.mix = { ...(c.mix ?? {}), [id]: { vol: 1, ...(c.mix?.[id] ?? {}), ...p } };
  });
}
export function toggleScan(s: Stream) {
  setScan((c) => {
    if (c.stations.some((x) => x.id === s.id)) c.stations = c.stations.filter((x) => x.id !== s.id);
    else c.stations.push(toScan(s));
  });
}

export const scanOn = signal(false);
/** "server": the server decodes; "client": this computer decodes (fallback) */
export const scanBackend = signal<"off" | "connecting" | "server" | "client">("off");
export const scanNote = signal("");
export const scanStatus = signal<Record<string, StStatus>>({});
/** station whose audio is playing */
export const scanCurrent = signal<string | null>(null);
export const scanSince = signal(0);
export const scanLock = signal<{ id: string; until: number; reason: string } | null>(null);
export const scanAlerts = signal<ScanAlert[]>([]);
/** stations decoded on this computer (client fallback) */
export const clientDecoded = computed(() => (scanBackend.value === "client" ? scanCfg.value.stations.slice(0, MAX_CLIENT).map((s) => s.id) : []));

const label = (s: ScanStation) => s.call ?? s.name;
const toStream = (s: ScanStation): Stream => ({ id: s.id, name: s.name, url: s.url, call: s.call });
const byId = (id: string) => scanCfg.value.stations.find((s) => s.id === id);

// ---------- start / stop ----------

let poll: number | undefined;
let tick: number | undefined;
let lastSwitch = 0;
let order = 0;

/* server monitor (GET/PUT /api/radio/monitor): the scanner adds its stations to the server's list
   (which may already hold 24/7 stations for server rules) and takes back only what it added */
let added: string[] = [];
let prevEnabled: boolean | null = null;
async function releaseServer() {
  const ids = added;
  const en = prevEnabled;
  added = [];
  prevEnabled = null;
  if (scanCfg.value.keepServer || (!ids.length && en !== false)) return;
  try {
    const cur: any = await api.get("/api/radio/monitor");
    const stations = (cur?.stations ?? []).filter((x: any) => !ids.includes(x.id)).map((x: any) => ({ id: x.id, url: x.url, name: x.name ?? "" }));
    await api.send("PUT", "/api/radio/monitor", { stations, enabled: en ?? !!cur?.enabled });
  } catch {
    /* server gone */
  }
}

export async function startScan() {
  if (scanOn.value) return;
  if (!scanCfg.value.stations.length) return toast("Add stations to scan first", "warn");
  scanOn.value = true;
  scanStatus.value = {};
  scanBackend.value = "connecting";
  scanNote.value = "Asking the server to monitor…";
  await syncMonitors();
  tick = window.setInterval(step, 1000);
  lastSwitch = 0;
  step();
}

export function stopScan() {
  if (!scanOn.value) return;
  scanOn.value = false;
  clearInterval(tick);
  clearInterval(poll);
  poll = tick = undefined;
  if (scanBackend.value === "server") void releaseServer();
  stopClient();
  stopMix();
  scanBackend.value = "off";
  scanNote.value = "";
  scanLock.value = null;
  if (scanCurrent.value && nowPlaying.value?.id === scanCurrent.value) stopStream();
  scanCurrent.value = null;
}

/** Tell the server which stations to monitor; fall back to client decoding when it can't. */
async function syncMonitors() {
  const st = scanCfg.value.stations;
  if (scanBackend.value === "client") return syncClient();
  try {
    const cur: any = await api.get("/api/radio/monitor");
    if (cur?.ffmpeg === false) throw Object.assign(new Error("the server has no ffmpeg"), { soft: true });
    const have: any[] = cur?.stations ?? [];
    if (prevEnabled === null) prevEnabled = !!cur?.enabled;
    // stations removed from the scan since the last sync: take them back off the server (only ours)
    const gone = added.filter((id) => !st.some((s) => s.id === id));
    const keep = have.filter((x) => !gone.includes(x.id)).map((x) => ({ id: x.id, url: x.url, name: x.name ?? "" }));
    const fresh = st.filter((s) => !keep.some((x) => x.id === s.id));
    added = [...added.filter((id) => !gone.includes(id)), ...fresh.map((s) => s.id)];
    const r: any = await api.send("PUT", "/api/radio/monitor", { stations: [...keep, ...fresh.map((s) => ({ id: s.id, url: s.url, name: label(s) }))], enabled: true });
    if (!scanOn.value) return;
    if (r && (r.ffmpeg === false || r.error)) {
      void releaseServer();
      throw Object.assign(new Error(r.error || "the server can't decode audio (no ffmpeg)"), { soft: true });
    }
    scanBackend.value = "server";
    scanNote.value = `The server is monitoring ${st.length} station${st.length === 1 ? "" : "s"} for SAME data and alert tones`;
    stopClient();
    clearInterval(poll);
    poll = window.setInterval(pollServer, 3000);
    pollServer();
    backfill();
  } catch (e: any) {
    if (!scanOn.value) return;
    scanBackend.value = "client";
    const why = e?.status === 404 || e?.status === 405 ? "this server has no radio monitor" : e?.message || "server unavailable";
    scanNote.value = `Decoding here (${why}): the first ${Math.min(MAX_CLIENT, st.length)} of ${st.length} station${st.length === 1 ? "" : "s"}`;
    syncClient();
  }
}

async function pollServer() {
  try {
    const r: any = await api.get("/api/radio/monitor");
    const list: any[] = Array.isArray(r) ? r : r?.stations ?? [];
    const out: Record<string, StStatus> = {};
    for (const x of list) {
      if (!x?.id) continue;
      const ls = x.last_same;
      out[x.id] = {
        connected: !!x.connected,
        level_db: x.level_db != null && Number.isFinite(+x.level_db) ? +x.level_db : null,
        last_audio: x.last_audio ? +x.last_audio || Date.parse(x.last_audio) : null,
        tone: !!x.tone_active,
        last_same: ls ? { t: +ls.t || Date.parse(ls.t ?? ls.at ?? "") || Date.now(), event: ls.header?.event_name ?? ls.eventName ?? ls.event_name ?? (ls.event ? eventInfo(ls.event).name : ls.raw ? parseHeader(ls.raw)?.eventName ?? "SAME" : "SAME"), code: ls.header?.event ?? ls.event ?? (ls.raw ? parseHeader(ls.raw)?.event : undefined) } : null,
        note: x.error,
      };
      const was = scanStatus.peek()[x.id]?.tone;
      if (x.tone_active && !was) onTone(x.id, "server");
    }
    scanStatus.value = out;
  } catch {
    /* keep the last status */
  }
}

/** recent messages from the server (no jumping; the list only) */
async function backfill() {
  try {
    const r: any = await api.get(`/api/radio/same?since=${Date.now() - 6 * 3600_000}&limit=100`);
    const list: any[] = (Array.isArray(r) ? r : r?.messages ?? []).filter((m: any) => (m.kind ?? "header") === "header" && st0().has(String(m.station)));
    for (const m of list.slice(-30)) handleServer(m, true);
  } catch {
    /* older server */
  }
}

const st0 = () => new Set(scanCfg.value.stations.map((s) => s.id));
// server WS {type:"same"}: kind header | eom | tone (stored) or tone-start (broadcast only)
api.on("same", (m) => {
  if (!scanOn.value || scanBackend.value !== "server" || !st0().has(String(m.station))) return;
  const k = m.kind ?? "header";
  if (k === "tone-start") return onTone(String(m.station), "server");
  if (k === "header") handleServer(m, false);
});

function headerOf(m: any): SameHeader | null {
  if (m.raw) {
    const h = parseHeader(String(m.raw));
    if (h) return h;
  }
  if (m.header && typeof m.header === "object") m = { ...m, ...m.header }; // server's parsed header
  if (!m.event) return null;
  const info = eventInfo(m.event);
  const issued = new Date(m.issued ?? m.t ?? Date.now());
  const expires = new Date(m.expires ?? issued.getTime() + (m.purge_min ?? 60) * 60000);
  const locs: string[] = m.locations ?? m.fips ?? [];
  const h = parseHeader(buildHeader({ org: m.org ?? "WXR", event: m.event, locations: locs.map((l: any) => String(l.code ?? l).padStart(6, "0")), purge: m.purge ?? "0100", issued, sender: m.sender ?? "NWS" }));
  return h ? { ...h, eventName: m.eventName ?? m.event_name ?? info.name, issued, expires } : null;
}

function handleServer(m: any, old: boolean) {
  const id = String(m.station ?? "");
  const s = byId(id);
  const key = `scan:${id}:${m.id ?? ""}:${m.t ?? m.raw ?? Date.now()}`;
  if (scanAlerts.peek().some((a) => a.key === key)) return;
  const h = headerOf(m);
  const test = !!m.test || h?.event === "RWT" || h?.event === "RMT" || h?.event === "DMO";
  addAlert({ key, station: id, label: s ? label(s) : id, header: h, raw: String(m.raw ?? ""), at: +m.t || Date.parse(m.at ?? "") || Date.now(), test, source: "server" }, !old);
}

function addAlert(a: ScanAlert, live: boolean) {
  scanAlerts.value = [a, ...scanAlerts.peek()].sort((x, y) => y.at - x.at).slice(0, 100);
  if (!live) return;
  if (a.source === "server" && a.header) {
    if (sameAutoMap.value) mapHeader(a.header, a.key, a.label, a.test);
    const loud = a.header.level === "warning" || a.header.level === "emergency";
    toast(`${a.test ? "[TEST] " : ""}${a.label} SAME: ${a.header.eventName} for ${areaList(a.header, 4)}`, loud ? "alert" : "info", loud ? 12000 : 6000);
    if (loud && sameSound.value) playAlertSound(a.header.eventName);
  }
  jumpTo(a.station, a.header ? `${a.test ? "Test: " : ""}${a.header.eventName}` : "SAME data");
}

function onTone(id: string, _src: string) {
  jumpTo(id, "Alert tone");
}

/** Switch to a station that fired and stay there for a while (scanCfg.stayMin). */
export function jumpTo(id: string, reason: string) {
  const c = scanCfg.value;
  if (!scanOn.value || !c.jump || !byId(id)) return;
  // the tone follows the header on air: keep the message's name as the reason
  const cur = scanLock.value;
  if (cur && cur.id === id && reason === "Alert tone" && Date.now() < cur.until) reason = cur.reason;
  scanLock.value = { id, until: Date.now() + c.stayMin * 60_000, reason };
  play(id);
}

export function resumeScan() {
  scanLock.value = null;
  lastSwitch = 0;
  step();
}

/** Listen to one station now (manual pick; cycling continues after the dwell time). */
export function listenTo(id: string) {
  // 0.8.1: in the mix, listening to one station = solo it (it joins the mix if needed)
  if (scanCfg.value.mode === "mix") {
    return setScan((c) => {
      c.mix = setMix(c.mix, [id], true);
      c.solo = c.solo === id ? null : id;
    });
  }
  play(id);
}

// ---------- audio ----------

function play(id: string) {
  const s = byId(id);
  if (!s) return;
  scanCurrent.value = id;
  scanSince.value = Date.now();
  lastSwitch = Date.now();
  if (scanCfg.value.mode === "mix") return syncMix();
  stopMix();
  if (!scanCfg.value.audio) {
    if (nowPlaying.value && scanCfg.value.stations.some((x) => x.url === nowPlaying.value!.url)) stopStream();
    for (const [, p] of client) p.setMuted(true);
    return;
  }
  const cp = client.get(id);
  if (cp) {
    // decoded here: unmute its player, mute the rest; no extra connection
    if (nowPlaying.value && scanCfg.value.stations.some((x) => x.url === nowPlaying.value!.url)) stopStream();
    for (const [k, p] of client) p.setMuted(k !== id);
    return;
  }
  for (const [, p] of client) p.setMuted(true);
  if (nowPlaying.value?.url !== s.url) playStream(toStream(s), { small: true });
}

function step() {
  if (!scanOn.value) return;
  const c = scanCfg.value;
  const lock = scanLock.value;
  if (lock) {
    if (Date.now() < lock.until) {
      if (scanCurrent.value !== lock.id) play(lock.id);
      return;
    }
    scanLock.value = null;
  }
  // stations we can cycle through: decoded-here ones in client mode, connected ones on the server
  let list = c.stations;
  if (scanBackend.value === "client") list = list.filter((s) => client.has(s.id));
  else if (scanBackend.value === "server") {
    const st = scanStatus.value;
    const up = list.filter((s) => st[s.id]?.connected !== false);
    if (up.length) list = up;
  }
  if (c.mode === "mix") return syncMix();
  stopMix();
  if (!list.length) return;
  if (c.mode === "hold") {
    const id = c.fav && list.some((s) => s.id === c.fav) ? c.fav : list[0].id;
    if (scanCurrent.value !== id) play(id);
    return;
  }
  if (scanCurrent.value && list.some((s) => s.id === scanCurrent.value) && Date.now() - lastSwitch < c.dwell * 1000) return;
  const i = list.findIndex((s) => s.id === scanCurrent.value);
  order = (i + 1) % list.length;
  play(list[order].id);
}

/** seconds until the next station (cycling), or null */
export function nextIn(): number | null {
  if (!scanOn.value || scanLock.value || scanCfg.value.mode !== "cycle" || !lastSwitch) return null;
  return Math.max(0, Math.ceil((lastSwitch + scanCfg.value.dwell * 1000 - Date.now()) / 1000));
}

// ---------- 0.8.1: audio mix (several stations at once) ----------

/** players for the mix (stations decoded here reuse their client player instead) */
const mixP = new Map<string, LivePlayer>();
/** stations heard in the mix right now (for the list) */
export const mixLive = signal<string[]>([]);

function syncMix() {
  const c = scanCfg.value;
  const lock = scanLock.peek();
  const plan = mixPlan(c, lock && Date.now() < lock.until ? lock.id : null, settings.peek().radio.volume);
  // the single-station player isn't used in mix mode
  if (nowPlaying.value && c.stations.some((x) => x.url === nowPlaying.value!.url)) stopStream();
  for (const [id, p] of mixP)
    if (!plan.ids.includes(id) || client.has(id)) {
      p.destroy();
      mixP.delete(id);
    }
  for (const [id, p] of client) if (!plan.ids.includes(id)) p.setMuted(true);
  for (const id of plan.ids) {
    const s = byId(id);
    if (!s) continue;
    let p = client.get(id) ?? mixP.get(id);
    if (!p) {
      p = new LivePlayer(toStream(s));
      p.headless = true;
      mixP.set(id, p);
    }
    p.setVolume(plan.vol[id]);
    p.setMuted(plan.muted[id]);
  }
  const live = plan.ids.filter((id) => !plan.muted[id]);
  if (live.join() !== mixLive.peek().join()) mixLive.value = live;
  if (plan.solo && scanCurrent.peek() !== plan.solo) scanCurrent.value = plan.solo;
}

function stopMix() {
  for (const [, p] of mixP) p.destroy();
  mixP.clear();
  if (mixLive.peek().length) mixLive.value = [];
}

// ---------- client fallback: decode up to MAX_CLIENT streams here ----------

const client = new Map<string, LivePlayer>();
let clientTimer: number | undefined;

function syncClient() {
  const want = scanCfg.value.stations.slice(0, MAX_CLIENT);
  for (const [id, p] of client)
    if (!want.some((s) => s.id === id)) {
      p.destroy();
      client.delete(id);
    }
  for (const s of want) {
    if (client.has(s.id)) continue;
    const p = new LivePlayer(toStream(s));
    p.headless = true;
    p.setMuted(true);
    p.same.start();
    // level meter for the station list
    const t = window.setInterval(() => {
      if (!client.has(s.id) || p.snap.value.status !== "playing") return;
      p.startLevels(true);
      clearInterval(t);
    }, 1500);
    client.set(s.id, p);
  }
  clearInterval(clientTimer);
  clientTimer = window.setInterval(() => {
    const out: Record<string, StStatus> = {};
    for (const [id, p] of client) {
      const L = p.levels.live;
      const fresh = performance.now() - L.t < 3000;
      const sn = p.snap.value;
      out[id] = { connected: sn.status === "playing" || sn.status === "paused", level_db: fresh && L.rms > 0 ? 20 * Math.log10(L.rms) : null, last_audio: fresh ? Date.now() : null, tone: !!p.same.tone.value, note: sn.status === "error" ? sn.note ?? "error" : sn.mode === "plain" ? "audio not readable (no CORS)" : undefined };
    }
    scanStatus.value = out;
  }, 1000);
  if (scanCurrent.value) play(scanCurrent.value);
}

function stopClient() {
  for (const [, p] of client) p.destroy();
  client.clear();
  clearInterval(clientTimer);
}

// headers / tones decoded here (the monitors already map + toast them)
sameHitListeners.add((h: SameHit) => {
  if (!scanOn.value) return;
  const s = scanCfg.value.stations.find((x) => label(x) === h.label);
  if (!s) return;
  // same key as the monitor's own map outline, so Map / Hide here match it
  addAlert({ key: sameKey(h.id), station: s.id, label: h.label, header: h.header, raw: h.raw, at: h.at.getTime(), test: h.test, source: "client" }, true);
});
sameToneListeners.add((lbl, _kind, on) => {
  if (!scanOn.value || !on) return;
  const s = scanCfg.value.stations.find((x) => label(x) === lbl);
  if (s && client.has(s.id)) onTone(s.id, "client");
});

/** Inject a test header for a station (checks the jump + map path without real audio). */
export function scanTest(id?: string) {
  const s = byId(id ?? scanCurrent.value ?? "") ?? scanCfg.value.stations[0];
  if (!s) return;
  if (scanOn.value && scanBackend.value === "server") {
    // through the server's decoder (POST /api/radio/same/test): arrives as WS "same" like a real one
    api.send("POST", "/api/radio/same/test", { station: s.id, event: "TOR", locations: ["040027", "040087", "040109"] }).catch((e) => toast(`Server SAME test: ${e.message}`, "warn"));
    return;
  }
  const raw = buildHeader({ event: "TOR", locations: ["040027", "040087", "040109"], purge: "0030", sender: "KOUN/NWS" });
  const h = parseHeader(raw);
  addAlert({ key: `scan:${s.id}:test:${Date.now()}`, station: s.id, label: label(s), header: h, raw, at: Date.now(), test: true, source: "server" }, true);
}

export function clearScanAlerts() {
  for (const a of scanAlerts.value) if (sameShown.value[a.key]) hideCounties(a.key);
  scanAlerts.value = [];
}

// debugging / screenshots
(window as any).__tbwScan = { scanCfg, scanOn, scanStatus, scanAlerts, scanBackend, startScan, stopScan, scanTest, setScan, jumpTo, watchAll, mixStations, handleServer: (m: any) => handleServer(m, false), clientPlayers: () => client, mixPlayers: () => mixP };
