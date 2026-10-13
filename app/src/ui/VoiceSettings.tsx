// radio/dash 0.8: speech engine / voice picker with a "Test voice" button (briefings, read-aloud
// warnings and rule actions all use it; see tts.ts).

import { useEffect, useState } from "preact/hooks";
import { Volume2, Square } from "lucide-preact";
import { settings, update } from "../store";
import { OFFLINE_VOICES, systemVoices, testVoice, stopTts, ttsInfo, ttsSpeaking, systemFailed, resetSystemCheck, type TtsEngine } from "../tts";

export function VoiceSettings() {
  const b = settings.value.wf6.briefing;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => systemVoices());
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const f = () => setVoices(systemVoices());
    speechSynthesis.addEventListener("voiceschanged", f);
    const t = setTimeout(f, 800);
    return () => (speechSynthesis.removeEventListener("voiceschanged", f), clearTimeout(t));
  }, []);
  const set = (fn: (x: typeof b) => void) => update((s) => fn(s.wf6.briefing));
  const eng: TtsEngine = b.engine ?? "auto";
  const info = ttsInfo.value;
  const noSys = !voices.length;
  return (
    <div class="tts-cfg">
      <div class="row">
        <span>Engine</span>
        <div class="seg" role="radiogroup" aria-label="Speech engine">
          {(
            [
              ["auto", "Auto"],
              ["system", "System"],
              ["offline", "Built-in"],
            ] as [TtsEngine, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="radio"
              aria-checked={eng === k}
              class={eng === k ? "on" : ""}
              title={k === "auto" ? "System voices when they work, else the built-in voice" : k === "system" ? "The operating system's speech engine only" : "The bundled eSpeak voice (works offline, no system services)"}
              onClick={() => (set((x) => (x.engine = k)), k !== "offline" && resetSystemCheck())}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {eng !== "offline" && (
        <div class="row">
          <span>System voice</span>
          <select value={b.voice} disabled={noSys} onChange={(e) => set((x) => (x.voice = (e.target as HTMLSelectElement).value))}>
            <option value="">{noSys ? "No system voices found" : "System default"}</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
      )}
      {eng !== "system" && (
        <div class="row">
          <span>Built-in voice</span>
          <select value={b.offlineVoice ?? "en-us"} onChange={(e) => set((x) => (x.offlineVoice = (e.target as HTMLSelectElement).value))}>
            {OFFLINE_VOICES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}
      <div class="row">
        <span>Rate</span>
        <input type="range" min={0.6} max={1.6} step={0.1} value={b.rate} onInput={(e) => set((x) => (x.rate = +(e.target as HTMLInputElement).value))} />
        <span class="val">{b.rate.toFixed(1)}×</span>
      </div>
      <div class="row tts-test">
        <button class="btn sm" onClick={() => (ttsSpeaking.value ? stopTts() : testVoice())}>
          {ttsSpeaking.value ? <Square size={12} /> : <Volume2 size={12} />} {ttsSpeaking.value ? "Stop" : "Test voice"}
        </button>
        <small class="muted tts-note">
          {info.loading ? "Loading the built-in voice (5 MB, once)…" : info.note || (noSys && eng !== "system" ? "No system voices: the built-in voice will be used" : systemFailed() ? "System speech failed earlier: using the built-in voice" : "")}
        </small>
      </div>
    </div>
  );
}
