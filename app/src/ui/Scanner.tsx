// radio/dash 0.8: weather-radio scanner panel (inside the Weather radio window). Pick stations, the
// server watches all of them for SAME / alert tones, the app cycles or holds the audio and jumps to
// the station that fires. Logic: same/scanner.ts.
// 0.8.1: "Watch all for SAME" in one click, multi-select, and an audio mix (several stations at
// once with per-station volume / mute / solo).

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { Play, Pause, ScanLine, Star, X, Headphones, MapPin, FlaskConical, Trash2, Siren, Server, Cpu, Loader, SkipForward, Lock, Radar, Volume2, VolumeX, Layers } from "lucide-preact";
import type { Stream } from "../radio";
import { scanCfg, setScan, scanOn, scanBackend, scanNote, scanStatus, scanCurrent, scanLock, scanAlerts, startScan, stopScan, resumeScan, listenTo, nextIn, scanTest, clearScanAlerts, toggleScan, inScan, clientDecoded, MAX_CLIENT, scanSince, type ScanAlert } from "../same/scanner";
import { watchAll, mixStations, setMixEntry, mixLive } from "../same/scanner"; // 0.8.1
import { areaList, LVL_COLOR, mapHeader } from "../same/monitor";
import { hideCounties, sameShown } from "../same/mapshow";
import { fipsNames, loadFips } from "../same/fips";

/** the radio window shows the scanner instead of the station details */
export const scanView = signal(false);
/** 0.8.1: stations ticked in the scanner list (bulk actions) */
const scanSel = signal<string[]>([]);
/** 0.8.1: "Watch all" audio: "" = muted, or a station id */
const watchAudio = signal("");

export function ScanRowBtn({ s }: { s: Stream }) {
  if (s.id.startsWith("custom:") && !s.url) return null;
  const on = inScan(s.id);
  return (
    <button class={`icon-btn rc-scan ${on ? "on" : ""}`} aria-pressed={on} title={on ? "In the scanner (click to remove)" : "Add to the scanner"} onClick={(e) => (e.stopPropagation(), toggleScan(s))}>
      <ScanLine size={12} />
    </button>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;
const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Level({ db }: { db: number | null }) {
  const pos = db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <span class="scn-lvl" title={db == null ? "No audio" : `${db.toFixed(0)} dBFS`}>
      <i style={{ width: `${pos * 100}%`, background: db != null && db > -6 ? "#ef4444" : db != null && db > -18 ? "#facc15" : "#22c55e" }} />
    </span>
  );
}

function AlertRow({ a }: { a: ScanAlert }) {
  const h = a.header;
  const shown = !!sameShown.value[a.key];
  const color = h ? LVL_COLOR[h.level] ?? "#ff3b30" : "#8a96a6";
  return (
    <div class="scn-alert" style={{ borderLeftColor: color }}>
      <div class="scn-atop">
        <b style={{ color }}>{h ? h.eventName : "Unreadable header"}</b>
        {a.test && <span class="same-tag">TEST</span>}
        <span class="scn-ast">{a.label}</span>
        <span class="rp-fill" />
        <span class="muted">{hm(a.at)}</span>
      </div>
      {h && <div class="scn-areas">{areaList(h, 8)}</div>}
      <div class="scn-afoot">
        {h && <span class="muted small">Until {hm(h.expires.getTime())} · {h.sender}</span>}
        <span class="rp-fill" />
        {h &&
          (shown ? (
            <button class="btn sm ghost same-hide on" onClick={() => hideCounties(a.key)}>
              <X size={11} /> Hide on map
            </button>
          ) : (
            <button class="btn sm ghost" onClick={() => mapHeader(h, a.key, a.label, a.test)}>
              <MapPin size={11} /> Map
            </button>
          ))}
        <button class="icon-btn" title="Listen to this station" onClick={() => listenTo(a.station)}>
          <Headphones size={12} />
        </button>
      </div>
    </div>
  );
}

export function ScannerPanel() {
  const [, setT] = useState(0);
  useEffect(() => {
    loadFips();
    const t = window.setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  fipsNames.value;
  const c = scanCfg.value;
  const on = scanOn.value;
  const be = scanBackend.value;
  const st = scanStatus.value;
  const cur = scanCurrent.value;
  const lock = scanLock.value;
  const curS = c.stations.find((s) => s.id === cur);
  const nx = nextIn();
  const decodedHere = clientDecoded.value;
  const sel = scanSel.value.filter((id) => c.stations.some((s) => s.id === id));
  const mixing = c.mode === "mix";
  const mix = c.mix ?? {};
  const heard = mixLive.value;
  const toggleSel = (id: string) => (scanSel.value = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const allSel = c.stations.length > 0 && sel.length === c.stations.length;
  return (
    <div class="scn">
      <section class="scn-head">
        <button class={`btn ${on ? "scn-stop" : ""}`} disabled={!on && !c.stations.length} onClick={() => (on ? stopScan() : startScan())}>
          {on ? <Pause size={14} /> : <Play size={14} />} {on ? "Stop scanning" : "Start scanning"}
        </button>
        <span class={`scn-be ${be}`} title={scanNote.value}>
          {be === "server" ? <Server size={12} /> : be === "client" ? <Cpu size={12} /> : be === "connecting" ? <Loader size={12} class="spin" /> : <ScanLine size={12} />}
          {be === "server" ? "Server decoding" : be === "client" ? "Decoding here" : be === "connecting" ? "Connecting" : "Off"}
        </span>
        <span class="rp-fill" />
        <button class="icon-btn" title="Simulate a SAME test alert on the current station (checks the jump + map path)" disabled={!c.stations.length} onClick={() => scanTest()}>
          <FlaskConical size={14} />
        </button>
      </section>
      <section class="scn-watch" title="Monitor every station below for SAME headers and alert tones at once; jumps to the one that fires">
        <button class={`btn sm ${on && c.jump && (!c.audio || c.mode === "hold") ? "on" : ""}`} disabled={!c.stations.length} onClick={() => watchAll(watchAudio.value || null)}>
          <Radar size={13} /> Watch all for SAME
        </button>
        <select value={watchAudio.value} title="Audio while watching" onChange={(e) => {
          watchAudio.value = (e.target as HTMLSelectElement).value;
          if (on) watchAll(watchAudio.value || null);
        }}>
          <option value="">Audio muted</option>
          {c.stations.map((s) => (
            <option key={s.id} value={s.id}>
              Listen to {s.call ?? s.name}
            </option>
          ))}
        </select>
        <span class="muted small">{c.stations.length} station{c.stations.length === 1 ? "" : "s"}</span>
      </section>
      {scanNote.value && <div class="muted small scn-note">{scanNote.value}</div>}
      <section class="scn-ctl">
        <div class="seg" role="radiogroup" aria-label="Scanner mode">
          <button role="radio" aria-checked={c.mode === "cycle"} class={c.mode === "cycle" ? "on" : ""} onClick={() => setScan((x) => (x.mode = "cycle"))}>
            Cycle
          </button>
          <button role="radio" aria-checked={c.mode === "hold"} class={c.mode === "hold" ? "on" : ""} onClick={() => setScan((x) => ((x.mode = "hold"), (x.fav ??= cur ?? x.stations[0]?.id ?? null)))}>
            Hold favourite
          </button>
          <button role="radio" aria-checked={mixing} class={mixing ? "on" : ""} title="Play several stations at once (tick them, then Mix)" onClick={() =>
              setScan((x) => {
                x.mode = "mix";
                x.audio = true;
                // nothing mixed yet: start with the ticked stations (or the first two)
                if (!Object.keys(x.mix ?? {}).length) x.mix = Object.fromEntries((sel.length ? sel : x.stations.slice(0, 2).map((s) => s.id)).map((id) => [id, { vol: 1 }]));
              })
            }>
            Mix
          </button>
        </div>
        <label class="scn-dwell" title="Seconds on each station while cycling">
          Dwell
          <input type="range" min={5} max={120} step={5} value={c.dwell} disabled={c.mode !== "cycle"} onInput={(e) => setScan((x) => (x.dwell = +(e.target as HTMLInputElement).value))} />
          <span class="val">{c.dwell} s</span>
        </label>
        <label class="sk-chk" title="When a station sends SAME data or an alert tone, switch to it">
          <input type="checkbox" checked={c.jump} onChange={(e) => setScan((x) => (x.jump = (e.target as HTMLInputElement).checked))} /> Jump to alerts
        </label>
        <select value={c.stayMin} disabled={!c.jump} title="How long to stay on the station that fired" onChange={(e) => setScan((x) => (x.stayMin = +(e.target as HTMLSelectElement).value))}>
          {[2, 5, 10, 15, 30].map((m) => (
            <option key={m} value={m}>
              stay {m} min
            </option>
          ))}
        </select>
        <label class="sk-chk" title="Off: monitor silently (alerts still show and jump)">
          <input type="checkbox" checked={c.audio} onChange={(e) => setScan((x) => (x.audio = (e.target as HTMLInputElement).checked))} /> Audio
        </label>
        <label class="sk-chk" title="Keep these stations on the server's 24/7 radio monitor after stopping the scanner (SAME conditions in server rules, notifications)">
          <input type="checkbox" checked={!!c.keepServer} onChange={(e) => setScan((x) => (x.keepServer = (e.target as HTMLInputElement).checked))} /> Keep on server
        </label>
      </section>
      {on && (
        <section class={`scn-now ${lock ? "locked" : ""}`}>
          {lock ? <Lock size={14} /> : <Headphones size={14} />}
          <div class="scn-nowtxt">
            <b>{curS ? curS.call ?? curS.name : "—"}</b> <span class="muted">{curS?.call ? curS.name : ""}</span>
            <div class="muted small">
              {lock ? (
                <>
                  <b class="scn-lockr">{lock.reason}</b> · staying {mmss((lock.until - Date.now()) / 1000)}
                </>
              ) : mixing ? (
                c.solo ? `Solo · ${heard.length} playing` : `Mixing ${heard.length} station${heard.length === 1 ? "" : "s"}`
              ) : c.mode === "hold" ? (
                "Holding the favourite"
              ) : nx != null ? (
                `Next station in ${nx} s`
              ) : (
                `Listening ${mmss((Date.now() - scanSince.value) / 1000)}`
              )}
            </div>
          </div>
          <span class="rp-fill" />
          {lock ? (
            <button class="btn sm" onClick={() => resumeScan()}>
              Resume scanning
            </button>
          ) : (
            c.mode === "cycle" && (
              <button class="icon-btn" title="Next station" onClick={() => resumeScan()}>
                <SkipForward size={14} />
              </button>
            )
          )}
        </section>
      )}
      <section>
        <div class="lbl scn-lbl">
          <input type="checkbox" checked={allSel} disabled={!c.stations.length} title="Select all" onChange={() => (scanSel.value = allSel ? [] : c.stations.map((s) => s.id))} />
          Stations <small class="muted">{c.stations.length}</small>
          <span class="rp-fill" />
          {sel.length > 0 && (
            <span class="scn-bulk">
              <small class="muted">{sel.length} selected</small>
              <button class="btn xs" title="Play the selected stations together" onClick={() => mixStations(sel, true)}>
                <Layers size={11} /> Mix
              </button>
              {mixing && (
                <button class="btn xs ghost" title="Take them out of the mix" onClick={() => mixStations(sel, false)}>
                  Unmix
                </button>
              )}
              <button class="btn xs ghost" title="Remove from the scanner" onClick={() => (setScan((y) => (y.stations = y.stations.filter((z) => !sel.includes(z.id)))), (scanSel.value = []))}>
                <X size={11} /> Remove
              </button>
            </span>
          )}
        </div>
        {!c.stations.length && <div class="muted small">Add stations with the <ScanLine size={11} /> button in the list on the left, or "+ Scan" on a state or the favourites.</div>}
        {mixing && !Object.keys(mix).length && c.stations.length > 0 && <div class="muted small">Tick stations and press Mix to hear them together.</div>}
        <div class="scn-list">
          {c.stations.map((s) => {
            const x = st[s.id];
            const here = be === "client" && !decodedHere.includes(s.id);
            const m = mix[s.id];
            const inMix = mixing && !!m;
            const loud = heard.includes(s.id);
            return (
              <div key={s.id} class={`scn-row ${cur === s.id ? "cur" : ""} ${x?.tone ? "tone" : ""} ${inMix ? "mixed" : ""} ${loud ? "loud" : ""}`}>
                <input type="checkbox" class="scn-sel" checked={sel.includes(s.id)} aria-label={`Select ${s.call ?? s.name}`} onChange={() => toggleSel(s.id)} />
                <span class={`scn-dot ${!on ? "" : here ? "off" : x?.connected ? "ok" : x ? "bad" : "wait"}`} title={!on ? "Not monitoring" : here ? "Not decoded" : x?.connected ? "Listening for SAME" : x ? "Offline" : "Connecting"} />
                <b class="scn-call">{s.call ?? "—"}</b>
                <span class="scn-name" title={s.url}>
                  {s.name}
                </span>
                {on && !here && <Level db={x?.level_db ?? null} />}
                {x?.tone && (
                  <span class="scn-tone" title="Alert tone on air">
                    <Siren size={11} /> tone
                  </span>
                )}
                {on && here && <small class="muted">not decoded (limit {MAX_CLIENT} here)</small>}
                {x?.note && <small class="err-text" title={x.note}>!</small>}
                {x?.last_same && (
                  <small class="scn-last" title={`Last SAME message: ${x.last_same.event} at ${hm(x.last_same.t)}`}>
                    {x.last_same.code ?? "SAME"} {new Date(x.last_same.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </small>
                )}
                <span class="rp-fill" />
                {inMix && (
                  <span class="scn-mix">
                    <button class={`icon-btn ${m.mute ? "on" : ""}`} title={m.mute ? "Unmute" : "Mute"} onClick={() => setMixEntry(s.id, { mute: !m.mute })}>
                      {m.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                    <input type="range" min={0} max={1} step={0.05} value={m.vol} title={`Volume ${Math.round(m.vol * 100)}%`} onInput={(e) => setMixEntry(s.id, { vol: +(e.target as HTMLInputElement).value })} />
                    <button class={`icon-btn scn-solo ${c.solo === s.id ? "on" : ""}`} title={c.solo === s.id ? "Unsolo" : "Solo: hear only this one"} onClick={() => setScan((y) => (y.solo = y.solo === s.id ? null : s.id))}>
                      S
                    </button>
                  </span>
                )}
                {mixing && !m && (
                  <button class="icon-btn" title="Add to the mix" onClick={() => mixStations([s.id], true)}>
                    <Layers size={12} />
                  </button>
                )}
                <button class="icon-btn" title="Listen now" disabled={!on} onClick={() => listenTo(s.id)}>
                  <Headphones size={12} />
                </button>
                <button class={`icon-btn ${c.fav === s.id ? "fav" : ""}`} title="Favourite (held in Hold mode)" onClick={() => setScan((y) => ((y.fav = y.fav === s.id ? null : s.id), y.fav && (y.mode = "hold")))}>
                  <Star size={12} />
                </button>
                <button class="icon-btn" title="Remove from the scanner" onClick={() => setScan((y) => (y.stations = y.stations.filter((z) => z.id !== s.id)))}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <section>
        <label class="lbl">
          Alerts heard <small class="muted">{scanAlerts.value.length}</small>
          <span class="rp-fill" />
          {scanAlerts.value.length > 0 && (
            <button class="icon-btn" title="Clear (removes their map outlines)" onClick={() => clearScanAlerts()}>
              <Trash2 size={12} />
            </button>
          )}
        </label>
        <div class="scn-alerts">
          {!scanAlerts.value.length && <div class="muted small">SAME messages from any scanned station appear here and on the map.</div>}
          {scanAlerts.value.map((a) => (
            <AlertRow key={a.key} a={a} />
          ))}
        </div>
      </section>
    </div>
  );
}
