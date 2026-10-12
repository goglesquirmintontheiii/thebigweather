// Loop export: steps through every timeline frame, waits for it to be drawn, grabs the map
// (plus legend, time stamp and attribution) or the whole window, then encodes a GIF (gifenc.ts)
// or WebM/MP4 (MediaRecorder on a canvas stream) and saves it to Downloads/TheBigWeather.

import { signal } from "@preact/signals";
import { settings, toast } from "./store";
import { frameIndex, playing, frameCount } from "./anim";
import { activeFrames, activeTime, activeLegend } from "./active";
import { mapRef } from "./map/mapview";
import { rasterize, TEX_SIZE } from "./radar/colormaps";
import { productName } from "./radar/controller";
import { gridDef } from "./weather";
import { fmtTime, convertUnit } from "./util";
import { GifWriter, buildPalette } from "./gifenc";
import { saveFile, stamp } from "./saveio";

export type LoopFormat = "gif" | "webm" | "mp4";
export interface LoopOpts {
  format: LoopFormat;
  area: "map" | "window" | "crop";
  /** crop size in CSS px, centred on the map */
  crop: [number, number];
  /** output scale (0.5–1) */
  scale: number;
  fps: number;
  /** times the sequence plays (GIF: 0 = forever) */
  loops: number;
  /** legend + time + attribution on map captures */
  decor: boolean;
}

export const loopDialog = signal(false);
export const loopProgress = signal<{ phase: "capture" | "encode"; i: number; n: number } | null>(null);
export const loopOpts = signal<LoopOpts>({ format: "gif", area: "map", crop: [800, 600], scale: 1, fps: 6, loops: 0, decor: true });
let cancelled = false;

export function mp4Supported() {
  return typeof MediaRecorder !== "undefined" && (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1") || MediaRecorder.isTypeSupported("video/mp4"));
}
export const canWindow = () => !!(window as any).tbw?.captureBuf;

export function cancelLoopExport() {
  cancelled = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** Wait until timeline frame i is loaded (or failed), then until the map has settled. */
async function waitFrame(i: number) {
  const t0 = performance.now();
  while (performance.now() - t0 < 20_000 && !cancelled) {
    const f = activeFrames.value[i];
    if (!f || f.state !== "wait") break;
    await sleep(100);
  }
  const map = mapRef.value!;
  await new Promise<void>((res) => {
    const done = () => (clearTimeout(t), res());
    const t = setTimeout(done, 4000);
    map.once("idle", done);
    map.triggerRepaint();
  });
  await raf();
}

/** Draw the map's WebGL canvas right after a render (the buffer isn't preserved). */
function grabMap(): Promise<HTMLCanvasElement> {
  const map = mapRef.value!;
  return new Promise((res) => {
    map.once("render", () => {
      const src = map.getCanvas();
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      c.getContext("2d")!.drawImage(src, 0, 0);
      res(c);
    });
    map.triggerRepaint();
  });
}

async function grabWindow(): Promise<ImageBitmap> {
  document.body.classList.add("loopx-hide");
  await raf();
  await raf();
  try {
    const buf: Uint8Array = await (window as any).tbw.captureBuf();
    return await createImageBitmap(new Blob([buf as BlobPart], { type: "image/png" }));
  } finally {
    document.body.classList.remove("loopx-hide");
  }
}

function layerLabel(): string {
  const s = settings.value;
  const w = s.weather;
  if (w.kind === "radar") return `${s.radar.site} · ${productName(s.radar.product)}${s.radar.source === "L2" ? ` ${s.radar.tiltAngle.toFixed(1)}°` : ""}${s.srv.on && s.radar.product === "VEL" ? " · SRV" : ""}`;
  if (w.kind === "grid") return gridDef(w.id)?.name ?? w.id;
  return w.id;
}

/** Time stamp, legend bar and attribution drawn onto the output (sizes in output px). */
function decorate(ctx: CanvasRenderingContext2D, W: number, H: number, time: number) {
  const k = Math.max(0.7, Math.min(2, W / 1100));
  const pad = 10 * k;
  ctx.save();
  ctx.textBaseline = "top";
  // time + layer
  ctx.font = `700 ${16 * k}px Inter, system-ui, sans-serif`;
  const t1 = fmtTime(time, true);
  const t2 = layerLabel();
  const w1 = Math.max(ctx.measureText(t1).width, (ctx.font = `500 ${12 * k}px Inter, system-ui, sans-serif`, ctx.measureText(t2).width));
  ctx.fillStyle = "rgba(10,13,18,.78)";
  ctx.beginPath();
  ctx.roundRect(pad, pad, w1 + 20 * k, 44 * k, 8 * k);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${16 * k}px Inter, system-ui, sans-serif`;
  ctx.fillText(t1, pad + 10 * k, pad + 6 * k);
  ctx.fillStyle = "#b9c3cf";
  ctx.font = `500 ${12 * k}px Inter, system-ui, sans-serif`;
  ctx.fillText(t2, pad + 10 * k, pad + 26 * k);
  // legend
  const L = activeLegend.value;
  if (L) {
    const lw = Math.min(360 * k, W * 0.45);
    const lh = 10 * k;
    const x0 = pad, y0 = H - pad - lh - 30 * k;
    ctx.fillStyle = "rgba(10,13,18,.78)";
    ctx.beginPath();
    ctx.roundRect(x0, y0, lw + 20 * k, lh + 30 * k, 8 * k);
    ctx.fill();
    const r = rasterize(L.table);
    for (let i = 0; i < lw; i++) {
      const j = Math.min(TEX_SIZE - 1, Math.floor((i / lw) * TEX_SIZE));
      ctx.fillStyle = `rgba(${r[j * 4]},${r[j * 4 + 1]},${r[j * 4 + 2]},${Math.max(0.15, r[j * 4 + 3] / 255)})`;
      ctx.fillRect(x0 + 10 * k + i, y0 + 8 * k, 1.5, lh);
    }
    ctx.fillStyle = "#cfd8e3";
    ctx.font = `500 ${10 * k}px Inter, system-ui, sans-serif`;
    const t = L.table;
    for (let q = 0; q <= 4; q++) {
      const v = t.min + ((t.max - t.min) * q) / 4;
      const [cv] = convertUnit(v, L.units);
      let s = Math.abs(cv) < 10 ? cv.toFixed(1).replace(/\.0$/, "") : String(Math.round(cv));
      if (q === 4) s += ` ${convertUnit(v, L.units)[1]}`;
      const x = x0 + 10 * k + (lw * q) / 4;
      ctx.textAlign = q === 0 ? "left" : q === 4 ? "right" : "center";
      ctx.fillText(s, x, y0 + 10 * k + lh);
    }
  }
  // attribution
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.font = `500 ${10 * k}px Inter, system-ui, sans-serif`;
  const at = "© OpenStreetMap · CARTO · NOAA/NWS · TheBigWeather";
  const aw = ctx.measureText(at).width;
  ctx.fillStyle = "rgba(10,13,18,.6)";
  ctx.fillRect(W - aw - 14 * k, H - 18 * k, aw + 14 * k, 18 * k);
  ctx.fillStyle = "#cfd8e3";
  ctx.fillText(at, W - 7 * k, H - 4 * k);
  ctx.restore();
}

export async function runLoopExport() {
  const map = mapRef.value;
  const o = loopOpts.value;
  const n = frameCount.value;
  if (!map || n < 1) return toast("Nothing to export", "warn");
  if (loopProgress.value) return;
  cancelled = false;
  const wasPlaying = playing.value;
  const wasIndex = frameIndex.value;
  playing.value = false;
  loopDialog.value = false;
  const N = Math.min(n, 150);
  const first = n - N;
  const frames: ImageData[] = [];
  let W = 0, H = 0;
  const out = document.createElement("canvas");
  const octx = out.getContext("2d", { willReadFrequently: true })!;
  try {
    for (let i = first; i < n && !cancelled; i++) {
      loopProgress.value = { phase: "capture", i: i - first, n: N };
      frameIndex.value = i;
      await waitFrame(i);
      if (cancelled) break;
      const time = activeTime.value;
      let src: CanvasImageSource, sx = 0, sy = 0, sw = 0, sh = 0;
      if (o.area === "window" && canWindow()) {
        const b = await grabWindow();
        src = b;
        sw = b.width;
        sh = b.height;
      } else {
        const c = await grabMap();
        src = c;
        sw = c.width;
        sh = c.height;
        if (o.area === "crop") {
          const dpr = c.width / map.getContainer().clientWidth;
          const cw = Math.min(sw, Math.round(o.crop[0] * dpr)), ch = Math.min(sh, Math.round(o.crop[1] * dpr));
          sx = Math.round((sw - cw) / 2);
          sy = Math.round((sh - ch) / 2);
          sw = cw;
          sh = ch;
        }
      }
      if (!W) {
        // even sizes keep video encoders happy
        W = Math.max(2, Math.round((sw * o.scale) / 2) * 2);
        H = Math.max(2, Math.round((sh * o.scale) / 2) * 2);
        out.width = W;
        out.height = H;
      }
      octx.clearRect(0, 0, W, H);
      octx.fillStyle = "#07090c";
      octx.fillRect(0, 0, W, H);
      octx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
      if (o.decor && o.area !== "window") decorate(octx, W, H, time);
      frames.push(octx.getImageData(0, 0, W, H));
      if ("close" in src) (src as ImageBitmap).close();
    }
    if (cancelled) {
      toast("Loop export cancelled");
      return;
    }
    const delay = 1000 / o.fps;
    const dwell = Math.max(delay, settings.value.anim.dwellMs);
    let blob: Blob;
    let ext: string;
    if (o.format === "gif") {
      loopProgress.value = { phase: "encode", i: 0, n: frames.length };
      await sleep(30);
      const { pal, lut } = buildPalette(frames.map((f) => f.data));
      const loops = o.loops === 0 ? 0 : o.loops === 1 ? null : o.loops - 1;
      const g = new GifWriter(W, H, pal, lut, loops);
      for (let i = 0; i < frames.length && !cancelled; i++) {
        loopProgress.value = { phase: "encode", i, n: frames.length };
        g.addFrame(frames[i].data, i === frames.length - 1 ? dwell : delay);
        await sleep(0);
      }
      if (cancelled) return toast("Loop export cancelled");
      blob = g.finish();
      ext = "gif";
    } else {
      const mp4 = o.format === "mp4" && mp4Supported();
      const mime = mp4
        ? MediaRecorder.isTypeSupported("video/mp4;codecs=avc1") ? "video/mp4;codecs=avc1" : "video/mp4"
        : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
      ext = mp4 ? "mp4" : "webm";
      const vc = document.createElement("canvas");
      vc.width = W;
      vc.height = H;
      const vctx = vc.getContext("2d")!;
      vctx.putImageData(frames[0], 0, 0);
      const stream = vc.captureStream(0);
      const track = stream.getVideoTracks()[0] as any;
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(16_000_000, W * H * 6) });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start(500);
      const loops = Math.max(1, o.loops || 1);
      const total = frames.length * loops;
      let k = 0;
      for (let l = 0; l < loops && !cancelled; l++)
        for (let i = 0; i < frames.length && !cancelled; i++) {
          loopProgress.value = { phase: "encode", i: k++, n: total };
          vctx.putImageData(frames[i], 0, 0);
          track.requestFrame?.();
          await sleep(i === frames.length - 1 ? dwell : delay);
        }
      track.requestFrame?.();
      await sleep(60);
      rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      if (cancelled) return toast("Loop export cancelled");
      blob = new Blob(chunks, { type: mime.split(";")[0] });
    }
    const f = await saveFile(`TheBigWeather-loop-${stamp()}.${ext}`, blob);
    if (f) toast(`Saved ${f} (${(blob.size / 1048576).toFixed(1)} MB)`, "info", 7000);
  } catch (e: any) {
    toast(`Loop export failed: ${e?.message ?? e}`, "error", 7000);
  } finally {
    loopProgress.value = null;
    frameIndex.value = Math.min(wasIndex, Math.max(0, frameCount.value - 1));
    if (wasPlaying) playing.value = true;
  }
}
