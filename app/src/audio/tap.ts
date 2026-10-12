// Taps a player's <audio> element with WebAudio so decoders can read the PCM while it keeps
// playing: element → MediaElementSource → gain (volume/mute) → speakers
//                                       ↘ AudioWorklet (or ScriptProcessor) → subscribers (resampled)
// Once tapped, the element's own volume stays at 1 and volume/mute go through the gain node, so the
// decoders still hear the stream when the user mutes it.

import { Resampler } from "../same/dsp";

type Sub = { rate: number; rs: Resampler; cb: (x: Float32Array) => void };

export class AudioTap {
  readonly ctx: AudioContext;
  private src: MediaElementAudioSourceNode;
  private out: GainNode;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode;
  private subs = new Set<Sub>();
  private vol = 1;
  private muted = false;
  private clips = new Set<AudioBufferSourceNode>();

  private constructor(audio: HTMLAudioElement) {
    this.ctx = new AudioContext({ latencyHint: "playback" });
    this.vol = audio.volume;
    this.muted = audio.muted;
    this.src = this.ctx.createMediaElementSource(audio);
    audio.volume = 1;
    audio.muted = false;
    this.out = this.ctx.createGain();
    this.out.gain.value = this.muted ? 0 : this.vol;
    this.src.connect(this.out).connect(this.ctx.destination);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
  }

  static async create(audio: HTMLAudioElement): Promise<AudioTap> {
    const t = new AudioTap(audio);
    await t.ctx.resume().catch(() => {});
    try {
      if (!t.ctx.audioWorklet) throw new Error("no worklet");
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await t.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      const n = new AudioWorkletNode(t.ctx, "tbw-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      n.port.onmessage = (e) => t.feed(e.data as Float32Array);
      t.node = n;
    } catch {
      const sp = t.ctx.createScriptProcessor(4096, 2, 1);
      sp.onaudioprocess = (e) => {
        const b = e.inputBuffer;
        const x = new Float32Array(b.length);
        for (let c = 0; c < b.numberOfChannels; c++) {
          const d = b.getChannelData(c);
          for (let i = 0; i < x.length; i++) x[i] += d[i] / b.numberOfChannels;
        }
        t.feed(x);
      };
      t.node = sp;
    }
    t.src.connect(t.node);
    t.node.connect(t.sink);
    t.setActive(false);
    return t;
  }

  get kind() {
    return this.node instanceof AudioWorkletNode ? "AudioWorklet" : "ScriptProcessor";
  }
  get running() {
    return this.ctx.state === "running";
  }

  private setActive(on: boolean) {
    if (this.node instanceof AudioWorkletNode) this.node.port.postMessage({ on });
  }

  private feed(x: Float32Array) {
    for (const s of this.subs) {
      const y = s.rs.process(x);
      if (y.length) s.cb(y);
    }
  }

  /** Receive mono PCM at `rate` Hz until the returned function is called. */
  subscribe(rate: number, cb: (x: Float32Array) => void): () => void {
    const s: Sub = { rate, rs: new Resampler(this.ctx.sampleRate, rate), cb };
    this.subs.add(s);
    this.setActive(true);
    this.ctx.resume().catch(() => {});
    return () => {
      this.subs.delete(s);
      if (!this.subs.size) this.setActive(false);
    };
  }

  /** Feed PCM straight to subscribers (used when the AudioContext can't run). */
  feedDirect(x: Float32Array, rate: number) {
    for (const s of this.subs) {
      const y = rate === s.rate ? x : new Resampler(rate, s.rate).process(x);
      if (y.length) s.cb(y);
    }
  }

  /** Play a clip through the speakers and the decoders (self-test). */
  playClip(x: Float32Array, rate: number, gain = 0.3): Promise<void> {
    const buf = this.ctx.createBuffer(1, x.length, rate);
    buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain * (this.muted ? 0 : 1);
    s.connect(g).connect(this.ctx.destination);
    if (this.node) s.connect(this.node);
    this.clips.add(s);
    return new Promise((res) => {
      s.onended = () => {
        this.clips.delete(s);
        res();
      };
      s.start();
    });
  }

  /** The stream's audio as a MediaStream (element.captureStream() may go silent once tapped). */
  stream(): MediaStream {
    const d = this.ctx.createMediaStreamDestination();
    this.src.connect(d);
    return d.stream;
  }

  setVolume(v: number) {
    this.vol = v;
    this.out.gain.value = this.muted ? 0 : v;
  }
  setMuted(m: boolean) {
    this.muted = m;
    this.out.gain.value = m ? 0 : this.vol;
  }

  close() {
    this.subs.clear();
    for (const c of this.clips) c.stop();
    this.ctx.close().catch(() => {});
  }
}

// AudioWorklet source (a blob: URL keeps it inside the CSP and out of the asset pipeline).
const WORKLET = `
// AudioWorklet: mixes the input to mono and posts ~2048-frame blocks to the main thread.
// Outputs silence (it's only connected so the graph keeps pulling it).
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.on === "boolean") this.on = e.data.on;
    };
  }
  process(inputs) {
    const inp = inputs[0];
    if (!this.on || !inp || !inp.length) return true;
    const ch = inp.length;
    const len = inp[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += inp[c][i];
      this.buf[this.n++] = v / ch;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("tbw-tap", TapProcessor);
`;
