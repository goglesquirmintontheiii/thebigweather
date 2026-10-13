// radio/dash 0.8: audio levels for the big player's seek bar and live meter.
// The player's tap feeds PCM while the element plays; every BIN seconds of media time keeps its
// peak and RMS, keyed by the element's currentTime, so the seek bar can draw what was heard
// (like Broadcastify / an audio editor). Parts of the buffer never played have no levels yet.

export const BIN = 0.25;

export class LevelTrack {
  private peaks = new Map<number, number>();
  private rmss = new Map<number, number>();
  private bin = -1;
  private bPeak = 0;
  private bSq = 0;
  private bN = 0;
  /** live meter: latest block (linear 0..1) and a decaying peak hold */
  live = { peak: 0, rms: 0, hold: 0, holdAt: 0, t: 0 };
  /** bumps whenever stored bins change (cheap redraw check) */
  version = 0;

  feed(x: Float32Array, mediaTime: number) {
    let pk = 0;
    let sq = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      sq += v * v;
    }
    const rms = x.length ? Math.sqrt(sq / x.length) : 0;
    const now = performance.now();
    const L = this.live;
    L.peak = pk;
    L.rms = rms;
    L.t = now;
    if (pk >= L.hold || now - L.holdAt > 1500) {
      L.hold = pk;
      L.holdAt = now;
    }
    if (!Number.isFinite(mediaTime)) return;
    const b = Math.floor(mediaTime / BIN);
    if (b !== this.bin) {
      this.flush();
      this.bin = b;
    }
    if (pk > this.bPeak) this.bPeak = pk;
    this.bSq += sq;
    this.bN += x.length;
  }

  private flush() {
    if (this.bin < 0 || !this.bN) return;
    this.peaks.set(this.bin, Math.max(this.peaks.get(this.bin) ?? 0, this.bPeak));
    this.rmss.set(this.bin, Math.sqrt(this.bSq / this.bN));
    this.bPeak = this.bSq = this.bN = 0;
    this.version++;
    if (this.peaks.size > 40000) this.prune(this.bin * BIN - 2.2 * 3600);
  }

  /** forget levels before this media time (the DVR buffer dropped them) */
  prune(before: number) {
    const lim = Math.floor(before / BIN);
    for (const k of this.peaks.keys()) if (k < lim) (this.peaks.delete(k), this.rmss.delete(k));
  }

  /** [peak, rms] maxima over a media-time span, or null when nothing was heard there */
  span(t0: number, t1: number): [number, number] | null {
    const a = Math.floor(t0 / BIN);
    const b = Math.max(a, Math.floor(t1 / BIN));
    let pk = -1;
    let rm = 0;
    for (let k = a; k <= b; k++) {
      const p = this.peaks.get(k);
      if (p == null) continue;
      if (p > pk) pk = p;
      const r = this.rmss.get(k) ?? 0;
      if (r > rm) rm = r;
    }
    return pk < 0 ? null : [pk, rm];
  }

  /** test / screenshot helper: fill a span with synthetic levels */
  fake(t0: number, t1: number, fn: (t: number) => [number, number]) {
    for (let k = Math.floor(t0 / BIN); k <= Math.floor(t1 / BIN); k++) {
      const [p, r] = fn(k * BIN);
      this.peaks.set(k, p);
      this.rmss.set(k, r);
    }
    this.version++;
  }
}

/** linear amplitude → dBFS (floor −60) */
export const toDb = (v: number) => (v > 1e-6 ? Math.max(-60, 20 * Math.log10(v)) : -60);
/** dBFS → 0..1 meter position (−60…0 dB) */
export const dbPos = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60));
