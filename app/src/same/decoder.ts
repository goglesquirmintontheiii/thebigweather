// Streaming EAS SAME decoder: AFSK demodulation (520.83 baud, mark 2083.3 Hz / space 1562.5 Hz),
// bit-clock recovery, byte framing on the 0xAB preamble, 3-burst majority vote, NNNN end of
// message, and attention-tone detection (NWR 1050 Hz, EAS 853 + 960 Hz).

import { parseHeader, type SameHeader } from "./parse";
import { toneRatio, energyOf } from "./dsp";

export const BAUD = 520.8333333;
export const MARK = 2083.3333333;
export const SPACE = 1562.5;

export type SameEvent =
  | { type: "header"; t: number; raw: string; header: SameHeader | null; copies: number }
  | { type: "eom"; t: number; copies: number }
  | { type: "tone-start"; t: number; kind: "nwr" | "eas" }
  | { type: "tone-end"; t: number; kind: "nwr" | "eas"; duration: number };

const KI = 0.006;

/** Bits → bursts of characters. */
class AfskDemod {
  private N: number;
  private ring: Float64Array; // 5 values per sample: mI mQ sI sQ x²
  private ri = 0;
  private sum = new Float64Array(5);
  private phM = 0;
  private phS = 0;
  private dM: number;
  private dS: number;
  private bitPh = 0;
  private bitStep: number;
  private fAdj = 0; // bit-clock frequency correction (PI loop integrator)
  private prevD = 0;
  private qAcc = 0;
  private qN = 0;
  private n = 0;
  // framing
  private shift = 0;
  private good = 0;
  private synced = false;
  private bitCount = 0;
  private bad = 0;
  private msg = "";
  private msgT = 0;

  constructor(
    private fs: number,
    private onBurst: (text: string, t: number) => void,
  ) {
    this.N = Math.round(fs / BAUD);
    this.ring = new Float64Array(this.N * 5);
    this.dM = (2 * Math.PI * MARK) / fs;
    this.dS = (2 * Math.PI * SPACE) / fs;
    this.bitStep = BAUD / fs;
  }

  push(x: Float32Array, t0: number) {
    const { N, ring, sum } = this;
    const halfN = N / 2;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const o = this.ri * 5;
      const a0 = v * Math.cos(this.phM);
      const a1 = v * Math.sin(this.phM);
      const a2 = v * Math.cos(this.phS);
      const a3 = v * Math.sin(this.phS);
      const a4 = v * v;
      sum[0] += a0 - ring[o];
      sum[1] += a1 - ring[o + 1];
      sum[2] += a2 - ring[o + 2];
      sum[3] += a3 - ring[o + 3];
      sum[4] += a4 - ring[o + 4];
      ring[o] = a0;
      ring[o + 1] = a1;
      ring[o + 2] = a2;
      ring[o + 3] = a3;
      ring[o + 4] = a4;
      if (++this.ri === N) this.ri = 0;
      this.phM += this.dM;
      if (this.phM > 2 * Math.PI) this.phM -= 2 * Math.PI;
      this.phS += this.dS;
      if (this.phS > 2 * Math.PI) this.phS -= 2 * Math.PI;
      if (++this.n % 65536 === 0) {
        // cancel running-sum drift
        sum.fill(0);
        for (let j = 0; j < ring.length; j++) sum[j % 5] += ring[j];
      }
      const em = sum[0] * sum[0] + sum[1] * sum[1];
      const es = sum[2] * sum[2] + sum[3] * sum[3];
      const tot = em + es;
      const d = (em - es) / (tot + 1e-20);
      const q = tot / (sum[4] * halfN + 1e-20);
      this.qAcc += q;
      this.qN++;
      // clock recovery: zero crossings of the discriminator belong half a bit after sampling
      if ((d > 0) !== (this.prevD > 0) && q > 0.2) {
        const err = this.bitPh - 0.5;
        this.bitPh -= err * (this.synced ? 0.12 : 0.3);
        this.fAdj = Math.max(-0.04, Math.min(0.04, this.fAdj - err * KI));
      } else if (q < 0.1) this.fAdj *= 0.9995;
      this.prevD = d;
      this.bitPh += this.bitStep * (1 + this.fAdj);
      if (this.bitPh >= 1) {
        this.bitPh -= 1;
        const qm = this.qAcc / this.qN;
        this.qAcc = 0;
        this.qN = 0;
        this.bit(d > 0 ? 1 : 0, Math.min(q, qm), t0 + i / this.fs);
      }
    }
  }

  private bit(b: number, q: number, t: number) {
    this.shift = ((this.shift >> 1) | (b << 7)) & 0xff;
    const carrier = q > 0.3;
    if (!this.synced) {
      this.good = carrier ? this.good + 1 : 0;
      if (this.good >= 8 && this.shift === 0xab) {
        this.synced = true;
        this.bitCount = 0;
        this.bad = 0;
        this.msg = "";
        this.msgT = t;
      }
      return;
    }
    this.bad = carrier ? 0 : this.bad + 1;
    if (this.bad >= 6) return this.end();
    if (++this.bitCount < 8) return;
    this.bitCount = 0;
    const c = this.shift;
    if (!this.msg && c === 0xab) return; // still in the preamble
    if (c < 0x20 || c > 0x7e) return this.end();
    if (!this.msg) this.msgT = t;
    this.msg += String.fromCharCode(c);
    if (this.msg.length === 4 && !looks(this.msg)) {
      this.msg = "";
      this.synced = false;
      this.good = 0;
      return;
    }
    if (this.msg.length >= 268) this.end();
  }

  private end() {
    if (this.msg.length >= 4) this.onBurst(this.msg, this.msgT);
    this.msg = "";
    this.synced = false;
    this.good = 0;
  }
}

/** Accept a burst start with at most one bad character. */
function looks(s: string): "ZCZC" | "NNNN" | null {
  const diff = (a: string) => [...a].filter((ch, i) => s[i] !== ch).length;
  if (diff("ZCZC") <= 1) return "ZCZC";
  if (diff("NNNN") <= 1) return "NNNN";
  return null;
}

/** Character-wise majority vote over up to 3 copies. */
export function vote(copies: string[]): string {
  if (copies.length === 1) return copies[0];
  const len = Math.max(...copies.map((c) => c.length));
  let out = "";
  for (let i = 0; i < len; i++) {
    const cnt = new Map<string, number>();
    for (const c of copies) if (i < c.length) cnt.set(c[i], (cnt.get(c[i]) ?? 0) + 1);
    let best = copies[0][i] ?? "";
    let bn = 0;
    for (const [ch, n] of cnt) if (n > bn) (best = ch), (bn = n);
    out += best;
  }
  return out;
}

class ToneDetector {
  private blk: number;
  private buf: Float32Array;
  private bn = 0;
  private kind: "nwr" | "eas" | null = null;
  private onCount = 0;
  private offCount = 0;
  private cand: "nwr" | "eas" | null = null;
  private start = 0;
  constructor(
    private fs: number,
    private emit: (e: SameEvent) => void,
  ) {
    this.blk = Math.round(fs * 0.025);
    this.buf = new Float32Array(this.blk);
  }
  active() {
    return this.kind;
  }
  push(x: Float32Array, t0: number) {
    for (let i = 0; i < x.length; i++) {
      this.buf[this.bn++] = x[i];
      if (this.bn === this.blk) {
        this.bn = 0;
        this.block(t0 + (i + 1) / this.fs);
      }
    }
  }
  private block(t: number) {
    const { buf, blk, fs } = this;
    const e = energyOf(buf, 0, blk);
    let k: "nwr" | "eas" | null = null;
    if (e / blk > 1e-6) {
      const r1050 = toneRatio(buf, 0, blk, fs, 1050, e);
      const r853 = toneRatio(buf, 0, blk, fs, 853, e);
      const r960 = toneRatio(buf, 0, blk, fs, 960, e);
      // lower thresholds once a tone is running (hysteresis)
      const h = this.kind ? 0.6 : 1;
      if (r1050 > 0.35 * h && r853 < 0.1 && r960 < 0.1) k = "nwr";
      else if (r853 > 0.1 * h && r960 > 0.1 * h && r853 + r960 > 0.3 * h) k = "eas";
    }
    const dt = blk / fs;
    if (!this.kind) {
      if (k && k === this.cand) this.onCount++;
      else (this.cand = k), (this.onCount = k ? 1 : 0);
      if (this.onCount >= 8) {
        this.kind = k;
        this.start = t - 8 * dt;
        this.offCount = 0;
        this.emit({ type: "tone-start", t: this.start, kind: k! });
      }
    } else if (k === this.kind) this.offCount = 0;
    else if (++this.offCount >= 4) {
      const end = t - 4 * dt;
      this.emit({ type: "tone-end", t: end, kind: this.kind, duration: end - this.start });
      this.kind = null;
      this.cand = null;
      this.onCount = 0;
    }
  }
}

export class SameDecoder {
  private demod: AfskDemod;
  private tones: ToneDetector;
  private t = 0;
  private group: { kind: "ZCZC" | "NNNN"; copies: string[]; t: number; last: number } | null = null;
  private lastHeader = { raw: "", t: -1e9 };
  private lastEom = -1e9;

  constructor(
    public fs: number,
    private emit: (e: SameEvent) => void,
    private now: () => Date = () => new Date(),
  ) {
    this.demod = new AfskDemod(fs, (s, t) => this.burst(s, t));
    this.tones = new ToneDetector(fs, emit);
  }

  /** Seconds of audio processed. */
  get time() {
    return this.t;
  }
  get tone() {
    return this.tones.active();
  }

  push(x: Float32Array) {
    this.demod.push(x, this.t);
    this.tones.push(x, this.t);
    this.t += x.length / this.fs;
    if (this.group && this.t - this.group.last > 4.5) this.flush();
  }

  /** Force out a partially received group (e.g. at end of a test clip). */
  finish() {
    this.flush();
  }

  private burst(s: string, t: number) {
    const kind = looks(s);
    if (!kind) return;
    if (this.group && (this.group.kind !== kind || t - this.group.last > 4.5)) this.flush();
    if (!this.group) this.group = { kind, copies: [], t, last: t };
    this.group.copies.push(s);
    this.group.last = t;
    if (this.group.copies.length >= 3) this.flush();
  }

  private flush() {
    const g = this.group;
    this.group = null;
    if (!g) return;
    if (g.kind === "NNNN") {
      if (g.t - this.lastEom < 10) return;
      this.lastEom = g.t;
      this.emit({ type: "eom", t: g.t, copies: g.copies.length });
      return;
    }
    const now = this.now();
    let raw = vote(g.copies);
    let header = parseHeader(raw, now);
    if (!header) {
      // two disagreeing copies: take whichever parses
      for (const c of g.copies) {
        const h = parseHeader(c, now);
        if (h) {
          header = h;
          raw = c;
          break;
        }
      }
    }
    const key = header?.raw ?? raw;
    if (key === this.lastHeader.raw && g.t - this.lastHeader.t < 15) return;
    this.lastHeader = { raw: key, t: g.t };
    this.emit({ type: "header", t: g.t, raw: header?.raw ?? raw.replace(/[^\x20-\x7e]/g, "?"), header, copies: g.copies.length });
  }
}
