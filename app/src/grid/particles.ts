// Wind particles: a MapLibre custom layer (WebGL2). Particles move on the CPU through a u/v field
// from /api/grid/wind (sampled with Catmull-Rom bicubic interpolation in lon/lat, no-data aware)
// and are drawn as anti-aliased thick segments (instanced quads) into a fading trail texture,
// which is composited with an optional dark halo so trails read on satellite imagery.
// The field is requested for the current view with a resolution matched to the screen, so
// zooming in fetches finer data (the server returns the model's native grid when that's coarser).
// Listed as the "Wind particles" overlay (options: model, level, density, speed, colours, width, trails).

import { signal, effect } from "@preact/signals";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { api } from "../api";
import { settings, toast } from "../store";
import { OVERLAYS, overlayDef, optsFor, type OverlayDef } from "../overlays/defs";
import { activeTime, isForecast } from "../active";
import { histRange } from "../anim";

export const OVL_ID = "windparticles";

const def: OverlayDef = {
  id: OVL_ID,
  name: "Wind particles",
  group: "Surface",
  feed: "client",
  refresh: 0,
  options: [
    { key: "model", label: "Model", choices: [["gfs", "GFS"], ["hrrr", "HRRR"]], def: "gfs" },
    { key: "level", label: "Level", choices: [["10m", "10 m"], ["850", "850 hPa"], ["500", "500 hPa"], ["250", "250 hPa"]], def: "10m" },
    { key: "color", label: "Colours", choices: [["outline", "Black outline"], ["speed", "Speed (bright)"], ["dark", "Speed (dark map)"], ["white", "White"]], def: "outline" },
    { key: "width", label: "Line width", choices: [["0.5", "0.5 px"], ["0.75", "0.75 px"], ["1", "1 px"], ["1.5", "1.5 px"], ["2", "2 px"], ["3", "3 px"], ["4", "4 px"]], def: "2" },
    { key: "trail", label: "Trails", choices: [["short", "Short"], ["normal", "Normal"], ["long", "Long"]], def: "normal" },
    { key: "density", label: "Density", choices: [["lo", "Low"], ["md", "Medium"], ["hi", "High"], ["max", "Very high"]], def: "md" },
    { key: "speed", label: "Speed", choices: [["0.5", "Slow"], ["1", "Normal"], ["2", "Fast"]], def: "1" },
  ],
  style: { opacity: 0.9 },
  layers: () => [],
  note: "Animated model wind. Follows the timeline when a model layer is shown. Detail follows the zoom. Drawn on the GPU; stops when off.",
};
if (!overlayDef(OVL_ID)) {
  const i = OVERLAYS.reduce((a, o, k) => (o.group === "Surface" ? k : a), -1);
  OVERLAYS.splice(i < 0 ? OVERLAYS.length : i + 1, 0, def);
}

export interface WindField {
  nx: number;
  ny: number;
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
  time?: number;
  u: Float32Array;
  v: Float32Array;
  /** 1 = valid sample */
  ok: Uint8Array;
}

/**
 * Parse the /api/grid/wind binary: u32 LE header length, JSON header
 * {nx,ny,lon0,lat0,dlon,dlat,time,umin,umax,vmin,vmax}, then nx*ny (u,v) u8 pairs, x fastest W→E,
 * rows S→N; value = min + (b-1)/254·(max-min), b = 0 no data.
 */
export function parseWind(buf: ArrayBuffer): WindField {
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const n = h.nx * h.ny;
  const b = new Uint8Array(buf, 4 + hl, n * 2);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const ok = new Uint8Array(n);
  const su = (h.umax - h.umin) / 254;
  const sv = (h.vmax - h.vmin) / 254;
  for (let i = 0; i < n; i++) {
    const bu = b[i * 2], bv = b[i * 2 + 1];
    if (bu && bv) {
      u[i] = h.umin + (bu - 1) * su;
      v[i] = h.vmin + (bv - 1) * sv;
      ok[i] = 1;
    }
  }
  return { nx: h.nx, ny: h.ny, lon0: h.lon0, lat0: h.lat0, dlon: h.dlon, dlat: h.dlat, time: h.time, u, v, ok };
}

// ---------- shaders ----------

const SEG_VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_vp;       // drawing-buffer size (px)
uniform float u_hw;      // half line width (px)
in vec2 a_corner;        // along (0..1), side (-1..1)
in vec4 a_seg;           // x0, y0, x1, y1 (mercator, relative to the view centre)
in float a_speed;
out float v_speed;
out float v_d;
void main() {
  vec4 c0 = u_matrix * vec4(a_seg.xy, 0.0, 1.0);
  vec4 c1 = u_matrix * vec4(a_seg.zw, 0.0, 1.0);
  if (c0.w <= 0.0 || c1.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 s0 = c0.xy / c0.w * 0.5 * u_vp;
  vec2 s1 = c1.xy / c1.w * 0.5 * u_vp;
  vec2 dv = s1 - s0;
  float L = length(dv);
  vec2 dir = L > 1e-4 ? dv / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = u_hw + 0.75;
  vec2 s = mix(s0, s1, a_corner.x) + nrm * a_corner.y * hw + dir * (a_corner.x * 2.0 - 1.0) * u_hw * 0.5;
  v_speed = a_speed;
  v_d = a_corner.y * hw;
  gl_Position = vec4(s / (0.5 * u_vp), 0.0, 1.0);
}`;
const SEG_FS = `#version 300 es
precision highp float;
in float v_speed;
in float v_d;
uniform int u_ramp;      // 0 white, 1 bright, 2 dark-map
uniform float u_hw;
out vec4 frag;
vec3 bright(float s) {
  vec3 c = mix(vec3(0.55, 0.88, 1.0), vec3(0.30, 1.0, 0.92), smoothstep(0.0, 5.0, s));
  c = mix(c, vec3(0.55, 1.0, 0.35), smoothstep(5.0, 10.0, s));
  c = mix(c, vec3(1.0, 0.95, 0.20), smoothstep(10.0, 17.0, s));
  c = mix(c, vec3(1.0, 0.62, 0.15), smoothstep(17.0, 26.0, s));
  c = mix(c, vec3(1.0, 0.32, 0.36), smoothstep(26.0, 38.0, s));
  c = mix(c, vec3(1.0, 0.50, 1.0), smoothstep(38.0, 60.0, s));
  return c;
}
vec3 classic(float s) {
  vec3 c = mix(vec3(0.23,0.51,0.96), vec3(0.13,0.83,0.93), smoothstep(0.0, 5.0, s));
  c = mix(c, vec3(0.29,0.87,0.5), smoothstep(5.0, 10.0, s));
  c = mix(c, vec3(0.98,0.8,0.08), smoothstep(10.0, 17.0, s));
  c = mix(c, vec3(0.98,0.45,0.09), smoothstep(17.0, 26.0, s));
  c = mix(c, vec3(0.94,0.27,0.27), smoothstep(26.0, 38.0, s));
  c = mix(c, vec3(0.91,0.47,0.98), smoothstep(38.0, 60.0, s));
  return mix(c, vec3(1.0), 0.18);
}
void main() {
  vec3 c = u_ramp == 0 ? vec3(1.0) : u_ramp == 1 ? bright(v_speed) : classic(v_speed);
  // sub-pixel lines (p7): a 1 px wide tent whose alpha is scaled to the line's real coverage (2·hw)
  float a = u_hw < 0.5 ? 2.0 * u_hw * clamp(1.0 - abs(v_d), 0.0, 1.0) : clamp(u_hw - abs(v_d) + 0.5, 0.0, 1.0);
  frag = vec4(c * a, a);
}`;
const QUAD_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const QUAD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_mul;
uniform float u_sub;
uniform float u_halo;    // dark outline strength (0 = none)
uniform vec2 u_px;       // halo radius in uv
out vec4 frag;
void main() {
  vec4 c = max(texture(u_tex, v_uv) * u_mul - vec4(u_sub), vec4(0.0));
  if (u_halo > 0.0) {
    float m = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634;
      m = max(m, texture(u_tex, v_uv + vec2(cos(a), sin(a)) * u_px).a);
    }
    // outline follows the trail's own strength, so faded tails don't leave a grey haze
    float ha = m * m * u_halo * u_mul;
    c += (1.0 - c.a) * vec4(0.0, 0.0, 0.0, ha);
  }
  frag = c;
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (t: number, src: string) => {
    const s = gl.createShader(t)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const lonOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** R2 low-discrepancy sequence (Roberts): evenly spread respawn points with no lattice. */
const R2A = 0.7548776662466927, R2B = 0.5698402909980532;

export type ParticleColors = "outline" | "speed" | "dark" | "white";

export class ParticleLayer implements CustomLayerInterface {
  id = "wind-particles";
  type = "custom" as const;
  renderingMode = "2d" as const;
  field: WindField | null = null;
  on = false;
  opacity = 0.9;
  density = 1;
  speed = 1;
  colors: ParticleColors = "outline";
  /** CSS px */
  width = 2;
  /** per-frame trail fade */
  fade = 0.92;
  private map: MLMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private seg: WebGLProgram | null = null;
  private quad: WebGLProgram | null = null;
  private segVao: WebGLVertexArrayObject | null = null;
  private segBuf: WebGLBuffer | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer | null = null;
  private uSeg: Record<string, WebGLUniformLocation | null> = {};
  private uQuad: Record<string, WebGLUniformLocation | null> = {};
  private tw = 0;
  private th = 0;
  private cur = 0;
  private reset = true;
  private moving = false;
  /** per particle: x, y (mercator 0..1), age, max age */
  private p = new Float32Array(0);
  /** per instance: x0, y0, x1, y1 (relative to cx, cy), speed */
  private inst = new Float32Array(0);
  private lastT = 0;
  private seq = Math.floor(Math.random() * 1000);
  private uv = [0, 0];
  /** last frame's length in 60 Hz frames (trail fade follows it so trails look the same at any fps) */
  private dtf = 1;

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    this.seg = compile(gl, SEG_VS, SEG_FS);
    this.quad = compile(gl, QUAD_VS, QUAD_FS);
    for (const n of ["u_matrix", "u_vp", "u_hw", "u_ramp"]) this.uSeg[n] = gl.getUniformLocation(this.seg, n);
    for (const n of ["u_tex", "u_mul", "u_sub", "u_halo", "u_px"]) this.uQuad[n] = gl.getUniformLocation(this.quad, n);
    // instanced quads: corner buffer + per-segment buffer
    this.segVao = gl.createVertexArray();
    gl.bindVertexArray(this.segVao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const ac = gl.getAttribLocation(this.seg, "a_corner");
    gl.enableVertexAttribArray(ac);
    gl.vertexAttribPointer(ac, 2, gl.FLOAT, false, 0, 0);
    this.segBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    const as = gl.getAttribLocation(this.seg, "a_seg");
    const asp = gl.getAttribLocation(this.seg, "a_speed");
    gl.enableVertexAttribArray(as);
    gl.vertexAttribPointer(as, 4, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(as, 1);
    gl.enableVertexAttribArray(asp);
    gl.vertexAttribPointer(asp, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(asp, 1);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const qp = gl.getAttribLocation(this.quad, "a_pos");
    gl.enableVertexAttribArray(qp);
    gl.vertexAttribPointer(qp, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.fbo = gl.createFramebuffer();
    const clearTrails = () => ((this.moving = true), (this.reset = true));
    map.on("movestart", clearTrails);
    map.on("move", () => (this.reset = true));
    map.on("moveend", () => ((this.moving = false), (this.reset = true)));
    map.on("resize", () => (this.reset = true));
  }

  onRemove() {
    this.tex = [];
    this.tw = this.th = 0;
  }

  /** start/stop (stopping just stops scheduling frames) */
  setOn(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    this.reset = true;
    this.lastT = 0;
    this.map?.triggerRepaint();
  }

  /** New field; particles keep flowing (no reset) when one replaces another. */
  setField(f: WindField | null) {
    if (!this.field || !f) this.reset = true;
    this.field = f;
    this.map?.triggerRepaint();
  }

  private ensureTextures(gl: WebGL2RenderingContext) {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (w === this.tw && h === this.th && this.tex.length === 2) return;
    for (const t of this.tex) gl.deleteTexture(t);
    this.tex = [0, 1].map(() => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });
    this.tw = w;
    this.th = h;
    this.reset = true;
  }

  /**
   * Wind at lon/lat: Catmull-Rom bicubic over the 4×4 neighbourhood; where any of those samples
   * is missing it falls back to no-data-aware bilinear. False outside the field / in no-data.
   */
  sample(lon: number, lat: number, out: number[]): boolean {
    const f = this.field!;
    const nx = f.nx, ny = f.ny;
    if (nx < 2 || ny < 2) return false;
    lon = ((lon - f.lon0 + 540) % 360) - 180 + f.lon0;
    const fx = (lon - f.lon0) / f.dlon;
    const fy = (lat - f.lat0) / f.dlat;
    if (!(fx >= 0 && fy >= 0 && fx <= nx - 1 && fy <= ny - 1)) return false;
    const x1 = Math.min(nx - 2, Math.floor(fx)), y1 = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - x1, ty = fy - y1;
    const ok = f.ok, U = f.u, V = f.v;
    const i11 = y1 * nx + x1;
    // bilinear (no-data aware) as the base
    const b00 = (1 - tx) * (1 - ty), b10 = tx * (1 - ty), b01 = (1 - tx) * ty, b11 = tx * ty;
    const w00 = ok[i11] * b00, w10 = ok[i11 + 1] * b10, w01 = ok[i11 + nx] * b01, w11 = ok[i11 + nx + 1] * b11;
    const ws = w00 + w10 + w01 + w11;
    if (ws < 0.5) return false;
    const full = ok[i11] & ok[i11 + 1] & ok[i11 + nx] & ok[i11 + nx + 1];
    if (full && x1 >= 1 && y1 >= 1 && x1 + 2 < nx && y1 + 2 < ny) {
      // Catmull-Rom weights
      const cx0 = tx * ((2 - tx) * tx - 1) * 0.5, cx1 = (tx * tx * (3 * tx - 5) + 2) * 0.5, cx2 = tx * ((4 - 3 * tx) * tx + 1) * 0.5, cx3 = (tx - 1) * tx * tx * 0.5;
      const cy0 = ty * ((2 - ty) * ty - 1) * 0.5, cy1 = (ty * ty * (3 * ty - 5) + 2) * 0.5, cy2 = ty * ((4 - 3 * ty) * ty + 1) * 0.5, cy3 = (ty - 1) * ty * ty * 0.5;
      const base = i11 - nx - 1;
      let su = 0, sv = 0, all = 1;
      const cy = [cy0, cy1, cy2, cy3];
      for (let j = 0; j < 4 && all; j++) {
        const r = base + j * nx;
        all = ok[r] & ok[r + 1] & ok[r + 2] & ok[r + 3];
        const ru = cx0 * U[r] + cx1 * U[r + 1] + cx2 * U[r + 2] + cx3 * U[r + 3];
        const rv = cx0 * V[r] + cx1 * V[r + 1] + cx2 * V[r + 2] + cx3 * V[r + 3];
        su += cy[j] * ru;
        sv += cy[j] * rv;
      }
      if (all) {
        out[0] = su;
        out[1] = sv;
        return true;
      }
    }
    out[0] = (U[i11] * w00 + U[i11 + 1] * w10 + U[i11 + nx] * w01 + U[i11 + nx + 1] * w11) / ws;
    out[1] = (V[i11] * w00 + V[i11 + 1] * w10 + V[i11 + nx] * w01 + V[i11 + nx + 1] * w11) / ws;
    return true;
  }

  private view() {
    const b = this.map!.getBounds();
    return { x0: mercX(b.getWest()), x1: mercX(b.getEast()), y0: mercY(b.getNorth()), y1: mercY(b.getSouth()) };
  }

  private spawn(i: number, v: { x0: number; x1: number; y0: number; y1: number }, randomAge: boolean) {
    const p = this.p;
    const k = this.seq++;
    // R2 point plus a jitter of about one point spacing: even coverage without a visible lattice
    const j = 1 / Math.sqrt(Math.max(1, this.p.length / 4));
    const fx = (0.5 + k * R2A + (Math.random() - 0.5) * j) % 1;
    const fy = (0.5 + k * R2B + (Math.random() - 0.5) * j) % 1;
    p[i * 4] = v.x0 + (fx < 0 ? fx + 1 : fx) * (v.x1 - v.x0);
    p[i * 4 + 1] = v.y0 + (fy < 0 ? fy + 1 : fy) * (v.y1 - v.y0);
    const max = 45 + Math.random() * 75;
    // new particles start at a random point of their life so they don't all expire together
    p[i * 4 + 2] = randomAge ? Math.random() * max : Math.random() * max * 0.25;
    p[i * 4 + 3] = max;
  }

  private step(cx: number, cy: number): number {
    const m = this.map!;
    const c = m.getCanvas();
    // thicker lines need fewer particles to read clearly
    const wk = 1 / Math.sqrt(Math.max(1, this.width / 1.5));
    const want = Math.round(Math.min(40000, Math.max(1200, ((c.clientWidth * c.clientHeight) / 260) * this.density * wk)));
    const v = this.view();
    if (this.p.length !== want * 4) {
      this.p = new Float32Array(want * 4);
      this.inst = new Float32Array(want * 5);
      for (let i = 0; i < want; i++) this.spawn(i, v, true);
    }
    // constant screen speed at every zoom and frame rate: 10 m/s ≈ 1.2 px per 60 Hz frame at "Normal"
    const now = performance.now();
    const dtf = this.lastT ? Math.min(3, (now - this.lastT) / 16.7) : 1;
    this.lastT = now;
    this.dtf = dtf;
    const world = 512 * Math.pow(2, m.getZoom());
    const k = (0.12 * this.speed * dtf) / world;
    const uv = this.uv;
    const p = this.p, out = this.inst;
    let n = 0;
    for (let i = 0; i < want; i++) {
      const x = p[i * 4], y = p[i * 4 + 1];
      if (p[i * 4 + 2]++ > p[i * 4 + 3] || x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1 || !this.sample(lonOf(x), latOf(y), uv)) {
        this.spawn(i, v, false);
        continue;
      }
      const sp = Math.hypot(uv[0], uv[1]);
      const nx = x + uv[0] * k;
      const ny = y - uv[1] * k;
      out[n++] = x - cx;
      out[n++] = y - cy;
      out[n++] = nx - cx;
      out[n++] = ny - cy;
      out[n++] = sp;
      p[i * 4] = nx;
      p[i * 4 + 1] = ny;
    }
    return n / 5;
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    if (!this.on || !this.field || !this.seg || !this.quad || document.hidden) return;
    this.ensureTextures(gl);
    // positions relative to the view centre keep float32 precision when zoomed in
    const ctr = this.map!.getCenter();
    const cx = mercX(ctr.lng), cy = mercY(ctr.lat);
    const ni = this.step(cx, cy);
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const src = this.cur, dst = 1 - this.cur;
    const dpr = window.devicePixelRatio || 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex[dst], 0);
    gl.viewport(0, 0, this.tw, this.th);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // fade the previous trails (unless the view moved: then the old trails are in the wrong place)
    if (!this.reset && !this.moving) {
      gl.disable(gl.BLEND);
      gl.useProgram(this.quad);
      gl.bindVertexArray(this.quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[src]);
      gl.uniform1i(this.uQuad.u_tex, 0);
      gl.uniform1f(this.uQuad.u_mul, Math.pow(this.fade, this.dtf));
      gl.uniform1f(this.uQuad.u_sub, 1.2 / 255);
      gl.uniform1f(this.uQuad.u_halo, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.reset = false;
    // new segments
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.seg);
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.subarray(0, ni * 5), gl.DYNAMIC_DRAW);
    const m = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    // m · translate(cx, cy)
    const mm = new Float32Array(16);
    for (let i = 0; i < 12; i++) mm[i] = m[i];
    for (let r = 0; r < 4; r++) mm[12 + r] = m[r] * cx + m[4 + r] * cy + m[12 + r];
    gl.uniformMatrix4fv(this.uSeg.u_matrix, false, mm);
    gl.uniform2f(this.uSeg.u_vp, this.tw, this.th);
    gl.uniform1f(this.uSeg.u_hw, Math.max(0.2, (this.width * dpr) / 2));
    gl.uniform1i(this.uSeg.u_ramp, this.colors === "white" ? 0 : this.colors === "dark" ? 2 : 1);
    if (ni > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ni);
    // back to the map's framebuffer: draw the trails (with a dark halo for light/satellite maps)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[dst]);
    gl.uniform1i(this.uQuad.u_tex, 0);
    gl.uniform1f(this.uQuad.u_mul, this.opacity);
    gl.uniform1f(this.uQuad.u_sub, 0);
    const halo = this.colors === "outline" ? 0.85 : this.colors === "white" ? 0.5 : this.colors === "speed" ? 0.3 : 0;
    gl.uniform1f(this.uQuad.u_halo, halo);
    const r = (1 + this.width * 0.35) * dpr;
    gl.uniform2f(this.uQuad.u_px, r / this.tw, r / this.th);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    this.cur = dst;
    this.map!.triggerRepaint();
  }
}

// ---------- controller ----------

export const windStatus = signal<{ loading: boolean; error?: string; time?: number }>({ loading: false });
let layer: ParticleLayer | null = null;
let map: MLMap | null = null;
const attached = signal(0);

function cfg() {
  const o = settings.value.ovl[OVL_ID];
  return { on: !!o?.on, opacity: o?.opacity ?? 0.9, opts: optsFor(def) };
}

/** Timeline time while a model / forecast layer is shown or in history mode (to the hour), else latest. */
function wantTime(): number | undefined {
  if (histRange.value) return activeTime.value ? Math.round(activeTime.value / 3600_000) * 3600_000 : undefined;
  return isForecast.value ? activeTime.value || undefined : undefined;
}

let gen = 0;
let lastErr = "";
let lastQ = "";
async function loadField() {
  const m = map;
  const c = cfg();
  if (!m || !layer || !c.on || !api.base) return;
  const b = m.getBounds();
  let w = b.getWest(), e = b.getEast();
  const s0 = Math.max(-85, b.getSouth()), n0 = Math.min(85, b.getNorth());
  const pw = (e - w) * 0.15, ph = (n0 - s0) * 0.15;
  w -= pw;
  e += pw;
  if (e - w >= 360) (w = -180), (e = 180);
  const dec = e - w > 20 ? 2 : 3;
  const bbox = [w, Math.max(-85, s0 - ph), e, Math.min(85, n0 + ph)].map((x) => x.toFixed(dec)).join(",");
  // resolution matched to the screen: about one field cell per 3 CSS px
  const cv = m.getCanvas();
  const max = Math.max(64, Math.min(512, Math.round((Math.max(cv.clientWidth, cv.clientHeight) * 1.3) / 3)));
  const t = wantTime();
  const q = `/api/grid/wind?layer=${c.opts.model}&level=${c.opts.level}&bbox=${bbox}&max=${max}${t ? `&time=${t}` : ""}`;
  if (q === lastQ && layer.field) return;
  const g = ++gen;
  windStatus.value = { ...windStatus.value, loading: true };
  try {
    // the old field keeps animating until this one arrives
    const f = parseWind(await api.bin(q));
    if (g !== gen) return;
    lastQ = q;
    // history mode: the server only keeps recent model runs; don't animate the wrong day's wind
    if (histRange.peek() && t && f.time && Math.abs(f.time - t) > 3 * 3600_000) {
      layer.setField(null);
      windStatus.value = { loading: false, error: "No model wind for this time" };
      return;
    }
    layer.setField(f);
    windStatus.value = { loading: false, time: f.time };
    lastErr = "";
  } catch (err: any) {
    if (g !== gen) return;
    windStatus.value = { loading: false, error: err.message };
    if (err.message !== lastErr) toast(`Wind particles: ${err.message}`, "warn");
    lastErr = err.message;
  }
}

let timer: number | undefined;
function reload(ms = 450) {
  clearTimeout(timer);
  timer = window.setTimeout(loadField, ms);
}

export function attachParticles(m: MLMap): ParticleLayer {
  map = m;
  layer = new ParticleLayer();
  m.on("moveend", () => cfg().on && reload());
  attached.value++;
  return layer;
}

let lastSig = "";
effect(() => {
  void attached.value;
  const c = cfg();
  if (!layer) return;
  const o = c.opts;
  layer.opacity = c.opacity;
  layer.density = o.density === "lo" ? 0.5 : o.density === "hi" ? 2 : o.density === "max" ? 3.5 : 1;
  layer.speed = +o.speed || 1;
  layer.colors = (["outline", "speed", "dark", "white"].includes(o.color) ? o.color : "speed") as ParticleColors;
  layer.width = Math.max(0.5, Math.min(4, +o.width || 2));
  layer.fade = o.trail === "short" ? 0.86 : o.trail === "long" ? 0.965 : 0.93;
  layer.setOn(c.on);
  const sig = c.on ? `${o.model}|${o.level}|${api.base}` : "";
  if (sig !== lastSig) {
    lastSig = sig;
    lastQ = "";
    if (!c.on) layer.setField(null);
    else {
      // a different model/level: drop the old field so it doesn't animate the wrong wind
      layer.setField(null);
      reload(0);
    }
  }
  map?.triggerRepaint();
});

// follow the timeline while a model layer is shown
let lastTime: number | undefined;
effect(() => {
  const t = wantTime();
  if (t === lastTime) return;
  lastTime = t;
  if (settings.peek().ovl[OVL_ID]?.on) reload(600);
});

// debug / test handle
(window as any).__tbwWind = {
  get layer() {
    return layer;
  },
  reload: () => reload(0),
};
