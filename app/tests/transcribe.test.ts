// Transcription plumbing with a fake transcriber: VAD/tone gating, chunking, overlap de-dupe.
import assert from "node:assert/strict";
import { Chunker, TranscriptSession, dedupe, cleanText, conditionAudio, buildPrompt, stripPromptEcho, looksLooped, RATE, type Transcriber } from "../src/transcribe/core";
import { encodeSame } from "../src/same/encoder";
import { buildHeader } from "../src/same/parse";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** Speech-like: noise bursts with a voiced 120–220 Hz buzz, amplitude-modulated at syllable rate. */
function speech(sec: number, seed = 1): Float32Array {
  const r = rng(seed);
  const x = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    const f0 = 150 + 50 * Math.sin(2 * Math.PI * 0.7 * t);
    x[i] = env * (0.15 * Math.sign(Math.sin(2 * Math.PI * f0 * t)) * 0.5 + 0.05 * r());
  }
  return x;
}
const silence = (sec: number, lvl = 0.0005, seed = 2) => {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round(sec * RATE) }, () => lvl * r());
};
const cat = (...a: Float32Array[]) => {
  const o = new Float32Array(a.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of a) o.set(x, k), (k += x.length);
  return o;
};
const feed = (c: Chunker, x: Float32Array, blk = 1024) => {
  const out = [];
  for (let i = 0; i < x.length; i += blk) out.push(...c.push(x.subarray(i, i + blk)));
  return out;
};

export function testSilenceSkipped() {
  const c = new Chunker();
  assert.equal(feed(c, silence(60)).length, 0);
}

export function testToneAndSameSkipped() {
  const c = new Chunker();
  const hdr = buildHeader({ event: "RWT", locations: ["040000"], purge: "0015" });
  const x = encodeSame({ fs: RATE, header: hdr, tone: "nwr", toneSec: 9, eom: true, amp: 0.4 });
  assert.equal(feed(c, x).length, 0);
  const c2 = new Chunker();
  assert.equal(feed(c2, encodeSame({ fs: RATE, header: hdr, tone: "eas", toneSec: 9, amp: 0.4 })).length, 0);
}

export function testChunkingAtPausesAndMax() {
  const c = new Chunker({ maxSec: 8, minSec: 3, overlapSec: 1.5 });
  // 4 s speech, 1 s pause, 20 s continuous speech
  const ch = feed(c, cat(silence(2), speech(4, 3), silence(1), speech(20, 4)));
  assert.ok(ch.length >= 3, `chunks ${ch.length}`);
  for (const k of ch) assert.ok(k.end - k.start <= 8.05, `len ${k.end - k.start}`);
  // first cut happens at the pause, not at 8 s
  assert.ok(ch[0].end < 7.5, `first end ${ch[0].end}`);
  // continuous-speech chunks overlap by ~1.5 s
  const lasts = ch.slice(1);
  for (let i = 1; i < lasts.length; i++) assert.ok(Math.abs(lasts[i - 1].end - lasts[i].start - 1.5) < 0.05, `overlap ${lasts[i - 1].end - lasts[i].start}`);
}

export function testDedupe() {
  assert.equal(dedupe("the national weather service in norman has issued a", "has issued a tornado warning for"), "tornado warning for");
  assert.equal(dedupe("Tornado warning for Cleveland County.", "cleveland county, until 5:45 PM."), "until 5:45 PM.");
  // one word different at the seam
  assert.equal(dedupe("winds of 60 miles per hour and", "of 60 mile per hour and quarter size hail"), "quarter size hail");
  assert.equal(dedupe("", "hello there"), "hello there");
  assert.equal(dedupe("completely different words", "nothing in common here"), "nothing in common here");
}

export function testClean() {
  assert.equal(cleanText(" [BLANK_AUDIO] "), "");
  assert.equal(cleanText("(music) Thank you."), "");
  assert.equal(cleanText("♪ The forecast for tonight ♪"), "The forecast for tonight");
  assert.equal(cleanText("this is a test. this is a test. this is a test. this is a test."), "this is a test.");
}

export async function testSessionWithFakeTranscriber() {
  const script = ["The National Weather Service in Norman has issued", "has issued a tornado warning for Cleveland County", "Cleveland County until 5:45 PM. [BLANK_AUDIO]"];
  let calls = 0;
  const fake: Transcriber = {
    async transcribe(pcm) {
      assert.ok(pcm.length > RATE && pcm.length <= 8 * RATE + 1024);
      await new Promise((r) => setTimeout(r, 5));
      return script[calls++] ?? "";
    },
  };
  const lines: string[] = [];
  const s = new TranscriptSession(fake, (l) => lines.push(l.text), undefined, { maxQueue: 10, maxSec: 8, minSec: 3, overlapSec: 1.5 });
  const x = cat(speech(20, 9), silence(2));
  for (let i = 0; i < x.length; i += 4096) s.push(x.subarray(i, i + 4096));
  await s.stop(true);
  assert.equal(calls, 3, `calls ${calls}`);
  assert.deepEqual(lines, ["The National Weather Service in Norman has issued", "a tornado warning for Cleveland County", "until 5:45 PM."]);
}

export async function testSessionDropsWhenBehind() {
  let n = 0;
  const slow: Transcriber = { transcribe: () => new Promise((r) => setTimeout(() => r(`chunk ${++n} words`), 30)) };
  const s = new TranscriptSession(slow, () => {}, undefined, { maxQueue: 1 });
  const x = speech(60, 5);
  for (let i = 0; i < x.length; i += 8000) s.push(x.subarray(i, i + 8000)); // all at once: model is "slow"
  await s.stop(true);
  assert.ok(s.dropped > 0, "dropped");
  assert.ok(n <= 4, `ran ${n}`);
}

// ---------- p7 ----------

export function testDefaultChunksLongerWithOverlap() {
  const c = new Chunker();
  const ch = feed(c, cat(silence(1), speech(40, 7)));
  assert.ok(ch.length >= 2, `chunks ${ch.length}`);
  for (const k of ch) assert.ok(k.end - k.start <= 15.05 && k.end - k.start >= 7.9, `len ${k.end - k.start}`);
  for (let i = 1; i < ch.length; i++) assert.ok(Math.abs(ch[i - 1].end - ch[i].start - 2) < 0.05, `overlap ${ch[i - 1].end - ch[i].start}`);
}

export function testDefaultCutsAtPauseAfterMin() {
  const c = new Chunker();
  const ch = feed(c, cat(speech(10, 3), silence(1.2), speech(10, 4), silence(2)));
  assert.ok(ch[0].end > 9.5 && ch[0].end < 11.5, `first end ${ch[0].end}`);
}

export function testConditionAudio() {
  // quiet speech + 60 Hz hum + 6 kHz whine: hum/whine removed, speech level normalised
  const n = RATE * 2;
  const sp = speech(2, 11);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.05 * sp[i] + 0.2 * Math.sin((2 * Math.PI * 60 * i) / RATE) + 0.1 * Math.sin((2 * Math.PI * 6000 * i) / RATE);
  const y = conditionAudio(x);
  assert.equal(y.length, n);
  const tone = (a: Float32Array, f: number) => {
    let re = 0, im = 0;
    for (let i = RATE / 2; i < a.length; i++) (re += a[i] * Math.cos((2 * Math.PI * f * i) / RATE)), (im += a[i] * Math.sin((2 * Math.PI * f * i) / RATE));
    return Math.hypot(re, im) / (a.length - RATE / 2);
  };
  const rel = (f: number) => tone(y, f) / tone(y, 300) / (tone(x, f) / tone(x, 300));
  assert.ok(rel(60) < 0.2, `60 Hz rel ${rel(60)}`);
  assert.ok(rel(6000) < 0.1, `6 kHz rel ${rel(6000)}`);
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1 && peak > 0.1, `peak ${peak}`);
  assert.ok(Number.isFinite(conditionAudio(new Float32Array(100))[0]));
}

export function testPromptHelpers() {
  const p = buildPrompt(["Cleveland", "McClain", "Cleveland"]);
  assert.ok(p.startsWith("National Weather Service"));
  assert.ok(p.endsWith("Cleveland, McClain"));
  assert.equal(stripPromptEcho("Severe Thunderstorm Warning, Flash Flood Warning", p), "");
  assert.equal(stripPromptEcho("A tornado warning for Cleveland County until 5 PM", p), "A tornado warning for Cleveland County until 5 PM");
  assert.ok(looksLooped("the the the the the the the the the the the the the"));
  assert.ok(!looksLooped("the national weather service in norman has issued a tornado warning for"));
}

export async function testSessionPassesPromptAndConditionedAudio() {
  let got: string | undefined;
  let peak = 0;
  const fake: Transcriber = {
    async transcribe(pcm, prompt) {
      got = prompt;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      return "hello world";
    },
  };
  const s = new TranscriptSession(fake, () => {}, undefined, { maxQueue: 10 });
  s.prompt = () => buildPrompt(["Logan"]);
  const x = speech(12, 3).map((v) => v * 0.1);
  for (let i = 0; i < x.length; i += 4096) s.push(x.subarray(i, i + 4096));
  await s.stop(true);
  assert.ok(got?.includes("Logan"));
  assert.ok(peak > 0.05, `AGC raised quiet audio (peak ${peak})`);
}
