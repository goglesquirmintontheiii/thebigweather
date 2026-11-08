// 0.8.2: MIDI controllers (Web MIDI). Off by default (MIDI tab). Buttons / pads run command
// palette commands (change product, toggle layers, pane layouts, play/pause, frames, radars …);
// knobs / faders drive opacity, frame scrub, zoom, loop speed, rotation. Mappings are per device.

import { signal, effect } from "@preact/signals";
import { settings, update, toast } from "../store";
import { frameIndex, frameCount, playing, stepFrame, FPS_STEPS } from "../anim";
import { mapRef } from "../map/mapview";
import { buildItems } from "../ui/CommandPalette";
import { parseMidi, ctlKey, isCont, isPress, contInput, lerp, MIDI_DEFAULTS, CONT_ACTIONS, EXTRA_ACTIONS, type MidiMsg, type MidiMap, type MidiSettings } from "./midicore";

export type MidiState = "off" | "asking" | "on" | "unsupported" | "denied";
export const midiState = signal<MidiState>("off");
export const midiError = signal("");
export interface MidiDev {
  key: string;
  name: string;
  connected: boolean;
}
export const midiInputs = signal<MidiDev[]>([]);
/** last control seen per device (activity dot) */
export const midiActivity = signal<Record<string, number>>({});
/** Learn: waiting for a control (the next one pressed / moved is captured into `learned`) */
export const learning = signal(false);
export const learned = signal<{ dev: string; ctl: string; msg: MidiMsg } | null>(null);

export const midiCfg = (): MidiSettings => ({ ...MIDI_DEFAULTS, ...(settings.value.midi ?? {}) });
export function setMidi(fn: (m: MidiSettings) => MidiSettings) {
  update((s) => (s.midi = fn({ ...MIDI_DEFAULTS, ...(s.midi ?? {}) })));
}

let access: MIDIAccess | null = null;
const devKey = (i: MIDIInput) => [i.manufacturer, i.name].filter(Boolean).join(" ").trim() || i.id;
const prevVal = new Map<string, number>();

function refresh() {
  if (!access) return (midiInputs.value = []);
  const list: MidiDev[] = [];
  access.inputs.forEach((i) => {
    list.push({ key: devKey(i), name: i.name || devKey(i), connected: i.state === "connected" });
    i.onmidimessage = (e) => onMessage(devKey(i), e.data);
  });
  midiInputs.value = list;
}

async function start() {
  if (access) return;
  const nav = navigator as any;
  if (typeof nav.requestMIDIAccess !== "function") return void (midiState.value = "unsupported");
  midiState.value = "asking";
  try {
    access = await nav.requestMIDIAccess({ sysex: false });
    if (!midiCfg().on) return stop(); // turned off while asking
    access!.onstatechange = refresh;
    refresh();
    midiState.value = "on";
    midiError.value = "";
  } catch (e: any) {
    access = null;
    midiState.value = "denied";
    midiError.value = e?.message ?? String(e);
  }
}
function stop() {
  if (access) {
    access.inputs.forEach((i) => (i.onmidimessage = null));
    access.onstatechange = null;
  }
  access = null;
  midiInputs.value = [];
  learning.value = false;
  if (midiState.peek() !== "unsupported") midiState.value = "off";
}

effect(() => {
  const on = !!settings.value.midi?.on;
  if (typeof window === "undefined") return;
  if (on) void start();
  else stop();
});

function onMessage(dev: string, data: Uint8Array | null) {
  const m = data && parseMidi(data);
  if (!m) return;
  const key = ctlKey(m);
  midiActivity.value = { ...midiActivity.peek(), [dev]: Date.now() };
  const pk = `${dev}|${key}`;
  const prev = prevVal.get(pk);
  prevVal.set(pk, m.val);
  if (learning.peek()) {
    if (m.kind === "note" && !m.on) return; // wait for a press, not the release
    learning.value = false;
    learned.value = { dev, ctl: key, msg: m };
    return;
  }
  const maps = settings.peek().midi?.devices?.[dev];
  const map = maps?.find((x) => x.ctl === key);
  if (!map) return;
  if (isCont(map.action)) return queueCont(map, m);
  if (isPress(m, prev)) runAction(map);
}

// ---------- button actions ----------
export function runAction(map: Pick<MidiMap, "action" | "label">) {
  const a = map.action;
  const map0 = mapRef.value;
  try {
    if (a === "midi:zoomin") return void map0?.zoomIn();
    if (a === "midi:zoomout") return void map0?.zoomOut();
    if (a === "midi:first" || a === "midi:last") {
      playing.value = false;
      frameIndex.value = a === "midi:first" ? 0 : Math.max(0, frameCount.value - 1);
      return;
    }
    const it = buildItems().find((x) => x.id === a);
    if (!it) return toast(`MIDI: “${map.label}” isn't available now`, "warn", 2000);
    it.run();
  } catch (e: any) {
    toast(`MIDI: ${e?.message ?? e}`, "error");
  }
}

// ---------- knob / fader actions (coalesced: one update per ~16 ms) ----------
const pending = new Map<string, { abs?: number; delta: number }>();
let raf = 0;
function queueCont(map: MidiMap, m: MidiMsg) {
  const v = contInput(m, map);
  if (v.abs === undefined && !v.delta) return;
  const p = pending.get(map.action) ?? { delta: 0 };
  if (v.abs !== undefined) (p.abs = v.abs), (p.delta = 0);
  else p.delta += v.delta ?? 0;
  pending.set(map.action, p);
  raf ||= window.setTimeout(flush, 16); // not rAF: it stalls while the map renders slowly / is hidden
}
function flush() {
  raf = 0;
  for (const [a, p] of pending) applyCont(a, p);
  pending.clear();
}
export function applyCont(a: string, p: { abs?: number; delta: number }) {
  const map = mapRef.value;
  const s = settings.peek();
  const radar = s.weather.kind === "radar";
  switch (a) {
    case "cont:opacity": {
      const cur = radar ? s.radar.opacity : s.grid.opacity;
      const v = Math.round(Math.max(0.1, Math.min(1, p.abs !== undefined ? lerp(0.1, 1, p.abs) : cur + p.delta * 0.02)) * 100) / 100;
      if (v !== cur) update((x) => (radar ? (x.radar.opacity = v) : (x.grid.opacity = v)));
      return;
    }
    case "cont:frame": {
      const n = frameCount.peek();
      if (!n) return;
      if (p.abs !== undefined) {
        playing.value = false;
        frameIndex.value = Math.round(p.abs * (n - 1));
      } else if (p.delta) stepFrame(Math.sign(p.delta) * Math.min(Math.abs(p.delta), n));
      return;
    }
    case "cont:zoom":
      if (!map) return;
      map.jumpTo({ zoom: p.abs !== undefined ? lerp(2, 16, p.abs) : map.getZoom() + p.delta * 0.1 });
      return;
    case "cont:rotate":
      if (!map) return;
      map.jumpTo({ bearing: p.abs !== undefined ? lerp(-180, 180, p.abs) : map.getBearing() + p.delta * 2 });
      return;
    case "cont:speed": {
      const i0 = Math.max(0, FPS_STEPS.indexOf(s.anim.fps));
      const i = p.abs !== undefined ? Math.round(p.abs * (FPS_STEPS.length - 1)) : Math.max(0, Math.min(FPS_STEPS.length - 1, i0 + Math.sign(p.delta)));
      if (FPS_STEPS[i] !== s.anim.fps) update((x) => (x.anim.fps = FPS_STEPS[i]));
      return;
    }
  }
}

/** every action a control can be mapped to: the command palette's commands, layers, weather layers,
 *  panels, toggles, radars, points, workspaces, plus the knob actions and a few extras */
export function allActions(range: boolean): { id: string; label: string; hint: string }[] {
  const out: { id: string; label: string; hint: string }[] = [];
  if (range) for (const c of CONT_ACTIONS) out.push({ id: c.id, label: c.name, hint: c.hint });
  for (const c of EXTRA_ACTIONS) out.push({ id: c.id, label: c.name, hint: c.hint });
  const CAT: Record<string, string> = { command: "Command", layer: "Layer", weather: "Weather layer", panel: "Panel", setting: "Setting", site: "Radar", point: "My point", workspace: "Workspace" };
  for (const it of buildItems()) if (CAT[it.cat]) out.push({ id: it.id, label: it.label, hint: `${CAT[it.cat]}${it.hint ? ` · ${it.hint}` : ""}` });
  return out;
}

(window as any).__tbwMidi = { midiState, midiInputs, learning, learned, onMessage, applyCont, runAction };
