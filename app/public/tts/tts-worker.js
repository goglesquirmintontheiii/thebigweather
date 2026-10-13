// Offline text-to-speech worker (radio/dash 0.8): meSpeak (eSpeak compiled to JS) renders WAV
// bytes off the main thread; the page plays them through WebAudio. Everything is bundled in this
// folder, so it works without speech-dispatcher, network or system voices.
/* global meSpeak */
importScripts("mespeak.js");

let cfg = null;
const voices = new Map();
const json = (u) => fetch(u).then((r) => {
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return r.json();
});

onmessage = async (e) => {
  const { id, text, voice = "en-us", speed = 175, pitch = 50, amplitude = 100 } = e.data || {};
  try {
    if (!cfg) cfg = json("mespeak_config.json").then((c) => meSpeak.loadConfig(c));
    await cfg;
    if (!voices.has(voice)) voices.set(voice, json(`voice-${voice}.json`).then((v) => (meSpeak.loadVoice(v), v.voice_id)));
    const vid = await voices.get(voice);
    const arr = meSpeak.speak(String(text || ""), { rawdata: "array", voice: vid, speed, pitch, amplitude });
    if (!arr || !arr.length) throw new Error("no audio");
    const u8 = new Uint8Array(arr);
    postMessage({ id, wav: u8.buffer }, [u8.buffer]);
  } catch (err) {
    postMessage({ id, error: String((err && err.message) || err) });
  }
};
