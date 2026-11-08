// 0.8.3 3d: height-surface renderer (MapLibre custom layer) for 2D products in 3D mode — Level III /
// single-tilt sweeps, velocity (|v|), composite, echo tops, VIL, MRMS and model grids. The field is
// max-pooled onto a capped grid (radar/surface3dcore.ts), turned into one indexed triangle mesh and
// shaded with facet normals from screen-space derivatives (no normal buffer, exaggeration is a uniform).
// Colours come from the product's colour table, so the legend still applies.

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import { type ColorTable, rasterize, TEX_SIZE } from "./colormaps";
import { buildMesh, raySurface, MESH_STRIDE, type Field, type HeightMap, type Mesh } from "./surface3dcore";

const VS = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
uniform float u_zs;
in vec3 a_pos;
in vec2 a_val;
out float v_val;
out float v_ok;
out vec3 v_p;
void main() {
  v_val = a_val.x;
  v_ok = a_val.y;
  vec3 p = vec3(a_pos.xy, a_pos.z * u_zs);
  v_p = p * 10000.0;
  gl_Position = u_mvp * vec4(p, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in float v_val;
in float v_ok;
in vec3 v_p;
out vec4 frag;
uniform sampler2D u_cmap;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_opacity;
uniform int u_shade;
uniform vec3 u_sun;
void main() {
  if (v_ok < 0.5) discard;
  vec4 c = texture(u_cmap, vec2(clamp((v_val - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5));
  if (c.a < 0.12) discard;
  vec3 rgb = c.rgb;
  if (u_shade == 1) {
    vec3 n = normalize(cross(dFdx(v_p), dFdy(v_p)));
    if (n.z < 0.0) n = -n;
    float lit = 0.42 + 0.58 * max(dot(n, u_sun), 0.0);
    // brighter on flat tops, a touch darker on steep walls
    rgb *= lit * (0.9 + 0.1 * n.z);
  }
  frag = vec4(rgb * u_opacity, u_opacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
  return s;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  mesh: Mesh;
  used: number;
}

export interface SurfParams {
  exag: number;
  shade: boolean;
  opacity: number;
}

export class Surface3DLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;
  field: Field | null = null;
  hm: HeightMap | null = null;
  table: ColorTable | null = null;
  params: SurfParams = { exag: 4, shade: true, opacity: 1 };
  error: string | null = null;
  private map?: MLMap;
  private gl?: WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private meshes = new Map<Field, GpuMesh>();
  private hmSig = new WeakMap<Field, string>();
  private cmaps = new Map<ColorTable, WebGLTexture>();
  private lastMvp: Float64Array | null = null;

  constructor(id = "surface3d") {
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
    for (const n of ["u_mvp", "u_zs", "u_cmap", "u_cmin", "u_cmax", "u_opacity", "u_shade", "u_sun"]) this.loc[n] = gl.getUniformLocation(this.prog, n);
    map.triggerRepaint();
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const m of this.meshes.values()) this.free(m);
    this.meshes.clear();
    for (const t of this.cmaps.values()) gl.deleteTexture(t);
    this.cmaps.clear();
    if (this.prog) gl.deleteProgram(this.prog);
    this.prog = undefined;
    this.gl = undefined;
  }

  set(field: Field | null, table: ColorTable | null, hm: HeightMap | null, params: Partial<SurfParams>) {
    if (table !== this.table && this.table) this.dropTable(this.table);
    this.field = field;
    this.table = table;
    this.hm = hm;
    this.params = { ...this.params, ...params };
    this.map?.triggerRepaint();
  }

  /** forget an edited colour table */
  dropTable(t: ColorTable) {
    const tex = this.cmaps.get(t);
    if (tex && this.gl) this.gl.deleteTexture(tex);
    this.cmaps.delete(t);
  }

  private free(m: GpuMesh) {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteBuffer(m.vbo);
    gl.deleteBuffer(m.ibo);
    gl.deleteVertexArray(m.vao);
  }

  private meshFor(f: Field, hm: HeightMap): GpuMesh {
    const gl = this.gl!;
    const sig = `${hm.lo}|${hm.hi}|${hm.top}|${hm.perUnit ?? 0}|${hm.abs}`;
    let g = this.meshes.get(f);
    if (g && this.hmSig.get(f) === sig) return g;
    if (g) this.free(g);
    const mesh = buildMesh(f, hm);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
    const ap = gl.getAttribLocation(this.prog!, "a_pos");
    const av = gl.getAttribLocation(this.prog!, "a_val");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, MESH_STRIDE * 4, 0);
    gl.enableVertexAttribArray(av);
    gl.vertexAttribPointer(av, 2, gl.FLOAT, false, MESH_STRIDE * 4, 12);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    g = { vao, vbo, ibo, count: mesh.idx.length, mesh, used: performance.now() };
    this.meshes.set(f, g);
    this.hmSig.set(f, sig);
    // a few frames stay on the GPU so a playing loop doesn't rebuild every frame
    if (this.meshes.size > 4) {
      const o = [...this.meshes.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      this.free(o[1]);
      this.meshes.delete(o[0]);
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

  /** value / height under a CSS pixel (ray against the surface) */
  pick(px: number, py: number): { value: number; h: number; lon: number; lat: number } | null {
    const f = this.field, hm = this.hm, mvp = this.lastMvp, map = this.map;
    if (!f || !hm || !mvp || !map) return null;
    const inv = invert(mvp);
    if (!inv) return null;
    const c = map.getCanvas();
    const nx = (px / c.clientWidth) * 2 - 1, ny = 1 - (py / c.clientHeight) * 2;
    const un = (z: number): [number, number, number] => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * z + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * z + inv[13];
      const zz = inv[2] * nx + inv[6] * ny + inv[10] * z + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * z + inv[15];
      return [x / w, y / w, zz / w];
    };
    // model space: mercator relative to the mesh centre, z in metres·exag (u_zs folded into the model)
    const a = un(-1), b = un(1);
    const ref = this.meshes.get(f)?.mesh.ref ?? [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2];
    const mpm = 1 / (2 * Math.PI * 6371000 * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - 2 * ref[1])))));
    const toM = (p: [number, number, number]): [number, number, number] => [p[0] + ref[0], p[1] + ref[1], p[2] / mpm];
    // clip the ray to a little above the highest surface so the march stays fine-grained
    const A = toM(a), B = toM(b);
    const top = (hm.top + 500) * this.params.exag;
    if (A[2] > top && B[2] < top) {
      const t = (A[2] - top) / (A[2] - B[2]);
      for (let k = 0; k < 3; k++) A[k] = A[k] + (B[k] - A[k]) * t;
    }
    if (B[2] < 0 && A[2] > 0) {
      const t = A[2] / (A[2] - B[2]);
      for (let k = 0; k < 3; k++) B[k] = A[k] + (B[k] - A[k]) * t;
    }
    const hit = raySurface(f, hm, A, B, this.params.exag);
    if (!hit) return null;
    const lon = hit.x * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * hit.y))) * 180) / Math.PI;
    return { value: hit.value, h: hit.h, lon, lat };
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const f = this.field, t = this.table, hm = this.hm;
    if (!this.prog || !f || !t || !hm || !f.valid) return;
    let g: GpuMesh;
    try {
      g = this.meshFor(f, hm);
    } catch (e: any) {
      this.error = e.message;
      console.error(e);
      this.field = null;
      return;
    }
    g.used = performance.now();
    if (!g.count) return;
    const ref = g.mesh.ref;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ref[1])));
    const mpm = 1 / (2 * Math.PI * 6371000 * Math.cos(lat));
    const zs = mpm * this.params.exag;
    // model: translate to the mesh centre (z scale applied in the vertex shader)
    const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ref[0], ref[1], 0, 1];
    const base = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    const mvp = mul(base, model);
    this.lastMvp = mvp;
    gl.useProgram(this.prog);
    gl.bindVertexArray(g.vao);
    // the surface only has to hide itself: start from a clean depth buffer (the basemap's flat layers
    // write depth too and would cut into it)
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    const L = this.loc;
    gl.uniformMatrix4fv(L.u_mvp, false, new Float32Array(mvp));
    gl.uniform1f(L.u_zs, zs);
    gl.uniform1f(L.u_cmin, t.min);
    gl.uniform1f(L.u_cmax, t.max);
    gl.uniform1f(L.u_opacity, Math.max(0.05, Math.min(1, this.params.opacity)));
    gl.uniform1i(L.u_shade, this.params.shade ? 1 : 0);
    // light from the north-west and above (mercator y runs south)
    const s = [-0.45, -0.55, 0.7], sl = Math.hypot(s[0], s[1], s[2]);
    gl.uniform3f(L.u_sun, s[0] / sl, s[1] / sl, s[2] / sl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cmapTex(t));
    gl.uniform1i(L.u_cmap, 0);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }
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
