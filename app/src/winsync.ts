// 0.8.2 windows: keeps pop-out OS windows (rail tabs, centre windows, cameras, …) live with the main
// window. Same-origin windows talk over a BroadcastChannel (like linkwin.ts does for map windows):
//   here / bye   a pop-out announces itself (every 3 s) and leaves; the main window marks its window
//                as "popped" (rail button lit, click focuses it)
//   who          the main window (re)started: pop-outs answer with "here"
//   full / set   settings: the whole set for a new pop-out, then only the top-level keys that changed,
//                both ways (main saves; pop-outs never write settings to disk)
//   dock         a pop-out's dock button: the main window opens that window again
//   open         0.8.2 integration: a pop-out opened another window (Settings → Data sources, a layer's
//                gear, …): it opens in the main window instead (the pop-out doesn't draw other windows)
// Map / pane windows keep their own settings and use linkwin.ts instead.

import { effect, untracked } from "@preact/signals";
import { settings } from "./store";
import { popoutSpec } from "./popout";
import { IN_OS_WIN, POP_WIN, POPPERS, popped, setDockImpl, popWindow } from "./ui/winframe";
import { changedKeys, livePeers } from "./ui/wincore";

type Msg =
  | { t: "here"; id: string }
  | { t: "bye"; id: string }
  | { t: "who" }
  | { t: "full"; to: string; keys: Record<string, unknown> }
  | { t: "set"; keys: Record<string, unknown> }
  | { t: "dock"; id: string; arg: any }
  | { t: "open"; id: string; arg: any };
type Env = Msg & { from: string };

const isMain = !popoutSpec;
const enabled = (isMain || IN_OS_WIN) && typeof BroadcastChannel !== "undefined";
const me = Math.random().toString(36).slice(2);
const ch = enabled ? new BroadcastChannel("tbw-win") : null;
const send = (m: Msg) => ch?.postMessage({ ...m, from: me });

/** main window: pop-outs seen lately (from → id, last seen) */
let peers: Record<string, { id: string; at: number }> = {};
let snap: Record<string, string> = {};
let applying = false;
let timer = 0;
const hasPeers = () => !isMain || Object.keys(peers).length > 0;

function apply(keys: Record<string, unknown>) {
  const cur = settings.peek() as any;
  const next: any = { ...cur };
  let any = false;
  for (const [k, v] of Object.entries(keys)) {
    let j: string;
    try {
      j = JSON.stringify(v) ?? "null";
    } catch {
      continue;
    }
    if (snap[k] === j && JSON.stringify(cur[k]) === j) continue;
    snap[k] = j;
    next[k] = v;
    any = true;
  }
  if (!any) return;
  applying = true;
  try {
    settings.value = next;
  } finally {
    applying = false;
  }
}

function flush() {
  if (!hasPeers()) return;
  const r = changedKeys(snap, settings.peek() as any);
  snap = r.snap;
  if (Object.keys(r.changed).length) send({ t: "set", keys: r.changed });
}

function syncPopped() {
  const now = Date.now();
  const out: Record<string, number> = {};
  // windows popped a moment ago that haven't said "here" yet keep their grace time
  for (const [id, at] of Object.entries(popped.peek())) if (at > now) out[id] = at;
  for (const p of Object.values(peers)) if (p.id) out[p.id] = Math.max(out[p.id] ?? 0, p.at);
  if (JSON.stringify(out) !== JSON.stringify(popped.peek())) popped.value = out;
}

function onMsg(m: Env) {
  if (!m || m.from === me) return;
  switch (m.t) {
    case "here":
      if (!isMain) return;
      if (!peers[m.from]) {
        // a new pop-out: the full settings, and a fresh baseline for the changes that follow
        peers[m.from] = { id: m.id, at: Date.now() };
        snap = changedKeys({}, settings.peek() as any).snap;
        send({ t: "full", to: m.from, keys: settings.peek() as any });
      } else peers[m.from] = { id: m.id, at: Date.now() };
      syncPopped();
      return;
    case "bye":
      if (!isMain) return;
      delete peers[m.from];
      if (m.id && popped.peek()[m.id]) {
        const p = { ...popped.peek() };
        delete p[m.id];
        popped.value = p;
      }
      syncPopped();
      return;
    case "who":
      if (!isMain) send({ t: "here", id: POP_WIN ?? "" });
      return;
    case "full":
      if (m.to === me) apply(m.keys);
      return;
    case "set":
      apply(m.keys);
      return;
    case "dock": {
      if (!isMain) return;
      const p = { ...popped.peek() };
      delete p[m.id];
      popped.value = p;
      POPPERS.get(m.id)?.open(m.arg);
      return;
    }
    case "open": {
      // 0.8.2 integration: opened from inside a pop-out
      if (!isMain) return;
      if (popped.peek()[m.id]) return void popWindow(m.id); // already in its own window: focus it
      POPPERS.get(m.id)?.open(m.arg);
      return;
    }
  }
}

if (ch) {
  ch.onmessage = (e) => onMsg(e.data);
  if (isMain) {
    send({ t: "who" });
    setDockImpl(() => {});
    setInterval(() => {
      peers = livePeers(peers, Date.now());
      syncPopped();
    }, 3000);
  } else {
    snap = changedKeys({}, settings.peek() as any).snap;
    send({ t: "here", id: POP_WIN ?? "" });
    setInterval(() => send({ t: "here", id: POP_WIN ?? "" }), 3000);
    window.addEventListener("beforeunload", () => send({ t: "bye", id: POP_WIN ?? "" }));
    setDockImpl((id, arg) => send({ t: "dock", id, arg }));
    // 0.8.2 integration: centre windows / layer settings / floating panels opened from inside this
    // pop-out open in the main window (registered by winreg.tsx after this module loaded)
    setTimeout(() => {
      effect(() => {
        const open: [string, any][] = [];
        for (const [id, p] of POPPERS) {
          if (id === POP_WIN || !/^[cof]:/.test(id) || p.hideWhenPopped || !p.isOpen()) continue;
          open.push([id, untracked(() => p.arg?.())]);
        }
        if (!open.length) return;
        queueMicrotask(() => {
          for (const [id, arg] of open) {
            POPPERS.get(id)?.close();
            send({ t: "open", id, arg });
          }
        });
      });
    }, 0);
  }
  effect(() => {
    void settings.value;
    if (applying) return;
    clearTimeout(timer);
    timer = window.setTimeout(flush, 120);
  });
}
