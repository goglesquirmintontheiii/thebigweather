// radar 0.6: heavy math for the Phase 6 radar tools, off the UI thread.
// ops: dealias (velocity unfolding), tds (debris signature clusters), hsda (hail size clusters),
// mesh (MESH grid from the whole volume).

import { hailClass } from "./hailfuzzy";

interface WS {
  nrad: number;
  ngates: number;
  firstGate: number;
  gate: number;
  elevation: number;
  lat: number;
  lon: number;
  height: number;
  nyquist: number;
  az: Float32Array;
  azIndex: Uint16Array;
  data: Uint8Array | Uint16Array;
  lut: Float32Array | null;
  scale: number;
  offset: number;
  product: string;
}

const RFV = -9999;
const DEG = Math.PI / 180;
const RE = (6371000 * 4) / 3;

function decode(s: WS): Float32Array {
  const n = s.nrad * s.ngates;
  const out = new Float32Array(n);
  const d = s.data;
  if (s.lut) {
    const l = s.lut;
    for (let i = 0; i < n; i++) out[i] = l[d[i]];
  } else {
    const sc = s.scale || 1, of = s.offset;
    for (let i = 0; i < n; i++) {
      const r = d[i];
      out[i] = r === 0 ? NaN : r === 1 ? RFV : (r - of) / sc;
    }
  }
  return out;
}

const beamH = (slant: number, el: number) => Math.sqrt(slant * slant + RE * RE + 2 * slant * RE * Math.sin(el)) - RE;

/** Value of sweep `s` at azimuth (deg) and ground range (m). */
function sampler(s: WS, v: Float32Array) {
  const cosel = Math.cos(s.elevation * DEG);
  return (az: number, ground: number) => {
    const gi = Math.floor((ground / cosel - s.firstGate) / s.gate + 0.5);
    if (gi < 0 || gi >= s.ngates) return NaN;
    let bin = Math.floor(az * 10) % 3600;
    if (bin < 0) bin += 3600;
    const ri = s.azIndex[bin];
    if (ri === 65535) return NaN;
    return v[ri * s.ngates + gi];
  };
}

// ---------- convex hull (monotone chain) ----------
function hull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  up.pop();
  lo.pop();
  return lo.concat(up);
}

/** Connected clusters of mask>0 gates (8-neighbours, plus 1-gate gaps along the radial). */
function clusters(mask: Uint8Array, nr: number, ng: number, minN: number): Int32Array[] {
  const seen = new Uint8Array(mask.length);
  const out: Int32Array[] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const members: number[] = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      const r = (c / ng) | 0, g = c - r * ng;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = (r + dr + nr) % nr;
        for (let dg = -2; dg <= 2; dg++) {
          if (!dr && !dg) continue;
          if (dr && Math.abs(dg) > 1) continue;
          const gg = g + dg;
          if (gg < 0 || gg >= ng) continue;
          const j = rr * ng + gg;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    if (members.length >= minN) out.push(Int32Array.from(members));
  }
  return out;
}

/** gate centre → km east/north of the radar, with a small buffer square for the hull */
function gateXY(s: WS, idx: number, buf: number, pts: [number, number][]) {
  const r = (idx / s.ngates) | 0, g = idx - r * s.ngates;
  const ground = ((s.firstGate + g * s.gate) * Math.cos(s.elevation * DEG)) / 1000;
  const a = s.az[r] * DEG;
  const x = ground * Math.sin(a), y = ground * Math.cos(a);
  if (buf > 0) pts.push([x - buf, y - buf], [x + buf, y - buf], [x + buf, y + buf], [x - buf, y + buf]);
  else pts.push([x, y]);
  return [x, y, ground];
}

// ---------- TDS ----------
interface Rot {
  x: number;
  y: number;
  vrot: number;
  kind: string;
  diam: number;
}
function tds(a: { tilts: { ref: WS; rho: WS; zdr: WS }[]; rot: Rot[]; p: { cc: number; zdr: number; ref: number; km: number; maxRange: number; needRot: boolean } }) {
  const res: any[] = [];
  a.tilts.forEach((t, k) => {
    const R = t.ref, ng = R.ngates, nr = R.nrad;
    const zv = decode(R);
    const cc = sampler(t.rho, decode(t.rho));
    const zd = sampler(t.zdr, decode(t.zdr));
    const cosel = Math.cos(R.elevation * DEG);
    const mask = new Uint8Array(nr * ng);
    const near = new Int16Array(nr * ng).fill(-1);
    const gmax = Math.min(ng, Math.floor((a.p.maxRange * 1000) / cosel / R.gate));
    for (let r = 0; r < nr; r++) {
      const az = R.az[r], sa = Math.sin(az * DEG), ca = Math.cos(az * DEG);
      for (let g = 0; g < gmax; g++) {
        const i = r * ng + g;
        const z = zv[i];
        if (!(z >= a.p.ref)) continue;
        const ground = (R.firstGate + g * R.gate) * cosel;
        const c = cc(az, ground);
        if (!(c < a.p.cc && c > 0.2)) continue;
        const d = zd(az, ground);
        if (!(Math.abs(d) <= a.p.zdr)) continue;
        const x = (ground / 1000) * sa, y = (ground / 1000) * ca;
        let best = -1, bd = 1e9;
        a.rot.forEach((o, j) => {
          const dd = Math.hypot(o.x - x, o.y - y);
          if (dd < bd) (bd = dd), (best = j);
        });
        const lim = a.p.km + (best >= 0 ? a.rot[best].diam / 2 : 0);
        if (a.p.needRot && bd > lim) continue;
        mask[i] = 1;
        if (bd <= lim) near[i] = best;
      }
    }
    for (const m of clusters(mask, nr, ng, 3)) {
      const pts: [number, number][] = [];
      let sx = 0, sy = 0, ccs = 0, ccMin = 9, zds = 0, zmax = -99, nRot = 0, rotIdx = -1, hsum = 0;
      for (const idx of m) {
        const r = (idx / ng) | 0;
        const [x, y, ground] = gateXY(R, idx, 0.12, pts);
        sx += x;
        sy += y;
        const c = cc(R.az[r], ground * 1000);
        ccs += c;
        ccMin = Math.min(ccMin, c);
        zds += zd(R.az[r], ground * 1000);
        zmax = Math.max(zmax, zv[idx]);
        hsum += beamH(ground * 1000 / cosel, R.elevation * DEG);
        if (near[idx] >= 0) {
          nRot++;
          rotIdx = near[idx];
        }
      }
      const n = m.length;
      if (!nRot && n < 10) continue; // isolated speckle away from rotation
      res.push({ tilt: k, elev: R.elevation, n, cx: sx / n, cy: sy / n, hull: hull(pts), ccMean: ccs / n, ccMin, zdrMean: zds / n, refMax: zmax, rotIdx, nRot, hkm: hsum / n / 1000 });
    }
  });
  return res;
}

// ---------- HSDA clusters (lowest tilt) ----------
function hsda(a: { ref: WS; zdr: WS; rho: WS; h0: number; maxRange: number }) {
  const R = a.ref, ng = R.ngates, nr = R.nrad;
  const zv = decode(R);
  const zd = sampler(a.zdr, decode(a.zdr));
  const cc = sampler(a.rho, decode(a.rho));
  const el = R.elevation * DEG, cosel = Math.cos(el);
  const cls = new Uint8Array(nr * ng);
  const gmax = Math.min(ng, Math.floor((a.maxRange * 1000) / cosel / R.gate));
  for (let r = 0; r < nr; r++) {
    const az = R.az[r];
    for (let g = 0; g < gmax; g++) {
      const i = r * ng + g;
      const z = zv[i];
      if (!(z >= 45)) continue;
      const slant = R.firstGate + g * R.gate;
      const ground = slant * cosel;
      const h = R.height + beamH(slant, el);
      cls[i] = hailClass(z, zd(az, ground), cc(az, ground), h - a.h0);
    }
  }
  const out: any[] = [];
  for (const m of clusters(cls, nr, ng, 4)) {
    const pts: [number, number][] = [];
    const cnt = [0, 0, 0, 0];
    let sx = 0, sy = 0, zmax = -99, mx = 0, my = 0;
    for (const idx of m) {
      const [x, y] = gateXY(R, idx, 0.15, pts);
      cnt[cls[idx]]++;
      sx += x;
      sy += y;
      if (zv[idx] > zmax) (zmax = zv[idx]), (mx = x), (my = y);
    }
    const n = m.length;
    // the size class shown: the largest class with a meaningful share of the cluster
    const top = cnt[3] >= Math.max(3, n * 0.08) ? 3 : cnt[2] + cnt[3] >= Math.max(3, n * 0.1) ? 2 : 1;
    out.push({ n, cnt, cls: top, cx: sx / n, cy: sy / n, mx, my, zmax, hull: hull(pts) });
  }
  return out;
}

// ---------- MESH grid ----------
function mesh(a: { refs: WS[]; h0: number; hm20: number; radarH: number; lat0: number; lon0: number; rangeKm: number; res: number }) {
  const W = Math.round((2 * a.rangeKm) / a.res), H = W;
  const kx = 111.32 * Math.cos(a.lat0 * DEG);
  const lonW = a.lon0 - a.rangeKm / kx, lonE = a.lon0 + a.rangeKm / kx;
  const latS = a.lat0 - a.rangeKm / 110.57, latN = a.lat0 + a.rangeKm / 110.57;
  const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  const yN = my(latN), yS = my(latS);
  const tilts = a.refs.slice().sort((p, q) => p.elevation - q.elevation);
  const samp = tilts.map((t) => sampler(t, decode(t)));
  const els = tilts.map((t) => t.elevation * DEG);
  const out = new Float32Array(W * H).fill(NaN);
  const maxG = a.rangeKm * 1000;
  const dH = Math.max(500, a.hm20 - a.h0);
  for (let j = 0; j < H; j++) {
    const yy = yN + ((j + 0.5) / H) * (yS - yN);
    const lat = (2 * Math.atan(Math.exp(yy)) - Math.PI / 2) / DEG;
    const ykm = (lat - a.lat0) * 110.57;
    for (let i = 0; i < W; i++) {
      const lon = lonW + ((i + 0.5) / W) * (lonE - lonW);
      const xkm = (lon - a.lon0) * kx;
      const ground = Math.hypot(xkm, ykm) * 1000;
      if (ground > maxG) continue;
      let az = Math.atan2(xkm, ykm) / DEG;
      if (az < 0) az += 360;
      let shi = 0, ph = 0, pf = 0, any = false, have = false;
      for (let k = 0; k < tilts.length; k++) {
        const z = samp[k](az, ground);
        const slant = ground / Math.cos(els[k]);
        const h = a.radarH + beamH(slant, els[k]);
        let f = 0;
        if (z > 40) {
          any = true;
          const wz = z >= 50 ? 1 : (z - 40) / 10;
          const wt = h <= a.h0 ? 0 : h >= a.h0 + dH ? 1 : (h - a.h0) / dH;
          f = 5e-6 * Math.pow(10, 0.084 * Math.min(z, 75)) * wz * wt;
        }
        if (have) shi += 0.5 * (f + pf) * Math.max(0, h - ph);
        ph = h;
        pf = f;
        have = true;
      }
      if (!any) {
        out[j * W + i] = 0;
        continue;
      }
      const SHI = 0.1 * shi;
      out[j * W + i] = SHI > 0 ? 2.54 * Math.sqrt(SHI) : 0;
    }
  }
  return { W, H, bounds: [lonW, latS, lonE, latN], mesh: out };
}

// ---------- velocity dealiasing (best-first region growing) ----------
class Heap {
  k = new Float32Array(1 << 16);
  v = new Int32Array(1 << 16);
  n = 0;
  push(key: number, val: number) {
    if (this.n >= this.k.length) {
      const k2 = new Float32Array(this.k.length * 2);
      k2.set(this.k);
      this.k = k2;
      const v2 = new Int32Array(this.v.length * 2);
      v2.set(this.v);
      this.v = v2;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = key;
    V[i] = val;
  }
  pop(): number {
    const K = this.k, V = this.v;
    const top = V[0];
    const n = --this.n;
    const key = K[n], val = V[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c];
      V[i] = V[c];
      i = c;
    }
    K[i] = key;
    V[i] = val;
    return top;
  }
}

function dealias(a: { s: WS; nyq: number }) {
  const s = a.s, nr = s.nrad, ng = s.ngates, n = nr * ng;
  const v = decode(s);
  let vn = a.nyq;
  if (!(vn > 1)) {
    vn = 0;
    for (let i = 0; i < n; i++) if (v[i] > -9000 && Math.abs(v[i]) > vn) vn = Math.abs(v[i]);
    vn = Math.max(vn, 5);
  }
  const span = 2 * vn;
  const out = new Float32Array(n).fill(NaN);
  const done = new Uint8Array(n);
  const best = new Float32Array(n).fill(1e9);
  const valid = (i: number) => v[i] > -9000; // NaN fails too
  for (let i = 0; i < n; i++) if (v[i] === RFV) out[i] = RFV;
  const heap = new Heap();
  // reference value for gate i from its already unfolded neighbours (radial neighbours weigh more)
  const ref = (i: number): number => {
    const r = (i / ng) | 0, g = i - r * ng;
    let s0 = 0, w = 0;
    const add = (j: number, wt: number) => {
      if (done[j]) {
        s0 += out[j] * wt;
        w += wt;
      }
    };
    if (g > 0) add(i - 1, 1.5);
    if (g < ng - 1) add(i + 1, 1.5);
    if (g > 1) add(i - 2, 0.6);
    if (g < ng - 2) add(i + 2, 0.6);
    add(((r + 1) % nr) * ng + g, 1);
    add(((r - 1 + nr) % nr) * ng + g, 1);
    return w ? s0 / w : NaN;
  };
  const unfold = (x: number, rf: number) => x + span * Math.round((rf - x) / span);
  const pushN = (i: number) => {
    const r = (i / ng) | 0, g = i - r * ng;
    const nb = [g > 0 ? i - 1 : -1, g < ng - 1 ? i + 1 : -1, ((r + 1) % nr) * ng + g, ((r - 1 + nr) % nr) * ng + g];
    for (const j of nb) {
      if (j < 0 || done[j] || !valid(j)) continue;
      const rf = ref(j);
      const u = unfold(v[j], rf);
      const c = Math.abs(u - rf);
      if (c < best[j] - 1e-3) {
        best[j] = c;
        heap.push(c, j);
      }
    }
  };
  // components → one seed each (low |v|, smooth neighbourhood, near the radar)
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let nc = 0;
  for (let g0 = 0; g0 < ng; g0++) {
    for (let r0 = 0; r0 < nr; r0++) {
      const i0 = r0 * ng + g0;
      if (comp[i0] >= 0 || !valid(i0)) continue;
      const id = nc++;
      comp[i0] = id;
      stack.push(i0);
      let seed = i0, sb = 1e9;
      while (stack.length) {
        const c = stack.pop()!;
        const r = (c / ng) | 0, g = c - r * ng;
        const nb = [g > 0 ? c - 1 : -1, g < ng - 1 ? c + 1 : -1, ((r + 1) % nr) * ng + g, ((r - 1 + nr) % nr) * ng + g];
        let rough = 0, cnt = 0;
        for (const j of nb) {
          if (j < 0 || !valid(j)) continue;
          rough += Math.abs(v[j] - v[c]);
          cnt++;
          if (comp[j] < 0) {
            comp[j] = id;
            stack.push(j);
          }
        }
        if (cnt >= 3) {
          const score = Math.abs(v[c]) / vn + (2 * rough) / cnt / vn + g / ng;
          if (score < sb) (sb = score), (seed = c);
        }
      }
      out[seed] = v[seed];
      done[seed] = 1;
      pushN(seed);
      while (heap.n) {
        const j = heap.pop();
        if (done[j]) continue;
        const rf = ref(j);
        out[j] = Number.isFinite(rf) ? unfold(v[j], rf) : v[j];
        done[j] = 1;
        pushN(j);
      }
    }
  }
  return { vals: out, vn, comps: nc };
}

self.onmessage = (e: MessageEvent) => {
  const { id, op, args } = e.data;
  try {
    let result: any;
    let transfer: Transferable[] = [];
    if (op === "dealias") {
      result = dealias(args);
      transfer = [result.vals.buffer];
    } else if (op === "tds") result = tds(args);
    else if (op === "hsda") result = hsda(args);
    else if (op === "mesh") {
      result = mesh(args);
      transfer = [result.mesh.buffer];
    } else throw new Error(`unknown op ${op}`);
    (self as any).postMessage({ id, result }, transfer);
  } catch (err: any) {
    (self as any).postMessage({ id, error: err?.message ?? String(err) });
  }
};
