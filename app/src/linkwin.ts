// Link other map windows (a second full map, or a pane window) to the main one so they behave like
// panes. Each linked window chooses what it follows (panes 0.8: per-window links):
//   pos    — map view and radar site(s)
//   time   — timeline frame, playback, history window
//   layers — overlay layers (Layers menu)
// Same-origin windows talk over a BroadcastChannel; incoming changes are applied under a guard so
// they are never echoed back. The main window relays whatever any linked window wants; secondary
// windows send and apply only what they themselves have linked.

import { signal, effect, computed } from "@preact/signals";
import type { Map as MLMap } from "maplibre-gl";
import { settings, update, type PaneLink } from "./store";
import { popoutSpec } from "./popout";
import { mapRef } from "./map/mapview";
import { frameIndex, playing, historyStart, historyEnd, setHistory } from "./anim";
import { activeFrames } from "./active";

export type WinKind = "main" | "map" | "pane";
export const myKind: WinKind = popoutSpec?.kind === "pane" ? "pane" : popoutSpec?.kind === "map" ? "map" : "main";
export const isSecondWindow = myKind !== "main";
const NONE: PaneLink = { pos: false, time: false, layers: false };
const ALL: PaneLink = { pos: true, time: true, layers: true };

/** what this (secondary) window follows; the main window's own flags are unused */
export const myLink = signal<PaneLink>(myKind === "pane" ? { ...ALL, ...(popoutSpec?.data?.paneWin?.link ?? {}) } : { ...NONE });
/** other windows seen in the last few seconds */
export interface Peer {
  id: string;
  kind: WinKind;
  title: string;
  lk: PaneLink;
  at: number;
}
export const peerList = signal<Peer[]>([]);
export const peers = computed(() => peerList.value.length);
/** pane windows: time sent by the main window (0 = follow the newest frame) */
export const linkedTime = signal(0);
/** the map this window links (pane windows set their pane's map) */
export const linkMap = signal<MLMap | null>(null);
const theMap = () => linkMap.peek() ?? mapRef.peek();

/* legacy API (one link switch for everything) */
export const linkOn = computed(() => (myKind === "main" ? peerList.value.some((p) => p.lk.pos || p.lk.time) : myLink.value.pos || myLink.value.time));
export const linkLayers = computed(() => (myKind === "main" ? peerList.value.some((p) => p.lk.layers) : myLink.value.layers));

const enabled = (!popoutSpec || popoutSpec.kind === "map" || popoutSpec.kind === "pane") && typeof BroadcastChannel !== "undefined";
const me = Math.random().toString(36).slice(2);
const ch = enabled ? new BroadcastChannel("tbw-link") : null;
let applying = 0;
const myTitle = () => (myKind === "main" ? "Main window" : myKind === "pane" ? popoutSpec?.data?.paneWin?.title ?? "Pane window" : popoutSpec?.title ?? "Map window");

type Msg =
  | { t: "ping" }
  | { t: "bye" }
  | { t: "linkcfg"; to: string; lk: PaneLink }
  | { t: "view"; c: [number, number]; z: number; b: number; p: number }
  | { t: "time"; time: number }
  | { t: "play"; on: boolean }
  | { t: "hist"; start: number | null; end: number | null }
  | { t: "site"; site: string; extra: string[] }
  | { t: "layers"; ovl: any; overlays: any };
type Env = Msg & { from: string; kind: WinKind; title: string; lk: PaneLink };

/** does this window send category c? */
function wants(c: keyof PaneLink): boolean {
  if (myKind === "main") return peerList.peek().some((p) => p.lk[c]);
  return myLink.peek()[c];
}
/** should this window apply category c from that sender? */
function accepts(c: keyof PaneLink, m: Env): boolean {
  if (myKind === "main") return !!m.lk?.[c];
  return myLink.peek()[c] && (m.kind === "main" || !!m.lk?.[c]);
}

function send(m: Msg) {
  ch?.postMessage({ ...m, from: me, kind: myKind, title: myTitle(), lk: myLink.peek() });
}

function guard(fn: () => void) {
  applying++;
  try {
    fn();
  } finally {
    applying--;
  }
}

const histSig = () => JSON.stringify([historyStart.value, historyEnd.value]);
let lastHist = "";
const siteSig = () => JSON.stringify([settings.value.radar.site, settings.value.extraSites]);
const layerSig = () => JSON.stringify([settings.value.ovl, settings.value.overlays]);
let lastSite = "";
let lastLayers = "";

function sendView() {
  const m = theMap();
  if (!m) return;
  const c = m.getCenter();
  send({ t: "view", c: [c.lng, c.lat], z: m.getZoom(), b: m.getBearing(), p: m.getPitch() });
}
function sendTime() {
  if (myKind === "pane") return; // a pane window has no timeline of its own
  const f = activeFrames.peek()[frameIndex.peek()];
  if (f) send({ t: "time", time: f.time });
}
function sendSite() {
  send({ t: "site", site: settings.peek().radar.site, extra: settings.peek().extraSites });
}
function sendLayers() {
  send({ t: "layers", ovl: settings.peek().ovl, overlays: settings.peek().overlays });
}
function sendHist() {
  if (myKind !== "pane") send({ t: "hist", start: historyStart.peek(), end: historyEnd.peek() });
}
function sendAll() {
  if (wants("pos")) (sendView(), sendSite());
  if (wants("time")) (sendHist(), sendTime());
  if (wants("layers")) sendLayers();
}

/** Secondary window: set what it follows. Main window: set it for every other window. */
export function setLink(on: boolean, layers = linkLayers.peek()) {
  const lk = { pos: on, time: on, layers: on && layers };
  if (myKind === "main") for (const p of peerList.peek()) setPeerLink(p.id, lk);
  else setMyLink(lk);
}
export function setMyLink(lk: PaneLink) {
  myLink.value = { ...lk };
  send({ t: "ping" });
  sendAll();
}
/** main window: change what another window follows */
export function setPeerLink(id: string, lk: PaneLink) {
  peerList.value = peerList.peek().map((p) => (p.id === id ? { ...p, lk: { ...lk } } : p));
  send({ t: "linkcfg", to: id, lk });
  setTimeout(sendAll, 50);
}

function onMsg(m: Env) {
  if (m.from === me) return;
  const list = peerList.peek();
  const prev = list.find((p) => p.id === m.from);
  if (m.t === "bye") peerList.value = list.filter((p) => p.id !== m.from);
  else {
    const row: Peer = { id: m.from, kind: m.kind ?? "map", title: m.title ?? "Map window", lk: m.lk ?? NONE, at: Date.now() };
    if (!prev || JSON.stringify([prev.lk, prev.title]) !== JSON.stringify([row.lk, row.title])) peerList.value = [...list.filter((p) => p.id !== m.from), row];
    else prev.at = row.at;
  }
  if (m.t === "ping") {
    // a window that just opened: answer, and bring it up to date
    if (!prev) {
      send({ t: "ping" });
      setTimeout(sendAll, 30);
    } else if (myKind === "main" && JSON.stringify(prev.lk) !== JSON.stringify(m.lk)) setTimeout(sendAll, 30);
    return;
  }
  if (m.t === "linkcfg") {
    if (m.to === me) setMyLink(m.lk);
    return;
  }
  guard(() => {
    switch (m.t) {
      case "view": {
        if (!accepts("pos", m)) break;
        theMap()?.jumpTo({ center: m.c, zoom: m.z, bearing: m.b, pitch: m.p });
        break;
      }
      case "time": {
        if (!accepts("time", m)) break;
        if (myKind === "pane") {
          linkedTime.value = m.time;
          break;
        }
        const fs = activeFrames.peek();
        if (!fs.length) break;
        let bi = 0;
        fs.forEach((f, i) => Math.abs(f.time - m.time) < Math.abs(fs[bi].time - m.time) && (bi = i));
        if (bi !== frameIndex.peek()) frameIndex.value = bi;
        break;
      }
      case "play":
        // the other window drives playback; this one follows its frame times
        if (accepts("time", m) && m.on && playing.peek()) playing.value = false;
        break;
      case "hist": {
        if (!accepts("time", m) || myKind === "pane") break;
        // history window first, so the frame times that follow line up
        lastHist = JSON.stringify([m.start, m.end]);
        if (lastHist !== histSig()) setHistory(m.start, m.end);
        break;
      }
      case "site": {
        if (!accepts("pos", m)) break;
        lastSite = JSON.stringify([m.site, m.extra]);
        if (lastSite !== siteSig())
          update((s) => {
            s.radar.site = m.site;
            s.extraSites = m.extra;
          });
        break;
      }
      case "layers":
        if (!accepts("layers", m)) break;
        lastLayers = JSON.stringify([m.ovl, m.overlays]);
        if (lastLayers !== layerSig())
          update((s) => {
            s.ovl = m.ovl;
            s.overlays = m.overlays;
          });
        break;
    }
  });
}

function prunePeers() {
  const now = Date.now();
  const l = peerList.peek();
  const keep = l.filter((p) => now - p.at < 8000);
  if (keep.length !== l.length) peerList.value = keep;
}

if (ch) {
  ch.onmessage = (e) => onMsg(e.data);
  send({ t: "ping" });
  setInterval(() => {
    send({ t: "ping" });
    prunePeers();
  }, 3000);
  window.addEventListener("beforeunload", () => send({ t: "bye" }));

  // map view → other windows (throttled to ~60/s; a timer keeps working in background windows)
  let hooked: MLMap | null = null;
  let raf = 0;
  effect(() => {
    const m = linkMap.value ?? mapRef.value;
    if (!m || hooked === m) return;
    hooked = m;
    m.on("move", () => {
      if (!wants("pos") || applying || raf) return;
      raf = window.setTimeout(() => {
        raf = 0;
        sendView();
      }, 16);
    });
  });
  if (myKind !== "pane") {
    // timeline
    effect(() => {
      void frameIndex.value;
      if (!wants("time") || applying) return;
      sendTime();
    });
    effect(() => {
      const p = playing.value;
      if (!wants("time") || applying) return;
      send({ t: "play", on: p });
    });
    // history mode window
    effect(() => {
      const sig = histSig();
      if (sig === lastHist) return;
      lastHist = sig;
      if (wants("time") && !applying) sendHist();
    });
  }
  // radar site(s)
  effect(() => {
    const sig = siteSig();
    if (sig === lastSite) return;
    lastSite = sig;
    if (wants("pos") && !applying) sendSite();
  });
  // overlay layers
  effect(() => {
    const sig = layerSig();
    if (sig === lastLayers) return;
    lastLayers = sig;
    if (wants("layers") && !applying) sendLayers();
  });
}
