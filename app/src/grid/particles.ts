// Wind particles: a MapLibre custom layer (WebGL2). Particles move on the CPU through a u/v field
// from /api/grid/wind and are drawn as short segments into a fading trail texture.
// Listed as the "Wind particles" overlay (options: model, level, density, speed, colors).

import { signal, effect } from "@preact/signals";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { api } from "../api";
import { settings, toast } from "../store";
import { OVERLAYS, overlayDef, optsFor, type OverlayDef } from "../overlays/defs";
import { activeTime, isForecast } from "../active";

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
    { key: "density", label: "Density", choices: [["lo", "Low"], ["md", "Medium"], ["hi", "High"]], def: "md" },
    { key: "speed", label: "Speed", choices: [["0.5", "Slow"], ["1", "Normal"], ["2", "Fast"]], def: "1" },
    { key: "color", label: "Colors", choices: [["speed", "By speed"], ["white", "White"]], def: "speed" },
  ],
  style: { opacity: 0.9 },
  layers: () => [],
  note: "Animated model wind. Follows the timeline when a model layer is shown. Drawn on the GPU; stops when off.",
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
}

/** Parse the /api/grid/wind binary: u32 LE header length, JSON header, then u8 (u,v) pairs. */
export function parseWind(buf: ArrayBuffer): WindField {
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const n = h.nx * h.ny;
  const b = new Uint8Array(buf, 4 + hl, n * 2);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const su = (h.umax - h.umin) / 255;
  const sv = (h.vmax - h.vmin) / 255;
  for (let i = 0; i < n; i++) {
    u[i] = h.umin + b[i * 2] * su;
    v[i] = h.vmin + b[i * 2 + 1] * sv;
  }
  return { nx: h.nx, ny: h.ny, lon0: h.lon0, lat0: h.lat0, dlon: h.dlon, dlat: h.dlat, time: h.time, u, v };
}

const SEG_VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec2 a_pos;
in float a_speed;
out float v_speed;
void main() {
  v_speed = a_speed;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;
const SEG_FS = `#version 300 es
precision highp float;
in float v_speed;
uniform int u_white;
out vec4 frag;
vec3 ramp(float s) {
  vec3 c = mix(vec3(0.23,0.51,0.96), vec3(0.13,0.83,0.93), smoothstep(0.0, 5.0, s));
  c = mix(c, vec3(0.29,0.87,0.5), smoothstep(5.0, 10.0, s));
  c = mix(c, vec3(0.98,0.8,0.08), smoothstep(10.0, 17.0, s));
  c = mix(c, vec3(0.98,0.45,0.09), smoothstep(17.0, 26.0, s));
  c = mix(c, vec3(0.94,0.27,0.27), smoothstep(26.0, 38.0, s));
  c = mix(c, vec3(0.91,0.47,0.98), smoothstep(38.0, 60.0, s));
  return c;
}
void main() {
  vec3 c = u_white == 1 ? vec3(1.0) : ramp(v_speed);
  frag = vec4(c * 0.9, 0.9);
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
out vec4 frag;
void main() { vec4 c = texture(u_tex, v_uv); frag = max(c * u_mul - vec4(u_sub), vec4(0.0)); }`;

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

export class ParticleLayer implements CustomLayerInterface {
  id = "wind-particles";
  type = "custom" as const;
  renderingMode = "2d" as const;
  field: WindField | null = null;
  on = false;
  opacity = 0.9;
  density = 1;
  speed = 1;
  white = false;
  private map: MLMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private seg: WebGLProgram | null = null;
  private quad: WebGLProgram | null = null;
  private segVao: WebGLVertexArrayObject | null = null;
  private segBuf: WebGLBuffer | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer | null = null;
  private tw = 0;
  private th = 0;
  private cur = 0;
  private reset = true;
  private moving = false;
  /** per particle: x, y (mercator 0..1), age, max age */
  private p = new Float32Array(0);
  private verts = new Float32Array(0);
  private lastT = 0;

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    this.seg = compile(gl, SEG_VS, SEG_FS);
    this.quad = compile(gl, QUAD_VS, QUAD_FS);
    this.segVao = gl.createVertexArray();
    this.segBuf = gl.createBuffer();
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    const ap = gl.getAttribLocation(this.seg, "a_pos");
    const as = gl.getAttribLocation(this.seg, "a_speed");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(as);
    gl.vertexAttribPointer(as, 1, gl.FLOAT, false, 12, 8);
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

  setField(f: WindField | null) {
    this.field = f;
    this.reset = true;
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

  private sample(lon: number, lat: number, out: number[]): boolean {
    const f = this.field!;
    lon = ((lon - f.lon0 + 540) % 360) - 180 + f.lon0;
    const fx = (lon - f.lon0) / f.dlon;
    const fy = (lat - f.lat0) / f.dlat;
    if (fx < 0 || fy < 0 || fx > f.nx - 1 || fy > f.ny - 1) return false;
    const x0 = Math.min(f.nx - 2, Math.floor(fx)), y0 = Math.min(f.ny - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0;
    const i = y0 * f.nx + x0;
    const b = (a: Float32Array) => (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + f.nx] * (1 - tx) + a[i + f.nx + 1] * tx) * ty;
    if (f.nx < 2 || f.ny < 2) return false;
    out[0] = b(f.u);
    out[1] = b(f.v);
    return true;
  }

  private view() {
    const b = this.map!.getBounds();
    return { x0: mercX(b.getWest()), x1: mercX(b.getEast()), y0: mercY(b.getNorth()), y1: mercY(b.getSouth()) };
  }

  private spawn(i: number, v: { x0: number; x1: number; y0: number; y1: number }, randomAge: boolean) {
    const p = this.p;
    p[i * 4] = v.x0 + Math.random() * (v.x1 - v.x0);
    p[i * 4 + 1] = v.y0 + Math.random() * (v.y1 - v.y0);
    const max = 40 + Math.random() * 70;
    p[i * 4 + 2] = randomAge ? Math.random() * max : 0;
    p[i * 4 + 3] = max;
  }

  private step(): number {
    const m = this.map!;
    const c = m.getCanvas();
    const want = Math.round(Math.min(24000, Math.max(1500, ((c.clientWidth * c.clientHeight) / 260) * this.density)));
    const v = this.view();
    if (this.p.length !== want * 4) {
      this.p = new Float32Array(want * 4);
      this.verts = new Float32Array(want * 6);
      for (let i = 0; i < want; i++) this.spawn(i, v, true);
    }
    // a constant screen speed at every zoom: 10 m/s ≈ 1.2 px per frame at "Normal"
    const now = performance.now();
    const dtf = this.lastT ? Math.min(3, (now - this.lastT) / 16.7) : 1;
    this.lastT = now;
    const world = 512 * Math.pow(2, m.getZoom());
    const k = (0.12 * this.speed * dtf) / world;
    const uv = [0, 0];
    const p = this.p, out = this.verts;
    let n = 0;
    for (let i = 0; i < want; i++) {
      let x = p[i * 4], y = p[i * 4 + 1];
      if (p[i * 4 + 2]++ > p[i * 4 + 3] || x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1 || !this.sample(lonOf(x), latOf(y), uv)) {
        this.spawn(i, v, false);
        continue;
      }
      const sp = Math.hypot(uv[0], uv[1]);
      const nx = x + uv[0] * k;
      const ny = y - uv[1] * k;
      out[n++] = x;
      out[n++] = y;
      out[n++] = sp;
      out[n++] = nx;
      out[n++] = ny;
      out[n++] = sp;
      p[i * 4] = nx;
      p[i * 4 + 1] = ny;
    }
    return n / 3;
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    if (!this.on || !this.field || !this.seg || !this.quad || document.hidden) return;
    this.ensureTextures(gl);
    const nv = this.step();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const src = this.cur, dst = 1 - this.cur;
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
      gl.uniform1i(gl.getUniformLocation(this.quad, "u_tex"), 0);
      gl.uniform1f(gl.getUniformLocation(this.quad, "u_mul"), 0.91);
      gl.uniform1f(gl.getUniformLocation(this.quad, "u_sub"), 1.5 / 255);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.reset = false;
    // new segments
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.seg);
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, nv * 3), gl.DYNAMIC_DRAW);
    const m = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    gl.uniformMatrix4fv(gl.getUniformLocation(this.seg, "u_matrix"), false, m);
    gl.uniform1i(gl.getUniformLocation(this.seg, "u_white"), this.white ? 1 : 0);
    gl.drawArrays(gl.LINES, 0, nv);
    // back to the map's framebuffer: draw the trails
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[dst]);
    gl.uniform1i(gl.getUniformLocation(this.quad, "u_tex"), 0);
    gl.uniform1f(gl.getUniformLocation(this.quad, "u_mul"), this.opacity);
    gl.uniform1f(gl.getUniformLocation(this.quad, "u_sub"), 0);
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

/** Timeline time while a model / forecast layer is shown, else latest. */
function wantTime(): number | undefined {
  return isForecast.value ? activeTime.value || undefined : undefined;
}

let gen = 0;
let lastErr = "";
async function loadField() {
  const m = map;
  const c = cfg();
  if (!m || !layer || !c.on || !api.base) return;
  const g = ++gen;
  const b = m.getBounds();
  let w = b.getWest(), e = b.getEast();
  const s0 = Math.max(-85, b.getSouth()), n0 = Math.min(85, b.getNorth());
  const pw = (e - w) * 0.15, ph = (n0 - s0) * 0.15;
  w -= pw;
  e += pw;
  if (e - w >= 360) (w = -180), (e = 180);
  const bbox = [w, Math.max(-85, s0 - ph), e, Math.min(85, n0 + ph)].map((x) => x.toFixed(3)).join(",");
  const t = wantTime();
  const q = `/api/grid/wind?layer=${c.opts.model}&level=${c.opts.level}&bbox=${bbox}&max=256${t ? `&time=${t}` : ""}`;
  windStatus.value = { ...windStatus.value, loading: true };
  try {
    const f = parseWind(await api.bin(q));
    if (g !== gen) return;
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
  layer.opacity = c.opacity;
  layer.density = c.opts.density === "lo" ? 0.5 : c.opts.density === "hi" ? 2 : 1;
  layer.speed = +c.opts.speed || 1;
  layer.white = c.opts.color === "white";
  layer.setOn(c.on);
  const sig = c.on ? `${c.opts.model}|${c.opts.level}|${api.base}` : "";
  if (sig !== lastSig) {
    lastSig = sig;
    if (!c.on) layer.setField(null);
    else reload(0);
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
