// NOAA Weather Radio player: one stream at a time (wxradio.org asks for that).

import { signal, effect } from "@preact/signals";
import { settings, toast } from "./store";
import Hls from "hls.js";
import { AudioTap } from "./audio/tap";
import { SameMonitor } from "./same/monitor";
import { TranscriptCtl } from "./transcribe/client";
import { popoutSpec } from "./popout"; // p7

export interface Stream {
  id: string;
  name: string;
  url: string;
  call?: string;
  city?: string;
  state?: string;
}

export const nowPlaying = signal<Stream | null>(null);
export const radioState = signal<"idle" | "loading" | "playing" | "error">("idle");
let audio: HTMLAudioElement | null = null;

export function playStream(s: Stream) {
  // p7: stations last used in the big player open there again
  if (sizePref(s.url) === "big" && popoutSpec?.kind !== "radio") return openPlayer(s);
  stopStream();
  audio = new Audio();
  audio.preload = "none";
  audio.volume = settings.value.radio.volume;
  audio.src = s.url;
  nowPlaying.value = s;
  radioState.value = "loading";
  audio.onplaying = () => (radioState.value = "playing");
  audio.onwaiting = () => (radioState.value = "loading");
  audio.onerror = () => {
    radioState.value = "error";
    toast(`Couldn't play ${s.name}`, "warn");
  };
  audio.play().catch(() => (radioState.value = "error"));
}

export function stopStream() {
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio = null;
  }
  nowPlaying.value = null;
  radioState.value = "idle";
}

effect(() => {
  const v = settings.value.radio.volume;
  if (audio) audio.volume = v;
});

// ---------- DVR players (Weather radio → Player) ----------
// fetch() + MediaSource for MP3/AAC so everything heard so far stays seekable (2 h cap), with the
// raw bytes kept for recording. HLS goes through hls.js with a long back buffer; anything else
// falls back to a plain <audio> element.


const CAP_S = 2 * 3600;
const CAP_BYTES = 160 * 1024 * 1024;

export interface PlayerSnap {
  status: "connecting" | "playing" | "paused" | "buffering" | "reconnecting" | "error";
  mode: "dvr" | "hls" | "plain" | null;
  note?: string;
  start: number;
  end: number;
  cur: number;
  rec: boolean;
  recBytes: number;
  recSecs: number;
  kbps: number;
  type: string;
}

function mimeFor(ct: string, url: string): string {
  const c = ct.toLowerCase();
  if (/mpeg(?!url)|mp3/.test(c)) return "audio/mpeg";
  if (/aac/.test(c)) return "audio/aac";
  if (/ogg|opus|vorbis|flac|wav/.test(c)) return c.split(";")[0];
  if (/\.aac(\?|$)/i.test(url)) return "audio/aac";
  return "audio/mpeg";
}
const extFor = (m: string) => (m === "audio/aac" ? "aac" : m === "audio/mpeg" ? "mp3" : /ogg/.test(m) ? "ogg" : /webm/.test(m) ? "webm" : "bin");

/** First stream URL in a .pls / .m3u playlist. */
function fromPlaylist(text: string, base: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    const m = l.match(/^File\d+=(.+)$/i);
    const u = m ? m[1] : l && !l.startsWith("#") && !l.startsWith("[") ? l : null;
    if (u) {
      try {
        return new URL(u, base).href;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export function saveBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);

export class LivePlayer {
  audio = new Audio();
  snap = signal<PlayerSnap>({ status: "connecting", mode: null, start: 0, end: 0, cur: 0, rec: false, recBytes: 0, recSecs: 0, kbps: 0, type: "" });
  private ac: AbortController | null = null;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private pending: Uint8Array[] = [];
  private kept: { t: number; b: Uint8Array }[] = [];
  private keptBytes = 0;
  private recChunks: Uint8Array[] | null = null;
  private recAt = 0;
  private mr: MediaRecorder | null = null;
  private mrChunks: Blob[] = [];
  private hls: Hls | null = null;
  private stopped = false;
  private tries = 0;
  private resetParser = false;
  private atStart = true;
  private mime = "audio/mpeg";
  private url: string;
  private timer: number;
  private bytesIn = 0;
  private t0 = 0;

  /** WebAudio tap for the SAME decoder / transcription (created on first use; can't be undone). */
  tap: AudioTap | null = null;
  private tapP: Promise<AudioTap | null> | null = null;
  readonly same: SameMonitor;
  readonly tx: TranscriptCtl;

  /** p7: taking over from the simple player: stay silent until our audio plays, then stop it */
  private handing = false;
  private userMuted = false;

  constructor(public stream: Stream, opts: { handoff?: () => void } = {}) {
    this.url = stream.url;
    if (opts.handoff) {
      this.handing = true;
      this.audio.muted = true;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.handing = false;
        this.applyMute();
        opts.handoff!();
      };
      this.audio.addEventListener("playing", () => setTimeout(finish, 250), { once: true });
      // the stream may refuse a second connection or stall: never keep both silent/playing for long
      setTimeout(finish, 10000);
    }
    const label = () => this.stream.call ?? this.stream.name;
    this.same = new SameMonitor(label, () => this.ensureTap());
    this.tx = new TranscriptCtl(label, () => this.ensureTap());
    this.audio.preload = "auto";
    this.audio.volume = settings.value.radio.volume;
    this.audio.onplaying = () => this.set({ status: "playing" });
    this.audio.onpause = () => !this.stopped && this.set({ status: "paused" });
    this.audio.onwaiting = () => this.set({ status: this.snap.value.status === "reconnecting" ? "reconnecting" : "buffering" });
    this.audio.onerror = () => {
      if (this.stopped) return;
      const m = this.snap.value.mode;
      if (m === "dvr") {
        // the decoder choked on the stream: plain playback instead
        this.ac?.abort();
        this.sb = null;
        this.ms = null;
        this.pending = [];
        this.startPlain("Seeking not supported for this stream");
      } else if (m === "plain" || m === null) this.set({ status: "error", note: "Stream unavailable" });
    };
    this.timer = window.setInterval(() => this.tick(), 250);
    this.start();
  }

  private set(p: Partial<PlayerSnap>) {
    this.snap.value = { ...this.snap.value, ...p };
  }

  private tick() {
    const a = this.audio;
    const b = a.buffered;
    const st = b.length ? b.start(0) : 0;
    const en = b.length ? b.end(b.length - 1) : 0;
    if (this.snap.value.mode === "dvr" && en && a.currentTime < st) a.currentTime = st + 0.1;
    // bitrate from what's buffered (the connect burst would inflate a bytes-per-second figure)
    const kept = this.kept.length ? (this.kept[this.kept.length - 1].t - this.kept[0].t) / 1000 : 0;
    const dur = this.snap.value.mode === "dvr" && en - st > 5 ? en - st : Math.max(1, kept);
    this.set({ start: st, end: en, cur: a.currentTime, kbps: this.t0 ? Math.round((this.keptBytes * 8) / 1000 / dur) : 0, recSecs: this.recAt ? (Date.now() - this.recAt) / 1000 : 0 });
  }

  private async start() {
    if (/\.m3u8(\?|$)/i.test(this.url)) return this.startHls(this.url);
    if (!("MediaSource" in window)) return this.startPlain("Seeking not supported here");
    for (let hop = 0; hop < 3; hop++) {
      this.ac = new AbortController();
      let r: Response;
      try {
        r = await fetch(this.url, { signal: this.ac.signal, cache: "no-store" });
        if (!r.ok || !r.body) throw new Error(String(r.status));
      } catch (e: any) {
        if (this.stopped) return;
        // most likely no CORS: the plain player still works
        return this.startPlain("Seeking not supported for this stream");
      }
      const ct = r.headers.get("content-type") ?? "";
      if (/mpegurl|scpls|x-pls/i.test(ct) || /\.(pls|m3u)(\?|$)/i.test(r.url)) {
        const text = await r.text();
        if (/#EXT-X-(TARGETDURATION|STREAM-INF)/.test(text)) return this.startHls(r.url);
        const next = fromPlaylist(text, r.url);
        if (!next) return this.fail("Empty playlist");
        this.url = next;
        continue;
      }
      this.mime = mimeFor(ct, r.url);
      if (!MediaSource.isTypeSupported(this.mime)) {
        this.ac.abort();
        return this.startPlain("Seeking not supported for this stream");
      }
      await this.startDvr();
      if (this.stopped) return;
      this.pump(r);
      return;
    }
    this.fail("Too many redirects");
  }

  private fail(note: string) {
    this.set({ status: "error", note });
  }

  private startDvr(): Promise<void> {
    this.set({ mode: "dvr", type: this.mime });
    this.ms = new MediaSource();
    this.audio.src = URL.createObjectURL(this.ms);
    return new Promise((res) => {
      this.ms!.addEventListener(
        "sourceopen",
        () => {
          try {
            this.sb = this.ms!.addSourceBuffer(this.mime);
            this.sb.mode = "sequence";
            this.sb.addEventListener("updateend", () => {
              // start near the live edge, not at the start of the server's connect burst
              const b = this.sb?.buffered;
              if (this.atStart && b?.length) {
                this.atStart = false;
                const en = b.end(b.length - 1);
                if (en - b.start(0) > 8) this.audio.currentTime = en - 3;
              }
              this.flush();
            });
          } catch (e: any) {
            this.fail(`Can't decode (${e.message})`);
          }
          res();
        },
        { once: true },
      );
    });
  }

  private async pump(r: Response) {
    const rd = r.body!.getReader();
    let first = true;
    try {
      for (;;) {
        const { done, value } = await rd.read();
        if (done || this.stopped) break;
        if (!value?.length) continue;
        this.tries = 0;
        if (!this.t0) this.t0 = performance.now();
        this.bytesIn += value.length;
        this.pending.push(value);
        this.kept.push({ t: Date.now(), b: value });
        this.keptBytes += value.length;
        while (this.kept.length && (this.keptBytes > CAP_BYTES || this.kept[0].t < Date.now() - CAP_S * 1000)) this.keptBytes -= this.kept.shift()!.b.length;
        if (this.recChunks) {
          this.recChunks.push(value);
          this.set({ recBytes: this.snap.value.recBytes + value.length });
        }
        this.flush();
        if (first) {
          first = false;
          this.audio.play().catch(() => this.set({ status: "paused" }));
        }
      }
    } catch {
      /* network drop */
    }
    if (!this.stopped && this.snap.value.mode === "dvr") this.reconnect();
  }

  private reconnect() {
    this.set({ status: "reconnecting" });
    const wait = Math.min(30000, 1500 * 2 ** this.tries++);
    this.resetParser = true;
    setTimeout(async () => {
      if (this.stopped) return;
      this.ac = new AbortController();
      try {
        const r = await fetch(this.url, { signal: this.ac.signal, cache: "no-store" });
        if (!r.ok || !r.body) throw new Error(String(r.status));
        if (!this.audio.paused) this.set({ status: "playing" });
        this.pump(r);
      } catch {
        if (!this.stopped) this.reconnect();
      }
    }, wait);
  }

  private flush() {
    const sb = this.sb;
    if (!sb || sb.updating || !this.ms || this.ms.readyState !== "open") return;
    if (this.resetParser) {
      this.resetParser = false;
      try {
        sb.abort();
      } catch {
        /* */
      }
    }
    // drop audio older than the cap
    const b = sb.buffered;
    if (b.length && b.end(b.length - 1) - b.start(0) > CAP_S + 60) {
      const cut = b.end(b.length - 1) - CAP_S;
      if (cut > this.audio.currentTime) this.audio.currentTime = cut + 1;
      sb.remove(0, cut);
      return;
    }
    if (!this.pending.length) return;
    let n = 0;
    for (const p of this.pending) n += p.length;
    const buf = new Uint8Array(n);
    let o = 0;
    for (const p of this.pending) {
      buf.set(p, o);
      o += p.length;
    }
    this.pending = [];
    try {
      sb.appendBuffer(buf);
    } catch (e: any) {
      if (e?.name === "QuotaExceededError" && b.length) {
        this.pending.unshift(buf);
        const cut = Math.min(b.start(0) + 900, this.audio.currentTime - 5);
        if (cut > b.start(0)) sb.remove(0, cut);
      }
    }
  }

  private startHls(url: string) {
    this.set({ mode: "hls", type: "HLS" });
    this.audio.crossOrigin = "anonymous";
    if (Hls.isSupported()) {
      this.hls = new Hls({ backBufferLength: CAP_S, maxBufferLength: 30, liveDurationInfinity: true, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.audio);
      this.hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.set({ status: "reconnecting" });
          setTimeout(() => this.hls?.startLoad(), 3000);
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) this.hls?.recoverMediaError();
        else this.fail(d.details || "Stream error");
      });
    } else this.audio.src = url;
    this.audio.play().catch(() => this.set({ status: "paused" }));
  }

  private startPlain(note: string) {
    this.set({ mode: "plain", note, type: "" });
    this.audio.src = this.url;
    this.audio.play().catch(() => this.set({ status: "error", note: "Stream unavailable" }));
  }

  // ---------- controls ----------
  toggle() {
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }
  seek(t: number) {
    const s = this.snap.value;
    if (s.mode === "plain") return;
    this.audio.currentTime = Math.max(s.start, Math.min(s.end - 0.3, t));
    if (this.audio.paused) this.audio.play().catch(() => {});
  }
  back(sec: number) {
    this.seek(this.audio.currentTime - sec);
  }
  live() {
    const s = this.snap.value;
    if (s.end) this.seek(s.end - 1);
  }
  setVolume(v: number) {
    if (this.tap) this.tap.setVolume(v);
    else this.audio.volume = v;
  }
  setMuted(m: boolean) {
    this.userMuted = m;
    this.applyMute();
  }
  private applyMute() {
    const m = this.userMuted || this.handing;
    if (this.tap) this.tap.setMuted(m);
    else this.audio.muted = m;
  }

  ensureTap(): Promise<AudioTap | null> {
    this.tapP ??= AudioTap.create(this.audio).then(
      (t) => {
        if (this.stopped) {
          t.close();
          return null;
        }
        this.tap = t;
        return t;
      },
      (e) => {
        console.warn("audio tap", e);
        this.tapP = null;
        return null;
      },
    );
    return this.tapP;
  }

  get canRecord() {
    return this.snap.value.mode !== "plain" || !!this.tap || !!(this.audio as any).captureStream;
  }

  recStart() {
    if (this.snap.value.rec) return;
    this.recAt = Date.now();
    if (this.snap.value.mode === "dvr") {
      this.recChunks = [];
      this.set({ rec: true, recBytes: 0 });
      return;
    }
    // HLS / plain: record what plays through the element
    try {
      const ms: MediaStream = this.tap ? this.tap.stream() : (this.audio as any).captureStream();
      const type = ["audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      this.mr = new MediaRecorder(ms, type ? { mimeType: type } : undefined);
      this.mrChunks = [];
      this.mr.ondataavailable = (e) => {
        if (e.data.size) {
          this.mrChunks.push(e.data);
          this.set({ recBytes: this.snap.value.recBytes + e.data.size });
        }
      };
      this.mr.start(1000);
      this.set({ rec: true, recBytes: 0 });
    } catch (e: any) {
      this.recAt = 0;
      toast("Recording isn't available for this stream", "warn");
    }
  }

  recStop() {
    const name = `${(this.stream.call ?? this.stream.name).replace(/[^\w.-]+/g, "_")}_${stamp()}`;
    if (this.recChunks) {
      const blob = new Blob(this.recChunks as BlobPart[], { type: this.mime });
      this.recChunks = null;
      if (blob.size) saveBlob(blob, `${name}.${extFor(this.mime)}`);
    } else if (this.mr) {
      const mr = this.mr;
      this.mr = null;
      mr.onstop = () => {
        const blob = new Blob(this.mrChunks, { type: mr.mimeType || "audio/webm" });
        if (blob.size) saveBlob(blob, `${name}.webm`);
        this.mrChunks = [];
      };
      mr.stop();
    }
    this.recAt = 0;
    this.set({ rec: false, recSecs: 0 });
  }

  /** Save everything received so far (up to 2 h). */
  saveBuffer() {
    if (!this.kept.length) return;
    const blob = new Blob(
      this.kept.map((k) => k.b as BlobPart),
      { type: this.mime },
    );
    saveBlob(blob, `${(this.stream.call ?? this.stream.name).replace(/[^\w.-]+/g, "_")}_buffer_${stamp()}.${extFor(this.mime)}`);
  }

  destroy() {
    if (this.snap.value.rec) this.recStop();
    this.stopped = true;
    this.same.stop();
    this.tx.disable();
    this.tap?.close();
    clearInterval(this.timer);
    this.ac?.abort();
    this.hls?.destroy();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.ms?.readyState === "open") {
      try {
        this.ms.endOfStream();
      } catch {
        /* */
      }
    }
  }
}

export interface PlayerWin {
  id: string;
  p: LivePlayer;
  x: number;
  y: number;
  /** p7: shown as the small player bar (decoders keep running) */
  compact?: boolean;
}
export const players = signal<PlayerWin[]>([]);
// debugging / automated UI checks
(window as any).__tbwRadio = { players };

export function openPlayer(s: Stream, compact = false) {
  const have = players.value.find((w) => w.id === s.url);
  if (have) {
    players.value = [...players.value.filter((w) => w !== have), { ...have, compact }];
    return;
  }
  // p7: the simple player keeps going until the new one is audible (no gap when expanding)
  const handoff = nowPlaying.value?.url === s.url ? () => nowPlaying.peek()?.url === s.url && stopStream() : undefined;
  const n = players.value.length;
  const x = Math.max(10, window.innerWidth - 420 - ((n * 24) % 120));
  const y = 80 + ((n * 175) % Math.max(175, window.innerHeight - 300));
  players.value = [...players.value, { id: s.url, p: new LivePlayer(s, { handoff }), x, y, compact }];
}

// ---------- p7: small <-> big player ----------
const SIZE_KEY = "tbw.radio.size";
function sizes(): Record<string, "small" | "big"> {
  try {
    return JSON.parse(localStorage.getItem(SIZE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
/** preferred player size per station URL ("small" when never chosen) */
export function sizePref(url: string): "small" | "big" {
  return sizes()[url] ?? "small";
}
function setSizePref(url: string, v: "small" | "big") {
  try {
    const m = sizes();
    m[url] = v;
    localStorage.setItem(SIZE_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}
/** Small player -> big media player for the same station, without a gap. */
export function expandSimple() {
  const s = nowPlaying.value;
  if (!s) return;
  setSizePref(s.url, "big");
  openPlayer(s);
}
/** Big player <-> its small bar; SAME / transcription keep running either way. */
export function setPlayerCompact(id: string, compact: boolean) {
  const w = players.value.find((x) => x.id === id);
  if (!w) return;
  setSizePref(id, compact ? "small" : "big");
  players.value = players.value.map((x) => (x === w ? { ...x, compact } : x));
}

export function closePlayer(id: string) {
  const w = players.value.find((x) => x.id === id);
  w?.p.destroy();
  players.value = players.value.filter((x) => x.id !== id);
}
