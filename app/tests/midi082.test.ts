// 0.8.2: MIDI message parsing and mapping maths.
import assert from "node:assert/strict";
import { parseMidi, ctlKey, ctlName, relDelta, isPress, contInput, setMapping, removeMapping, searchActions, isRangeCtl, MIDI_DEFAULTS } from "../src/midi/midicore";

export function testParse() {
  assert.deepEqual(parseMidi([0x90, 60, 100]), { kind: "note", ch: 1, num: 60, val: 100, on: true });
  assert.equal(parseMidi([0x90, 60, 0])!.on, false, "note on with velocity 0 = release");
  assert.equal(parseMidi([0x81, 60, 40])!.on, false);
  assert.equal(parseMidi([0x81, 60, 40])!.ch, 2);
  assert.deepEqual(parseMidi([0xb3, 7, 64]), { kind: "cc", ch: 4, num: 7, val: 64, on: true });
  assert.equal(parseMidi([0xc0, 5])!.kind, "pc");
  assert.equal(Math.round(parseMidi([0xe0, 0x7f, 0x7f])!.val), 127);
  assert.equal(parseMidi([0xe0, 0, 0x40])!.val > 63, true);
  assert.equal(parseMidi([0xf8]), null, "clock ignored");
  assert.equal(parseMidi([]), null);
}

export function testNames() {
  assert.equal(ctlKey({ kind: "cc", ch: 1, num: 7 }), "cc:1:7");
  assert.equal(ctlName("note:1:60"), "Note C4 · ch 1");
  assert.equal(ctlName("cc:10:74"), "CC 74 · ch 10");
  assert.ok(isRangeCtl("cc:1:1") && isRangeCtl("pb:1:0") && !isRangeCtl("note:1:1"));
}

export function testPressAndKnobs() {
  const note = parseMidi([0x90, 36, 90])!;
  assert.ok(isPress(note, undefined));
  assert.ok(!isPress(parseMidi([0x80, 36, 0])!, 90));
  const cc = (v: number) => parseMidi([0xb0, 20, v])!;
  assert.ok(isPress(cc(127), 0), "CC button: rising edge");
  assert.ok(!isPress(cc(127), 127), "held: no repeat");
  assert.ok(!isPress(cc(0), 127), "release");
  assert.equal(relDelta(1), 1);
  assert.equal(relDelta(127), -1);
  assert.equal(relDelta(64), 0);
  assert.equal(relDelta(3), 3);
  assert.deepEqual(contInput(cc(127), {}), { abs: 1 });
  assert.deepEqual(contInput(cc(0), { invert: true }), { abs: 1 });
  assert.deepEqual(contInput(cc(126), { mode: "rel" }), { delta: -2 });
  assert.deepEqual(contInput(note, {}), { delta: 1 });
}

export function testMappings() {
  let s = setMapping(MIDI_DEFAULTS, "nanoKONTROL2", { ctl: "cc:1:0", action: "cont:opacity", label: "Opacity" });
  s = setMapping(s, "nanoKONTROL2", { ctl: "cc:1:0", action: "cont:zoom", label: "Zoom" });
  assert.equal(s.devices.nanoKONTROL2.length, 1, "one mapping per control");
  assert.equal(s.devices.nanoKONTROL2[0].action, "cont:zoom");
  assert.deepEqual(MIDI_DEFAULTS.devices, {}, "defaults untouched");
  s = removeMapping(s, "nanoKONTROL2", "cc:1:0");
  assert.equal(s.devices.nanoKONTROL2, undefined);
}

export function testSearch() {
  const items = [
    { label: "Play / pause loop", hint: "Command" },
    { label: "Radar · Reflectivity", hint: "Weather layer" },
    { label: "Panes: 2 side by side", hint: "Command" },
  ];
  assert.equal(searchActions(items, "play")[0].label, "Play / pause loop");
  assert.equal(searchActions(items, "weather refl").length, 1);
  assert.equal(searchActions(items, "").length, 3);
  assert.equal(searchActions(items, "zzz").length, 0);
}
