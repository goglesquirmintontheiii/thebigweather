// Whisper worker client + per-player transcription controller. Only one player transcribes at a
// time (it's CPU/GPU heavy); enabling it on another player asks to move it.

import { signal } from "@preact/signals";
import type { AudioTap } from "../audio/tap";
import { TranscriptSession, RATE, buildPrompt, type Transcriber, type Line } from "./core";
import { sameRecentPlaces } from "../same/monitor";

export type Quality = "fast" | "better" | "best";
// p7: "best" = whisper-small.en (≈250 MB quantized; slower, clearly more accurate on radio audio)
export const MODELS: Record<Quality, string> = { fast: "onnx-community/whisper-tiny.en", better: "onnx-community/whisper-base.en", best: "onnx-community/whisper-small.en" };
export const QUALITY_LABEL: Record<Quality, string> = { fast: "Fast (tiny.en)", better: "Better (base.en)", best: "Best (small.en, ~250 MB)" };

export interface ModelStatus {
  phase: "idle" | "loading" | "ready" | "error";
  pct: number;
  loaded?: number;
  total?: number;
  device?: string;
  model?: string;
  error?: string;
  lastMs?: number;
}
export const modelStatus = signal<ModelStatus>({ phase: "idle", pct: 0 });

function readQuality(): Quality | null {
  try {
    const q = localStorage.getItem("tbw.tx.quality");
    return q === "fast" || q === "better" || q === "best" ? q : null;
  } catch {
    return null;
  }
}
/** null until known: defaults to base.en with WebGPU, tiny.en without. */
export const quality = signal<Quality | null>(readQuality());
async function defaultQuality(): Promise<Quality> {
  try {
    const gpu = (navigator as any).gpu;
    return gpu && (await gpu.requestAdapter()) ? "better" : "fast";
  } catch {
    return "fast";
  }
}

let worker: Worker | null = null;
let workerModel = "";
let seq = 0;
const pending = new Map<number, { res: (t: string) => void; rej: (e: Error) => void }>();
let idleT = 0;

/** Overridable for tests / screenshots. */
export const workerFactory = { create: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) };

function ensureWorker(model: string): Worker {
  if (worker && workerModel === model) return worker;
  worker?.terminate();
  for (const p of pending.values()) p.rej(new Error("model changed"));
  pending.clear();
  worker = workerFactory.create();
  workerModel = model;
  modelStatus.value = { phase: "loading", pct: 0, model };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") modelStatus.value = { ...modelStatus.value, phase: "loading", pct: m.pct, loaded: m.loaded, total: m.total };
    else if (m.type === "ready") modelStatus.value = { phase: "ready", pct: 100, device: m.device, model: m.model };
    else if (m.type === "result") {
      modelStatus.value = { ...modelStatus.value, lastMs: m.ms };
      pending.get(m.id)?.res(m.text);
      pending.delete(m.id);
    } else if (m.type === "error") {
      if (m.id != null) {
        pending.get(m.id)?.rej(new Error(m.message));
        pending.delete(m.id);
      } else {
        modelStatus.value = { ...modelStatus.value, phase: "error", error: m.message };
        for (const p of pending.values()) p.rej(new Error(m.message));
        pending.clear();
        worker?.terminate();
        worker = null;
      }
    }
  };
  worker.onerror = (e) => {
    modelStatus.value = { ...modelStatus.value, phase: "error", error: e.message || "Worker failed to start" };
    worker = null;
  };
  worker.postMessage({ type: "load", model, device: "auto" });
  return worker;
}

class WorkerTranscriber implements Transcriber {
  constructor(private model: string) {}
  transcribe(pcm: Float32Array, prompt?: string): Promise<string> {
    // after a failed load, wait for the user to retry rather than re-downloading per chunk
    if (!worker && modelStatus.value.phase === "error") return Promise.reject(new Error(modelStatus.value.error));
    const w = ensureWorker(this.model);
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      const copy = pcm.slice();
      w.postMessage({ type: "run", id, pcm: copy, prompt }, [copy.buffer]);
    });
  }
}

/** Free the model's memory a while after the last transcription stops. */
function scheduleIdle() {
  clearTimeout(idleT);
  idleT = window.setTimeout(() => {
    if (owner.value) return;
    worker?.terminate();
    worker = null;
    modelStatus.value = { phase: "idle", pct: 0 };
  }, 3 * 60000);
}

export const owner = signal<TranscriptCtl | null>(null);

export class TranscriptCtl {
  on = signal(false);
  lines = signal<Line[]>([]);
  state = signal<{ busy: boolean; queued: number; error?: string; dropped?: number }>({ busy: false, queued: 0 });
  private sess: TranscriptSession | null = null;
  private unsub: (() => void) | null = null;

  constructor(
    public label: () => string,
    private getTap: () => Promise<AudioTap | null>,
  ) {}

  async enable(): Promise<boolean> {
    if (this.on.value) return true;
    const other = owner.value;
    if (other && other !== this) {
      if (!confirm(`Transcription is running on ${other.label()}. Only one stream can be transcribed at a time.\n\nMove it to ${this.label()}?`)) return false;
      other.disable();
    }
    clearTimeout(idleT);
    owner.value = this;
    this.on.value = true;
    quality.value ??= await defaultQuality();
    const model = MODELS[quality.value];
    ensureWorker(model);
    this.start(model);
    return true;
  }

  private gen = 0;
  private async start(model: string) {
    const g = ++this.gen;
    this.unsub?.();
    this.unsub = null;
    this.sess?.stop();
    this.sess = new TranscriptSession(
      new WorkerTranscriber(model),
      (l) => (this.lines.value = [...this.lines.value, l].slice(-2000)),
      (s) => (this.state.value = { ...s, dropped: this.sess?.dropped }),
    );
    // p7: weather vocabulary + county names from SAME headers heard recently as Whisper's prompt
    this.sess.prompt = () => buildPrompt(sameRecentPlaces.value);
    const tap = await this.getTap().catch(() => null);
    // a newer start (or a stop) happened while waiting for the tap
    if (!this.on.value || g !== this.gen) return;
    if (!tap) {
      this.state.value = { busy: false, queued: 0, error: "Can't read this stream's audio" };
      return;
    }
    const s = this.sess;
    this.unsub = tap.subscribe(RATE, (x) => s.push(x));
  }

  /** Feed PCM directly (testing / screenshots). */
  push(x: Float32Array) {
    this.sess?.push(x);
  }

  disable() {
    this.on.value = false;
    this.unsub?.();
    this.unsub = null;
    this.sess?.stop();
    this.sess = null;
    if (owner.value === this) owner.value = null;
    scheduleIdle();
  }

  toggle() {
    if (this.on.value) this.disable();
    else this.enable();
  }

  setQuality(q: Quality) {
    quality.value = q;
    try {
      localStorage.setItem("tbw.tx.quality", q);
    } catch {
      /* */
    }
    if (this.on.value) {
      this.unsub?.();
      this.sess?.stop();
      const model = MODELS[q];
      ensureWorker(model);
      this.start(model);
    }
  }

  retry() {
    if (!this.on.value) return;
    ensureWorker(MODELS[quality.value ?? "fast"]);
  }

  text(): string {
    return this.lines.value.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.text}`).join("\n");
  }
}
