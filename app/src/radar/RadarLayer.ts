// WebGL2 polar radar renderer as a MapLibre custom layer.
// Raw gate values are uploaded once per sweep; color tables are applied on the GPU,
// so switching colormaps, opacity or smoothing never re-uploads data.

import * as maplibregl from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { type Sweep, sweepRange } from "./sweep";
import { type ColorTable, rasterize, TEX_SIZE } from "./colormaps";
import { gateFor, radarGateKey, onGateChange } from "../gate";

const VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_extent;
in vec2 a_pos;
out vec2 v_local;
void main() {
  v_local = a_pos * u_extent;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 v_local;
out vec4 fragColor;
uniform float u_cy;        // radar mercator y
uniform float u_lat0;      // radians
uniform float u_lon0;      // radians
uniform float u_first;     // m
uniform float u_gate;      // m
uniform float u_cosel;
uniform int u_ngates;
uniform int u_nrad;
uniform int u_word;        // 1 = LUT, 2 = scale/offset
uniform float u_scale;
uniform float u_offset;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_opacity;
uniform float u_smooth;   // 0 = off … 0.5 = bilinear … 1 = heavy
uniform float u_gmin;     // value filter (native units); |v| when u_gabs == 1
uniform float u_gmax;
uniform int u_gabs;
uniform vec4 u_rf;
uniform usampler2D u_data;
uniform usampler2D u_azidx;
uniform sampler2D u_az;
uniform sampler2D u_lut;
uniform sampler2D u_cmap;
// other radars drawn at the same time (lat, lon in radians; usable range in m):
// a pixel belongs to whichever radar is closest, since data is better nearer the radar
uniform int u_nother;
uniform vec3 u_others[8];

const float PI = 3.141592653589793;
const float R = 6371000.0;
const float NODATA = -99999.0;
const float RFV = -9999.0;

float valueAt(int row, int gate) {
  if (gate < 0 || gate >= u_ngates) return NODATA;
  uint raw = texelFetch(u_data, ivec2(gate, row), 0).r;
  if (raw == 0u) return NODATA;
  if (u_word == 1) return texelFetch(u_lut, ivec2(int(raw), 0), 0).r;
  if (raw == 1u) return RFV;
  return (float(raw) - u_offset) / u_scale;
}

bool valid(float v) { return v > -9000.0; }

void main() {
  float y = u_cy + v_local.y;
  float lat = 2.0 * atan(exp(PI * (1.0 - 2.0 * y))) - PI * 0.5;
  float dlon = v_local.x * 2.0 * PI;
  float dlat = lat - u_lat0;
  float a = sin(dlat * 0.5) * sin(dlat * 0.5) + cos(u_lat0) * cos(lat) * sin(dlon * 0.5) * sin(dlon * 0.5);
  float ground = 2.0 * R * asin(min(1.0, sqrt(a)));
  float lon = u_lon0 + dlon;
  for (int k = 0; k < 8; k++) {
    if (k >= u_nother) break;
    vec3 o = u_others[k];
    float ddl = lat - o.x;
    float ddo = lon - o.y;
    float h = sin(ddl * 0.5) * sin(ddl * 0.5) + cos(o.x) * cos(lat) * sin(ddo * 0.5) * sin(ddo * 0.5);
    float d = 2.0 * R * asin(min(1.0, sqrt(h)));
    if (d < ground && d < o.z) discard;
  }
  float az = atan(sin(dlon) * cos(lat), cos(u_lat0) * sin(lat) - sin(u_lat0) * cos(lat) * cos(dlon));
  az = mod(degrees(az) + 360.0, 360.0);
  float slant = ground / u_cosel;
  float g = (slant - u_first) / u_gate;
  int bin = int(az * 10.0) % 3600;
  uint row = texelFetch(u_azidx, ivec2(bin, 0), 0).r;
  if (row == 65535u) discard;
  int r0 = int(row);
  int gi = int(floor(g + 0.5));
  float v = valueAt(r0, gi);
  if (v <= NODATA + 1.0) discard;
  if (!valid(v)) {
    if (u_rf.a <= 0.0) discard;
    fragColor = vec4(u_rf.rgb * u_rf.a, u_rf.a) * u_opacity;
    return;
  }
  if (u_smooth > 0.0) {
    // bilinear in (azimuth, range) over valid neighbours
    float ac = texelFetch(u_az, ivec2(r0, 0), 0).r;
    float da = az - ac;
    if (da > 180.0) da -= 360.0;
    if (da < -180.0) da += 360.0;
    int r1 = da >= 0.0 ? (r0 + 1) % u_nrad : (r0 - 1 + u_nrad) % u_nrad;
    float ac1 = texelFetch(u_az, ivec2(r1, 0), 0).r;
    float span = abs(ac1 - ac);
    if (span > 180.0) span = 360.0 - span;
    float fa = span > 0.01 && span < 3.0 ? clamp(abs(da) / span, 0.0, 1.0) : 0.0;
    int g0 = int(floor(g));
    float fg = g - float(g0);
    float vs[4];
    vs[0] = valueAt(r0, g0); vs[1] = valueAt(r0, g0 + 1);
    vs[2] = valueAt(r1, g0); vs[3] = valueAt(r1, g0 + 1);
    float w[4];
    w[0] = (1.0 - fa) * (1.0 - fg); w[1] = (1.0 - fa) * fg;
    w[2] = fa * (1.0 - fg); w[3] = fa * fg;
    float acc = 0.0, wsum = 0.0;
    for (int i = 0; i < 4; i++) {
      if (valid(vs[i])) { acc += vs[i] * w[i]; wsum += w[i]; }
    }
    float sm = wsum > 0.0 ? acc / wsum : v;
    if (u_smooth > 0.5) {
      // heavier: gaussian over 3 radials x 5 gates, widening with the setting
      float spread = (u_smooth - 0.5) * 2.0;
      float step = 1.0 + spread * 1.5;
      float acc2 = 0.0, ws2 = 0.0;
      for (int dr = -1; dr <= 1; dr++) {
        int rr = (r0 + dr + u_nrad) % u_nrad;
        for (int dg = -2; dg <= 2; dg++) {
          float vv = valueAt(rr, int(floor(g + float(dg) * step + 0.5)));
          if (!valid(vv)) continue;
          float wg = exp(-0.5 * float(dg * dg) - 0.9 * float(dr * dr));
          acc2 += vv * wg;
          ws2 += wg;
        }
      }
      if (ws2 > 0.0) sm = mix(sm, acc2 / ws2, spread);
    }
    v = mix(v, sm, min(1.0, u_smooth * 2.0));
  }
  float gv = u_gabs == 1 ? abs(v) : v;
  if (gv < u_gmin || gv > u_gmax) discard;
  float t = (v - u_cmin) / (u_cmax - u_cmin);
  vec4 c = texture(u_cmap, vec2(clamp(t, 0.0, 1.0), 0.5));
  float alpha = c.a * u_opacity;
  if (alpha <= 0.003) discard;
  fragColor = vec4(c.rgb * alpha, alpha);
}`;

interface GpuSweep {
  data: WebGLTexture;
  azidx: WebGLTexture;
  az: WebGLTexture;
  lut: WebGLTexture;
  lastUsed: number;
}

export interface DrawItem {
  sweep: Sweep;
  table: ColorTable;
  opacity: number;
}

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

export class RadarLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "2d" as const;
  private map?: MLMap;
  private gl?: WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private vbo?: WebGLBuffer;
  private vao?: WebGLVertexArrayObject;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private cache = new Map<Sweep, GpuSweep>();
  private cmaps = new Map<ColorTable, WebGLTexture>();
  items: DrawItem[] = [];
  /** 0 = off, 0.5 = bilinear, 1 = heavy */
  smooth = 0;
  maxCached = 48;

  constructor(id = "radar") {
    this.id = id;
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
    this.prog = p;
    for (const n of ["u_matrix", "u_extent", "u_cy", "u_lat0", "u_lon0", "u_first", "u_gate", "u_cosel", "u_ngates", "u_nrad", "u_word", "u_scale", "u_offset", "u_cmin", "u_cmax", "u_opacity", "u_smooth", "u_gmin", "u_gmax", "u_gabs", "u_rf", "u_data", "u_azidx", "u_az", "u_lut", "u_cmap", "u_nother", "u_others"]) {
      this.loc[n] = gl.getUniformLocation(p, n);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, "a_pos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.unGate?.();
    this.unGate = onGateChange(() => this.repaint());
    this.repaint();
  }

  private unGate?: () => void;

  onRemove() {
    this.unGate?.();
    this.unGate = undefined;
    const gl = this.gl;
    if (!gl) return;
    for (const g of this.cache.values()) this.freeGpu(g);
    this.cache.clear();
    for (const t of this.cmaps.values()) gl.deleteTexture(t);
    this.cmaps.clear();
  }

  setItems(items: DrawItem[]) {
    this.items = items;
    this.repaint();
  }

  private repaint() {
    const m = this.map;
    if (!m) return;
    m.triggerRepaint();
    // a second nudge covers repaints requested while a frame is mid-flight
    requestAnimationFrame(() => m.triggerRepaint());
  }

  private freeGpu(g: GpuSweep) {
    const gl = this.gl!;
    gl.deleteTexture(g.data);
    gl.deleteTexture(g.azidx);
    gl.deleteTexture(g.az);
    gl.deleteTexture(g.lut);
  }

  /** Drop GPU copies for sweeps no longer needed. */
  release(s: Sweep) {
    const g = this.cache.get(s);
    if (g && this.gl) {
      this.freeGpu(g);
      this.cache.delete(s);
    }
  }

  private tex(): WebGLTexture {
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private upload(s: Sweep): GpuSweep {
    const gl = this.gl!;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data = this.tex();
    if (s.word === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, s.ngates, s.nrad, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, s.data as Uint16Array);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, s.ngates, s.nrad, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, s.data as Uint8Array);
    const azidx = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 3600, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, s.azIndex);
    const az = this.tex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, s.nrad, 1, 0, gl.RED, gl.FLOAT, s.az);
    const lut = this.tex();
    const l = new Float32Array(256).fill(-99999);
    if (s.lut) for (let i = 0; i < 256; i++) l[i] = Number.isNaN(s.lut[i]) ? -99999 : s.lut[i];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, l);
    const g = { data, azidx, az, lut, lastUsed: performance.now() };
    this.cache.set(s, g);
    if (this.cache.size > this.maxCached) {
      const old = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed).slice(0, this.cache.size - this.maxCached);
      for (const [k, v] of old) {
        this.freeGpu(v);
        this.cache.delete(k);
      }
    }
    return g;
  }

  private pending: Sweep[] = [];
  /** Upload ahead of time so animation frames don't stall (done inside the next render pass). */
  preload(sweeps: Sweep[]) {
    this.pending = sweeps.filter((s) => !this.cache.has(s));
    this.repaint();
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
    if (!this.prog) return;
    if (this.pending.length) {
      // a few per frame keeps panning smooth
      for (const s of this.pending.splice(0, 4)) if (!this.cache.has(s)) this.upload(s);
      if (this.pending.length) this.repaint();
    }
    if (!this.items.length) return;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao!);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    const L = this.loc;
    for (const it of this.items) {
      const s = it.sweep;
      // nearest-radar priority between the radars on screen
      const others = this.items.filter((o) => o !== it && (o.sweep.lat !== s.lat || o.sweep.lon !== s.lon)).slice(0, 8);
      const ov = new Float32Array(24);
      others.forEach((o, k) => {
        ov[k * 3] = (o.sweep.lat * Math.PI) / 180;
        ov[k * 3 + 1] = (o.sweep.lon * Math.PI) / 180;
        ov[k * 3 + 2] = sweepRange(o.sweep);
      });
      gl.uniform1i(L.u_nother, others.length);
      gl.uniform3fv(L.u_others, ov);
      const g = this.cache.get(s) ?? this.upload(s);
      g.lastUsed = performance.now();
      const c = maplibregl.MercatorCoordinate.fromLngLat([s.lon, s.lat]);
      const range = sweepRange(s) / Math.cos((s.elevation * Math.PI) / 180);
      // mercator units per meter at this latitude
      const extent = (range * c.meterInMercatorCoordinateUnits()) * 1.02;
      const model = new Float64Array([extent, 0, 0, 0, 0, extent, 0, 0, 0, 0, 1, 0, c.x, c.y, 0, 1]);
      const m = mul((opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix, model);
      gl.uniformMatrix4fv(L.u_matrix, false, new Float32Array(m));
      gl.uniform1f(L.u_extent, extent);
      gl.uniform1f(L.u_cy, c.y);
      gl.uniform1f(L.u_lat0, (s.lat * Math.PI) / 180);
      gl.uniform1f(L.u_lon0, (s.lon * Math.PI) / 180);
      gl.uniform1f(L.u_first, s.firstGate);
      gl.uniform1f(L.u_gate, s.gate);
      gl.uniform1f(L.u_cosel, Math.cos((s.elevation * Math.PI) / 180));
      gl.uniform1i(L.u_ngates, s.ngates);
      gl.uniform1i(L.u_nrad, s.nrad);
      gl.uniform1i(L.u_word, s.lut ? 1 : 2);
      gl.uniform1f(L.u_scale, s.scale || 1);
      gl.uniform1f(L.u_offset, s.offset);
      gl.uniform1f(L.u_cmin, it.table.min);
      gl.uniform1f(L.u_cmax, it.table.max);
      gl.uniform1f(L.u_opacity, it.opacity);
      gl.uniform1f(L.u_smooth, this.smooth);
      const gate = gateFor(radarGateKey(s.product || it.table.id));
      gl.uniform1f(L.u_gmin, gate ? gate[0] : -1e30);
      gl.uniform1f(L.u_gmax, gate ? gate[1] : 1e30);
      gl.uniform1i(L.u_gabs, gate?.[2] ? 1 : 0);
      const rf = it.table.rf ?? [0, 0, 0, 0];
      gl.uniform4f(L.u_rf, rf[0] / 255, rf[1] / 255, rf[2] / 255, rf[3] / 255);
      const bind = (unit: number, tex: WebGLTexture, name: string) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(L[name], unit);
      };
      bind(0, g.data, "u_data");
      bind(1, g.azidx, "u_azidx");
      bind(2, g.az, "u_az");
      bind(3, g.lut, "u_lut");
      bind(4, this.cmapTex(it.table), "u_cmap");
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Forget the GPU color table for a table that was edited. */
  invalidateTable(t: ColorTable) {
    const tex = this.cmaps.get(t);
    if (tex && this.gl) this.gl.deleteTexture(tex);
    this.cmaps.delete(t);
  }
}
