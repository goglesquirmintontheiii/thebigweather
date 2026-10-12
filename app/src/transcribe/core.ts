// Transcription plumbing that doesn't depend on the model: speech gating (energy VAD that ignores
// SAME bursts and attention tones), overlapping chunking, de-duplication of the overlap, and a
// session that feeds an injectable Transcriber one chunk at a time.

import { toneRatio, energyOf } from "../same/dsp";

export const RATE = 16000;

export interface Transcriber {
  transcribe(pcm: Float32Array): Promise<string>;
}

export interface Chunk {
  pcm: Float32Array;
  /** seconds since the session started */
  start: number;
  end: number;
  speech: number; // fraction of frames with speech
}

export interface ChunkerOpts {
  maxSec?: number; // hard chunk length
  minSec?: number; // earliest cut at a pause
  overlapSec?: number;
  pauseSec?: number;
  minSpeech?: number; // fraction of speech frames to bother transcribing
}

const FRAME = 320; // 20 ms
const TONES = [1050, 853, 960, 1562.5, 2083.3];

/** Per-frame speech flag: loud enough over the tracked noise floor and not a pure tone. */
export class Vad {
  floor = 0.002;
  private hang = 0;
  isTone(x: Float32Array, off: number, e: number): boolean {
    const r = TONES.map((f) => toneRatio(x, off, FRAME, RATE, f, e));
    // attention tones (1050, 853 + 960) or SAME AFSK (1562.5 / 2083.3 alternating within a frame)
    return r[0] > 0.4 || r[1] + r[2] > 0.4 || r[3] + r[4] > 0.3 || Math.max(...r) > 0.4;
  }
  frame(x: Float32Array, off: number): { speech: boolean; tone: boolean } {
    const e = energyOf(x, off, FRAME);
    const rms = Math.sqrt(e / FRAME);
    let tone = rms > 0.003 && this.isTone(x, off, e);
    // a few frames of hangover so tone edges don't count as speech
    if (tone) this.hang = 4;
    else if (this.hang > 0 && rms > 0.003) (this.hang--, (tone = true));
    // floor follows quiet frames quickly and loud ones slowly
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.999 + rms * 0.001;
    this.floor = Math.max(this.floor, 1e-4);
    return { speech: !tone && rms > Math.max(0.006, this.floor * 2.5), tone };
  }
}

/** Collects 16 kHz audio and cuts overlapping chunks at pauses (or at maxSec). Tone/SAME frames are zeroed. */
export class Chunker {
  private buf = new Float32Array(RATE * 40);
  private n = 0;
  private flags: boolean[] = []; // speech per complete frame in buf
  private part = 0; // samples of buf already classified
  private t0 = 0; // session time of buf[0]
  private vad = new Vad();
  private o: Required<ChunkerOpts>;
  constructor(opts: ChunkerOpts = {}) {
    this.o = { maxSec: 8, minSec: 3, overlapSec: 1.5, pauseSec: 0.6, minSpeech: 0.12, ...opts };
  }

  push(x: Float32Array): Chunk[] {
    const out: Chunk[] = [];
    let i = 0;
    while (i < x.length) {
      const take = Math.min(x.length - i, this.buf.length - this.n);
      this.buf.set(x.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      while (this.part + FRAME <= this.n) {
        const f = this.vad.frame(this.buf, this.part);
        if (f.tone) this.buf.fill(0, this.part, this.part + FRAME);
        this.flags.push(f.speech);
        this.part += FRAME;
        const c = this.maybeCut();
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** Emit whatever speech is buffered (e.g. when stopping). */
  flush(): Chunk | null {
    const c = this.cut(this.part, true);
    return c;
  }

  private maybeCut(): Chunk | null {
    const { maxSec, minSec, pauseSec } = this.o;
    const sec = this.part / RATE;
    const fl = this.flags;
    const pauseFrames = Math.round((pauseSec * RATE) / FRAME);
    // leading silence never needs to be kept beyond the overlap
    if (!fl.some((f) => f) && sec > this.o.overlapSec + 0.5) return this.cut(this.part, false);
    if (sec >= maxSec) return this.cut(this.part, true);
    if (sec >= minSec && fl.length > pauseFrames && fl.slice(-pauseFrames).every((f) => !f)) return this.cut(this.part, true);
    return null;
  }

  private cut(at: number, emit: boolean): Chunk | null {
    const fl = this.flags;
    const speech = fl.length ? fl.filter((f) => f).length / fl.length : 0;
    let c: Chunk | null = null;
    if (emit && at > 0 && speech >= this.o.minSpeech) c = { pcm: this.buf.slice(0, at), start: this.t0, end: this.t0 + at / RATE, speech };
    // keep the tail as overlap for the next chunk (unless we just cut at a pause: nothing to repeat)
    const pausedTail = fl.length > 5 && fl.slice(-5).every((f) => !f);
    const keep = c && !pausedTail ? Math.min(at, Math.round(this.o.overlapSec * RATE)) : c ? 0 : Math.min(at, Math.round(0.3 * RATE));
    const keepFrom = at - keep;
    this.buf.copyWithin(0, keepFrom, this.n);
    this.n -= keepFrom;
    this.part -= keepFrom;
    this.flags = fl.slice(fl.length - Math.round(keep / FRAME));
    this.t0 += keepFrom / RATE;
    return c;
  }
}

// ---------- text ----------

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Whisper's usual noise on music / silence / tones. */
export function cleanText(t: string): string {
  let s = t
    .replace(/\[[^\]]*\]|\([^)]*\)|♪+|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(thank you|thanks for watching|you|bye|\.+|okay)[.!]?$/i.test(s)) return "";
  // collapse a phrase repeated 3+ times (decoder loops)
  s = s.replace(/(\b.{6,80}?)(?:\s*\1){2,}/g, "$1");
  return s;
}

/**
 * Remove from `next` the words that repeat the end of `prev` (chunks overlap ~1.5 s, so the first
 * few words of a chunk usually repeat the last few of the previous one, give or take a word).
 */
export function dedupe(prev: string, next: string): string {
  const a = prev.split(/\s+/).filter(Boolean);
  const bWords = next.split(/\s+/).filter(Boolean);
  const A = a.slice(-14).map(norm);
  const B = bWords.map(norm);
  let best = 0;
  let bestScore = 0;
  for (let k = Math.min(A.length, B.length, 14); k >= 1; k--) {
    // tail of A (length k) vs head of B (length k): allow one mismatch for k >= 4
    let same = 0;
    for (let i = 0; i < k; i++) if (A[A.length - k + i] === B[i] && B[i]) same++;
    const ok = same === k || (k >= 4 && same >= k - 1);
    if (ok && same > bestScore) {
      best = k;
      bestScore = same;
    }
  }
  // also catch overlap where whisper dropped/added a word at the seam: head of B found inside tail of A
  if (!best && B.length >= 3) {
    const tail = A.join(" ");
    for (let k = Math.min(B.length, 8); k >= 3; k--) {
      const head = B.slice(0, k).join(" ");
      if (tail.endsWith(head) || tail.includes(" " + head + " ") || tail.startsWith(head + " ")) {
        const idx = tail.lastIndexOf(head);
        const rest = tail.slice(idx + head.length).trim();
        if (rest.split(" ").filter(Boolean).length <= 3) {
          best = k;
          break;
        }
      }
    }
  }
  return bWords.slice(best).join(" ");
}

export interface Line {
  at: number; // ms epoch
  text: string;
}

/** Glue: PCM in → chunks → transcriber (one at a time, newest wins when backed up) → lines out. */
export class TranscriptSession {
  private chunker: Chunker;
  private queue: Chunk[] = [];
  private busy = false;
  private last = "";
  private stopped = false;
  dropped = 0;
  constructor(
    private tr: Transcriber,
    private onLine: (l: Line) => void,
    private onState: (s: { busy: boolean; queued: number; error?: string }) => void = () => {},
    opts: ChunkerOpts & { maxQueue?: number } = {},
    private clock: () => number = () => Date.now(),
  ) {
    this.chunker = new Chunker(opts);
    this.maxQueue = opts.maxQueue ?? 2;
  }
  private maxQueue: number;

  push(x: Float32Array) {
    if (this.stopped) return;
    for (const c of this.chunker.push(x)) this.enqueue(c);
  }

  private enqueue(c: Chunk) {
    this.queue.push(c);
    // the model can't keep up: drop the oldest (live audio matters more than completeness)
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    this.pump();
  }

  private async pump() {
    if (this.busy || this.stopped) return;
    const c = this.queue.shift();
    if (!c) return;
    this.busy = true;
    this.onState({ busy: true, queued: this.queue.length });
    try {
      const raw = await this.tr.transcribe(c.pcm);
      const text = dedupe(this.last, cleanText(raw));
      if (text && !this.stopped) {
        this.last = (this.last + " " + text).split(/\s+/).slice(-30).join(" ");
        this.onLine({ at: this.clock(), text });
      }
      this.onState({ busy: false, queued: this.queue.length });
    } catch (e: any) {
      this.onState({ busy: false, queued: this.queue.length, error: String(e?.message ?? e) });
    }
    this.busy = false;
    if (this.queue.length) this.pump();
  }

  /** Transcribe what's buffered, then stop. */
  async stop(flush = false) {
    if (flush) {
      const c = this.chunker.flush();
      if (c) this.enqueue(c);
    }
    this.stopped = !flush;
    if (flush) {
      while (this.busy || this.queue.length) await new Promise((r) => setTimeout(r, 20));
      this.stopped = true;
    }
  }
}
