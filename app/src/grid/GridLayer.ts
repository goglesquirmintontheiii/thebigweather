// WebGL2 layer for gridded rasters: raw u16 values on the GPU, colored by the active table.

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from "maplibre-gl";
import type { Raster } from "./raster";
import { type ColorTable, rasterize, TEX_SIZE } from "../radar/colormaps";

const VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform usampler2D u_data;
uniform sampler2D u_cmap;
uniform ivec2 u_size;
uniform float u_scale;
uniform float u_offset;
uniform float u_cmin;
uniform float u_cmax;
uniform float u_opacity;
uniform int u_smooth;
uniform int u_rgb;
uniform sampler2D u_color;

float val(ivec2 p) {
  p = clamp(p, ivec2(0), u_size - 1);
  uint r = texelFetch(u_data, p, 0).r;
  return r == 0u ? -1e30 : u_offset + (float(r) - 1.0) * u_scale;
}

void main() {
  if (u_rgb == 1) {
    vec4 c = texture(u_color, v_uv);
    float a = c.a * u_opacity;
    if (a <= 0.003) discard;
    fragColor = vec4(c.rgb * a, a);
    return;
  }
  vec2 f = v_uv * vec2(u_size) - 0.5;
  ivec2 p0 = ivec2(floor(f));
  vec2 t = f - vec2(p0);
  float v;
  float c = val(ivec2(floor(v_uv * vec2(u_size))));
  if (c < -1e29) discard;
  if (u_smooth == 1) {
    float a = val(p0), b = val(p0 + ivec2(1, 0)), d = val(p0 + ivec2(0, 1)), e = val(p0 + ivec2(1, 1));
    float wa = (1.0 - t.x) * (1.0 - t.y), wb = t.x * (1.0 - t.y), wd = (1.0 - t.x) * t.y, we = t.x * t.y;
    float acc = 0.0, ws = 0.0;
    if (a > -1e29) { acc += a * wa; ws += wa; }
    if (b > -1e29) { acc += b * wb; ws += wb; }
    if (d > -1e29) { acc += d * wd; ws += wd; }
    if (e > -1e29) { acc += e * we; ws += we; }
    v = ws > 0.0 ? acc / ws : c;
  } else {
    v = c;
  }
  vec4 col = texture(u_cmap, vec2(clamp((v - u_cmin) / (u_cmax - u_cmin), 0.0, 1.0), 0.5));
  float alpha = col.a * u_opacity;
  if (alpha <= 0.003) discard;
  fragColor = vec4(col.rgb * alpha, alpha);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
  return s;
}

function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  return o;
}

export class GridLayer implements CustomLayerInterface {
  id = "grid";
  type = "custom" as const;
  renderingMode = "2d" as const;
  private map?: MLMap;
  private gl?: WebGL2RenderingContext;
  private prog?: WebGLProgram;
  private vao?: WebGLVertexArrayObject;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private textures = new Map<Raster, { tex: WebGLTexture; used: number }>();
  private cmaps = new Map<ColorTable, WebGLTexture>();
  raster: Raster | null = null;
  table: ColorTable | null = null;
  opacity = 0.85;
  smooth = true;

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
    this.prog = p;
    for (const n of ["u_matrix", "u_data", "u_cmap", "u_size", "u_scale", "u_offset", "u_cmin", "u_cmax", "u_opacity", "u_smooth", "u_rgb", "u_color"]) this.loc[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, "a_pos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    map.triggerRepaint();
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    this.textures.clear();
    for (const t of this.cmaps.values()) gl.deleteTexture(t);
    this.cmaps.clear();
  }

  set(raster: Raster | null, table: ColorTable | null, opacity: number, smooth: boolean) {
    this.raster = raster;
    this.table = table;
    this.opacity = opacity;
    this.smooth = smooth;
    this.map?.triggerRepaint();
  }

  release(r: Raster) {
    const t = this.textures.get(r);
    if (t && this.gl) this.gl.deleteTexture(t.tex);
    this.textures.delete(r);
  }

  private texFor(r: Raster): WebGLTexture {
    const hit = this.textures.get(r);
    if (hit) {
      hit.used = performance.now();
      return hit.tex;
    }
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (r.rgba) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, r.w, r.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, r.rgba);
    } else {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, r.w, r.h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, r.data);
    }
    this.textures.set(r, { tex, used: performance.now() });
    // keep GPU memory bounded
    if (this.textures.size > 40) {
      const old = [...this.textures.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.textures.size - 40);
      for (const [k, v] of old) {
        gl.deleteTexture(v.tex);
        this.textures.delete(k);
      }
    }
    return tex;
  }

  private dummyU?: WebGLTexture;
  private dummyFl?: WebGLTexture;
  /** 1x1 placeholders so both samplers always have a texture of the right kind bound */
  private dummy(): WebGLTexture {
    if (this.dummyU) return this.dummyU;
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(1));
    return (this.dummyU = t);
  }
  private dummyF(): WebGLTexture {
    if (this.dummyFl) return this.dummyFl;
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return (this.dummyFl = t);
  }

  private cmapTex(t: ColorTable): WebGLTexture {
    let tex = this.cmaps.get(t);
    if (tex) return tex;
    const gl = this.gl!;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, t.labels ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, t.labels ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rasterize(t));
    this.cmaps.set(t, tex);
    return tex;
  }

  render(gl: WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const r = this.raster;
    const t = this.table;
    if (!this.prog || !r || (!t && !r.rgba)) return;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao!);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    const model = [r.x1 - r.x0, 0, 0, 0, 0, r.y1 - r.y0, 0, 0, 0, 0, 1, 0, r.x0, r.y0, 0, 1];
    const m = (opts as any).defaultProjectionData?.mainMatrix ?? opts.modelViewProjectionMatrix;
    const L = this.loc;
    gl.uniformMatrix4fv(L.u_matrix, false, mul(m, model));
    gl.uniform2i(L.u_size, r.w, r.h);
    gl.uniform1f(L.u_scale, r.scale);
    gl.uniform1f(L.u_offset, r.offset);
    gl.uniform1f(L.u_opacity, this.opacity);
    gl.uniform1i(L.u_rgb, r.rgba ? 1 : 0);
    if (r.rgba) {
      // the integer sampler still needs a valid binding
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.texFor(r));
      gl.uniform1i(L.u_color, 2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dummy());
      gl.uniform1i(L.u_data, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyF());
      gl.uniform1i(L.u_cmap, 1);
    } else {
      gl.uniform1f(L.u_cmin, t!.min);
      gl.uniform1f(L.u_cmax, t!.max);
      gl.uniform1i(L.u_smooth, this.smooth && !t!.labels ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texFor(r));
      gl.uniform1i(L.u_data, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.cmapTex(t!));
      gl.uniform1i(L.u_cmap, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyF());
      gl.uniform1i(L.u_color, 2);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
