// Generated alert tones (no audio files needed).

import { settings } from "./store";

let ctx: AudioContext | null = null;

function tone(freqs: number[], dur: number, gap: number, type: OscillatorType = "sine") {
  ctx ??= new AudioContext();
  const vol = settings.value.audio.volume;
  let t = ctx.currentTime + 0.02;
  for (const f of freqs) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25 * vol, t + 0.01);
    g.gain.setValueAtTime(0.25 * vol, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur);
    t += dur + gap;
  }
}

export function playAlertSound(event: string, tag?: string | null) {
  if (tag === "TORNADO EMERGENCY" || tag === "FLASH FLOOD EMERGENCY") tone([1050, 850, 1050, 850, 1050, 850], 0.22, 0.04, "square");
  else if (event === "Tornado Warning") tone([1050, 850, 1050, 850], 0.25, 0.05, "square");
  else if (event.endsWith("Warning")) tone([880, 660, 880], 0.2, 0.06, "triangle");
  else tone([660, 880], 0.15, 0.05);
}

export function playSweepSound() {
  if (!settings.value.audio.sweeps) return;
  tone([1320], 0.06, 0, "sine");
}
