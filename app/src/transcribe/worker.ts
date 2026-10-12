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

type Asr = ((pcm: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>) & { model?: any; tokenizer?: any; processor?: any };
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

// ---------- p7: decoding with a prompt, repeat blocking and a sampled fallback ----------

const looped = (t: string) => {
  const w = t.toLowerCase().split(/\s+/).filter(Boolean);
  return w.length >= 12 && new Set(w).size / w.length < 0.35;
};

/** Whisper with an "initial prompt": <|startofprev|> prompt tokens, then the usual start tokens;
 * only the newly generated tokens are decoded. Falls back to the plain pipeline when the
 * model/tokenizer don't expose what's needed. */
async function decode(pcm: Float32Array, prompt: string | undefined, gen: Record<string, unknown>): Promise<string> {
  const a = asr!;
  const tok = a.tokenizer;
  const model = a.model;
  const gc = model?.generation_config;
  if (prompt && tok && model && a.processor && gc?.decoder_start_token_id != null) {
    try {
      const prev = tok.encode("<|startofprev|>", { add_special_tokens: false }) as number[];
      if (prev.length === 1) {
        const ids = (tok.encode(" " + prompt.trim(), { add_special_tokens: false }) as number[]).slice(-120);
        const start = [gc.decoder_start_token_id, ...(gc.no_timestamps_token_id != null ? [gc.no_timestamps_token_id] : [])];
        const dec = [prev[0], ...ids, ...start];
        const feats = await a.processor(pcm);
        const out = await model.generate({ inputs: feats.input_features, decoder_input_ids: dec, max_new_tokens: 200, ...gen });
        const seq: number[] = (out[0] ?? out).tolist().map(Number);
        const body = seq.slice(0, dec.length).every((v, i) => v === dec[i]) ? seq.slice(dec.length) : seq.slice(seq.lastIndexOf(start[start.length - 1]) + 1);
        return String(tok.decode(body, { skip_special_tokens: true })).trim();
      }
    } catch (err) {
      console.warn("whisper prompt decode failed, using the plain pipeline", err);
    }
  }
  const r = await a(pcm, gen);
  return (Array.isArray(r) ? r.map((x) => x.text).join(" ") : r.text).trim();
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
      // greedy with 6-token repeat blocking (the prompt counts too, its terms are shorter); a looping result is retried once, sampled at T=0.4 and
      // without the prompt (Whisper's temperature fallback, single step to keep CPU use bounded)
      let text = await decode(m.pcm, m.prompt, { no_repeat_ngram_size: 6 });
      if (looped(text)) text = await decode(m.pcm, undefined, { no_repeat_ngram_size: 4, do_sample: true, temperature: 0.4, top_k: 0 });
      self.postMessage({ type: "result", id: m.id, text, ms: performance.now() - t0 });
    } catch (err: any) {
      self.postMessage({ type: "error", id: m.id, message: String(err?.message ?? err) });
    }
  }
};
