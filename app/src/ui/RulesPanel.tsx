// workflow 0.6: Rules panel — notification rule builder, quiet hours, firing log.

import { useState } from "preact/hooks";
import { Plus, Trash2, Play, ChevronDown, ChevronRight, Cloud, HardDrive } from "lucide-preact";
import { settings, update, type Rule, type RuleCond } from "../store";
import { ALERT_SOUNDS } from "../sound";
import { ruleLog, rulesStore, ruleState, testRule, newRule, describe, serverTestRule, atFor } from "../rules/engine";
import { toast } from "../store"; // data 0.8
import { Toggle } from "./panels/RadarPanel";
import { OVERLAYS } from "../overlays/defs";
import { fmtTime } from "../util";
import { models as mlModels, ensureModels } from "../ml/client"; // detection models

const KINDS: [RuleCond["kind"], string][] = [
  ["alert", "Weather alert nearby"],
  ["rotation", "Rotation / TVS nearby"],
  ["lightning", "Lightning nearby"],
  ["eta", "Storm cell arriving"],
  ["dbz", "Radar dBZ at location"],
  ["aqi", "Air quality (AQI)"],
  ["metar", "METAR value"],
  ["spc", "SPC outlook risk"],
  ["mldet", "Detection model hit nearby"], // detection models
  ["same", "Weather radio SAME (server)"], // data 0.8
];
const EVENTS = ["Tornado Warning", "Severe Thunderstorm Warning", "Flash Flood Warning", "Warning", "Tornado Watch", "Severe Thunderstorm Watch", "Winter Storm Warning", "Special Marine Warning", "Extreme Wind Warning", "Watch", "Advisory"];

function num(v: number | undefined, set: (n: number) => void, w = 64, step = 1) {
  return <input type="number" class="rl-num" style={{ width: `${w}px` }} step={step} value={v ?? 0} onChange={(e) => set(+(e.target as HTMLInputElement).value)} />;
}

function RuleEditor({ r }: { r: Rule }) {
  const set = (fn: (x: Rule) => void) =>
    update((s) => {
      const x = s.wf6.rules.find((y) => y.id === r.id);
      if (x) fn(x);
    });
  const c = r.cond;
  const ws = settings.value.workspaces;
  return (
    <div class="rl-edit">
      <div class="row">
        <span>Name</span>
        <input value={r.name} onChange={(e) => set((x) => (x.name = (e.target as HTMLInputElement).value))} />
      </div>
      <div class="row">
        <span>When</span>
        <select
          value={c.kind}
          onChange={(e) =>
            set((x) => {
              x.cond = { ...newRule((e.target as HTMLSelectElement).value as any).cond, where: x.cond.where };
              if (x.cond.kind === "same" && rulesStore.value === "server" && (x.run_on ?? "app") === "app") x.run_on = "server"; // data 0.8: SAME runs on the server
            })
          }
        >
          {KINDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {c.kind !== "same" && <div class="row">
        <span>Where</span>
        <select value={c.where} onChange={(e) => set((x) => (x.cond.where = (e.target as HTMLSelectElement).value))}>
          {settings.value.points.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="gps">My GPS position</option>
          <option value="route">Along my planned route</option>
        </select>
      </div>}
      {/* data 0.8: server rules check one point (cond.at), copied from the saved point / GPS */}
      {c.kind !== "same" && r.run_on && r.run_on !== "app" && (
        <div class="muted small rl-at">
          {c.where === "route"
            ? "Route rules can't run on the server: pick a saved point or GPS."
            : c.at
              ? `Server checks ${c.at.label ?? "the point"} (${c.at.lat.toFixed(3)}, ${c.at.lon.toFixed(3)})${c.where === "gps" ? ", updated while the app has a GPS fix" : ""}.`
              : atFor(c)
                ? "Sending the point to the server…"
                : "No position yet (GPS): the server can't check this rule until the app has one."}
        </div>
      )}
      {c.kind === "same" && (
        <>
          <div class="row">
            <span>Event</span>
            <input list="rl-same-ev" placeholder="code or name, e.g. TOR / Tornado (empty = any)" value={c.event ?? ""} onChange={(e) => set((x) => (x.cond.event = (e.target as HTMLInputElement).value.trim()))} />
            <datalist id="rl-same-ev">
              {["TOR", "SVR", "FFW", "EWW", "SMW", "TOA", "SVA", "FFA", "WSW", "BZW", "HUW", "SPS", "CEM", "CAE"].map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
          </div>
          <div class="row" title="5-digit county FIPS codes (state + county, e.g. 40109); SS000 = the whole state. Empty = any area">
            <span>Counties</span>
            <input placeholder="40109, 40027 (empty = any)" value={(c.fips ?? []).join(", ")} onChange={(e) => set((x) => (x.cond.fips = (e.target as HTMLInputElement).value.split(/[\s,;]+/).map((v) => v.trim()).filter((v) => /^\d{5}$/.test(v))))} />
          </div>
          <div class="row">
            <span>Station</span>
            <input placeholder="monitor station id (empty = any)" value={c.station ?? ""} onChange={(e) => set((x) => (x.cond.station = (e.target as HTMLInputElement).value.trim() || undefined))} />
          </div>
          <div class="muted small">Heard by the server's radio monitor (Radio → Scanner, "Keep on server"). {(r.run_on ?? "app") === "app" ? "Set Run on to Server or Both." : ""}</div>
        </>
      )}
      {c.kind === "alert" && (
        <div class="row">
          <span>Alert</span>
          <input list="rl-events" value={c.event} onChange={(e) => set((x) => (x.cond.event = (e.target as HTMLInputElement).value))} />
          <datalist id="rl-events">
            {EVENTS.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
        </div>
      )}
      {c.kind === "rotation" && (
        <div class="row">
          <span>Type</span>
          <select value={c.rot} onChange={(e) => set((x) => (x.cond.rot = (e.target as HTMLSelectElement).value as any))}>
            <option value="meso">Mesocyclone</option>
            <option value="tvs">TVS only</option>
          </select>
          {c.rot !== "tvs" && (
            <>
              <span>rank ≥</span>
              {num(c.value, (n) => set((x) => (x.cond.value = n)), 52)}
            </>
          )}
        </div>
      )}
      {c.kind === "metar" && (
        <div class="row">
          <span>From</span>
          <select value={c.source ?? "metar"} onChange={(e) => set((x) => (x.cond.source = (e.target as HTMLSelectElement).value === "pws" ? "pws" : undefined))}>
            <option value="metar">METAR (airports)</option>
            <option value="pws">Personal weather stations</option>
          </select>
        </div>
      )}
      {c.kind === "metar" && (
        <div class="row">
          <span>Value</span>
          <select value={c.field} onChange={(e) => set((x) => (x.cond.field = (e.target as HTMLSelectElement).value as any))}>
            <option value="gust">Gust ≥ (mph)</option>
            <option value="temp_hi">Temp ≥ (°F)</option>
            <option value="temp_lo">Temp ≤ (°F)</option>
          </select>
          {num(c.value, (n) => set((x) => (x.cond.value = n)))}
        </div>
      )}
      {(c.kind === "aqi" || c.kind === "dbz" || c.kind === "eta") && (
        <div class="row">
          <span>{c.kind === "aqi" ? "AQI above" : c.kind === "dbz" ? "dBZ at least" : "Within (min)"}</span>
          {num(c.value, (n) => set((x) => (x.cond.value = n)))}
        </div>
      )}
      {/* detection models */}
      {c.kind === "mldet" && ensureModels() === undefined && (
        <div class="row">
          <span>Model</span>
          <select value={c.model ?? ""} onChange={(e) => set((x) => (x.cond.model = (e.target as HTMLSelectElement).value))}>
            <option value="">Any model</option>
            {mlModels.value.map((m) => (
              <option key={m.ep + m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <span>≥</span>
          {num(c.value, (n) => set((x) => (x.cond.value = n)), 52)}
          <span>%</span>
        </div>
      )}
      {/* models 0.7: probability window + map gate */}
      {c.kind === "mldet" && (
        <div class="row">
          <span>and ≤</span>
          <input type="number" min={0} max={100} style={{ width: "52px" }} placeholder="100" value={c.maxp ?? ""} onChange={(e) => set((x) => { const v = (e.target as HTMLInputElement).value; x.cond.maxp = v === "" ? undefined : Math.max(0, Math.min(100, +v)); })} />
          <span>%</span>
          <label class="ml-check" title="Only detections inside the probability gate on the map legend">
            <input type="checkbox" checked={!!c.useGate} onChange={(e) => set((x) => (x.cond.useGate = (e.target as HTMLInputElement).checked || undefined))} /> match map gate
          </label>
        </div>
      )}
      {c.kind === "spc" && (
        <div class="row">
          <span>Risk at least</span>
          <select value={String(c.value ?? 2)} onChange={(e) => set((x) => (x.cond.value = +(e.target as HTMLSelectElement).value))}>
            {["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"].map((l, i) => (
              <option key={l} value={String(i)}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}
      {c.kind !== "spc" && c.kind !== "dbz" && c.kind !== "same" && (
        <div class="row">
          <span>{c.kind === "eta" ? "Track within (mi)" : "Distance (mi)"}</span>
          {num(c.mi, (n) => set((x) => (x.cond.mi = n)))}
          {c.kind === "lightning" && (
            <>
              <span>last</span>
              {num(c.minutes, (n) => set((x) => (x.cond.minutes = n)), 52)}
              <span>min</span>
            </>
          )}
        </div>
      )}
      {/* data 0.8: where the rule runs + server channels */}
      <div class="row">
        <span>Run on</span>
        <div class="seg sm">
          {(["app", "server", "both"] as const).map((k) => (
            <button key={k} class={(r.run_on ?? "app") === k ? "on" : ""} disabled={k !== "app" && rulesStore.value !== "server"} title={k === "app" ? "This computer, while the app is open" : rulesStore.value !== "server" ? "The server doesn't store rules" : k === "server" ? "The server, even when the app is closed (channels only)" : "Both: sounds etc. here, channels from the server"} onClick={() => set((x) => (x.run_on = k === "app" ? undefined : k))}>
              {k === "app" ? "This app" : k === "server" ? "Server" : "Both"}
            </button>
          ))}
        </div>
      </div>
      {r.run_on && r.run_on !== "app" && (
        <div class="row">
          <span />
          <button
            class="btn sm ghost"
            title="Run the condition on the server now and send its channel messages marked as a test"
            onClick={() =>
              serverTestRule(r)
                .then((x) => toast(`Server: ${x.error ? `error: ${x.error}` : x.hit ? `TRUE — ${x.msg}` : "condition false right now"}${x.results?.length ? ` · ${x.results.filter((y: any) => y.ok).length}/${x.results.length} delivered` : ""}`, x.error ? "warn" : "info", 8000))
                .catch((e) => toast(`Server test failed: ${e.message}`, "warn"))
            }
          >
            <Play size={12} /> Test on server
          </button>
        </div>
      )}
      <label class="lbl">Then</label>
      {r.run_on && r.run_on !== "app" && <P8Channels r={r} set={set} />}
      <div class="row">
        <span>Sound</span>
        <select value={r.act.sound ?? "off"} onChange={(e) => set((x) => (x.act.sound = (e.target as HTMLSelectElement).value as any))}>
          {ALERT_SOUNDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Toggle label="Desktop notification" on={!!r.act.desktop} set={(v) => set((x) => (x.act.desktop = v))} />
      <Toggle label="Flash the window" on={!!r.act.flash} set={(v) => set((x) => (x.act.flash = v))} />
      <div class="row">
        <span>Speak</span>
        <input placeholder="e.g. {event} {dist} from {place}" value={r.act.tts ?? ""} onChange={(e) => set((x) => (x.act.tts = (e.target as HTMLInputElement).value))} />
      </div>
      <div class="row">
        <span>Webhook</span>
        <input placeholder="https://… (POST JSON)" value={r.act.webhook ?? ""} onChange={(e) => set((x) => (x.act.webhook = (e.target as HTMLInputElement).value.trim()))} />
      </div>
      <div class="row">
        <span>Open</span>
        <select value={r.act.open ?? ""} onChange={(e) => set((x) => (x.act.open = (e.target as HTMLSelectElement).value || undefined))}>
          <option value="">Nothing</option>
          {ws.map((w) => (
            <option key={w.id} value={`ws:${w.id}`}>
              Workspace: {w.name}
            </option>
          ))}
          {OVERLAYS.filter((o) => ["Severe", "Lightning"].includes(o.group) || o.id === "glm").map((o) => (
            <option key={o.id} value={`ovl:${o.id}`}>
              Layer: {o.name}
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <span>Cooldown (min)</span>
        {num(r.cooldown, (n) => set((x) => (x.cooldown = Math.max(1, n))))}
      </div>
      <div class="muted small">Speech placeholders: {"{msg} {event} {dist} {place} {value} {min} {rule}"}</div>
    </div>
  );
}

export function RulesPanel() {
  const s = settings.value.wf6;
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<RuleCond["kind"]>("alert");
  const st = ruleState.value;
  return (
    <div class="stack rl-panel">
      <section>
        <div class="row">
          <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as any)}>
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <button
            class="btn sm"
            onClick={() => {
              const r = newRule(kind);
              update((x) => x.wf6.rules.push(r));
              setOpen(r.id);
            }}
          >
            <Plus size={13} /> Add rule
          </button>
        </div>
        {/* data 0.8 */}
        <button class="btn sm ghost p8-notify-btn" onClick={() => (notifyOpen.value = true)}>
          <BellRing size={13} /> Notification channels…
        </button>
        <div class="muted small rl-store">
          {rulesStore.value === "server" ? <Cloud size={12} /> : <HardDrive size={12} />}
          {rulesStore.value === "server" ? " Rules are saved on the server." : " Saved on this computer (the server has no rules store)."} Checked when data updates, at most every 30 s.
        </div>
      </section>
      <section>
        {s.rules.length === 0 && <div class="muted small">No rules yet. Examples: “Tornado Warning within 10 mi of GPS”, “Lightning within 5 mi of Home”, “AQI &gt; 150”.</div>}
        {s.rules.map((r) => (
          <div key={r.id} class={`rl-rule ${st[r.id]?.hit ? "hit" : ""} ${r.on ? "" : "off"}`}>
            <div class="rl-head">
              <button class="icon-btn" onClick={() => setOpen(open === r.id ? null : r.id)}>
                {open === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <div class="rl-title" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <b>{r.name}</b>
                <small>{describe(r.cond)}</small>
                {st[r.id]?.text && <small class="rl-now">Now: {st[r.id].text}</small>}
              </div>
              <label class="toggle mini" title="Enabled">
                <input type="checkbox" checked={r.on} onChange={(e) => update((x) => (x.wf6.rules.find((y) => y.id === r.id)!.on = (e.target as HTMLInputElement).checked))} />
                <i />
              </label>
              <button class="icon-btn" title="Test (runs the actions now)" onClick={() => testRule(r)}>
                <Play size={13} />
              </button>
              <button class="icon-btn danger" title="Delete" onClick={() => update((x) => (x.wf6.rules = x.wf6.rules.filter((y) => y.id !== r.id)))}>
                <Trash2 size={13} />
              </button>
            </div>
            {open === r.id && <RuleEditor r={r} />}
          </div>
        ))}
      </section>
      <section>
        <label class="lbl">Quiet hours</label>
        <Toggle label="No sound, speech or flashing" on={s.quiet.on} set={(v) => update((x) => (x.wf6.quiet.on = v))} />
        {s.quiet.on && (
          <div class="row">
            <span>From</span>
            <input type="time" value={s.quiet.from} onChange={(e) => update((x) => (x.wf6.quiet.from = (e.target as HTMLInputElement).value))} />
            <span>to</span>
            <input type="time" value={s.quiet.to} onChange={(e) => update((x) => (x.wf6.quiet.to = (e.target as HTMLInputElement).value))} />
          </div>
        )}
      </section>
      <section>
        <label class="lbl">Log</label>
        <div class="rl-log">
          {ruleLog.value.length === 0 && <div class="muted small">Nothing fired yet.</div>}
          {ruleLog.value.slice(0, 50).map((l, i) => (
            <div key={i} class={l.test ? "test" : ""}>
              <span>{fmtTime(l.t, true)}</span> <b>{l.rule}</b> {l.msg}
            </div>
          ))}
        </div>
        {ruleLog.value.length > 0 && (
          <button class="btn sm ghost" onClick={() => ((ruleLog.value = []), localStorage.removeItem("tbw.ruleLog.v1"))}>
            Clear log
          </button>
        )}
      </section>
    </div>
  );
}

/* ---------- data 0.8: server channel actions ---------- */
import { BellRing } from "lucide-preact";
import { useEffect } from "preact/hooks";
import { notifyOpen, channels, chanState, loadChannels, TemplateEditor } from "./NotifyPanel"; // 0.8.1: TemplateEditor
function P8Channels({ r, set }: { r: Rule; set: (fn: (x: Rule) => void) => void }) {
  useEffect(() => {
    if (chanState.value.supported == null) loadChannels();
  }, []);
  const on = new Set(r.act.channels ?? []);
  const toggle = (id: string) =>
    set((x) => {
      const s = new Set(x.act.channels ?? []);
      s.has(id) ? s.delete(id) : s.add(id);
      x.act.channels = [...s];
    });
  return (
    <div class="row p8-rl-ch">
      <span>Send to</span>
      <div class="d6-chips">
        <button class={`chip ${on.has("*") ? "on" : ""}`} title="Every enabled channel (server: act.channels [&quot;*&quot;])" onClick={() => set((x) => (x.act.channels = on.has("*") ? [] : ["*"]))}>
          All
        </button>
        {channels.value.map((c) => (
          <button key={c.id} class={`chip ${on.has(c.id) || on.has("*") ? "on" : ""} ${c.enabled ? "" : "off"}`} title={c.type} disabled={on.has("*")} onClick={() => toggle(c.id)}>
            {c.name}
          </button>
        ))}
        {!channels.value.length && <span class="muted small">{chanState.value.supported === false ? "Server has no channels." : "No channels yet."}</span>}
        <button class="chip" onClick={() => (notifyOpen.value = true)}>
          Manage…
        </button>
      </div>
      {/* 0.8.1: this rule's message template */ on.size > 0 && <TemplateEditor rule v={{ title_tpl: r.act.title_tpl ?? "", body_tpl: r.act.body_tpl ?? "" }} chan={on.size === 1 && !on.has("*") ? channels.value.find((c) => on.has(c.id))?.config : undefined} onChange={(p) => set((x) => Object.assign(x.act, p))} />}
    </div>
  );
}
/* ---------- end data 0.8 ---------- */
