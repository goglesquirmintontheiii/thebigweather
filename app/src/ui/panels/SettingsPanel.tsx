import { useEffect, useState } from "preact/hooks";
import { settings, update, uid, toast } from "../../store";
import { api, lastHello } from "../../api";
import { Toggle } from "./RadarPanel";
import { Trash2, Check, Plus, Server } from "lucide-preact";
import { playAlertSound } from "../../sound";
import { ACCENTS } from "../../theme"; // workflow
import { ServerSettingsSection } from "../ServerSettings"; // shake/stats/server 0.6

const KEY_LABELS: Record<string, string> = {
  google_maps: "Google Map Tiles",
  synoptic: "Synoptic (mesonets)",
  airnow: "AirNow",
  aisstream: "aisstream.io (ships)",
  mping: "mPING",
  spotter_network: "Spotter Network",
  eumetsat: "EUMETSAT",
  kma: "KMA (Korea)",
  trafikverket: "Trafikverket",
  nsw_transport: "Transport for NSW",
  trafficvision: "TrafficVision",
  tomtom: "TomTom (traffic)",
};

export function ServerEditor({ onDone }: { onDone?: () => void }) {
  // when the UI is served by the server itself (browser use), default to that server
  const [url, setUrl] = useState(/^https?:$/.test(location.protocol) && location.port !== "5173" ? location.origin : "");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await api.test(url, token.trim());
    setBusy(false);
    setMsg({ ok: r.ok, text: r.message });
    if (!r.ok) return;
    const id = uid();
    update((s) => {
      s.servers.push({ id, name: name.trim() || r.info?.name || url, url: url.trim(), token: token.trim() });
      s.activeServer = id;
    });
    setUrl("");
    setToken("");
    setName("");
    onDone?.();
  };
  return (
    <div class="server-edit">
      <input placeholder="Server URL (https://wx.example.com)" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      <input placeholder="Token (from start.sh · not needed on this computer)" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
      <input placeholder="Name (optional)" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      <button class="btn" disabled={!url || busy} onClick={add}>
        <Plus size={14} /> {busy ? "Testing…" : "Add server"}
      </button>
      {msg && <div class={msg.ok ? "ok-text" : "err-text"}>{msg.text}</div>}
    </div>
  );
}

export function KeysEditor() {
  const [keys, setKeys] = useState<Record<string, string> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    api.get("/api/keys").then(setKeys).catch(() => setKeys(null));
  }, [settings.value.activeServer]);
  if (!keys) return <div class="muted small">Connect to a server to manage keys.</div>;
  const save = async () => {
    try {
      await api.send("PUT", "/api/keys", edits);
      setKeys(await api.get("/api/keys"));
      setEdits({});
      toast("Keys saved on the server");
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div class="keys">
      <p class="muted small">Optional. Stored on the server so all your devices share them. Missing keys just disable that source.</p>
      {Object.keys(KEY_LABELS).map((k) => (
        <div key={k} class="key-row">
          <span>{KEY_LABELS[k]}</span>
          <input
            type="password"
            placeholder={keys[k] ? keys[k] : "not set"}
            value={edits[k] ?? ""}
            onInput={(e) => setEdits({ ...edits, [k]: (e.target as HTMLInputElement).value })}
          />
        </div>
      ))}
      <button class="btn sm" disabled={!Object.keys(edits).length} onClick={save}>
        <Check size={13} /> Save keys
      </button>
    </div>
  );
}

export function SettingsPanel() {
  const s = settings.value;
  const [adding, setAdding] = useState(false);
  const hello = lastHello.value;
  return (
    <div class="stack">
      <section>
        <label class="lbl">Servers</label>
        {s.servers.map((sv) => (
          <div key={sv.id} class={`server-row ${sv.id === s.activeServer ? "on" : ""}`}>
            <button class="srv" onClick={() => update((x) => (x.activeServer = sv.id))}>
              <Server size={14} />
              <span>
                <b>{sv.name}</b>
                <small>{sv.url}</small>
              </span>
            </button>
            <button
              class="icon-btn danger"
              title="Remove"
              onClick={() =>
                update((x) => {
                  x.servers = x.servers.filter((y) => y.id !== sv.id);
                  if (x.activeServer === sv.id) x.activeServer = x.servers[0]?.id ?? "";
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {adding || !s.servers.length ? (
          <ServerEditor onDone={() => setAdding(false)} />
        ) : (
          <button class="btn sm ghost" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add server
          </button>
        )}
        {hello?.profile && (
          <div class="muted small">
            Server: {hello.profile.name} profile · {hello.profile.cores} cores · {hello.profile.threads} decode threads · v{hello.version}
          </div>
        )}
      </section>
      <ServerSettingsSection /> {/* shake/stats/server 0.6 */}
      <AppearanceSection />
      <section>
        <label class="lbl">Data use</label>
        <Toggle label="Bandwidth saver" on={!!s.saver} set={(v) => update((x) => (x.saver = v))} />
        <div class="muted small">Max 12 frames, overlays refresh 3× slower, no RapidSweep, low-res 3D, no polling while the window is hidden.</div>
        <Toggle label="Notify when a storm cell will reach my points" on={!!s.etaNotify} set={(v) => (update((x) => (x.etaNotify = v)), v && typeof Notification !== "undefined" && Notification.permission === "default" && Notification.requestPermission())} />
      </section>
      <section>
        <label class="lbl">Units & time</label>
        <div class="row">
          <span>Distance</span>
          <select value={s.units.distance} onChange={(e) => update((x) => (x.units.distance = (e.target as HTMLSelectElement).value as any))}>
            <option value="mi">mi</option>
            <option value="km">km</option>
            <option value="nmi">nmi</option>
          </select>
          <span>Speed</span>
          <select value={s.units.speed} onChange={(e) => update((x) => (x.units.speed = (e.target as HTMLSelectElement).value as any))}>
            <option value="mph">mph</option>
            <option value="kt">kt</option>
            <option value="m/s">m/s</option>
            <option value="km/h">km/h</option>
          </select>
        </div>
        <div class="row">
          <span>Temp</span>
          <select value={s.units.temp} onChange={(e) => update((x) => (x.units.temp = (e.target as HTMLSelectElement).value as any))}>
            <option value="F">°F</option>
            <option value="C">°C</option>
          </select>
          <span>Precip</span>
          <select value={s.units.precip} onChange={(e) => update((x) => (x.units.precip = (e.target as HTMLSelectElement).value as any))}>
            <option value="in">in</option>
            <option value="mm">mm</option>
          </select>
        </div>
        <Toggle label="Show times in UTC" on={s.utc} set={(v) => update((x) => (x.utc = v))} />
        <Toggle label="FPS counter" on={s.showFps} set={(v) => update((x) => (x.showFps = v))} />
        <Toggle label="Colorblind-friendly tables" on={s.colorblind} set={(v) => update((x) => (x.colorblind = v))} />
      </section>
      <section>
        <label class="lbl">Animation</label>
        <div class="row">
          <span>Speed</span>
          <input type="range" min={1} max={20} value={s.anim.fps} onInput={(e) => update((x) => (x.anim.fps = +(e.target as HTMLInputElement).value))} />
          <span class="val">{s.anim.fps} fps</span>
        </div>
        <div class="row">
          <span>Last-frame pause</span>
          <input type="range" min={0} max={5000} step={250} value={s.anim.dwellMs} onInput={(e) => update((x) => (x.anim.dwellMs = +(e.target as HTMLInputElement).value))} />
          <span class="val">{(s.anim.dwellMs / 1000).toFixed(1)}s</span>
        </div>
      </section>
      <section>
        <label class="lbl">Alerts & sound</label>
        <div class="row">
          <span>Notify for</span>
          <select value={s.notify.mode} onChange={(e) => update((x) => (x.notify.mode = (e.target as HTMLSelectElement).value as any))}>
            <option value="points">My points only</option>
            <option value="all">All new alerts</option>
            <option value="off">Nothing</option>
          </select>
        </div>
        <Toggle label="Warnings only" on={s.notify.warningsOnly} set={(v) => update((x) => (x.notify.warningsOnly = v))} />
        <Toggle label="Desktop notifications" on={s.notify.desktop} set={(v) => update((x) => (x.notify.desktop = v))} />
        <Toggle label="Alert sounds" on={s.audio.alerts} set={(v) => update((x) => (x.audio.alerts = v))} />
        <Toggle label="Sound on new sweep" on={s.audio.sweeps} set={(v) => update((x) => (x.audio.sweeps = v))} />
        <div class="row">
          <span>Volume</span>
          <input type="range" min={0} max={100} value={Math.round(s.audio.volume * 100)} onInput={(e) => update((x) => (x.audio.volume = +(e.target as HTMLInputElement).value / 100))} />
          <button class="btn sm ghost" onClick={() => playAlertSound("Tornado Warning")}>
            Test
          </button>
        </div>
      </section>
      <section>
        <label class="lbl">API keys</label>
        <KeysEditor />
      </section>
      <section>
        <label class="lbl">About</label>
        <div class="muted small">
          TheBigWeather. Map data © OpenStreetMap contributors, CARTO, Esri, OpenFreeMap. Radar data: NOAA NEXRAD/TDWR via AWS Open Data. Alerts: NWS.
        </div>
      </section>
    </div>
  );
}

/* ---------- workflow: appearance ---------- */
function AppearanceSection() {
  const t = settings.value.theme;
  const set = (p: Partial<typeof t>) => update((x) => (x.theme = { ...x.theme, ...p }));
  const zoomable = !!(window as any).tbw?.setZoom;
  return (
    <section>
      <label class="lbl">Appearance</label>
      <div class="row accent-row">
        <span>Accent</span>
        <div class="swatches">
          {ACCENTS.map((c) => (
            <button key={c} class={`sw ${t.accent.toLowerCase() === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => set({ accent: c })} />
          ))}
          <input type="color" value={t.accent} title="Custom colour" onInput={(e) => set({ accent: (e.target as HTMLInputElement).value })} />
        </div>
      </div>
      <div class="row">
        <span>UI scale</span>
        <input type="range" min={90} max={125} step={5} disabled={!zoomable} value={Math.round(t.scale * 100)} onChange={(e) => set({ scale: +(e.target as HTMLInputElement).value / 100 })} />
        <span class="val">{Math.round(t.scale * 100)}%</span>
      </div>
      {!zoomable && <div class="muted small">In a browser, use the browser's zoom (Ctrl +/−).</div>}
      <div class="row">
        <span>Panel opacity</span>
        <input type="range" min={50} max={100} step={5} value={Math.round(t.panelOpacity * 100)} onInput={(e) => set({ panelOpacity: +(e.target as HTMLInputElement).value / 100 })} />
        <span class="val">{Math.round(t.panelOpacity * 100)}%</span>
      </div>
      <button class="btn sm ghost" onClick={() => set({ accent: "#3fb7ff", scale: 1, panelOpacity: 0.9 })}>
        Reset
      </button>
    </section>
  );
}
/* ---------- end workflow ---------- */
