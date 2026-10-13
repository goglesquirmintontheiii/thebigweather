// workflow 0.6: on-map UI — briefing window, kiosk clock + alert banner, rule "flash" overlay,
// plugin panels.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Volume2, Square, RefreshCw, Settings2, LogOut, Puzzle } from "lucide-preact";
import { FloatPanel } from "./FloatPanel";
import { settings, update } from "../store";
import { briefing, briefingBusy, runBriefing, speak, stopSpeaking } from "../briefing";
import { kiosk, kioskPaused, exitKiosk } from "../kiosk";
import { flashOn } from "../rules/engine";
import { pluginPanels, type PluginPanel } from "../plugins/host";
import { alerts, sortedAlerts } from "../alerts";
import { fmtTime, pointInGeometry } from "../util";
import { hhmm } from "../wf6data";
import { VoiceSettings } from "./VoiceSettings"; // radio/dash 0.8

export const briefingCfgOpen = signal(false);

function BriefingSettings() {
  const b = settings.value.wf6.briefing;
  const [t, setT] = useState("07:00");
  const set = (fn: (x: typeof b) => void) => update((s) => fn(s.wf6.briefing));
  return (
    <div class="bf-cfg">
      <div class="row">
        <span>Point</span>
        <select value={b.point} onChange={(e) => set((x) => (x.point = (e.target as HTMLSelectElement).value))}>
          <option value="">First saved point</option>
          {settings.value.points.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="gps">GPS position</option>
        </select>
      </div>
      <VoiceSettings /> {/* radio/dash 0.8: engine, voices, rate, Test voice */}
      <div class="row">
        <span>Daily at</span>
        <input type="time" value={t} onInput={(e) => setT((e.target as HTMLInputElement).value)} />
        <button class="btn sm" onClick={() => t && !b.times.includes(t) && set((x) => (x.times = [...x.times, t].sort()))}>
          Add
        </button>
      </div>
      {b.times.length > 0 && (
        <div class="bf-times">
          {b.times.map((x) => (
            <button key={x} class="chip" title="Remove" onClick={() => set((y) => (y.times = y.times.filter((z) => z !== x)))}>
              {x} ×
            </button>
          ))}
        </div>
      )}
      <div class="muted small">Scheduled briefings play while the app is running.</div>
    </div>
  );
}

export function BriefingPanel() {
  const b = briefing.value;
  if (!b) return null;
  return (
    <FloatPanel
      title={b.title}
      x={Math.max(20, window.innerWidth - 470)}
      y={90}
      w={420}
      cls="bf-panel"
      onClose={() => (stopSpeaking(), (briefing.value = null))}
      tools={
        <>
          <button class="icon-btn" title={b.speaking ? "Stop" : "Read aloud"} onClick={() => (b.speaking ? stopSpeaking() : speak(b))}>
            {b.speaking ? <Square size={14} /> : <Volume2 size={14} />}
          </button>
          <button class="icon-btn" title="Refresh" disabled={briefingBusy.value} onClick={() => runBriefing(undefined, false)}>
            <RefreshCw size={14} class={briefingBusy.value ? "spin" : ""} />
          </button>
          <button class={`icon-btn ${briefingCfgOpen.value ? "on" : ""}`} title="Briefing settings" onClick={() => (briefingCfgOpen.value = !briefingCfgOpen.value)}>
            <Settings2 size={14} />
          </button>
        </>
      }
    >
      <div class="bf-body">
        {b.lines.map((l, i) => (
          <p key={i} class={`bf-${l.k}`}>
            {l.text}
          </p>
        ))}
        <div class="muted small">Built {fmtTime(b.t)} from NWS alerts, NEXRAD storm tracks, MRMS radar, GOES GLM, SPC and the hourly forecast.</div>
      </div>
      {briefingCfgOpen.value && <BriefingSettings />}
    </FloatPanel>
  );
}

function KioskClock() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void alerts.value;
  const warn = sortedAlerts().filter((a) => String(a.properties.event).endsWith("Warning"));
  const pts = settings.value.points;
  const mine = pts.length ? warn.filter((a) => pts.some((p) => a.geometry && pointInGeometry(p.lon, p.lat, a.geometry))) : [];
  const shown = (mine.length ? mine : warn).slice(0, 6);
  const d = new Date();
  const ws = settings.value.workspaces;
  return (
    <>
      <div class="ks-clock">
        <b>{d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</b>
        <span>{d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
      </div>
      {shown.length > 0 && (
        <div class="ks-banner">
          {shown.map((a) => (
            <span key={a.properties.id} style={{ background: a.properties.color }}>
              {a.properties.event}
              <small>{String(a.properties.areaDesc ?? "").split(";").slice(0, 2).join(",")} · until {hhmm(Date.parse(a.properties.ends ?? a.properties.expires))}</small>
            </span>
          ))}
          {warn.length > shown.length && <span class="more">+{warn.length - shown.length} more warnings</span>}
        </div>
      )}
      <div class={`ks-ctl ${kioskPaused.value ? "show" : ""}`}>
        <span>{kioskPaused.value ? `Cycling paused — resumes after ${settings.value.wf6.kiosk.resume}s idle` : `${ws.length ? "Cycling workspaces" : "Kiosk"}`}</span>
        <button class="btn sm" onClick={exitKiosk}>
          <LogOut size={13} /> Exit kiosk (Esc)
        </button>
      </div>
    </>
  );
}

function PluginPanelView({ p, i }: { p: PluginPanel; i: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    let cleanup: any;
    try {
      cleanup = p.render(el);
    } catch (e: any) {
      el.textContent = `Plugin error: ${e?.message ?? e}`;
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch {
        /* ignore */
      }
      el.innerHTML = "";
    };
  }, [p]);
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <FloatPanel
      title={
        <>
          <Puzzle size={13} /> {p.title}
        </>
      }
      x={Math.max(80, window.innerWidth - 340 - i * 30)}
      y={300 + i * 30}
      w={300}
      cls="plg-panel"
      onClose={() => setOpen(false)}
    >
      <div ref={ref} class="plg-body" />
    </FloatPanel>
  );
}

export function Wf6Overlays() {
  return (
    <>
      <BriefingPanel />
      {kiosk.value && <KioskClock />}
      {flashOn.value && <div class="wf6-flash" />}
      {pluginPanels.value.map((p, i) => (
        <PluginPanelView key={p.id} p={p} i={i} />
      ))}
    </>
  );
}

/* ---------- workflow 0.6: automation hook (screenshots / console) ---------- */
import * as wf6route from "../route/route";
import * as wf6rules from "../rules/engine";
import * as wf6brief from "../briefing";
import * as wf6kiosk from "../kiosk";
import * as wf6plug from "../plugins/host";
import * as wf6off from "../offline/tiles";
import * as wf6wid from "../widgets/manager";
import { decorateAlert } from "../alerts";
import { settings as wf6settings, update as wf6update, openPanel as wf6open } from "../store";
(window as any).__tbwWf6 = { route: wf6route, rules: wf6rules, brief: wf6brief, kiosk: wf6kiosk, plug: wf6plug, off: wf6off, wid: wf6wid, alerts, decorateAlert, settings: wf6settings, update: wf6update, openPanel: wf6open };
