import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals"; // 0.8.3
import { settings, update, uid, toast, connection, openPanel } from "../../store"; // 0.8.3: openPanel
import { sourcesOpen } from "../SourcesWindow"; // 0.8.2
import { api, lastHello } from "../../api";
import { Toggle } from "./RadarPanel";
import { Trash2, Check, Plus, Server, Activity } from "lucide-preact";
import { Palette, Map as MapIcon, Bell, Gauge, AppWindow, Search, X, ChevronRight, KeyboardMusic } from "lucide-preact"; // 0.8.3
import { ToolsSection } from "../ToolsSection"; // 0.8.3: one-click yt-dlp / Deno
import { filterCategory, queryWords, HIDE } from "../setfilter"; // 0.8.3: settings search
import "./settings083.css"; // 0.8.3
import { playAlertSound } from "../../sound";
import { ACCENTS } from "../../theme"; // workflow
import { DesktopSection } from "../../share/DesktopSettings"; // Phase 6
import { UpdatesSection } from "../../update/UpdatesSection"; // p8: updates
import { ServerSettingsSection } from "../ServerSettings"; // shake/stats/server 0.6
import { LookSection, KioskSection, OfflineSection, PluginsSection } from "../Wf6Settings"; // workflow 0.6
import { AccessibilitySection } from "../../a11y/A11yUI"; // panes/palette/a11y 0.8
import { PaneLayoutsSection } from "../PaneLayoutEditor"; // panes/palette/a11y 0.8
import { PerfSection } from "../PerfSettings"; // 0.8.1 perf
import { DevCaptureSetting } from "../../devcapture"; // 0.8.2: TEMPORARY dev-only feedback capture

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
      s.servers.push({
        id,
        name: name.trim() || r.info?.name || url,
        url: url.trim(),
        token: token.trim(),
      });
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
    api
      .get("/api/keys")
      .then(setKeys)
      .catch(() => setKeys(null));
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
          <input type="password" placeholder={keys[k] ? keys[k] : "not set"} value={edits[k] ?? ""} onInput={(e) => setEdits({ ...edits, [k]: (e.target as HTMLInputElement).value })} />
        </div>
      ))}
      <button class="btn sm" disabled={!Object.keys(edits).length} onClick={save}>
        <Check size={13} /> Save keys
      </button>
    </div>
  );
}

/* ---------- 0.8.3: Settings in categories + search ---------- */
// Categories are collapsible (one open at a time); the bar on top searches every setting and
// jumps between categories. All sections stay in the DOM (collapsed <details>), so
// jumpToSetting() (command palette, "Edit layouts"…) still finds and opens them.

interface Cat {
  id: string;
  name: string;
  icon: any;
  sub: string;
  body: () => any;
}

/** a section (or a component that renders one) plus search keywords */
const Sec = ({ kw, children }: { kw: string; children: any }) => (
  <div class="s83-sec" data-kw={kw}>
    {children}
  </div>
);

const CATS: Cat[] = [
  {
    id: "conn",
    name: "Connection",
    icon: Server,
    sub: "Servers, API keys, recording tools",
    body: () => (
      <>
        <Sec kw="server connect url token address remote add data sources feeds status health">
          <ServersSection />
        </Sec>
        <Sec kw="local bundled memory cpu budgets caches logs restart credentials">
          <ServerSettingsSection /> {/* shake/stats/server 0.6 */}
        </Sec>
        <Sec kw="keys credentials token google synoptic airnow tomtom eumetsat">
          <section>
            <label class="lbl">API keys</label>
            <KeysEditor />
          </section>
        </Sec>
        <Sec kw="yt-dlp ytdlp deno youtube download install recording camera">
          <ToolsSection /> {/* 0.8.3 */}
        </Sec>
      </>
    ),
  },
  {
    id: "look",
    name: "Look & units",
    icon: Palette,
    sub: "Theme, accent, units, time, accessibility",
    body: () => (
      <>
        <Sec kw="theme dark light auto accent colour color scale zoom size opacity transparency terrain hillshade radar look smooth classic snow rain">
          <AppearanceSection />
        </Sec>
        <Sec kw="units miles km nmi knots mph celsius fahrenheit temperature precip utc zulu timezone fps colorblind">
          <UnitsSection />
        </Sec>
        <Sec kw="a11y accessibility contrast motion focus text size font screen reader colour vision colorblind">
          <AccessibilitySection /> {/* panes/palette/a11y 0.8 */}
        </Sec>
      </>
    ),
  },
  {
    id: "map",
    name: "Map & panes",
    icon: MapIcon,
    sub: "Animation, pane layouts, offline maps",
    body: () => (
      <>
        <Sec kw="animation loop speed fps dwell pause last frame">
          <AnimationSection />
        </Sec>
        <Sec kw="pane layouts grid split custom editor">
          <PaneLayoutsSection /> {/* panes/palette/a11y 0.8 */}
        </Sec>
        <Sec kw="offline maps tiles download cache basemap area">
          <OfflineSection />
        </Sec>
      </>
    ),
  },
  {
    id: "alerts",
    name: "Alerts",
    icon: Bell,
    sub: "Notifications and sounds",
    body: () => (
      <Sec kw="alerts notifications notify desktop sound audio volume warnings eta storm cell points">
        <AlertsSoundSection />
      </Sec>
    ),
  },
  {
    id: "perf",
    name: "Speed & data",
    icon: Gauge,
    sub: "Performance, bandwidth saver",
    body: () => (
      <>
        <Sec kw="performance fps gpu quality speed slow lag frame rate">
          <PerfSection /> {/* 0.8.1 perf */}
        </Sec>
        <Sec kw="data use bandwidth saver rapidsweep metered">
          <DataUseSection />
        </Sec>
      </>
    ),
  },
  {
    id: "app",
    name: "App",
    icon: AppWindow,
    sub: "Updates, kiosk, plugins, about",
    body: () => (
      <>
        <Sec kw="desktop tray autostart startup minimize close built-in server">
          <DesktopSection /> {/* Phase 6: tray, auto-start, built-in server */}
        </Sec>
        <Sec kw="updates update version upgrade download">
          <UpdatesSection /> {/* p8: app auto-update + server self-update */}
        </Sec>
        <Sec kw="wall kiosk mode cycle workspaces display tv">
          <KioskSection />
        </Sec>
        <Sec kw="plugins marketplace extensions add-ons">
          <PluginsSection />
        </Sec>
        <Sec kw="midi controller knob fader pad learn">
          <MidiLink />
        </Sec>
        <Sec kw="advanced feedback capture developer debug">
          <DevCaptureSetting /> {/* 0.8.2: TEMPORARY dev-only feedback capture */}
        </Sec>
        <Sec kw="about version credits license stormiq attribution">
          <section>
            <label class="lbl">About</label>
            <AboutBrand />
            <div class="muted small">Map data © OpenStreetMap contributors, CARTO, Esri, OpenFreeMap. Radar data: NOAA NEXRAD/TDWR via AWS Open Data. Alerts: NWS.</div>
          </section>
        </Sec>
      </>
    ),
  },
];
export const SETTINGS_CATS = CATS.map(({ id, name }) => ({ id, name }));

const LS_CAT = "tbw.settings.cat";
function savedCat(): string | null {
  try {
    const v = localStorage.getItem(LS_CAT);
    return v && CATS.some((c) => c.id === v) ? v : null;
  } catch {
    return null;
  }
}
/** open category (null: all collapsed, the overview) */
const openCat = signal<string | null>(savedCat());
const query = signal("");
function setCat(id: string | null) {
  openCat.value = id;
  try {
    if (id) localStorage.setItem(LS_CAT, id);
    else localStorage.removeItem(LS_CAT);
  } catch {
    /* private mode */
  }
}

export function SettingsPanel() {
  const cur = openCat.value;
  const q = query.value;
  const words = queryWords(q);
  const searching = words.length > 0;
  const root = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<Record<string, number>>({});
  // a closed panel starts unfiltered next time (deep links must find their target)
  useEffect(() => () => void (query.value = ""), []);
  // search: filter the rendered sections (again whenever they re-render)
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const run = () => {
      const h: Record<string, number> = {};
      el.querySelectorAll<HTMLElement>(".s83-cat").forEach((d) => {
        const n = filterCategory(d.querySelector(".s83-body") as any, words);
        h[d.dataset.cat!] = n;
        d.toggleAttribute(HIDE, searching && n === 0);
      });
      setHits((o) => (JSON.stringify(o) === JSON.stringify(h) ? o : h));
    };
    run();
    if (!searching) return;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(run);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => (mo.disconnect(), cancelAnimationFrame(raf));
  }, [q]);
  const go = (id: string) => {
    query.value = "";
    setCat(id);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`.s83-cat[data-cat="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  return (
    <div class={`s83${searching ? " s83-searching" : ""}`} ref={root}>
      <div class="s83-in">
        <div class="s83-bar">
          <div class="s83-search">
            <Search size={13} />
            <input
              type="search"
              placeholder="Search settings"
              value={q}
              aria-label="Search settings"
              onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && q) {
                  e.stopPropagation();
                  query.value = "";
                }
                if (e.key === "Enter") {
                  // first match: focus its control
                  const hit = root.current?.querySelector<HTMLElement>(`.s83-sec:not([${HIDE}]) section:not([${HIDE}]) > :not(.lbl):not([${HIDE}])`);
                  const f = hit?.matches("input, select, button") ? hit : hit?.querySelector<HTMLElement>("input, select, button, textarea");
                  hit?.scrollIntoView({ block: "center" });
                  f?.focus({ preventScroll: true });
                }
              }}
            />
            {q && (
              <button class="icon-btn" title="Clear" onClick={() => (query.value = "")}>
                <X size={12} />
              </button>
            )}
          </div>
          <div class="s83-chips" role="tablist">
            {CATS.map((c) => {
              const Icon = c.icon;
              const dim = searching && !hits[c.id];
              return (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={!searching && cur === c.id}
                  class={`s83-chip${!searching && cur === c.id ? " on" : ""}${dim ? " dim" : ""}`}
                  title={c.name}
                  onClick={() => go(c.id)}
                >
                  <Icon size={15} />
                  <span class="s83-chip-l">{c.name}</span>
                  {searching && hits[c.id] > 0 && <i class="s83-n">{hits[c.id]}</i>}
                </button>
              );
            })}
          </div>
        </div>
        {searching && total === 0 && <div class="muted small s83-none">No settings match “{q.trim()}”.</div>}
        <div class="s83-cats">
          {CATS.map((c) => {
            const Icon = c.icon;
            const open = searching || cur === c.id;
            return (
              <details
                key={c.id}
                class="s83-cat"
                data-cat={c.id}
                open={open}
                onToggle={(e) => {
                  if (query.peek()) return;
                  const o = (e.currentTarget as HTMLDetailsElement).open;
                  if (o && openCat.peek() !== c.id) setCat(c.id);
                  else if (!o && openCat.peek() === c.id) setCat(null);
                }}
              >
                <summary class="s83-head">
                  <Icon size={16} />
                  <span>
                    <b>{c.name}</b>
                    <small>{c.sub}</small>
                  </span>
                  <ChevronRight size={14} class="s83-chev" />
                </summary>
                <div class="s83-body stack">{c.body()}</div>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- sections (were inline in SettingsPanel) ---------- */
function ServersSection() {
  const s = settings.value;
  const [adding, setAdding] = useState(false);
  const hello = lastHello.value;
  return (
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
      {/* 0.8.2: Data sources (was a rail tab) */}
      <button class="btn sm ghost srcwin-btn" title="Feed status, health and timing" onClick={() => (sourcesOpen.value = true)}>
        <Activity size={13} /> Data sources
        {connection.value !== "online" && <i class={`srcwin-dot ${connection.value}`} />}
      </button>
    </section>
  );
}

function DataUseSection() {
  const s = settings.value;
  return (
    <section>
      <label class="lbl">Data use</label>
      <Toggle label="Bandwidth saver" on={!!s.saver} set={(v) => update((x) => (x.saver = v))} />
      <div class="muted small">Save bandwidth by turning off RapidSweep, capping FPS at 12, reducing 3D resolution, and disabling window polling while the window isn't visible.</div>
    </section>
  );
}

function UnitsSection() {
  const s = settings.value;
  return (
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
  );
}

function AnimationSection() {
  const s = settings.value;
  return (
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
  );
}

function AlertsSoundSection() {
  const s = settings.value;
  return (
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
      {/* 0.8.3: was under Data use */}
      <Toggle
        label="Notify when a storm cell will reach my points"
        on={!!s.etaNotify}
        set={(v) => (update((x) => (x.etaNotify = v)), v && typeof Notification !== "undefined" && Notification.permission === "default" && Notification.requestPermission())}
      />
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
  );
}

/** 0.8.3: MIDI moved to its own rail tab */
function MidiLink() {
  return (
    <section>
      <label class="lbl">MIDI</label>
      <div class="row">
        <span class="muted small">MIDI controllers are in the MIDI tab.</span>
        <button class="btn sm ghost" onClick={() => (openPanel.value = "midi")}>
          <KeyboardMusic size={13} /> Open MIDI
        </button>
      </div>
    </section>
  );
}

/* ---------- 0.8.2: Stormiq ---------- */
function AboutBrand() {
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => {
    Promise.resolve((window as any).tbw?.info?.())
      .then((i: any) => setVer(i?.version ?? null))
      .catch(() => {});
  }, []);
  const srv = lastHello.value?.version;
  return (
    <div class="brand-about">
      <img class="brand-logo" src="icon.png" alt="" />
      <div>
        <b>Stormiq</b>
        <span class="muted small">{ver ? ` ${ver}` : ""}</span>
        <div class="brand-tag">A Swiss army knife for the sky.</div>
        {srv && srv !== ver && <div class="muted small">Server {srv}</div> /* 0.8.3: "Formerly TheBigWeather" removed */}
      </div>
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
      <LookSection /> {/* workflow 0.6: theme, radar look, terrain, precip effect */}
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
