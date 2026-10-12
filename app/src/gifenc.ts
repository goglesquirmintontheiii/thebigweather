// Small animated-GIF encoder: one global 256-colour palette (median cut over all frames'
// 15-bit colour histogram), LZW with a generation-stamped hash table (no big clears).

/** Build a palette from RGBA frames (sampled). Returns 256*3 bytes and a 15-bit → index lookup. */
export function buildPalette(frames: Uint8ClampedArray[], maxSamples = 600_000): { pal: Uint8Array; lut: Int16Array } {
  const hist = new Uint32Array(32768);
  const per = Math.max(1, Math.floor(maxSamples / Math.max(1, frames.length)));
  for (const d of frames) {
    const n = d.length / 4;
    const step = Math.max(1, Math.floor(n / per));
    for (let i = 0; i < n; i += step) {
      const o = i * 4;
      hist[((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3)]++;
    }
  }
  const bins: number[] = [];
  for (let i = 0; i < 32768; i++) if (hist[i]) bins.push(i);
  type Box = { b: number[]; score: number; axis: number };
  const comp = (c: number, a: number) => (a === 0 ? c >> 10 : a === 1 ? (c >> 5) & 31 : c & 31);
  const mkBox = (b: number[]): Box => {
    let best = 0, axis = 0, cnt = 0;
    for (let a = 0; a < 3; a++) {
      let lo = 31, hi = 0;
      for (const c of b) {
        const v = comp(c, a);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) ((best = hi - lo), (axis = a));
    }
    for (const c of b) cnt += hist[c];
    return { b, axis, score: b.length > 1 ? best * Math.sqrt(cnt) : -1 };
  };
  const boxes: Box[] = bins.length ? [mkBox(bins)] : [];
  while (boxes.length < 256) {
    let bi = -1, bs = 0;
    boxes.forEach((x, i) => x.score > bs && ((bs = x.score), (bi = i)));
    if (bi < 0) break;
    const bx = boxes[bi];
    bx.b.sort((p, q) => comp(p, bx.axis) - comp(q, bx.axis));
    let tot = 0;
    for (const c of bx.b) tot += hist[c];
    let acc = 0, cut = 1;
    for (let i = 0; i < bx.b.length - 1; i++) {
      acc += hist[bx.b[i]];
      if (acc >= tot / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(bi, 1, mkBox(bx.b.slice(0, cut)), mkBox(bx.b.slice(cut)));
  }
  const pal = new Uint8Array(768);
  boxes.forEach((bx, i) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of bx.b) {
      const w = hist[c];
      r += ((c >> 10) * 8 + 4) * w;
      g += (((c >> 5) & 31) * 8 + 4) * w;
      b += ((c & 31) * 8 + 4) * w;
      n += w;
    }
    pal[i * 3] = Math.round(r / n);
    pal[i * 3 + 1] = Math.round(g / n);
    pal[i * 3 + 2] = Math.round(b / n);
  });
  const np = Math.max(1, boxes.length);
  const lut = new Int16Array(32768).fill(-1);
  const nearest = (c: number) => {
    const r = (c >> 10) * 8 + 4, g = ((c >> 5) & 31) * 8 + 4, b = (c & 31) * 8 + 4;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < np; i++) {
      const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) ((bd = d), (bi = i));
    }
    return bi;
  };
  for (const c of bins) lut[c] = nearest(c);
  (lut as any).nearest = nearest;
  return { pal, lut };
}

function indexFrame(d: Uint8ClampedArray, lut: Int16Array): Uint8Array {
  const n = d.length / 4;
  const out = new Uint8Array(n);
  const nearest = (lut as any).nearest as (c: number) => number;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const c = ((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3);
    let v = lut[c];
    if (v < 0) v = lut[c] = nearest(c);
    out[i] = v;
  }
  return out;
}

/** LZW-compress 8-bit indices into GIF data sub-blocks (min code size 8). */
function lzw(px: Uint8Array): Uint8Array {
  const MIN = 8, CLEAR = 256, EOI = 257;
  const out: number[] = [];
  let cur = 0, nbits = 0;
  let size = MIN + 1;
  const emit = (code: number) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      nbits -= 8;
    }
  };
  const HS = 1 << 20;
  const codes = new Int32Array(HS);
  const gens = new Int32Array(HS);
  let gen = 1;
  let next = EOI + 1;
  emit(CLEAR);
  if (!px.length) {
    emit(EOI);
  } else {
    let prefix = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i];
      const key = (prefix << 8) | k;
      if (gens[key] === gen) {
        prefix = codes[key];
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        gens[key] = gen;
        codes[key] = next++;
        if (next > 1 << size && size < 12) size++;
      } else {
        emit(CLEAR);
        gen++;
        next = EOI + 1;
        size = MIN + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(EOI);
  }
  if (nbits > 0) out.push(cur & 255);
  // sub-blocks
  const blocks = new Uint8Array(out.length + Math.ceil(out.length / 255) + 2);
  let o = 0;
  blocks[o++] = MIN;
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks[o++] = n;
    for (let j = 0; j < n; j++) blocks[o++] = out[i + j];
  }
  blocks[o++] = 0;
  return blocks.subarray(0, o);
}

export class GifWriter {
  private parts: Uint8Array[] = [];
  constructor(private w: number, private h: number, private pal: Uint8Array, private lut: Int16Array, loop: number | null) {
    const hd = new Uint8Array(13);
    hd.set([71, 73, 70, 56, 57, 97]);
    hd[6] = w & 255; hd[7] = w >> 8; hd[8] = h & 255; hd[9] = h >> 8;
    hd[10] = 0xf7; // global table, 8-bit, 256 entries
    this.parts.push(hd, pal);
    // loop: null = play once, 0 = forever, n = repeat n more times
    if (loop !== null) this.parts.push(new Uint8Array([0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, loop & 255, loop >> 8, 0]));
  }
  /** rgba: w*h*4; delay in ms */
  addFrame(rgba: Uint8ClampedArray, delayMs: number) {
    const cs = Math.max(2, Math.round(delayMs / 10));
    const w = this.w, h = this.h;
    this.parts.push(new Uint8Array([0x21, 0xf9, 4, 1 << 2, cs & 255, cs >> 8, 0, 0]));
    this.parts.push(new Uint8Array([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]));
    this.parts.push(lzw(indexFrame(rgba, this.lut)));
  }
  finish(): Blob {
    this.parts.push(new Uint8Array([0x3b]));
    return new Blob(this.parts as BlobPart[], { type: "image/gif" });
  }
}
