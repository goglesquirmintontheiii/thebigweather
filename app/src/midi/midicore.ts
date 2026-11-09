// 0.8.2: MIDI controller mappings — message parsing and value maths (pure, unit-tested).
// The Web MIDI side is midi.ts; the MIDI tab (0.8.3) is MidiSection.tsx.

export type MKind = "note" | "cc" | "pc" | "pb";
export interface MidiMsg {
  kind: MKind;
  /** channel 1..16 */
  ch: number;
  /** note / controller / program number (0 for pitch bend) */
  num: number;
  /** 0..127 (pitch bend scaled to 0..127, fractional) */
  val: number;
  /** a press (note on with velocity, program change) vs a release (note off) */
  on: boolean;
}

/** one mapping: a control on a device → an action */
export interface MidiMap {
  /** control key, see ctlKey() */
  ctl: string;
  /** command palette item id ("cmd:play", "layer:…", "wx:r:REF", "site:KTLX", "cmd:layout:4" …),
   *  "cont:<id>" for a knob/fader action, or "midi:<id>" for the few extra button actions */
  action: string;
  /** label shown in Settings (the command's name when it was mapped) */
  label: string;
  /** knobs: "abs" (0..127 = whole range, default) or "rel" (endless encoder, 1..63 up / 65..127 down) */
  mode?: "abs" | "rel";
  invert?: boolean;
}
export interface MidiSettings {
  on: boolean;
  /** mappings per device (key = device name, stable across restarts) */
  devices: Record<string, MidiMap[]>;
}
export const MIDI_DEFAULTS: MidiSettings = { on: false, devices: {} };

/** knob / fader actions */
export const CONT_ACTIONS: { id: string; name: string; hint: string }[] = [
  { id: "cont:opacity", name: "Weather layer opacity", hint: "Knob / fader" },
  { id: "cont:frame", name: "Scrub loop frames", hint: "Knob / fader" },
  { id: "cont:zoom", name: "Map zoom", hint: "Knob / fader" },
  { id: "cont:speed", name: "Loop speed", hint: "Knob / fader" },
  { id: "cont:rotate", name: "Map rotation", hint: "Knob / fader" },
];
/** button actions that the command palette doesn't have */
export const EXTRA_ACTIONS: { id: string; name: string; hint: string }[] = [
  { id: "midi:zoomin", name: "Zoom in", hint: "Map" },
  { id: "midi:zoomout", name: "Zoom out", hint: "Map" },
  { id: "midi:first", name: "First frame", hint: "Loop" },
  { id: "midi:last", name: "Last frame (newest)", hint: "Loop" },
];
export const isCont = (action: string) => action.startsWith("cont:");

export function parseMidi(d: ArrayLike<number>): MidiMsg | null {
  if (!d || d.length < 1) return null;
  const st = d[0];
  if (st < 0x80 || st >= 0xf0) return null; // running status / system messages: ignored
  const t = st & 0xf0;
  const ch = (st & 0x0f) + 1;
  const a = d[1] ?? 0, b = d[2] ?? 0;
  switch (t) {
    case 0x90:
      return { kind: "note", ch, num: a, val: b, on: b > 0 };
    case 0x80:
      return { kind: "note", ch, num: a, val: 0, on: false };
    case 0xb0:
      return { kind: "cc", ch, num: a, val: b, on: b > 0 };
    case 0xc0:
      return { kind: "pc", ch, num: a, val: 127, on: true };
    case 0xe0:
      return { kind: "pb", ch, num: 0, val: (((b << 7) | a) / 16383) * 127, on: true };
  }
  return null;
}

export const ctlKey = (m: Pick<MidiMsg, "kind" | "ch" | "num">) => `${m.kind}:${m.ch}:${m.num}`;
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n: number) => `${NOTES[n % 12]}${Math.floor(n / 12) - 1}`;
/** "Note C4 · ch 1", "CC 7 · ch 1", "Program 3 · ch 2", "Pitch bend · ch 1" */
export function ctlName(key: string): string {
  const [k, ch, num] = key.split(":");
  const c = `ch ${ch}`;
  if (k === "note") return `Note ${noteName(+num)} · ${c}`;
  if (k === "cc") return `CC ${num} · ${c}`;
  if (k === "pc") return `Program ${num} · ${c}`;
  if (k === "pb") return `Pitch bend · ${c}`;
  return key;
}
/** controls that send a range of values (can drive knob / fader actions) */
export const isRangeCtl = (key: string) => key.startsWith("cc:") || key.startsWith("pb:");

/** endless encoder value → steps (two's complement around 64: 1..63 up, 65..127 down) */
export function relDelta(v: number): number {
  v = Math.round(v);
  if (v === 0 || v === 64) return 0;
  return v < 64 ? v : v - 128;
}

/** a repeat of the same high CC value this long after the last one is a new press (ms) */
export const CC_REPRESS_MS = 150;
/** does this message press a button? notes / program changes on press; a CC when it crosses 64
 *  upward (buttons that send 127 / 0), so holding or releasing doesn't repeat. 0.8.4: buttons that
 *  send only 127 (no release message) never cross 64 again: the same value after a gap (`gapMs`,
 *  ms since this control's last message) is a new press too. */
export function isPress(m: MidiMsg, prevVal: number | undefined, gapMs?: number): boolean {
  if (m.kind === "note" || m.kind === "pc") return m.on;
  if (m.kind === "cc") return m.val >= 64 && (prevVal === undefined || prevVal < 64 || (m.val === prevVal && gapMs !== undefined && gapMs >= CC_REPRESS_MS));
  return false;
}

/** knob / fader: absolute position 0..1, or relative steps */
export function contInput(m: MidiMsg, map: Pick<MidiMap, "mode" | "invert">): { abs?: number; delta?: number } {
  if (map.mode === "rel" && m.kind === "cc") {
    const d = relDelta(m.val);
    return { delta: map.invert ? -d : d };
  }
  if (m.kind === "note") {
    // a pad mapped to a knob action: press = one step up
    return m.on ? { delta: map.invert ? -1 : 1 } : {};
  }
  const v = Math.max(0, Math.min(1, m.val / 127));
  return { abs: map.invert ? 1 - v : v };
}

export interface ContPending {
  abs?: number;
  delta: number;
}
/** 0.8.4: knob / fader updates waiting to be applied, coalesced per action. The queue is emptied
 *  before anything runs and each action is isolated: an action that throws is reported and dropped,
 *  it can't stay queued and stop the others (or itself) from ever running again. */
export class ContQueue {
  private q = new Map<string, ContPending>();
  get size() {
    return this.q.size;
  }
  add(action: string, v: { abs?: number; delta?: number }) {
    const p = this.q.get(action) ?? { delta: 0 };
    if (v.abs !== undefined) (p.abs = v.abs), (p.delta = 0);
    else p.delta += v.delta ?? 0;
    this.q.set(action, p);
  }
  flush(apply: (action: string, p: ContPending) => void, onError: (action: string, e: unknown) => void) {
    const batch = [...this.q];
    this.q.clear();
    for (const [a, p] of batch) {
      try {
        apply(a, p);
      } catch (e) {
        onError(a, e);
      }
    }
  }
}

/** Which windows use MIDI: the main window runs the mapped commands. The MIDI tab popped out to its
 *  own window only needs the devices and Learn. Every other pop-out stays off, or each press would
 *  run once per window. */
export type MidiRole = "main" | "view" | "none";
export function midiRole(popoutKind: string | null | undefined, popWin?: string | null): MidiRole {
  if (!popoutKind) return "main";
  return popWin === "p:midi" ? "view" : "none";
}

/** a 0..1 position onto [lo, hi] */
export const lerp = (lo: number, hi: number, t: number) => lo + (hi - lo) * t;

/** add / replace the mapping for a control on a device */
export function setMapping(s: MidiSettings, dev: string, map: MidiMap): MidiSettings {
  const list = (s.devices[dev] ?? []).filter((m) => m.ctl !== map.ctl);
  return { ...s, devices: { ...s.devices, [dev]: [...list, map] } };
}
export function removeMapping(s: MidiSettings, dev: string, ctl: string): MidiSettings {
  const list = (s.devices[dev] ?? []).filter((m) => m.ctl !== ctl);
  const devices = { ...s.devices, [dev]: list };
  if (!list.length) delete devices[dev];
  return { ...s, devices };
}

/** simple word search over the action list (every word must match the label or hint) */
export function searchActions<T extends { label: string; hint?: string }>(items: T[], q: string, max = 60): T[] {
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return items.slice(0, max);
  const out: { it: T; sc: number }[] = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    const h = `${l} ${(it.hint ?? "").toLowerCase()}`;
    if (!ws.every((w) => h.includes(w))) continue;
    out.push({ it, sc: (l.startsWith(ws[0]) ? 2 : 0) + (ws.every((w) => l.includes(w)) ? 1 : 0) });
  }
  return out
    .sort((a, b) => b.sc - a.sc)
    .slice(0, max)
    .map((x) => x.it);
}
