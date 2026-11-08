// 0.8.2: Settings → MIDI: on/off, devices, Learn (press a control → pick an action), mappings per device.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Toggle } from "../ui/panels/RadarPanel";
import { Trash2, Radio, X } from "lucide-preact";
import { midiState, midiError, midiInputs, midiActivity, learning, learned, midiCfg, setMidi, runAction } from "./midi";
import { allActions } from "./midi";
import { ctlName, isCont, isRangeCtl, setMapping, removeMapping, searchActions, type MidiMap } from "./midicore";
import "../ui/tb082.css";

const STATE: Record<string, string> = { off: "Off", asking: "Asking for access…", on: "On", unsupported: "Web MIDI isn't available here", denied: "Access denied" };

function Learn({ onClose }: { onClose: () => void }) {
  const l = learned.value;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inRef = useRef<HTMLInputElement>(null);
  const acts = useMemo(() => (l ? allActions(isRangeCtl(l.ctl)) : []), [l?.ctl]);
  const res = useMemo(() => searchActions(acts, q, 80), [acts, q]);
  useEffect(() => {
    learning.value = !l;
    if (l) inRef.current?.focus();
  }, [l?.ctl, l?.dev]);
  useEffect(
    () => () => {
      learning.value = false;
      learned.value = null;
    },
    [],
  );
  useEffect(() => setSel(0), [q]);
  const pick = (a: { id: string; label: string } | undefined) => {
    if (!a || !l) return;
    const map: MidiMap = { ctl: l.ctl, action: a.id, label: a.label };
    setMidi((m) => setMapping(m, l.dev, map));
    learned.value = null;
    onClose();
  };
  if (!l)
    return (
      <div class="midi-learn">
        <b>Press a button or move a knob on your MIDI controller…</b>
        <button class="btn sm ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    );
  return (
    <div class="midi-learn">
      <div class="row">
        <span>
          <b>{ctlName(l.ctl)}</b> <span class="muted small">on {l.dev}</span>
        </span>
        <button class="icon-btn" title="Cancel" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <input
        ref={inRef}
        value={q}
        placeholder={isRangeCtl(l.ctl) ? "Search actions (knob: opacity, frames, zoom…)" : "Search actions: product, layer, layout, play…"}
        aria-label="Search actions"
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel(Math.min(res.length - 1, sel + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel(Math.max(0, sel - 1)));
          else if (e.key === "Enter") (e.preventDefault(), pick(res[sel]));
          else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose());
        }}
      />
      <div class="midi-acts" role="listbox" aria-label="Actions">
        {res.map((a, i) => (
          <button key={a.id} role="option" aria-selected={i === sel} class={i === sel ? "sel" : ""} onClick={() => pick(a)}>
            {a.label}
            <small title={a.hint}>{a.hint.split(" · ")[0]}</small>
          </button>
        ))}
        {!res.length && <div class="muted small">No matches</div>}
      </div>
    </div>
  );
}

export function MidiSection() {
  const cfg = midiCfg();
  const st = midiState.value;
  const [learnOpen, setLearnOpen] = useState(false);
  const act = midiActivity.value;
  const now = Date.now();
  const [, tick] = useState(0);
  useEffect(() => {
    // fade the activity dots
    const t = Object.values(act).some((x) => now - x < 400) ? setTimeout(() => tick((n) => n + 1), 400) : 0;
    return () => clearTimeout(t);
  }, [act]);
  const devs = new Map<string, { name: string; connected: boolean }>();
  for (const d of midiInputs.value) devs.set(d.key, { name: d.name, connected: d.connected });
  for (const k of Object.keys(cfg.devices)) if (!devs.has(k)) devs.set(k, { name: k, connected: false });
  return (
    <section id="set-midi">
      <label class="lbl">MIDI</label>
      <Toggle label="MIDI controllers" on={cfg.on} set={(v) => setMidi((m) => ({ ...m, on: v }))} hint="Use a MIDI controller's buttons, pads, knobs and faders to control the app" />
      {cfg.on && (
        <>
          <div class="muted small">
            {STATE[st]}
            {midiError.value ? ` (${midiError.value})` : ""}
            {st === "on" && !midiInputs.value.length ? " · no devices connected" : ""}
          </div>
          {[...devs].map(([key, d]) => {
            const maps = cfg.devices[key] ?? [];
            const hit = act[key] && now - act[key] < 400;
            return (
              <div key={key} class="midi-devbox">
                <div class="midi-dev">
                  <span class={`midi-dot ${hit ? "hit" : d.connected ? "on" : ""}`} title={d.connected ? "Connected" : "Not connected"} />
                  <b>{d.name}</b>
                  <span class="muted">
                    {maps.length} mapping{maps.length === 1 ? "" : "s"}
                    {!d.connected ? " · not connected" : ""}
                  </span>
                </div>
                {maps.length > 0 && (
                  <div class="midi-maps">
                    {maps.map((m) => (
                      <div key={m.ctl} class="midi-map">
                        <span class="midi-map-l" title={m.action}>
                          <code>{ctlName(m.ctl)}</code>
                          <button class="linkish" title={isCont(m.action) ? m.label : `${m.label} · click to run now`} onClick={() => !isCont(m.action) && runAction(m)}>
                            {m.label}
                          </button>
                        </span>
                        <span class="row" style={{ gap: 2 }}>
                          {isCont(m.action) && m.ctl.startsWith("cc:") && (
                            <select
                              value={m.mode ?? "abs"}
                              title="Knob type"
                              aria-label="Knob type"
                              onChange={(e) => setMidi((x) => setMapping(x, key, { ...m, mode: (e.target as HTMLSelectElement).value as any }))}
                            >
                              <option value="abs">Absolute</option>
                              <option value="rel">Endless</option>
                            </select>
                          )}
                          {isCont(m.action) && (
                            <button class={`icon-btn ${m.invert ? "on" : ""}`} title="Reverse direction" onClick={() => setMidi((x) => setMapping(x, key, { ...m, invert: !m.invert }))}>
                              ⇅
                            </button>
                          )}
                          <button class="icon-btn" title="Remove mapping" onClick={() => setMidi((x) => removeMapping(x, key, m.ctl))}>
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {learnOpen ? (
            <Learn onClose={() => setLearnOpen(false)} />
          ) : (
            <button class="btn sm" disabled={st !== "on"} onClick={() => ((learned.value = null), setLearnOpen(true))} title="Press a control on the device, then choose what it does">
              <Radio size={13} /> Learn
            </button>
          )}
          <div class="muted small">Buttons and pads run commands (products, layers, pane layouts, play, frames, radars…). Knobs and faders: opacity, frames, zoom, speed.</div>
        </>
      )}
    </section>
  );
}
