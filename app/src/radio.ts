// NOAA Weather Radio player: one stream at a time (wxradio.org asks for that).

import { signal, effect } from "@preact/signals";
import { settings, toast } from "./store";

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
