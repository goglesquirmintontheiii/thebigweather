// 0.8.2 dev-only feedback capture: the code format (see the brief's capture_format.md).
//   "STORMIQ-FB2:" + base85( deflate-raw( [u32 BE JSON length][JSON UTF-8][screenshot bytes] ) )
// Pure functions (no DOM) so the node test can round-trip them through the reference decoder.

export const PREFIX = "STORMIQ-FB2:";
/** the 94 printable ASCII chars 33..126 minus " & ' * < > \ _ `  (85 chars, ascending) */
export const B85 = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i))
  .filter((ch) => !"\"&'*<>\\_`".includes(ch))
  .join("");

export function b85encode(bytes: Uint8Array): string {
  const out: string[] = [];
  const digits = new Array<string>(5);
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? bytes[i + k] : 0);
    for (let d = 4; d >= 0; d--) {
      digits[d] = B85[v % 85];
      v = Math.floor(v / 85);
    }
    out.push(n === 4 ? digits.join("") : digits.slice(0, n + 1).join(""));
  }
  return out.join("");
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(stream as any);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const deflateRaw = (d: Uint8Array) => pipe(d, new CompressionStream("deflate-raw"));
export const inflateRaw = (d: Uint8Array) => pipe(d, new DecompressionStream("deflate-raw"));

/** Drop empty values (undefined, null, "", [], {}) recursively so the JSON stays compact. */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact).filter((x) => !isEmpty(x)) as any;
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) {
      const c = compact(x);
      if (!isEmpty(c)) o[k] = c;
    }
    return o;
  }
  return v;
}
const isEmpty = (x: any) => x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && x && !Array.isArray(x) && !Object.keys(x).length);

/** Build the code from the capture JSON and an optional screenshot. */
export async function encodeCapture(json: object, shot?: Uint8Array | null): Promise<string> {
  const j = new TextEncoder().encode(JSON.stringify(compact(json)));
  const raw = new Uint8Array(4 + j.length + (shot?.length ?? 0));
  new DataView(raw.buffer).setUint32(0, j.length);
  raw.set(j, 4);
  if (shot) raw.set(shot, 4 + j.length);
  return PREFIX + b85encode(await deflateRaw(raw));
}

/** Decode (for the app's own use; the checklist page has its own copy of the reference decoder). */
export async function decodeCapture(code: string): Promise<{ json: any; shot: Uint8Array | null }> {
  const t = code.trim().replace(/^STORMIQ-FB2:/, "").replace(/\s+/g, "");
  const idx = new Map([...B85].map((ch, i) => [ch, i]));
  const out = new Uint8Array(Math.floor(t.length / 5) * 4 + 4);
  let o = 0;
  for (let i = 0; i < t.length; i += 5) {
    const g = t.slice(i, i + 5);
    const n = g.length;
    if (n === 1) throw new Error("bad length");
    let v = 0;
    for (const ch of g.padEnd(5, B85[84])) {
      const d = idx.get(ch);
      if (d === undefined) throw new Error("bad character");
      v = v * 85 + d;
    }
    for (let k = 3; k >= 0; k--) {
      const byte = v % 256;
      v = Math.floor(v / 256);
      if (k < n - 1) out[o + k] = byte;
    }
    o += n - 1;
  }
  const raw = await inflateRaw(out.slice(0, o));
  const n = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  const json = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + n)));
  return { json, shot: raw.length > 4 + n ? raw.slice(4 + n) : null };
}

/** fit (w, h) inside a box whose longer side is ≤ max */
export function fitScale(w: number, h: number, max = 1280): number {
  const m = Math.max(w, h);
  return m > max ? max / m : 1;
}
