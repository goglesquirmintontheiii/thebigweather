// WebGL2 volumetric radar renderer (MapLibre custom layer).
// A 3D grid of u8 voxels (Level II volume resampled by the server, or MRMS 3D mosaic) is uploaded
// as a TEXTURE_3D and ray-marched inside a box placed in mercator space. Colors come from the same
// color table as the 2D layer so the legend still applies.
//
// Binary format (/api/radar/volume3d, /api/grid/volume3d): u32 LE header length, JSON header
// (VolHeader), then nx*ny*nz bytes, x fastest, then y (south→north), then z (bottom→top);
// byte 0 = no data, value = (byte - offset) / scale.
//
// Two render modes:
//  - "iso": up to three threshold shells. Each ray finds every entering crossing of each shell,
//    refines it by bisection, takes the normal from the central-difference gradient of the
//    (CPU-smoothed) field and shades it with Blinn-Phong (sun + headlight) and a short
//    ambient-occlusion probe along the normal. Shells are composited front to back with their
//    own opacity, so inner cores show through translucent outer shells.
//  - "volume": emission/absorption ray march with a steep value→opacity transfer function and
//    optional height colouring.
// Optional cues: horizontal planes every 5 km, a height axis with ticks and echo-top markers
// (labels are handed to the UI through onLabels), and pick() for a hover readout.

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

export type V3Mode = "iso" | "volume";
export interface IsoShell {
  value: number;
  /** 0..1 */
  opacity: number;
  on: boolean;
}

export interface VolParams {
  mode: V3Mode;
  /** volume mode: show only values ≥ threshold (product units) */
  threshold: number;
  /** compare |value| (velocity) */
  absValue: boolean;
  /** volume mode opacity multiplier */
  density: number;
  /** vertical exaggeration */
  exag: number;
  /** CPU-smoothed field + trilinear filtering vs raw nearest voxels */
  smooth: boolean;
  /** lighting */
  shade: boolean;
  /** iso mode shells (≤ 3) */
  iso: IsoShell[];
  /** volume mode: colour by height instead of value */
  heightColor: boolean;
  /** height axis + echo-top markers */
  tops: boolean;
  /** faint horizontal planes every 5 km */
  planes: boolean;
  /** axis/label units */
  heightUnit: "km" | "kft";
}

export interface Label {
  x: number;
  y: number;
  text: string;
  kind: "tick" | "top" | "core";
}

export interface Pick {
  lon: number;
  lat: number;
  /** height of the first surface hit (m, grid heights) */
  h: number;
  /** value at the hit and the strongest value further along the ray inside the echo */
  value: number;
  max: number;
  maxH: number;
  /** horizontal distance from the radar (aeqd only), m */
  range?: number;
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
uniform sampler3D u_vol;     // RG8: r = byte*mask/255, g = mask (both smoothed on the CPU)
uniform sampler2D u_cmap;
uniform sampler2D u_lev;     // latlon: box z -> fractional level index (256 x 1, R32F)
uniform sampler3D u_brick;   // empty-space skipping: RG8 min/max byte per brick, dilated by one brick
uniform vec3 u_bskip;        // box-local length of one brick per axis (conservative)
uniform float u_skipThr;     // nothing below this value is drawn
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
uniform vec3 u_vs;           // voxel size in metres (z exaggerated)
uniform float u_exag;
uniform float u_scale;
uniform float u_offset;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_thr;
uniform float u_floor;       // value used for no data (below every threshold)
uniform float u_unit;        // ~2% of the table range
uniform int u_abs;
uniform float u_density;
uniform int u_shade;
uniform int u_maxSteps;
uniform int u_mode;          // 0 iso, 1 volume
uniform int u_isoN;
uniform vec3 u_iso;          // shell values (ascending)
uniform vec3 u_isoA;         // shell opacities
uniform vec3 u_isoC0;
uniform vec3 u_isoC1;
uniform vec3 u_isoC2;
uniform vec3 u_sun;          // east, north, up
uniform int u_hcol;
uniform int u_planes;
uniform float u_pxm;         // metres per screen pixel near the volume

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

// product value at a texture coordinate; no data fades to u_floor so shells close smoothly
float fieldTc(vec3 tc) {
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return u_floor;
  vec2 s = texture(u_vol, tc).rg;
  if (s.g < 0.004) return u_floor;
  float v = (s.r / s.g * 255.0 - u_offset) / u_scale;
  if (u_abs == 1) v = abs(v);
  return mix(u_floor, v, smoothstep(0.06, 0.4, s.g));
}
float fieldAt(vec3 p) { return fieldTc(texCoord(p)); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 heightRamp(float km) {
  float x = clamp(km / 16.0, 0.0, 1.0);
  vec3 c = mix(vec3(0.20, 0.35, 0.95), vec3(0.10, 0.80, 0.95), smoothstep(0.0, 0.25, x));
  c = mix(c, vec3(0.25, 0.90, 0.35), smoothstep(0.25, 0.45, x));
  c = mix(c, vec3(1.00, 0.88, 0.15), smoothstep(0.45, 0.65, x));
  c = mix(c, vec3(1.00, 0.45, 0.12), smoothstep(0.65, 0.82, x));
  c = mix(c, vec3(1.00, 0.55, 0.95), smoothstep(0.82, 1.0, x));
  return c;
}

vec4 planeCol(vec3 p) {
  vec2 m = p.xy * u_mstep.xy;
  vec2 gd = abs(fract(m / 25000.0 + 0.5) - 0.5) * 25000.0;
  float w = max(u_pxm, 50.0);
  float line = 1.0 - smoothstep(0.3 * w, 0.9 * w, min(gd.x, gd.y));
  float a = 0.025 + 0.07 * line;
  return vec4(vec3(0.78, 0.88, 1.0) * a, a);
}

// shade a shell crossing at box-local p; returns premultiplied colour
vec4 shadeIso(vec3 p, int k, vec3 V) {
  vec3 tc = texCoord(p);
  vec3 e = 1.0 / u_dims;
  float th = k == 0 ? u_iso.x : (k == 1 ? u_iso.y : u_iso.z);
  vec3 g = vec3(
    fieldTc(tc + vec3(e.x, 0.0, 0.0)) - fieldTc(tc - vec3(e.x, 0.0, 0.0)),
    fieldTc(tc + vec3(0.0, e.y, 0.0)) - fieldTc(tc - vec3(0.0, e.y, 0.0)),
    fieldTc(tc + vec3(0.0, 0.0, e.z)) - fieldTc(tc - vec3(0.0, 0.0, e.z))) / (2.0 * u_vs);
  float gl = length(g);
  vec3 n = gl > 1e-12 ? -g / gl : V;
  if (dot(n, V) < 0.0) n = -n;
  vec3 base = k == 0 ? u_isoC0 : (k == 1 ? u_isoC1 : u_isoC2);
  float a = k == 0 ? u_isoA.x : (k == 1 ? u_isoA.y : u_isoA.z);
  if (u_shade == 0) return vec4(base * a, a);
  // ambient occlusion: is there echo just outside the surface along the normal?
  vec3 di = n / u_vs;
  di /= max(length(di), 1e-9);
  float lo = th - 6.0 * u_unit, hi = th + 2.0 * u_unit;
  float occ = 0.45 * smoothstep(lo, hi, fieldTc(tc + di * 1.5 * e))
            + 0.35 * smoothstep(lo, hi, fieldTc(tc + di * 3.5 * e))
            + 0.20 * smoothstep(lo, hi, fieldTc(tc + di * 7.0 * e));
  float ao = 1.0 - 0.85 * occ;
  float ndl = max(dot(n, u_sun), 0.0);
  float ndv = max(dot(n, V), 0.0);
  vec3 H = normalize(u_sun + V);
  float spec = pow(max(dot(n, H), 0.0), 42.0) * 0.32 + pow(ndv, 24.0) * 0.08;
  float lit = 0.2 * ao + 0.78 * ndl * (0.45 + 0.55 * ao) + 0.22 * ndv;
  // brighter toward the top so towers read as peaks
  float hz = clamp(p.z, 0.0, 1.0);
  vec3 col = base * lit * (0.86 + 0.34 * hz) + vec3(spec * ao);
  // silhouettes of translucent shells stay visible
  if (a < 0.999) a = a + (1.0 - a) * 0.55 * pow(1.0 - ndv, 3.0);
  return vec4(col * a, a);
}

// faint planes crossed in (ta, tb]
void addPlanes(inout vec4 acc, vec3 o, vec3 d, float ta, float tb) {
  if (u_planes == 0 || abs(d.z) < 1e-6) return;
  float hz0 = u_h.x, hzs = u_h.y - u_h.x;
  for (int k = 1; k <= 4; k++) {
    float zk = (float(k) * 5000.0 - hz0) / hzs;
    if (zk <= 0.0 || zk >= 1.0) continue;
    float tk = (zk - o.z) / d.z;
    if (tk > ta && tk <= tb) acc += (1.0 - acc.a) * planeCol(o + d * tk);
  }
}

// true when the brick around tc (and its neighbours) has nothing at or above u_skipThr
bool emptyBrick(vec3 tc) {
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return true;
  vec2 mm = texture(u_brick, tc).rg * 255.0;
  if (mm.g < 0.5) return true;
  float bmax = u_abs == 1 ? max(abs((mm.r - u_offset) / u_scale), abs((mm.g - u_offset) / u_scale)) : (mm.g - u_offset) / u_scale;
  return bmax < u_skipThr;
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
  vec3 span = d * (tfar - tnear) * u_dims;
  float nvox = length(span);
  int n = int(clamp(nvox * (u_mode == 0 ? 1.1 : 1.4), 24.0, float(u_maxSteps)));
  float dt = (tfar - tnear) / float(n);
  float dkm = length(d * dt * u_mstep) * 0.001;
  // view direction in east/north/up metres (box y runs north→south)
  vec3 V = -normalize(vec3(d.x * u_mstep.x, -d.y * u_mstep.y, d.z * u_mstep.z * u_exag));
  float t = tnear + dt * (0.25 + 0.5 * hash(gl_FragCoord.xy));
  float tPrev = tnear;
  float tPl = tnear;           // planes drawn up to here
  float fPrev = u_floor;
  // longest jump that stays within one brick on every axis
  vec3 ad = max(abs(d), vec3(1e-6));
  float tSkip = min(min(u_bskip.x / ad.x, u_bskip.y / ad.y), u_bskip.z / ad.z);
  bool canSkip = tSkip > 2.0 * dt;
  vec4 acc = vec4(0.0);
  vec3 vox = 1.0 / u_dims;
  int steps = 0;
  if (u_mode == 0) {
    // isosurfaces: a light inner loop finds the next shell crossing; refinement and shading run
    // once per hit (keeps the per-step cost low and divergence small)
    bool done = false;
    for (int hit = 0; hit < 12; hit++) {
      if (done || acc.a >= 0.985) break;
      int kHit = -1;
      for (int i = 0; i < 1100; i++) {
        if (steps >= 1100) { done = true; break; }
        steps++;
        t = min(t, tfar);
        vec3 tcp = texCoord(o + d * t);
        if (canSkip && t + tSkip < tfar && emptyBrick(tcp)) {
          addPlanes(acc, o, d, tPl, t + tSkip);
          tPl = t + tSkip;
          tPrev = t + tSkip;
          t = tPrev + dt * 0.5;
          fPrev = u_floor;
          continue;
        }
        if (t > tPl) {
          addPlanes(acc, o, d, tPl, t);
          tPl = t;
        }
        float f = fieldTc(tcp);
        if (u_isoN > 0 && fPrev < u_iso.x && f >= u_iso.x) { kHit = 0; break; }
        if (u_isoN > 1 && fPrev < u_iso.y && f >= u_iso.y) { kHit = 1; break; }
        if (u_isoN > 2 && fPrev < u_iso.z && f >= u_iso.z) { kHit = 2; break; }
        if (t >= tfar) { done = true; break; }
        fPrev = f;
        tPrev = t;
        t += dt;
      }
      if (kHit < 0) break;
      float th = kHit == 0 ? u_iso.x : (kHit == 1 ? u_iso.y : u_iso.z);
      float a = tPrev, b = t;
      for (int j = 0; j < 6; j++) {
        float m = 0.5 * (a + b);
        if (fieldAt(o + d * m) >= th) b = m; else a = m;
      }
      acc += (1.0 - acc.a) * shadeIso(o + d * b, kHit, V);
      // a stronger shell may be entered in the same step: re-test this sample from just above th
      fPrev = th;
    }
  } else {
    for (int i = 0; i < 1100; i++) {
      if (acc.a >= 0.985) break;
      t = min(t, tfar);
      vec3 p = o + d * t;
      vec3 tc = texCoord(p);
      if (canSkip && t + tSkip < tfar && emptyBrick(tc)) {
        addPlanes(acc, o, d, tPrev, t + tSkip);
        tPrev = t + tSkip;
        t = tPrev + dt * 0.5;
        continue;
      }
      addPlanes(acc, o, d, tPrev, t);
      float tv = fieldTc(tc);
      if (tv >= u_thr) {
        float x = clamp((tv - u_thr) / max(u_cmax - u_thr, 1e-3), 0.0, 1.0);
        // steep transfer function: weak echo stays a faint haze, cores turn opaque quickly
        float op = smoothstep(0.0, 0.05, x) * (0.07 + 5.0 * x * x * sqrt(x));
        float a = 1.0 - exp(-op * u_density * 0.8 * dkm);
        if (a > 0.002) {
          vec3 rgb;
          if (u_hcol == 1) rgb = heightRamp(mix(u_h.x, u_h.y, p.z) * 0.001) * (0.55 + 0.6 * x);
          else {
            vec2 rs = texture(u_vol, tc).rg;
            float sv = u_abs == 1 ? sign(rs.r / max(rs.g, 1e-4) * 255.0 - u_offset) * tv : tv;
            rgb = texture(u_cmap, vec2(clamp((sv - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5)).rgb;
          }
          if (u_shade == 1) {
            vec3 g = vec3(
              fieldTc(tc + vec3(vox.x, 0.0, 0.0)) - tv,
              fieldTc(tc + vec3(0.0, vox.y, 0.0)) - tv,
              fieldTc(tc + vec3(0.0, 0.0, vox.z)) - tv) / u_vs;
            float gl = length(g);
            float lit = 0.75;
            if (gl > 1e-9) {
              vec3 nn = -g / gl;
              lit = 0.42 + 0.55 * max(dot(nn, u_sun), 0.0) + 0.2 * max(dot(nn, V), 0.0);
            }
            rgb *= lit;
          }
          acc.rgb += (1.0 - acc.a) * rgb * a;
          acc.a += (1.0 - acc.a) * a;
        }
      }
      if (t >= tfar) break;
      tPrev = t;
      t += dt;
    }
  }
  if (acc.a < 0.004) discard;
  fragColor = acc;
}`;

const LINE_VS = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
in vec4 a_col;
out vec4 v_col;
void main() { v_col = a_col; gl_Position = u_mvp * vec4(a_pos, 1.0); }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 frag;
void main() { frag = vec4(v_col.rgb * v_col.a, v_col.a); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
  return s;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
  return p;
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

const R_EARTH = 6371000;
const D2R = Math.PI / 180;

/** Box placement in mercator for a volume (independent of exaggeration). */
export function volumeGeo(hdr: VolHeader): Geo {
  const R = R_EARTH;
  const d2r = D2R;
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

// ---------- CPU helpers (picking, markers, camera aim) ----------

/** Voxel index (continuous, cell centre = integer) of a box-local point; also lon/lat/height. */
function localToIdx(hdr: VolHeader, geo: Geo, p: ArrayLike<number>) {
  const mx = geo.off[0] + p[0] * geo.size[0];
  const my = geo.ref.y + geo.off[1] + p[1] * geo.size[1];
  const lat = 2 * Math.atan(Math.exp(Math.PI * (1 - 2 * my))) - Math.PI / 2;
  const h = geo.h[0] + p[2] * (geo.h[1] - geo.h[0]);
  const lon = geo.lonc + mx * 360;
  let fx: number, fy: number, fz: number;
  if (hdr.proj === "aeqd") {
    const xm = R_EARTH * Math.cos(lat) * mx * 2 * Math.PI;
    const ym = R_EARTH * (lat - geo.latc * D2R);
    fx = (xm + geo.ext[0] / 2) / hdr.dx! - 0.5;
    fy = (ym + geo.ext[1] / 2) / hdr.dy! - 0.5;
    fz = (h - hdr.z0!) / hdr.dz!;
  } else {
    fx = (lon - hdr.lon0!) / hdr.dlon!;
    fy = (lat / D2R - hdr.lat0!) / hdr.dlat!;
    const lv = hdr.levels ?? [];
    let k = 0;
    while (k < lv.length - 2 && lv[k + 1] < h) k++;
    fz = lv.length > 1 ? k + (h - lv[k]) / (lv[k + 1] - lv[k]) : 0;
  }
  return { fx, fy, fz, lon, lat: lat / D2R, h };
}

/** Box-local point for lon/lat/height. */
function lonLatToLocal(geo: Geo, lon: number, lat: number, h: number): [number, number, number] {
  const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
  return [(m.x - geo.ref.x - geo.off[0]) / geo.size[0], (m.y - geo.ref.y - geo.off[1]) / geo.size[1], (h - geo.h[0]) / (geo.h[1] - geo.h[0])];
}

/** lon/lat of voxel column (ix, iy) and its height for level iz. */
function voxelLonLat(hdr: VolHeader, ix: number, iy: number): [number, number] {
  if (hdr.proj === "aeqd") {
    const xm = (ix + 0.5) * hdr.dx! - (hdr.nx * hdr.dx!) / 2;
    const ym = (iy + 0.5) * hdr.dy! - (hdr.ny * hdr.dy!) / 2;
    const lat = hdr.lat! + ym / R_EARTH / D2R;
    const lon = hdr.lon! + xm / (R_EARTH * Math.cos(lat * D2R)) / D2R;
    return [lon, lat];
  }
  return [hdr.lon0! + ix * hdr.dlon!, hdr.lat0! + iy * hdr.dlat!];
}
function voxelHeight(hdr: VolHeader, iz: number): number {
  return hdr.proj === "aeqd" ? hdr.z0! + iz * hdr.dz! : hdr.levels?.[iz] ?? 0;
}

/** byte -> passes threshold lookup */
function passTable(hdr: VolHeader, thr: number, abs: boolean): Uint8Array {
  const t = new Uint8Array(256);
  const sc = hdr.scale || 1, of = hdr.offset || 0;
  for (let b = 1; b < 256; b++) {
    const v = (b - of) / sc;
    t[b] = (abs ? Math.abs(v) : v) >= thr ? 1 : 0;
  }
  return t;
}

/** Highest voxel ≥ thr: column, height. */
export function echoTop(v: Volume, thr: number, abs = false): { lon: number; lat: number; h: number } | null {
  const { nx, ny, nz } = v.hdr;
  const ok = passTable(v.hdr, thr, abs);
  const d = v.data;
  const plane = nx * ny;
  for (let z = nz - 1; z >= 0; z--) {
    // the highest level with at least a couple of passing voxels (one is often noise)
    let best = -1, cnt = 0;
    const base = z * plane;
    for (let i = 0; i < plane; i++)
      if (ok[d[base + i]]) {
        cnt++;
        // prefer a voxel with a passing neighbour below
        if (best < 0 || (z > 0 && ok[d[base - plane + i]])) best = i;
      }
    if (cnt >= 3 && best >= 0) {
      const [lon, lat] = voxelLonLat(v.hdr, best % nx, Math.floor(best / nx));
      return { lon, lat, h: voxelHeight(v.hdr, z) };
    }
  }
  return null;
}

/** Echo-weighted centre of the storms and, for radar volumes, the bearing from there to the radar. */
export function volumeAim(v: Volume, thr: number, abs = false): { lon: number; lat: number; bearing: number | null; spreadKm: number } | null {
  const { nx, ny, nz } = v.hdr;
  const ok = passTable(v.hdr, thr, abs);
  const d = v.data;
  const sc = v.hdr.scale || 1, of = v.hdr.offset || 0;
  let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  const plane = nx * ny;
  const zs = Math.max(1, Math.floor(nz / 16));
  for (let z = 0; z < nz; z += zs)
    for (let i = 0; i < plane; i++) {
      const b = d[z * plane + i];
      if (!ok[b]) continue;
      const val = Math.abs((b - of) / sc) - thr;
      const w = 1 + val * val;
      const x = i % nx, y = (i / nx) | 0;
      sw += w;
      sx += w * x;
      sy += w * y;
      sxx += w * x * x;
      syy += w * y * y;
    }
  if (sw <= 0) return null;
  const cx = sx / sw, cy = sy / sw;
  const sdx = Math.sqrt(Math.max(0, sxx / sw - cx * cx)), sdy = Math.sqrt(Math.max(0, syy / sw - cy * cy));
  const [lon, lat] = voxelLonLat(v.hdr, cx, cy);
  const cell = v.hdr.proj === "aeqd" ? v.hdr.dx! / 1000 : v.hdr.dlat! * 111.2;
  const spreadKm = Math.max(sdx, sdy) * cell;
  let bearing: number | null = null;
  if (v.hdr.proj === "aeqd") {
    const p1 = lat * D2R, p2 = v.hdr.lat! * D2R, dl = (v.hdr.lon! - lon) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const distKm = Math.hypot((v.hdr.lon! - lon) * 111.2 * Math.cos(p1), (v.hdr.lat! - lat) * 111.2);
    if (distKm > 8) bearing = Math.atan2(y, x) / D2R;
  }
  return { lon, lat, bearing, spreadKm };
}

/** Trilinear sample (no-data aware) at a continuous voxel index; NaN when there is no data. */
function sampleIdx(v: Volume, fx: number, fy: number, fz: number, abs: boolean): number {
  const { nx, ny, nz } = v.hdr;
  if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > nx - 0.5 || fy > ny - 0.5 || fz > nz - 0.5) return NaN;
  const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(ny - 1, Math.floor(fy))), z0 = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0)), tz = Math.max(0, Math.min(1, fz - z0));
  const d = v.data;
  let s = 0, w = 0;
  const add = (x: number, y: number, z: number, k: number) => {
    const b = d[(z * ny + y) * nx + x];
    if (b && k > 0) {
      s += b * k;
      w += k;
    }
  };
  add(x0, y0, z0, (1 - tx) * (1 - ty) * (1 - tz));
  add(x1, y0, z0, tx * (1 - ty) * (1 - tz));
  add(x0, y1, z0, (1 - tx) * ty * (1 - tz));
  add(x1, y1, z0, tx * ty * (1 - tz));
  add(x0, y0, z1, (1 - tx) * (1 - ty) * tz);
  add(x1, y0, z1, tx * (1 - ty) * tz);
  add(x0, y1, z1, (1 - tx) * ty * tz);
  add(x1, y1, z1, tx * ty * tz);
  if (w < 0.35) return NaN;
  const val = (s / w - (v.hdr.offset || 0)) / (v.hdr.scale || 1);
  return abs ? Math.abs(val) : val;
}

/** Separable [1 2 1] blur of value*mask and mask, then RG8 (r = smoothed b*m, g = smoothed mask). */
function buildRG(v: Volume, smooth: boolean): Uint8Array {
  const src = v.data;
  const n = src.length;
  const rg = new Uint8Array(n * 2);
  if (!smooth) {
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      const b = src[i];
      rg[j] = b;
      rg[j + 1] = b ? 255 : 0;
    }
    return rg;
  }
  const { nx, ny, nz } = v.hdr;
  // fixed point ×64 so three passes keep precision in u16
  const r = new Uint16Array(n), g = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const b = src[i];
    r[i] = b << 6;
    g[i] = b ? 255 << 6 : 0;
  }
  const line = new Uint16Array(Math.max(nx, ny, nz) * 2);
  const pass = (len: number, stride: number, starts: (cb: (s: number) => void) => void) => {
    if (len < 3) return;
    starts((s) => {
      for (let k = 0; k < len; k++) {
        line[k * 2] = r[s + k * stride];
        line[k * 2 + 1] = g[s + k * stride];
      }
      for (let k = 0; k < len; k++) {
        const a = k > 0 ? k - 1 : 0, c = k < len - 1 ? k + 1 : len - 1;
        const i = s + k * stride;
        r[i] = (line[a * 2] + 2 * line[k * 2] + line[c * 2] + 2) >> 2;
        g[i] = (line[a * 2 + 1] + 2 * line[k * 2 + 1] + line[c * 2 + 1] + 2) >> 2;
      }
    });
  };
  pass(nx, 1, (cb) => {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) cb((z * ny + y) * nx);
  });
  pass(ny, nx, (cb) => {
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) cb(z * ny * nx + x);
  });
  pass(nz, nx * ny, (cb) => {
    for (let i = 0; i < nx * ny; i++) cb(i);
  });
  // shader computes r/g·255 = mean byte with g = Σw·m (×255) → r (byte units) = Σw·b·m
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    rg[j] = Math.min(255, Math.round(r[i] / 64));
    rg[j + 1] = Math.min(255, Math.round(g[i] / 64));
  }
  return rg;
}

/** Brick size (voxels) for empty-space skipping. */
const BRICK = [8, 8, 4];

/** Per-brick min/max valid byte (RG8, g = 0: empty), dilated by one brick so a jump of one brick is safe. */
function buildBricks(v: Volume): { data: Uint8Array; bx: number; by: number; bz: number } {
  const { nx, ny, nz } = v.hdr;
  const bx = Math.ceil(nx / BRICK[0]), by = Math.ceil(ny / BRICK[1]), bz = Math.ceil(nz / BRICK[2]);
  const nb = bx * by * bz;
  const mn = new Uint8Array(nb).fill(255), mx = new Uint8Array(nb);
  const d = v.data;
  for (let z = 0; z < nz; z++) {
    const kz = ((z / BRICK[2]) | 0) * by;
    for (let y = 0; y < ny; y++) {
      const ky = (kz + ((y / BRICK[1]) | 0)) * bx;
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) {
        const b = d[row + x];
        if (!b) continue;
        const k = ky + ((x / BRICK[0]) | 0);
        if (b < mn[k]) mn[k] = b;
        if (b > mx[k]) mx[k] = b;
      }
    }
  }
  const out = new Uint8Array(nb * 2);
  for (let z = 0; z < bz; z++)
    for (let y = 0; y < by; y++)
      for (let x = 0; x < bx; x++) {
        let lo = 255, hi = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= bz) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= by) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= bx) continue;
              const k = (zz * by + yy) * bx + xx;
              if (mx[k]) {
                if (mn[k] < lo) lo = mn[k];
                if (mx[k] > hi) hi = mx[k];
              }
            }
          }
        }
        const o = ((z * by + y) * bx + x) * 2;
        out[o] = hi ? lo : 0;
        out[o + 1] = hi;
      }
  return { data: out, bx, by, bz };
}

interface GpuVol {
  tex: WebGLTexture;
  lev: WebGLTexture;
  brick: WebGLTexture;
  smooth: boolean;
  used: number;
}

export class Volume3DLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;
  vol: Volume | null = null;
  table: ColorTable | null = null;
  params: VolParams = {
    mode: "iso",
    threshold: 20,
    absValue: false,
    density: 1,
    exag: 4,
    smooth: true,
    shade: true,
    iso: [
      { value: 20, opacity: 0.25, on: true },
      { value: 40, opacity: 0.55, on: true },
      { value: 55, opacity: 1, on: true },
    ],
    heightColor: false,
    tops: false,
    planes: false,
    heightUnit: "km",
  };
  /** ray-march step cap while idle / while the camera moves (adapted to frame time) */
  steps = 384;
  movingSteps = 160;
  /** set when the GPU can't do this (no 3D textures etc.) */
  error: string | null = null;
  /** screen labels for the height axis / echo tops (CSS px) */
  onLabels?: (l: Label[]) => void;
  private map?: MLMap;
  private gl?: WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private lineProg?: WebGLProgram;
  private vao?: WebGLVertexArrayObject;
  private vbo?: WebGLBuffer;
  private lineVao?: WebGLVertexArrayObject;
  private lineVbo?: WebGLBuffer;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private gpu = new Map<Volume, GpuVol>();
  private cmaps = new Map<ColorTable, WebGLTexture>();
  private rasters = new Map<ColorTable, Uint8Array>();
  private tops = new Map<string, ReturnType<typeof echoTop>>();
  private moving = false;
  private lastFrame = 0;
  private lastMvp: Float64Array | null = null;
  private lastLabelsKey = "";
  private onMoveStart = () => {
    this.moving = true;
    this.lastFrame = 0;
  };
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
      this.prog = program(gl, VS, FS);
      this.lineProg = program(gl, LINE_VS, LINE_FS);
    } catch (e: any) {
      this.error = `3D shader: ${e.message}`;
      console.error(this.error);
      return;
    }
    const p = this.prog;
    for (const n of ["u_mvp", "u_eye", "u_vol", "u_cmap", "u_lev", "u_proj", "u_dims", "u_off", "u_size", "u_cy", "u_lat0", "u_lonc", "u_ext", "u_ll", "u_h", "u_zgrid", "u_mstep", "u_vs", "u_exag", "u_scale", "u_offset", "u_cmin", "u_cmax", "u_thr", "u_floor", "u_unit", "u_abs", "u_density", "u_shade", "u_maxSteps", "u_mode", "u_isoN", "u_iso", "u_isoA", "u_isoC0", "u_isoC1", "u_isoC2", "u_sun", "u_hcol", "u_planes", "u_pxm", "u_brick", "u_bskip", "u_skipThr"])
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
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    const lp = gl.getAttribLocation(this.lineProg, "a_pos");
    const lc = gl.getAttribLocation(this.lineProg, "a_col");
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(lc);
    gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
    map.triggerRepaint();
  }

  onRemove() {
    const gl = this.gl;
    this.map?.off("movestart", this.onMoveStart);
    this.map?.off("moveend", this.onMoveEnd);
    this.onLabels?.([]);
    if (!gl) return;
    for (const g of this.gpu.values()) this.freeGpu(g);
    this.gpu.clear();
    for (const t of this.cmaps.values()) gl.deleteTexture(t);
    this.cmaps.clear();
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.lineProg) gl.deleteProgram(this.lineProg);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.lineVbo) gl.deleteBuffer(this.lineVbo);
    if (this.lineVao) gl.deleteVertexArray(this.lineVao);
    this.prog = undefined;
    this.gl = undefined;
  }

  setVolume(v: Volume | null) {
    if (v !== this.vol) this.tops.clear();
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
    this.rasters.delete(t);
  }

  /** Active shells, ascending. */
  shells(): IsoShell[] {
    return this.params.iso.filter((s) => s.on && s.opacity > 0).sort((a, b) => a.value - b.value).slice(0, 3);
  }

  colorOf(v: number): [number, number, number] {
    const t = this.table!;
    let r = this.rasters.get(t);
    if (!r) this.rasters.set(t, (r = rasterize(t)));
    const i = Math.max(0, Math.min(TEX_SIZE - 1, Math.floor(((v - t.min) / (t.max - t.min)) * TEX_SIZE)));
    return [r[i * 4] / 255, r[i * 4 + 1] / 255, r[i * 4 + 2] / 255];
  }

  private freeGpu(g: GpuVol) {
    this.gl?.deleteTexture(g.tex);
    this.gl?.deleteTexture(g.lev);
    this.gl?.deleteTexture(g.brick);
  }

  private upload(v: Volume, smooth: boolean): GpuVol {
    const gl = this.gl!;
    const { nx, ny, nz } = v.hdr;
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (nx > max || ny > max || nz > max) throw new Error(`volume ${nx}×${ny}×${nz} exceeds GPU limit ${max}`);
    // RG8: value byte·mask + mask, so linear filtering can be renormalised around missing data
    const rg = buildRG(v, smooth);
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
    const bk = buildBricks(v);
    const brick = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, brick);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, bk.bx, bk.by, bk.bz, 0, gl.RG, gl.UNSIGNED_BYTE, bk.data);
    const g = { tex, lev, brick, smooth, used: performance.now() };
    const old = this.gpu.get(v);
    if (old) this.freeGpu(old);
    this.gpu.set(v, g);
    // keep at most a few volumes on the GPU (animation flips between neighbours)
    if (this.gpu.size > 3) {
      const o = [...this.gpu.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.freeGpu(o[1]);
      this.gpu.delete(o[0]);
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

  private topOf(v: Volume, thr: number) {
    const k = `${thr}|${this.params.absValue}`;
    if (!this.tops.has(k)) this.tops.set(k, echoTop(v, thr, this.params.absValue));
    return this.tops.get(k)!;
  }

  /** Box-local -> CSS px (null when behind the camera). */
  private project(mvp: Float64Array, p: ArrayLike<number>): [number, number] | null {
    const c = this.map!.getCanvas();
    const x = mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12];
    const y = mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13];
    const w = mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15];
    if (w <= 1e-9) return null;
    return [((x / w + 1) / 2) * c.clientWidth, ((1 - y / w) / 2) * c.clientHeight];
  }

  /** Height axis, ticks and echo-top markers as GL lines; labels go to onLabels. */
  private drawCues(gl: WebGL2RenderingContext, v: Volume, geo: Geo, mvp: Float64Array) {
    const P = this.params;
    const labels: Label[] = [];
    const verts: number[] = [];
    const line = (a: number[], b: number[], c: number[]) => verts.push(...a, ...c, ...b, ...c);
    const hz = (h: number) => (h - geo.h[0]) / (geo.h[1] - geo.h[0]);
    // axis at the radar (aeqd) or the SW corner (lat/lon mosaic)
    const ax = 0.5 * (v.hdr.proj === "aeqd" ? 1 : 0), ay = v.hdr.proj === "aeqd" ? 0.5 : 1;
    const top = geo.h[1];
    const kft = P.heightUnit === "kft";
    const unitM = kft ? 304.8 : 1000;
    const minor = kft ? 5 : 1, major = kft ? 10 : 5;
    const white = [1, 1, 1, 0.85], dim = [1, 1, 1, 0.5];
    line([ax, ay, 0], [ax, ay, 1], white);
    // tick length ~2% of the box in each horizontal direction (aspect corrected)
    const tl = 0.012, tly = tl * (geo.size[0] / geo.size[1]);
    for (let u = minor; u * unitM < top; u += minor) {
      const z = hz(u * unitM);
      if (z <= 0) continue;
      const big = u % major === 0;
      const k = big ? 2.2 : 1;
      line([ax - tl * k, ay, z], [ax + tl * k, ay, z], big ? white : dim);
      line([ax, ay - tly * k, z], [ax, ay + tly * k, z], big ? white : dim);
      if (big) {
        const s = this.project(mvp, [ax + tl * 2.6, ay, z]);
        if (s) labels.push({ x: s[0], y: s[1], text: `${u} ${kft ? "kft" : "km"}`, kind: "tick" });
      }
    }
    // echo tops of the weakest and strongest active levels
    const sh = P.mode === "iso" ? this.shells() : [];
    const lvls = P.mode === "iso" ? (sh.length ? [sh[0], sh.length > 1 ? sh[sh.length - 1] : null] : []) : [{ value: P.threshold }];
    const cols = [[1, 0.93, 0.35, 0.95], [1, 0.35, 0.35, 0.95]];
    lvls.forEach((s, i) => {
      if (!s) return;
      const t = this.topOf(v, s.value);
      if (!t) return;
      const z = hz(t.h);
      const p = lonLatToLocal(geo, t.lon, t.lat, t.h);
      const c = cols[i];
      line([p[0], p[1], 0], [p[0], p[1], z], [c[0], c[1], c[2], 0.55]);
      line([p[0] - tl, p[1], z], [p[0] + tl, p[1], z], c);
      line([p[0], p[1] - tly, z], [p[0], p[1] + tly, z], c);
      const sp = this.project(mvp, [p[0], p[1], z]);
      const hv = t.h / unitM;
      if (sp) labels.push({ x: sp[0], y: sp[1], text: `▲ ${hv.toFixed(1)} ${kft ? "kft" : "km"} · ${s.value}${this.table?.units ? " " + this.table.units : ""} top`, kind: i ? "core" : "top" });
    });
    const arr = new Float32Array(verts);
    gl.useProgram(this.lineProg!);
    gl.bindVertexArray(this.lineVao!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo!);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg!, "u_mvp"), false, new Float32Array(mvp));
    gl.drawArrays(gl.LINES, 0, arr.length / 7);
    const key = labels.map((l) => `${l.x.toFixed(0)},${l.y.toFixed(0)},${l.text}`).join("|");
    if (key !== this.lastLabelsKey) {
      this.lastLabelsKey = key;
      this.onLabels?.(labels);
    }
  }

  /** Raycast from a CSS pixel to the first visible surface. */
  pick(px: number, py: number): Pick | null {
    const v = this.vol, mvp = this.lastMvp, map = this.map;
    if (!v || !mvp || !map) return null;
    const inv = invert(mvp);
    if (!inv) return null;
    const c = map.getCanvas();
    const nx = (px / c.clientWidth) * 2 - 1, ny = 1 - (py / c.clientHeight) * 2;
    const un = (z: number) => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13];
      const zz = inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15];
      return [x / w, y / w, zz / w];
    };
    const a = un(-1), b = un(1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    // clip to the unit box
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) {
        if (a[k] < 0 || a[k] > 1) return null;
        continue;
      }
      let ta = (0 - a[k]) / d[k], tb = (1 - a[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (t0 >= t1) return null;
    const P = this.params;
    const geo = volumeGeo(v.hdr);
    const sh = this.shells();
    const thr = P.mode === "iso" ? (sh.length ? sh[0].value : Infinity) : P.threshold;
    if (!isFinite(thr)) return null;
    const at = (t: number) => {
      const p = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
      const q = localToIdx(v.hdr, geo, p);
      return { q, val: sampleIdx(v, q.fx, q.fy, q.fz, P.absValue) };
    };
    // ~half a voxel per step
    const lenVox = Math.hypot(d[0] * v.hdr.nx, d[1] * v.hdr.ny, d[2] * v.hdr.nz) * (t1 - t0);
    const n = Math.min(4000, Math.max(32, Math.ceil(lenVox * 2)));
    const dt = (t1 - t0) / n;
    let prev = t0;
    for (let i = 0; i <= n; i++) {
      const t = t0 + i * dt;
      const s = at(t);
      if (s.val >= thr) {
        let lo = prev, hi = t;
        for (let j = 0; j < 12; j++) {
          const m = (lo + hi) / 2;
          if (at(m).val >= thr) hi = m;
          else lo = m;
        }
        const hit = at(hi);
        // strongest value further along the ray while still inside the echo
        let max = hit.val, maxH = hit.q.h;
        for (let k = 1; k < 400; k++) {
          const tt = hi + k * dt;
          if (tt > t1) break;
          const s2 = at(tt);
          if (!(s2.val >= thr - 3)) break;
          if (s2.val > max) {
            max = s2.val;
            maxH = s2.q.h;
          }
        }
        let range: number | undefined;
        if (v.hdr.proj === "aeqd") {
          const dy = (hit.q.lat - v.hdr.lat!) * D2R * R_EARTH;
          const dx = (hit.q.lon - v.hdr.lon!) * D2R * R_EARTH * Math.cos(v.hdr.lat! * D2R);
          range = Math.hypot(dx, dy);
        }
        return { lon: hit.q.lon, lat: hit.q.lat, h: hit.q.h, value: hit.val, max, maxH, range };
      }
      prev = t;
    }
    return null;
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const v = this.vol;
    const t = this.table;
    if (!this.prog || !v || !t) {
      if (this.lastLabelsKey) {
        this.lastLabelsKey = "";
        this.onLabels?.([]);
      }
      return;
    }
    const P = this.params;
    let g = this.gpu.get(v);
    if (!g || g.smooth !== P.smooth) {
      try {
        g = this.upload(v, P.smooth);
      } catch (e: any) {
        this.error = e.message;
        console.error(e);
        this.vol = null;
        return;
      }
    }
    g.used = performance.now();
    // adapt the step budget to keep interaction ≥ ~30 fps
    const now = performance.now();
    if (this.moving) {
      if (this.lastFrame) {
        const ft = now - this.lastFrame;
        if (ft > 40) this.movingSteps = Math.max(64, Math.round(this.movingSteps * 0.85));
        else if (ft < 22) this.movingSteps = Math.min(384, Math.round(this.movingSteps * 1.08));
      }
      this.lastFrame = now;
    }
    const geo = volumeGeo(v.hdr);
    const mpm = geo.ref.meterInMercatorCoordinateUnits();
    const zs = mpm * P.exag;
    const z0 = geo.h[0] * zs, zh = (geo.h[1] - geo.h[0]) * zs;
    const sx = geo.size[0], sy = geo.size[1];
    const ox = geo.ref.x + geo.off[0], oy = geo.ref.y + geo.off[1];
    const model = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, zh, 0, ox, oy, z0, 1];
    const base = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    const mvp = mul(base, model);
    this.lastMvp = mvp;
    const inv = invert(mvp);
    if (!inv) return;
    // camera position: the point every clip-space ray converges on, (0,0,±1,0) in clip space
    const ex = inv[8], ey = inv[9], ez = inv[10], ew = inv[11];
    if (Math.abs(ew) < 1e-30) return;
    const eye = [ex / ew, ey / ew, ez / ew];

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    // height axis / echo-top markers first: storms in front of them cover them
    if (P.tops && this.lineProg) this.drawCues(gl, v, geo, mvp);
    else if (this.lastLabelsKey) {
      this.lastLabelsKey = "";
      this.onLabels?.([]);
    }
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
    const vsx = h.proj === "aeqd" ? h.dx! : geo.mstep[0] / h.nx;
    const vsy = h.proj === "aeqd" ? h.dy! : geo.mstep[1] / h.ny;
    const vsz = (geo.mstep[2] / h.nz) * P.exag;
    gl.uniform3f(L.u_vs, vsx, vsy, vsz);
    gl.uniform1f(L.u_exag, P.exag);
    gl.uniform1f(L.u_scale, h.scale || 1);
    gl.uniform1f(L.u_offset, h.offset || 0);
    gl.uniform1f(L.u_cmin, t.min);
    gl.uniform1f(L.u_cmax, t.max);
    gl.uniform1f(L.u_thr, P.threshold);
    const sh = this.shells();
    const lowest = Math.min(P.threshold, ...sh.map((s) => s.value));
    const range = t.max - (P.absValue ? 0 : t.min);
    gl.uniform1f(L.u_floor, lowest - Math.max(10, range * 0.15));
    gl.uniform1f(L.u_unit, Math.max(1e-3, range * 0.02));
    gl.uniform1i(L.u_abs, P.absValue ? 1 : 0);
    gl.uniform1f(L.u_density, P.density);
    gl.uniform1i(L.u_shade, P.shade ? 1 : 0);
    gl.uniform1i(L.u_maxSteps, Math.min(1000, this.moving ? this.movingSteps : this.steps));
    gl.uniform1i(L.u_mode, P.mode === "iso" ? 0 : 1);
    gl.uniform1i(L.u_isoN, sh.length);
    const iv = [0, 0, 0], ia = [0, 0, 0], ic = new Float32Array(9);
    sh.forEach((s, i) => {
      iv[i] = s.value;
      ia[i] = Math.max(0, Math.min(1, s.opacity));
      // colour slightly inside the shell so a threshold on a colour boundary picks the stronger side
      const c = this.colorOf(s.value + range * 0.01);
      ic.set(c, i * 3);
    });
    gl.uniform3f(L.u_iso, iv[0], iv[1], iv[2]);
    gl.uniform3f(L.u_isoA, ia[0], ia[1], ia[2]);
    gl.uniform3f(L.u_isoC0, ic[0], ic[1], ic[2]);
    gl.uniform3f(L.u_isoC1, ic[3], ic[4], ic[5]);
    gl.uniform3f(L.u_isoC2, ic[6], ic[7], ic[8]);
    // key light from the upper left of the view (east/north/up). It depends only on the camera,
    // never on the data, so it stays put while the loop animates.
    const vd = [(0.5 - eye[0]) * geo.mstep[0], -(0.5 - eye[1]) * geo.mstep[1], (0.5 - eye[2]) * geo.mstep[2] * P.exag];
    const vh = Math.hypot(vd[0], vd[1]) || 1;
    const fwd = [vd[0] / vh, vd[1] / vh];
    const right = [fwd[1], -fwd[0]];
    const sun = [-fwd[0] * 0.55 - right[0] * 0.55, -fwd[1] * 0.55 - right[1] * 0.55, 0.75];
    const sl = Math.hypot(sun[0], sun[1], sun[2]);
    gl.uniform3f(L.u_sun, sun[0] / sl, sun[1] / sl, sun[2] / sl);
    gl.uniform1i(L.u_hcol, P.heightColor ? 1 : 0);
    gl.uniform1i(L.u_planes, P.planes ? 1 : 0);
    const map = this.map!;
    const pxm = (40075016.7 * Math.cos(geo.latc * D2R)) / (512 * Math.pow(2, map.getZoom()));
    gl.uniform1f(L.u_pxm, pxm * (window.devicePixelRatio > 1 ? 1 / window.devicePixelRatio : 1) * 1.5);
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
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, g.brick);
    gl.uniform1i(L.u_brick, 3);
    // one brick in box-local units, shrunk a little for the non-linear grid mappings
    const zf = h.proj === "latlon" ? 0.45 : 0.9;
    gl.uniform3f(L.u_bskip, (BRICK[0] / h.nx) * 0.9, (BRICK[1] / h.ny) * 0.9, (BRICK[2] / h.nz) * zf);
    gl.uniform1f(L.u_skipThr, P.mode === "iso" ? (sh.length ? sh[0].value : 1e9) : P.threshold);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }
}
