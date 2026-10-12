// Small streaming DSP helpers shared by the SAME decoder and the transcription feed.

/** Streaming resampler: 4th-order Butterworth low-pass (when downsampling) + linear interpolation. */
export class Resampler {
  private step: number;
  private pos = 0; // fractional read position into the current input block (may be negative: previous sample)
  private last = 0;
  private bq: Biquad[] = [];
  constructor(
    public inRate: number,
    public outRate: number,
  ) {
    this.step = inRate / outRate;
    if (outRate < inRate) {
      const fc = 0.45 * outRate;
      this.bq = [new Biquad(inRate, fc, 0.5412), new Biquad(inRate, fc, 1.3066)];
    }
  }
  process(x: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return x.slice();
    let y = x;
    if (this.bq.length) {
      y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        let v = x[i];
        for (const b of this.bq) v = b.run(v);
        y[i] = v;
      }
    }
    const out = new Float32Array(Math.ceil((y.length - this.pos) / this.step) + 1);
    let n = 0;
    let p = this.pos;
    while (p < y.length - 1) {
      const i = Math.floor(p);
      const f = p - i;
      const a = i < 0 ? this.last : y[i];
      const b = y[i + 1];
      out[n++] = a + (b - a) * f;
      p += this.step;
    }
    this.pos = p - y.length;
    if (y.length) this.last = y[y.length - 1];
    return out.subarray(0, n);
  }
}

export class Biquad {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private z1 = 0;
  private z2 = 0;
  constructor(fs: number, fc: number, q: number) {
    const w = (2 * Math.PI * fc) / fs;
    const al = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    const a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0;
    this.b1 = (1 - c) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Goertzel power at `f`, normalised so a full-scale-relative pure tone gives ≈1 vs. the block energy. */
export function toneRatio(x: Float32Array, off: number, n: number, fs: number, f: number, energy: number): number {
  const k = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[off + i] + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const p = s1 * s1 + s2 * s2 - k * s1 * s2;
  return energy > 1e-12 ? p / ((energy * n) / 2) : 0;
}

export function energyOf(x: Float32Array, off: number, n: number): number {
  let e = 0;
  for (let i = 0; i < n; i++) e += x[off + i] * x[off + i];
  return e;
}
