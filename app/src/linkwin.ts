// Link a second map window to the main one (or any two map windows) so it behaves like a pane:
// map view, timeline, radar site(s) and optionally overlay layers follow each other.
// Same-origin windows talk over a BroadcastChannel; incoming changes are applied under a guard so
// they are never echoed back.

import { signal, effect } from "@preact/signals";
import { settings, update } from "./store";
import { popoutSpec } from "./popout";
import { mapRef } from "./map/mapview";
import { frameIndex, playing } from "./anim";
import { activeFrames } from "./active";

export const isSecondWindow = popoutSpec?.kind === "map";
/** windows are linked */
export const linkOn = signal(false);
/** also sync overlay layers */
export const linkLayers = signal(false);
/** other map windows seen in the last few seconds */
export const peers = signal(0);

const enabled = (!popoutSpec || popoutSpec.kind === "map") && typeof BroadcastChannel !== "undefined";
const me = Math.random().toString(36).slice(2);
const ch = enabled ? new BroadcastChannel("tbw-link") : null;
const seen = new Map<string, number>();
let applying = 0;

type Msg =
  | { t: "ping" }
  | { t: "bye" }
  | { t: "link"; on: boolean; layers: boolean }
  | { t: "view"; c: [number, number]; z: number; b: number; p: number }
  | { t: "time"; time: number }
  | { t: "play"; on: boolean }
  | { t: "site"; site: string; extra: string[] }
  | { t: "layers"; ovl: any; overlays: any };

function send(m: Msg) {
  ch?.postMessage({ ...m, from: me });
}

function guard(fn: () => void) {
  applying++;
  try {
    fn();
  } finally {
    applying--;
  }
}

const siteSig = () => JSON.stringify([settings.value.radar.site, settings.value.extraSites]);
const layerSig = () => JSON.stringify([settings.value.ovl, settings.value.overlays]);
let lastSite = "";
let lastLayers = "";

function sendView() {
  const m = mapRef.peek();
  if (!m) return;
  const c = m.getCenter();
  send({ t: "view", c: [c.lng, c.lat], z: m.getZoom(), b: m.getBearing(), p: m.getPitch() });
}
function sendTime() {
  const f = activeFrames.peek()[frameIndex.peek()];
  if (f) send({ t: "time", time: f.time });
}
function sendSite() {
  send({ t: "site", site: settings.peek().radar.site, extra: settings.peek().extraSites });
}
function sendLayers() {
  send({ t: "layers", ovl: settings.peek().ovl, overlays: settings.peek().overlays });
}
function sendAll() {
  sendView();
  sendTime();
  sendSite();
  if (linkLayers.peek()) sendLayers();
}

export function setLink(on: boolean, layers = linkLayers.peek()) {
  linkOn.value = on;
  linkLayers.value = layers;
  send({ t: "link", on, layers });
  if (on) sendAll();
}

function onMsg(m: Msg & { from: string }) {
  if (m.from === me) return;
  const isNew = !seen.has(m.from);
  if (m.t === "bye") seen.delete(m.from);
  else seen.set(m.from, Date.now());
  countPeers();
  if (m.t === "ping") {
    // a window that just opened: answer, and pull it in if we're linked
    if (isNew) {
      send({ t: "ping" });
      if (linkOn.peek()) setLink(true);
    }
    return;
  }
  if (m.t === "link") {
    linkOn.value = m.on;
    linkLayers.value = m.layers;
    return;
  }
  if (!linkOn.peek()) return;
  guard(() => {
    switch (m.t) {
      case "view": {
        const map = mapRef.peek();
        map?.jumpTo({ center: m.c, zoom: m.z, bearing: m.b, pitch: m.p });
        break;
      }
      case "time": {
        const fs = activeFrames.peek();
        if (!fs.length) break;
        let bi = 0;
        fs.forEach((f, i) => Math.abs(f.time - m.time) < Math.abs(fs[bi].time - m.time) && (bi = i));
        if (bi !== frameIndex.peek()) frameIndex.value = bi;
        break;
      }
      case "play":
        // the other window drives playback; this one follows its frame times
        if (m.on && playing.peek()) playing.value = false;
        break;
      case "site": {
        lastSite = JSON.stringify([m.site, m.extra]);
        if (lastSite !== siteSig())
          update((s) => {
            s.radar.site = m.site;
            s.extraSites = m.extra;
          });
        break;
      }
      case "layers":
        if (!linkLayers.peek()) break;
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

function countPeers() {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 8000) seen.delete(k);
  peers.value = seen.size;
}

if (ch) {
  ch.onmessage = (e) => onMsg(e.data);
  send({ t: "ping" });
  setInterval(() => {
    send({ t: "ping" });
    countPeers();
  }, 3000);
  window.addEventListener("beforeunload", () => send({ t: "bye" }));

  // map view → other window (throttled to ~60/s; a timer keeps working in background windows)
  let hooked = false;
  let raf = 0;
  effect(() => {
    const m = mapRef.value;
    if (!m || hooked) return;
    hooked = true;
    m.on("move", () => {
      if (!linkOn.peek() || applying || raf) return;
      raf = window.setTimeout(() => {
        raf = 0;
        sendView();
      }, 16);
    });
  });
  // timeline
  effect(() => {
    void frameIndex.value;
    if (!linkOn.peek() || applying) return;
    sendTime();
  });
  effect(() => {
    const p = playing.value;
    if (!linkOn.peek() || applying) return;
    send({ t: "play", on: p });
  });
  // radar site(s)
  effect(() => {
    const sig = siteSig();
    if (sig === lastSite) return;
    lastSite = sig;
    if (linkOn.peek() && !applying) sendSite();
  });
  // overlay layers (opt-in)
  effect(() => {
    const sig = layerSig();
    if (sig === lastLayers) return;
    lastLayers = sig;
    if (linkOn.peek() && linkLayers.peek() && !applying) sendLayers();
  });
}
