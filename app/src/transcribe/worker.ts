/// <reference lib="webworker" />
// Whisper (transformers.js) speech-to-text worker. transformers.js is imported lazily on the first
// "load" so the worker itself is tiny; ONNX Runtime's wasm comes from the app bundle (offline once
// the model files are in the browser cache).
//
// in:  {type:"load", model, device: "auto"|"webgpu"|"wasm"}  {type:"run", id, pcm: Float32Array}
// out: {type:"progress", pct, file, loaded, total}  {type:"ready", device, model}
//      {type:"result", id, text, ms}  {type:"error", id?, message}

import ortWasm from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";

declare const self: DedicatedWorkerGlobalScope;

type Asr = (pcm: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Asr | null = null;
let loading: Promise<void> | null = null;

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(model: string, device: string) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const onnx = env.backends.onnx as any;
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = { wasm: new URL(ortWasm, self.location.href).href, mjs: new URL(ortMjs, self.location.href).href };
    onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  }
  const gpu = device === "webgpu" || (device === "auto" && (await hasWebGpu()));
  const files = new Map<string, { loaded: number; total: number }>();
  const progress = (p: any) => {
    if (p.status === "progress" && p.file) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let l = 0;
      let t = 0;
      for (const f of files.values()) (l += f.loaded), (t += f.total);
      self.postMessage({ type: "progress", pct: t ? (100 * l) / t : 0, file: p.file, loaded: l, total: t });
    }
  };
  const opts = (dev: "webgpu" | "wasm") => ({
    device: dev,
    dtype: dev === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: progress,
  });
  let dev: "webgpu" | "wasm" = gpu ? "webgpu" : "wasm";
  try {
    asr = (await pipeline("automatic-speech-recognition", model, opts(dev) as any)) as unknown as Asr;
  } catch (e) {
    if (dev !== "webgpu") throw e;
    dev = "wasm";
    asr = (await pipeline("automatic-speech-recognition", model, opts(dev) as any)) as unknown as Asr;
  }
  // warm up so the first real chunk isn't slow
  await asr(new Float32Array(16000));
  self.postMessage({ type: "ready", device: dev, model });
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "load") {
    loading ??= load(m.model, m.device ?? "auto").catch((err) => {
      loading = null;
      self.postMessage({ type: "error", message: `Couldn't load ${m.model}: ${err?.message ?? err}` });
    });
    return;
  }
  if (m.type === "run") {
    try {
      await loading;
      if (!asr) throw new Error("model not loaded");
      const t0 = performance.now();
      const r = await asr(m.pcm);
      const text = (Array.isArray(r) ? r.map((x) => x.text).join(" ") : r.text).trim();
      self.postMessage({ type: "result", id: m.id, text, ms: performance.now() - t0 });
    } catch (err: any) {
      self.postMessage({ type: "error", id: m.id, message: String(err?.message ?? err) });
    }
  }
};
