// SAME decoder tests with synthetic AFSK audio: noise, frequency and clock offsets, resampling.
import assert from "node:assert/strict";
import { SameDecoder, vote, type SameEvent } from "../src/same/decoder";
import { encodeSame } from "../src/same/encoder";
import { parseHeader, buildHeader, locationName } from "../src/same/parse";
import { Resampler } from "../src/same/dsp";

const NOW = new Date(Date.UTC(2026, 4, 20, 22, 5));
const HDR = buildHeader({ event: "TOR", locations: ["040109", "040027", "140017"], purge: "0045", issued: new Date(Date.UTC(2026, 4, 20, 22, 3)), sender: "KOUN/NWS" });

function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

function addNoise(x: Float32Array, snrDb: number, seed = 1) {
  const g = rng(seed);
  // signal power of a 0.5-amplitude sine is 0.125
  const sigma = Math.sqrt(0.125 / 10 ** (snrDb / 10));
  for (let i = 0; i < x.length; i++) x[i] += sigma * g();
  return x;
}

function decode(x: Float32Array, fs: number, block = 1000): SameEvent[] {
  const ev: SameEvent[] = [];
  const d = new SameDecoder(fs, (e) => ev.push(e), () => NOW);
  for (let i = 0; i < x.length; i += block) d.push(x.subarray(i, i + block));
  d.push(new Float32Array(fs * 5)); // let the group time out
  d.finish();
  return ev;
}

const headers = (ev: SameEvent[]) => ev.filter((e) => e.type === "header") as Extract<SameEvent, { type: "header" }>[];

export function testParse() {
  const h = parseHeader("garbageZCZC-WXR-TOR-040109-040027-140017+0045-1402203-KOUN/NWS-xx", NOW)!;
  assert.ok(h);
  assert.equal(h.event, "TOR");
  assert.equal(h.eventName, "Tornado Warning");
  assert.equal(h.level, "warning");
  assert.equal(h.orgName, "National Weather Service");
  assert.equal(h.locations.length, 3);
  assert.equal(h.locations[2].part, "Northwest");
  assert.equal(h.locations[2].fips, "40017");
  assert.equal(h.issued.toISOString(), "2026-05-20T22:03:00.000Z");
  assert.equal(h.expires.toISOString(), "2026-05-20T22:48:00.000Z");
  assert.equal(h.sender, "KOUN/NWS");
  const names: Record<string, string> = { "40109": "Oklahoma", "40017": "Canadian" };
  assert.equal(locationName(h.locations[0], (f) => names[f]), "Oklahoma Co., OK");
  assert.equal(locationName(h.locations[2], (f) => names[f]), "Northwest Canadian Co., OK");
  assert.equal(locationName({ ...h.locations[0], state: "40", county: "000", fips: "40000" }), "Oklahoma (entire state)");
  assert.equal(locationName({ code: "075712", part: "", state: "75", county: "712", fips: "75712", marine: true }), "Western Atlantic incl. Caribbean (AM) zone 712");
  // year rollover: day 365 heard on Jan 1
  const h2 = parseHeader("ZCZC-WXR-RWT-020000+0015-3652359-KXYZ/NWS-", new Date(Date.UTC(2027, 0, 1, 0, 5)))!;
  assert.equal(h2.issued.getUTCFullYear(), 2026);
  assert.equal(parseHeader("ZCZC-WXR-TOR-040109+0045-9992203-KOUN/NWS-"), null);
}

export function testVote() {
  assert.equal(vote(["ZCZC-WXR-TOR", "ZCZC-WXQ-TOR", "ZCZC-WXR-TPR"]), "ZCZC-WXR-TOR");
}

export function testCleanDecode() {
  const fs = 24000;
  const ev = decode(encodeSame({ fs, header: HDR, tone: "nwr", toneSec: 8, messageSec: 2, eom: true }), fs);
  const h = headers(ev);
  assert.equal(h.length, 1, JSON.stringify(ev));
  assert.equal(h[0].raw, HDR);
  assert.equal(h[0].copies, 3);
  assert.equal(h[0].header?.eventName, "Tornado Warning");
  const te = ev.find((e) => e.type === "tone-end") as any;
  assert.ok(te && te.kind === "nwr" && Math.abs(te.duration - 8) < 0.15, JSON.stringify(te));
  assert.equal(ev.filter((e) => e.type === "eom").length, 1);
}

export function testNoisyOffsets() {
  const fs = 24000;
  const cases = [
    { snr: 6, freqScale: 1, baudScale: 1 },
    { snr: 10, freqScale: 1.02, baudScale: 1 },
    { snr: 10, freqScale: 0.98, baudScale: 1 },
    { snr: 10, freqScale: 1, baudScale: 1.01 },
    { snr: 10, freqScale: 1, baudScale: 0.99 },
    { snr: 8, freqScale: 1.015, baudScale: 0.995 },
    { snr: 3, freqScale: 0.97, baudScale: 1.02 },
    { snr: 0, freqScale: 1.03, baudScale: 0.98 },
  ];
  for (const [k, c] of cases.entries()) {
    const x = addNoise(encodeSame({ fs, header: HDR, tone: "eas", toneSec: 3, eom: true, freqScale: c.freqScale, baudScale: c.baudScale }), c.snr, k + 7);
    const ev = decode(x, fs, 2048);
    const h = headers(ev);
    assert.equal(h.length, 1, `case ${JSON.stringify(c)}: ${JSON.stringify(ev)}`);
    assert.equal(h[0].raw, HDR, `case ${JSON.stringify(c)}`);
    const te = ev.find((e) => e.type === "tone-end") as any;
    assert.ok(te?.kind === "eas" && Math.abs(te.duration - 3) < (c.snr <= 3 ? 0.5 : 0.2), `tone ${JSON.stringify(c)} ${JSON.stringify(te)}`);
    assert.equal(ev.filter((e) => e.type === "eom").length, 1, `eom ${JSON.stringify(c)}`);
  }
}

export function testVoteRepairsBurst() {
  // one copy has a bad character in the event code; majority vote fixes it
  const fs = 24000;
  const a = encodeSame({ fs, header: HDR, eom: false, leadSec: 0.3 });
  const ev: SameEvent[] = [];
  const d = new SameDecoder(fs, (e) => ev.push(e), () => NOW);
  const bad = HDR.replace("TOR", "TQR");
  const b = encodeSame({ fs, header: bad, eom: false, leadSec: 0 });
  // splice: copy 1 from the bad clip, copies 2+3 from the good one
  const burst = Math.round(((16 + HDR.length) * 8 * fs) / 520.8333) + fs;
  d.push(a.subarray(0, Math.round(0.3 * fs)));
  d.push(b.subarray(0, burst));
  d.push(a.subarray(Math.round(0.3 * fs) + burst));
  d.push(new Float32Array(fs * 5));
  const h = headers(ev);
  assert.equal(h.length, 1, JSON.stringify(ev));
  assert.equal(h[0].header?.event, "TOR");
}

export function testResampled48k() {
  // 48 kHz audio → resampler → 24 kHz decoder, as in the app
  const x = addNoise(encodeSame({ fs: 48000, header: HDR, tone: "nwr", toneSec: 2, eom: true }), 12, 3);
  const r = new Resampler(48000, 24000);
  const y: Float32Array[] = [];
  for (let i = 0; i < x.length; i += 128 * 7) y.push(r.process(x.subarray(i, i + 128 * 7)));
  const all = new Float32Array(y.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of y) all.set(a, o), (o += a.length);
  assert.ok(Math.abs(all.length - x.length / 2) < 4);
  const h = headers(decode(all, 24000));
  assert.equal(h.length, 1);
  assert.equal(h[0].raw, HDR);
}

export function testNoFalseAlarms() {
  const fs = 24000;
  const x = addNoise(new Float32Array(fs * 60), 0, 99);
  // plus a voice-like warble
  for (let i = 0; i < x.length; i++) x[i] += 0.2 * Math.sin(2 * Math.PI * (180 + 40 * Math.sin(i / 3000)) * (i / fs));
  const ev = decode(x, fs);
  assert.equal(ev.length, 0, JSON.stringify(ev));
}
