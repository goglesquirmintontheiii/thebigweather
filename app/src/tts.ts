// radio/dash 0.8: text-to-speech with an offline fallback. The system engine (speechSynthesis)
// often has no voices in Electron on Linux (no speech-dispatcher) or fails silently; then — or when
// picked — the bundled meSpeak engine (eSpeak compiled to JS, public/tts/, loaded on first use in
// a worker) renders WAV that plays through WebAudio. Used by briefings, "read new warnings aloud"
// and rule actions.

import { signal } from "@preact/signals";
import { settings } from "./store";

export type TtsEngine = "auto" | "system" | "offline";
export const OFFLINE_VOICES: [string, string][] = [
  ["en-us", "English (US)"],
  ["en", "English (UK)"],
  ["en-rp", "English (Received Pronunciation)"],
  ["en-sc", "English (Scottish)"],
];

/** what spoke last / why the fallback was used (settings readout) */
export const ttsInfo = signal<{ engine: "system" | "offline" | null; note: string; loading?: boolean }>({ engine: null, note: "" });
export const ttsSpeaking = signal(false);

/** the system engine failed this session (no voices / error / never started): go offline directly */
let systemBroken = false;

export function systemVoices(): SpeechSynthesisVoice[] {
  return "speechSynthesis" in window ? speechSynthesis.getVoices() : [];
}

/** Voices load asynchronously; wait a moment for them. */
function waitVoices(ms = 1200): Promise<SpeechSynthesisVoice[]> {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  const v = speechSynthesis.getVoices();
  if (v.length) return Promise.resolve(v);
  return new Promise((res) => {
    const done = () => {
      speechSynthesis.removeEventListener("voiceschanged", done);
      clearTimeout(t);
      res(speechSynthesis.getVoices());
    };
    const t = setTimeout(done, ms);
    speechSynthesis.addEventListener("voiceschanged", done);
  });
}

export interface SayOpts {
  rate?: number;
  volume?: number;
  /** system voice name */
  voice?: string;
  /** offline voice id (en-us…) */
  offlineVoice?: string;
  engine?: TtsEngine;
}

function cfg(): Required<Pick<SayOpts, "rate" | "volume" | "engine">> & SayOpts {
  const b: any = settings.value.wf6?.briefing ?? {};
  return { rate: b.rate || 1, volume: settings.value.audio?.volume ?? 0.8, voice: b.voice || "", offlineVoice: b.offlineVoice || "en-us", engine: (b.engine as TtsEngine) || "auto" };
}

let gen = 0;

/** Speak text (cancels anything already speaking). Resolves when done or stopped. */
export async function say(text: string, o: SayOpts = {}): Promise<void> {
  const c = { ...cfg(), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) } as ReturnType<typeof cfg>;
  stopTts();
  const my = ++gen;
  const clean = text.replace(/°F/g, " degrees").replace(/°C/g, " degrees Celsius").replace(/ mi\b/g, " miles").replace(/ km\b/g, " kilometers").replace(/\s+/g, " ").trim();
  if (!clean) return;
  ttsSpeaking.value = true;
  try {
    if (c.engine !== "offline" && !(c.engine === "auto" && systemBroken)) {
      const ok = await saySystem(clean, c, my, c.engine === "system");
      if (ok || my !== gen) return;
      if (c.engine === "system") return;
    }
    if (my !== gen) return;
    await sayOffline(clean, c, my);
  } finally {
    if (my === gen) ttsSpeaking.value = false;
  }
}

/** true when the system engine spoke (or was stopped); false = it can't (fallback) */
async function saySystem(text: string, c: ReturnType<typeof cfg>, my: number, forced: boolean): Promise<boolean> {
  if (!("speechSynthesis" in window)) {
    systemBroken = true;
    ttsInfo.value = { engine: null, note: "This system has no speech engine" };
    return false;
  }
  const voices = await waitVoices();
  if (my !== gen) return true;
  if (!voices.length && !forced) {
    systemBroken = true;
    ttsInfo.value = { engine: null, note: "No system voices (on Linux: speech-dispatcher isn't installed): using the built-in voice" };
    return false;
  }
  return new Promise<boolean>((res) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = c.voice ? voices.find((v) => v.name === c.voice) ?? null : null;
    u.rate = Math.max(0.5, Math.min(2, c.rate));
    u.volume = c.volume;
    let started = false;
    let settled = false;
    const fin = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      res(ok);
    };
    u.onstart = () => {
      started = true;
      ttsInfo.value = { engine: "system", note: u.voice ? `System voice: ${u.voice.name}` : "System default voice" };
    };
    u.onend = () => fin(true);
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (e.error === "interrupted" || e.error === "canceled") return fin(true);
      if (!started && !forced) {
        systemBroken = true;
        ttsInfo.value = { engine: null, note: `System speech failed (${e.error}): using the built-in voice` };
      }
      fin(started);
    };
    // silent failure (common on Linux): nothing starts within a few seconds
    const watchdog = setTimeout(() => {
      if (started) return;
      speechSynthesis.cancel();
      if (!forced) {
        systemBroken = true;
        ttsInfo.value = { engine: null, note: "System speech didn't start: using the built-in voice" };
      }
      fin(false);
    }, 3500);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// ---------- offline engine (meSpeak in a worker, played via WebAudio) ----------

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { res: (b: ArrayBuffer) => void; rej: (e: Error) => void }>();
let ctx: AudioContext | null = null;
let src: AudioBufferSourceNode | null = null;

function synth(text: string, voice: string, speed: number): Promise<ArrayBuffer> {
  if (!worker) {
    worker = new Worker(new URL("tts/tts-worker.js", document.baseURI).href);
    worker.onmessage = (e) => {
      const { id, wav, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.rej(new Error(error));
      else p.res(wav);
    };
    worker.onerror = (e) => {
      for (const [, p] of pending) p.rej(new Error(e.message || "TTS worker failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++reqId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    worker!.postMessage({ id, text, voice, speed });
  });
}

/** sentence-sized pieces so playback starts quickly */
function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?;:])\s+/)) {
    if (cur && (cur + " " + s).length > 260) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

async function sayOffline(text: string, c: ReturnType<typeof cfg>, my: number) {
  ctx ??= new AudioContext();
  await ctx.resume().catch(() => {});
  const speed = Math.round(165 * Math.max(0.5, Math.min(2, c.rate)));
  const voice = OFFLINE_VOICES.some((v) => v[0] === c.offlineVoice) ? c.offlineVoice! : "en-us";
  const parts = chunks(text);
  if (!worker) ttsInfo.value = { ...ttsInfo.value, loading: true };
  let next = synth(parts[0], voice, speed);
  for (let i = 0; i < parts.length; i++) {
    let wav: ArrayBuffer;
    try {
      wav = await next;
    } catch (e: any) {
      ttsInfo.value = { engine: null, note: `Built-in voice failed: ${e.message}` };
      return;
    }
    if (my !== gen) return;
    if (i + 1 < parts.length) next = synth(parts[i + 1], voice, speed);
    const buf = await ctx.decodeAudioData(wav);
    if (my !== gen) return;
    ttsInfo.value = { engine: "offline", note: `Built-in voice (eSpeak · ${OFFLINE_VOICES.find((v) => v[0] === voice)?.[1]})`, loading: false };
    await new Promise<void>((res) => {
      const s = ctx!.createBufferSource();
      s.buffer = buf;
      const g = ctx!.createGain();
      g.gain.value = c.volume;
      s.connect(g).connect(ctx!.destination);
      s.onended = () => {
        if (src === s) src = null;
        res();
      };
      src = s;
      s.start();
    });
    if (my !== gen) return;
  }
}

export function stopTts() {
  gen++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  try {
    src?.stop();
  } catch {
    /* already stopped */
  }
  src = null;
  ttsSpeaking.value = false;
}

/** Settings → "Test voice" */
export function testVoice(o: SayOpts = {}) {
  return say("This is the TheBigWeather voice. A tornado warning is in effect until 6 45 PM.", o);
}

/** whether the system engine has been seen failing (shown in settings) */
export const systemFailed = () => systemBroken;
/** let the user retry the system engine after installing voices */
export function resetSystemCheck() {
  systemBroken = false;
}

(window as any).__tbwTts = { say, stopTts, testVoice, ttsInfo };
