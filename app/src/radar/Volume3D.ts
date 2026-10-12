// WebGL2 volumetric radar renderer (MapLibre custom layer).
// A 3D grid of u8 voxels (Level II volume resampled by the server, or MRMS 3D mosaic) is uploaded
// as a TEXTURE_3D and ray-marched inside a box placed in mercator space. Colors come from the same
// color table as the 2D layer so the legend still applies.

import * as maplibregl from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { type ColorTable, rasterize, TEX_SIZE } from "./colormaps";

export interface VolHeader {
  nx: number;
  ny: number;
  nz: number;
  scale: number;
  offset: number;
  moment?: string;
  time?: number;
  site?: string;
  elev_m?: number;
  /** "aeqd": radar-centred grid in metres; "latlon": regular lat/lon grid with height levels */
  proj: "aeqd" | "latlon";
  // aeqd
  dx?: number;
  dy?: number;
  dz?: number;
  z0?: number;
  lat?: number;
  lon?: number;
  // latlon
  lon0?: number;
  lat0?: number;
  dlon?: number;
  dlat?: number;
  levels?: number[];
}

export interface Volume {
  hdr: VolHeader;
  /** nx*ny*nz bytes, x fastest, then y (south→north), then z (bottom→top); 0 = no data */
  data: Uint8Array;
  bytes: number;
}

export function parseVolume(buf: ArrayBuffer): Volume {
  const dv = new DataView(buf);
  const L = dv.getUint32(0, true);
  const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, L))) as VolHeader;
  const n = hdr.nx * hdr.ny * hdr.nz;
  if (!(n > 0) || 4 + L + n > buf.byteLength) throw new Error("bad volume");
  if (!hdr.proj) hdr.proj = hdr.levels ? "latlon" : "aeqd";
  return { hdr, data: new Uint8Array(buf, 4 + L, n), bytes: buf.byteLength };
}

export interface VolParams {
  /** show only values ≥ threshold (product units) */
  threshold: number;
  /** compare |value| (velocity) */
  absValue: boolean;
  /** opacity multiplier */
  density: number;
  /** vertical exaggeration */
  exag: number;
  /** trilinear (nodata-aware) vs nearest */
  smooth: boolean;
  /** gradient lighting */
  shade: boolean;
}

const VS = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
in vec3 a_nrm;
out vec3 v_local;
flat out vec3 v_nrm;
void main() {
  v_local = a_pos;
  v_nrm = a_nrm;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 v_local;
flat in vec3 v_nrm;
out vec4 fragColor;
uniform vec3 u_eye;          // camera in box-local coords
uniform sampler3D u_vol;     // RG8: r = byte/255 (0 = nodata), g = valid mask
uniform sampler2D u_cmap;
uniform sampler2D u_lev;     // latlon: box z -> fractional level index (256 x 1, R32F)
uniform int u_proj;          // 0 aeqd, 1 latlon
uniform vec3 u_dims;         // nx, ny, nz
uniform vec2 u_off;          // box min (mercator) minus reference x/y
uniform vec2 u_size;         // box size (mercator)
uniform float u_cy;          // reference mercator y
uniform float u_lat0;        // reference lat (rad)
uniform float u_lonc;        // reference lon (deg)
uniform vec2 u_ext;          // aeqd: grid width/height (m)
uniform vec4 u_ll;           // latlon: lon0, lat0, dlon, dlat (deg, first cell centre)
uniform vec2 u_h;            // box bottom/top height (m)
uniform vec2 u_zgrid;        // aeqd: z0, dz (m)
uniform vec3 u_mstep;        // metres per box-local unit (x, y, z), unexaggerated
uniform float u_exag;
uniform float u_scale;
uniform float u_offset;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_thr;
uniform float u_soft;        // threshold fade width (product units)
uniform int u_abs;
uniform float u_density;
uniform int u_shade;
uniform int u_maxSteps;

const float PI = 3.141592653589793;
const float R = 6371000.0;

vec3 texCoord(vec3 p) {
  float mx = u_off.x + p.x * u_size.x;
  float my = u_cy + u_off.y + p.y * u_size.y;
  float lat = 2.0 * atan(exp(PI * (1.0 - 2.0 * my))) - PI * 0.5;
  vec2 uv;
  float w;
  if (u_proj == 0) {
    float xm = R * cos(lat) * mx * 2.0 * PI;
    float ym = R * (lat - u_lat0);
    uv = vec2(xm / u_ext.x + 0.5, ym / u_ext.y + 0.5);
    float h = mix(u_h.x, u_h.y, p.z);
    w = ((h - u_zgrid.x) / u_zgrid.y + 0.5) / u_dims.z;
  } else {
    float lon = u_lonc + mx * 360.0;
    uv = vec2(((lon - u_ll.x) / u_ll.z + 0.5) / u_dims.x, ((degrees(lat) - u_ll.y) / u_ll.w + 0.5) / u_dims.y);
    float f = clamp(p.z, 0.0, 1.0) * 255.0;
    int i0 = int(floor(f));
    int i1 = min(i0 + 1, 255);
    float k = mix(texelFetch(u_lev, ivec2(i0, 0), 0).r, texelFetch(u_lev, ivec2(i1, 0), 0).r, f - float(i0));
    w = (k + 0.5) / u_dims.z;
  }
  return vec3(uv, w);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 o = u_eye;
  vec3 seg = v_local - o;
  // only the far (back) faces of the box are rendered, so each pixel marches once
  if (dot(seg, v_nrm) <= 0.0) discard;
  float tfar = length(seg);
  vec3 d = seg / tfar;
  vec3 inv = 1.0 / d;
  vec3 t0 = (vec3(0.0) - o) * inv;
  vec3 t1 = (vec3(1.0) - o) * inv;
  vec3 tmin = min(t0, t1);
  float tnear = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  if (tnear >= tfar) discard;
  // step count from the path length in voxels
  vec3 span = d * (tfar - tnear) * u_dims;
  float nvox = length(span);
  int n = int(clamp(nvox * 1.3, 24.0, float(u_maxSteps)));
  float dt = (tfar - tnear) / float(n);
  // path length per step in km (true, unexaggerated heights)
  float dkm = length(d * dt * u_mstep) * 0.001;
  float t = tnear + dt * hash(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  vec3 L = normalize(vec3(-0.35, 0.45, 0.82));
  vec3 vox = 1.0 / u_dims;
  for (int i = 0; i < 1024; i++) {
    if (i >= n || acc.a >= 0.98) break;
    vec3 p = o + d * t;
    t += dt;
    vec3 tc = texCoord(p);
    if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) continue;
    vec2 s = texture(u_vol, tc).rg;
    if (s.g < 0.03) continue;
    float raw = s.r / s.g * 255.0;
    float v = (raw - u_offset) / u_scale;
    float tv = u_abs == 1 ? abs(v) : v;
    if (tv < u_thr) continue;
    vec4 c = texture(u_cmap, vec2(clamp((v - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5));
    // stronger echoes are denser, so cores show through the weaker shell around them
    float strength = clamp((tv - u_thr) / max(u_cmax - u_thr, 1e-3), 0.0, 1.0);
    float k = c.a * s.g * smoothstep(u_thr, u_thr + u_soft, tv) * (0.18 + 2.2 * strength * strength);
    float a = 1.0 - exp(-k * u_density * 0.7 * dkm);
    if (a < 0.002) continue;
    vec3 rgb = c.rgb;
    if (u_shade == 1) {
      // gradient of the mask-weighted field; points out of the echo
      float f0 = s.r;
      vec3 g = vec3(
        texture(u_vol, tc + vec3(vox.x, 0.0, 0.0)).r - f0,
        texture(u_vol, tc + vec3(0.0, vox.y, 0.0)).r - f0,
        texture(u_vol, tc + vec3(0.0, 0.0, vox.z)).r - f0);
      // to world-ish units: per metre, heights exaggerated
      g /= vec3(u_mstep.x * vox.x, u_mstep.y * vox.y, u_mstep.z * vox.z * u_exag);
      float gl = length(g);
      float lit = 1.0;
      if (gl > 1e-9) {
        vec3 nn = -g / gl;
        lit = 0.4 + 0.8 * max(dot(nn, L), 0.0);
      }
      rgb *= lit;
    }
    acc.rgb += (1.0 - acc.a) * rgb * a;
    acc.a += (1.0 - acc.a) * a;
  }
  if (acc.a < 0.004) discard;
  fragColor = acc;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
  return s;
}

/** 4x4 column-major multiply (float64) */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const o = new Float64Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  return o;
}

/** 4x4 inverse (float64, column-major) */
function invert(m: ArrayLike<number>): Float64Array | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return new Float64Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]);
}

/** Unit cube as 12 triangles with per-face outward normals (x, y, z, nx, ny, nz). */
function cube(): Float32Array {
  const out: number[] = [];
  const face = (axis: number, side: number) => {
    const n = [0, 0, 0];
    n[axis] = side ? 1 : -1;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const corner = (a: number, b: number) => {
      const p = [0, 0, 0];
      p[axis] = side;
      p[u] = a;
      p[v] = b;
      out.push(...p, ...n);
    };
    corner(0, 0); corner(1, 0); corner(1, 1);
    corner(0, 0); corner(1, 1); corner(0, 1);
  };
  for (let a = 0; a < 3; a++) for (let s = 0; s < 2; s++) face(a, s);
  return new Float32Array(out);
}

interface Geo {
  ref: maplibregl.MercatorCoordinate;
  off: [number, number];
  size: [number, number];
  h: [number, number];
  ext: [number, number];
  mstep: [number, number, number];
  lonc: number;
  latc: number;
}

/** Box placement in mercator for a volume (independent of exaggeration). */
export function volumeGeo(hdr: VolHeader): Geo {
  const R = 6371000;
  const d2r = Math.PI / 180;
  if (hdr.proj === "latlon") {
    const nx = hdr.nx, ny = hdr.ny, nz = hdr.nz;
    const lonW = hdr.lon0! - hdr.dlon! / 2, lonE = hdr.lon0! + (nx - 0.5) * hdr.dlon!;
    const latS = hdr.lat0! - hdr.dlat! / 2, latN = hdr.lat0! + (ny - 0.5) * hdr.dlat!;
    const lonc = (lonW + lonE) / 2, latc = (latS + latN) / 2;
    const ref = maplibregl.MercatorCoordinate.fromLngLat([lonc, latc]);
    const sw = maplibregl.MercatorCoordinate.fromLngLat([lonW, latS]);
    const ne = maplibregl.MercatorCoordinate.fromLngLat([lonE, latN]);
    const lv = hdr.levels ?? [];
    const sp0 = nz > 1 ? lv[1] - lv[0] : 500;
    const sp1 = nz > 1 ? lv[nz - 1] - lv[nz - 2] : 500;
    const h: [number, number] = [Math.max(0, lv[0] - sp0 / 2), lv[nz - 1] + sp1 / 2];
    return {
      ref,
      off: [sw.x - ref.x, ne.y - ref.y],
      size: [ne.x - sw.x, sw.y - ne.y],
      h,
      ext: [0, 0],
      mstep: [(lonE - lonW) * d2r * R * Math.cos(latc * d2r), (latN - latS) * d2r * R, h[1] - h[0]],
      lonc,
      latc,
    };
  }
  const W = hdr.nx * hdr.dx!, H = hdr.ny * hdr.dy!;
  const lat0 = hdr.lat!, lon0 = hdr.lon!;
  const ref = maplibregl.MercatorCoordinate.fromLngLat([lon0, lat0]);
  const latN = lat0 + (H / 2 / R) / d2r, latS = lat0 - (H / 2 / R) / d2r;
  const yN = maplibregl.MercatorCoordinate.fromLngLat([lon0, latN]).y;
  const yS = maplibregl.MercatorCoordinate.fromLngLat([lon0, latS]).y;
  // widest longitude span happens at the poleward edge
  const cosMin = Math.cos(Math.max(Math.abs(latN), Math.abs(latS)) * d2r);
  const hx = (W / 2 / (R * cosMin)) / (2 * Math.PI);
  const h: [number, number] = [hdr.z0! - hdr.dz! / 2, hdr.z0! + (hdr.nz - 0.5) * hdr.dz!];
  return {
    ref,
    off: [-hx, yN - ref.y],
    size: [2 * hx, yS - yN],
    h,
    ext: [W, H],
    mstep: [2 * hx * 2 * Math.PI * R * Math.cos(lat0 * d2r), H, h[1] - h[0]],
    lonc: lon0,
    latc: lat0,
  };
}

interface GpuVol {
  tex: WebGLTexture;
  lev: WebGLTexture;
  used: number;
}

export class Volume3DLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;
  vol: Volume | null = null;
  table: ColorTable | null = null;
  params: VolParams = { threshold: 20, absValue: false, density: 1, exag: 4, smooth: true, shade: true };
  /** ray-march step cap while idle / while the camera moves */
  steps = 320;
  movingSteps = 128;
  /** set when the GPU can't do this (no 3D textures etc.) */
  error: string | null = null;
  private map?: MLMap;
  private gl?: WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private vao?: WebGLVertexArrayObject;
  private vbo?: WebGLBuffer;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private gpu = new Map<Volume, GpuVol>();
  private cmaps = new Map<ColorTable, WebGLTexture>();
  private moving = false;
  private onMoveStart = () => (this.moving = true);
  private onMoveEnd = () => {
    this.moving = false;
    this.map?.triggerRepaint();
  };

  constructor(id = "volume3d") {
    this.id = id;
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
      this.prog = p;
    } catch (e: any) {
      this.error = `3D shader: ${e.message}`;
      console.error(this.error);
      return;
    }
    const p = this.prog;
    for (const n of ["u_mvp", "u_eye", "u_vol", "u_cmap", "u_lev", "u_proj", "u_dims", "u_off", "u_size", "u_cy", "u_lat0", "u_lonc", "u_ext", "u_ll", "u_h", "u_zgrid", "u_mstep", "u_exag", "u_scale", "u_offset", "u_cmin", "u_cmax", "u_thr", "u_soft", "u_abs", "u_density", "u_shade", "u_maxSteps"])
      this.loc[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, cube(), gl.STATIC_DRAW);
    const ap = gl.getAttribLocation(p, "a_pos");
    const an = gl.getAttribLocation(p, "a_nrm");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(an);
    gl.vertexAttribPointer(an, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
    map.triggerRepaint();
  }

  onRemove() {
    const gl = this.gl;
    this.map?.off("movestart", this.onMoveStart);
    this.map?.off("moveend", this.onMoveEnd);
    if (!gl) return;
    for (const g of this.gpu.values()) this.freeGpu(g);
    this.gpu.clear();
    for (const t of this.cmaps.values()) gl.deleteTexture(t);
    this.cmaps.clear();
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.prog = undefined;
    this.gl = undefined;
  }

  setVolume(v: Volume | null) {
    this.vol = v;
    this.map?.triggerRepaint();
  }

  setStyle(table: ColorTable, params: Partial<VolParams>) {
    if (table !== this.table && this.table) this.invalidateTable(this.table);
    this.table = table;
    this.params = { ...this.params, ...params };
    this.map?.triggerRepaint();
  }

  /** Forget the GPU color table (edited table). */
  invalidateTable(t: ColorTable) {
    const tex = this.cmaps.get(t);
    if (tex && this.gl) this.gl.deleteTexture(tex);
    this.cmaps.delete(t);
  }

  private freeGpu(g: GpuVol) {
    this.gl?.deleteTexture(g.tex);
    this.gl?.deleteTexture(g.lev);
  }

  private upload(v: Volume): GpuVol {
    const gl = this.gl!;
    const { nx, ny, nz } = v.hdr;
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (nx > max || ny > max || nz > max) throw new Error(`volume ${nx}×${ny}×${nz} exceeds GPU limit ${max}`);
    // RG8: value byte + validity, so linear filtering can be renormalised around missing data
    const src = v.data;
    const rg = new Uint8Array(src.length * 2);
    for (let i = 0, j = 0; i < src.length; i++, j += 2) {
      const b = src[i];
      rg[j] = b;
      rg[j + 1] = b ? 255 : 0;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, nx, ny, nz, 0, gl.RG, gl.UNSIGNED_BYTE, rg);
    // latlon: height (box z 0..1) -> fractional level index
    const lev = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, lev);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const lt = new Float32Array(256);
    const lv = v.hdr.levels;
    if (lv?.length) {
      const g = volumeGeo(v.hdr);
      for (let i = 0; i < 256; i++) {
        const h = g.h[0] + (i / 255) * (g.h[1] - g.h[0]);
        let k = 0;
        while (k < lv.length - 2 && lv[k + 1] < h) k++;
        const span = lv.length > 1 ? lv[k + 1] - lv[k] : 1;
        lt[i] = Math.max(-0.5, Math.min(lv.length - 0.5, k + (lv.length > 1 ? (h - lv[k]) / span : 0)));
      }
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, lt);
    const g = { tex, lev, used: performance.now() };
    this.gpu.set(v, g);
    // keep at most a few volumes on the GPU (animation flips between neighbours)
    if (this.gpu.size > 3) {
      const old = [...this.gpu.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.freeGpu(old[1]);
      this.gpu.delete(old[0]);
    }
    return g;
  }

  private cmapTex(t: ColorTable): WebGLTexture {
    let tex = this.cmaps.get(t);
    if (tex) return tex;
    const gl = this.gl!;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rasterize(t));
    this.cmaps.set(t, tex);
    return tex;
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const v = this.vol;
    const t = this.table;
    if (!this.prog || !v || !t) return;
    let g = this.gpu.get(v);
    if (!g) {
      try {
        g = this.upload(v);
      } catch (e: any) {
        this.error = e.message;
        console.error(e);
        this.vol = null;
        return;
      }
    }
    g.used = performance.now();
    const P = this.params;
    const geo = volumeGeo(v.hdr);
    const mpm = geo.ref.meterInMercatorCoordinateUnits();
    const zs = mpm * P.exag;
    const z0 = geo.h[0] * zs, zh = (geo.h[1] - geo.h[0]) * zs;
    const sx = geo.size[0], sy = geo.size[1];
    const ox = geo.ref.x + geo.off[0], oy = geo.ref.y + geo.off[1];
    const model = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, zh, 0, ox, oy, z0, 1];
    const base = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    const mvp = mul(base, model);
    const inv = invert(mvp);
    if (!inv) return;
    // camera position: the point every clip-space ray converges on, (0,0,±1,0) in clip space
    const ex = inv[8], ey = inv[9], ez = inv[10], ew = inv[11];
    if (Math.abs(ew) < 1e-30) return;
    const eye = [ex / ew, ey / ew, ez / ew];

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao!);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    const L = this.loc;
    gl.uniformMatrix4fv(L.u_mvp, false, new Float32Array(mvp));
    gl.uniform3f(L.u_eye, eye[0], eye[1], eye[2]);
    const h = v.hdr;
    gl.uniform1i(L.u_proj, h.proj === "latlon" ? 1 : 0);
    gl.uniform3f(L.u_dims, h.nx, h.ny, h.nz);
    gl.uniform2f(L.u_off, geo.off[0], geo.off[1]);
    gl.uniform2f(L.u_size, sx, sy);
    gl.uniform1f(L.u_cy, geo.ref.y);
    gl.uniform1f(L.u_lat0, (geo.latc * Math.PI) / 180);
    gl.uniform1f(L.u_lonc, geo.lonc);
    gl.uniform2f(L.u_ext, geo.ext[0], geo.ext[1]);
    gl.uniform4f(L.u_ll, h.lon0 ?? 0, h.lat0 ?? 0, h.dlon ?? 1, h.dlat ?? 1);
    gl.uniform2f(L.u_h, geo.h[0], geo.h[1]);
    gl.uniform2f(L.u_zgrid, h.z0 ?? 0, h.dz ?? 1);
    gl.uniform3f(L.u_mstep, geo.mstep[0], geo.mstep[1], geo.mstep[2]);
    gl.uniform1f(L.u_exag, P.exag);
    gl.uniform1f(L.u_scale, h.scale || 1);
    gl.uniform1f(L.u_offset, h.offset || 0);
    gl.uniform1f(L.u_cmin, t.min);
    gl.uniform1f(L.u_cmax, t.max);
    gl.uniform1f(L.u_thr, P.threshold);
    gl.uniform1f(L.u_soft, Math.max(1e-3, (t.max - t.min) * 0.03));
    gl.uniform1i(L.u_abs, P.absValue ? 1 : 0);
    gl.uniform1f(L.u_density, P.density);
    gl.uniform1i(L.u_shade, P.shade ? 1 : 0);
    gl.uniform1i(L.u_maxSteps, this.moving ? this.movingSteps : this.steps);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, g.tex);
    const filt = P.smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filt);
    gl.uniform1i(L.u_vol, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex(t));
    gl.uniform1i(L.u_cmap, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, g.lev);
    gl.uniform1i(L.u_lev, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.depthMask(true);
  }
}
