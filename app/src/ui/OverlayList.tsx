// Overlay toggles; the gear opens the layer's settings in a centered window.

import { useState, useRef, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { settings, update, type OvlSettings } from "../store";
import { OVERLAYS, optsFor, overlayDef, type OverlayDef } from "../overlays/defs";
import { ovlStatus, ovlMeta, refreshOverlay } from "../overlays/manager";
import { fileOverlays, fileImports, importFile, removeFile } from "../overlays/files";
import { Settings2, ChevronRight, Upload, Trash2, Loader, AlertTriangle, X, RefreshCw, Keyboard, Star } from "lucide-preact";
import { alerts } from "../alerts";
import { alertVisible } from "../alertstyle";
import { KbdBadge, KeyCapture } from "./Shortcuts";

/** layer whose shortcut is being captured (right-click a row, or the keyboard button in its settings) */
const captureFor = signal<string | null>(null);
import { camDialog } from "./Overlays";
import { AlertConfig } from "./AlertConfig";
import { Toggle } from "./panels/RadarPanel";
import { LayerExtra } from "./LayerExtras"; // layers 0.5

/** Layer whose settings window is open: overlay id, "file:<id>" or "base:<name>". */
export const configModal = signal<string | null>(null);

export function setOvl(id: string, fn: (o: OvlSettings) => void) {
  update((s) => {
    const o = { ...(s.ovl[id] ?? {}) };
    fn(o);
    s.ovl[id] = o;
  });
}

function Status({ id }: { id: string }) {
  const st = ovlStatus.value[id];
  if (!settings.value.ovl[id]?.on || !st) return null;
  if (st.loading && st.count === undefined) return <Loader size={12} class="spin muted" />;
  if (st.error)
    return (
      <span class="ovl-err" title={st.error}>
        <AlertTriangle size={12} />
      </span>
    );
  if (st.note) return <span class="ovl-count muted">{st.note}</span>;
  return st.count !== undefined ? <span class="ovl-count muted">{st.count.toLocaleString()}</span> : null;
}

type StyleDef = Partial<{
  color: string;
  opacity: number;
  size: number;
  labels: boolean;
}>;

export function StyleControls({ id, def, generic = true, refresh }: { id: string; def: StyleDef; generic?: boolean; refresh?: number }) {
  const o = settings.value.ovl[id] ?? {};
  return (
    <>
      {def.color !== undefined && (
        <div class="row">
          <span>Color</span>
          <input type="color" value={o.color ?? def.color} onInput={(e) => setOvl(id, (x) => (x.color = (e.target as HTMLInputElement).value))} />
        </div>
      )}
      {def.opacity !== undefined && (
        <div class="row">
          <span>Opacity</span>
          <input type="range" min={10} max={100} value={Math.round((o.opacity ?? def.opacity) * 100)} onInput={(e) => setOvl(id, (x) => (x.opacity = +(e.target as HTMLInputElement).value / 100))} />
          <span class="val">{Math.round((o.opacity ?? def.opacity) * 100)}%</span>
        </div>
      )}
      {def.size !== undefined && (
        <div class="row">
          <span>Size</span>
          <input type="range" min={30} max={300} value={Math.round(((o.size ?? def.size) / def.size) * 100)} onInput={(e) => setOvl(id, (x) => (x.size = (def.size! * +(e.target as HTMLInputElement).value) / 100))} />
          <span class="val">{Math.round(((o.size ?? def.size) / def.size) * 100)}%</span>
        </div>
      )}
      {def.labels !== undefined && <Toggle label="Labels" on={o.labels ?? def.labels} set={(v) => setOvl(id, (x) => (x.labels = v))} />}
      {generic && (
        <>
          <div class="row">
            <span>Show from zoom</span>
            <input type="range" min={0} max={12} step={1} value={o.minzoom ?? 0} onChange={(e) => setOvl(id, (x) => (x.minzoom = +(e.target as HTMLInputElement).value || undefined))} />
            <span class="val">{o.minzoom ? o.minzoom : "Any"}</span>
          </div>
          <Toggle label="Draw above weather" hint="Areas normally sit under the radar/satellite picture" on={!!o.top} set={(v) => setOvl(id, (x) => (x.top = v || undefined))} />
          {refresh ? (
            <div class="row">
              <span>Refresh every</span>
              <select value={String(o.refresh ?? refresh)} onChange={(e) => setOvl(id, (x) => (x.refresh = +(e.target as HTMLSelectElement).value === refresh ? undefined : +(e.target as HTMLSelectElement).value))}>
                {[...new Set([10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, refresh])]
                  .filter((v) => v >= Math.min(refresh, 10))
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v < 60 ? `${v} s` : v < 3600 ? `${v / 60} min` : `${v / 3600} h`}
                      {v === refresh ? " (default)" : ""}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
        </>
      )}
      {Object.keys(o).some((k) => k !== "on" && k !== "opts") && (
        <button class="btn sm ghost" onClick={() => setOvl(id, (x) => (delete x.color, delete x.opacity, delete x.size, delete x.labels, delete x.minzoom, delete x.refresh, delete x.top))}>
          Reset style
        </button>
      )}
    </>
  );
}

function CameraSources() {
  const srcs: any[] = ovlMeta.value.cameras ?? [];
  const db = ovlMeta.value.camdb;
  if (!srcs.length) return <div class="muted small">Turn the layer on to load the camera list.</div>;
  const offStr = settings.value.ovl.cameras?.opts?.off;
  const off = new Set(offStr !== undefined ? offStr.split(",").filter(Boolean) : srcs.filter((s) => s.off).map((s) => s.id));
  const setOff = (ids: string[], on: boolean) =>
    setOvl("cameras", (x) => {
      const n = new Set(off);
      for (const id of ids) on ? n.delete(id) : n.add(id);
      x.opts = { ...(x.opts ?? {}), off: [...n].join(",") };
    });
  const groups = [...new Set(srcs.map((s) => (s.region === "Camera database" ? "Camera database" : "Live sources")))];
  return (
    <div class="cam-srcs">
      {groups.map((g) => {
        const list = srcs.filter((s) => (s.region === "Camera database" ? "Camera database" : "Live sources") === g);
        return (
          <div key={g} class="cam-group">
            <div class="cam-ghead">
              <b>{g}</b>
              <button
                class="btn xs ghost"
                onClick={() =>
                  setOff(
                    list.map((s) => s.id),
                    true,
                  )
                }
              >
                All on
              </button>
              <button
                class="btn xs ghost"
                onClick={() =>
                  setOff(
                    list.map((s) => s.id),
                    false,
                  )
                }
              >
                All off
              </button>
            </div>
            {list.map((s) => (
              <label key={s.id} class="cam-src" title={s.attribution}>
                <input type="checkbox" checked={!off.has(s.id)} onChange={(e) => setOff([s.id], (e.target as HTMLInputElement).checked)} />
                <span>{s.name}</span>
                <small class="muted">
                  {s.region !== "Camera database" ? `${s.region} · ` : ""}
                  {Number(s.count).toLocaleString()}
                </small>
              </label>
            ))}
          </div>
        );
      })}
      {db?.db && (
        <p class="muted small">
          Database: {db.db.stats.records.toLocaleString()} records → {db.db.stats.kept.toLocaleString()} usable ({db.db.stats.inactive.toLocaleString()} inactive, {(db.db.stats.marked_duplicate + db.db.stats.duplicate_in_file).toLocaleString()}{" "}
          duplicates). {db.db.overlap_dropped.toLocaleString()} more were left out because a live source already shows them.
        </p>
      )}
      {!db?.db && db?.msg && <p class="muted small">{db.msg}</p>}
    </div>
  );
}

function MyCamList() {
  const cams = settings.value.myCams;
  return (
    <div class="cam-srcs">
      {cams.length === 0 && <div class="muted small">None yet. Right-click the map → Add camera here.</div>}
      {cams.map((c) => (
        <div key={c.id} class="cam-src">
          <span title={c.url}>{c.name}</span>
          <small class="muted">{c.ship ? `ship: ${c.ship}` : `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`}</small>
          <button class="icon-btn" title="Remove" onClick={() => update((s) => (s.myCams = s.myCams.filter((x) => x.id !== c.id)))}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button class="btn sm ghost" onClick={() => (camDialog.value = { ship: "" })}>
        Add ship camera
      </button>
    </div>
  );
}

/** An option as buttons when it has few short choices, else a dropdown. */
function OptionControl({ d, op, value }: { d: OverlayDef; op: NonNullable<OverlayDef["options"]>[number]; value: string }) {
  const set = (v: string) => setOvl(d.id, (x) => (x.opts = { ...(x.opts ?? {}), [op.key]: v }));
  const short = op.choices.length <= 4 && op.choices.every(([, l]) => l.length <= 14);
  return (
    <div class="row">
      <span>{op.label}</span>
      {short ? (
        <div class="seg sm">
          {op.choices.map(([v, l]) => (
            <button key={v} class={value === v ? "on" : ""} onClick={() => set(v)}>
              {l}
            </button>
          ))}
        </div>
      ) : (
        <select value={value} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
          {op.choices.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function OverlayConfig({ d }: { d: OverlayDef }) {
  const opts = optsFor(d);
  const st = ovlStatus.value[d.id];
  return (
    <>
      {!!d.options?.length && (
        <section>
          <label class="lbl">Options</label>
          {d.options.map((op) => (
            <OptionControl key={op.key} d={d} op={op} value={opts[op.key]} />
          ))}
        </section>
      )}
      <section>
        <label class="lbl">Display</label>
        <StyleControls id={d.id} def={d.style} refresh={d.feed === "client" ? undefined : d.refresh} />
      </section>
      {d.id === "cameras" && (
        <section>
          <label class="lbl">Camera sources</label>
          <CameraSources />
        </section>
      )}
      <LayerExtra id={d.id} /> {/* layers 0.5: storm table, Kp, traffic key */}
      {d.id === "mycams" && (
        <section>
          <label class="lbl">My cameras</label>
          <MyCamList />
        </section>
      )}
      <section>
        {d.note && <p class="muted small">{d.note}</p>}
        {st?.error && <p class="err-text small">{st.error}</p>}
        {st?.count !== undefined && !st.error && (
          <p class="muted small">
            {st.count.toLocaleString()} shown{st.note ? ` · ${st.note}` : ""}
          </p>
        )}
      </section>
    </>
  );
}

const BASE_NAMES: Record<string, string> = {
  alerts: "Weather alerts",
  counties: "County lines",
  states: "State lines",
  rings: "Range rings",
};
const BASE_STYLE: Record<string, StyleDef> = {
  counties: { color: "#8a96a6", opacity: 0.55, size: 1 },
  states: { color: "#c9d1d9", opacity: 1, size: 1 },
  rings: { color: "#9fb3c8", opacity: 0.55 },
};

/** Centered settings window for one layer (RadarOmega style). */
export function ConfigModal() {
  const id = configModal.value;
  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && (configModal.value = null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [id]);
  if (!id) return null;
  const close = () => (configModal.value = null);
  let title = id;
  let body: any = null;
  let onToggle: { on: boolean; set: (v: boolean) => void } | null = null;
  let reload: (() => void) | null = null;
  if (id.startsWith("base:")) {
    const k = id.slice(5) as keyof typeof settings.value.overlays;
    title = BASE_NAMES[k] ?? k;
    onToggle = {
      on: !!settings.value.overlays[k],
      set: (v) => update((x) => (x.overlays[k] = v)),
    };
    body =
      k === "alerts" ? (
        <AlertConfig />
      ) : (
        <section>
          <label class="lbl">Display</label>
          <StyleControls id={id} def={BASE_STYLE[k] ?? {}} generic={false} />
        </section>
      );
  } else if (id.startsWith("file:")) {
    const f = fileOverlays.value.find((x) => `file:${x.id}` === id);
    title = f?.name ?? "File";
    onToggle = {
      on: !!settings.value.ovl[id]?.on,
      set: (v) => setOvl(id, (x) => (x.on = v)),
    };
    body = (
      <>
        <section>
          <label class="lbl">Display</label>
          <StyleControls id={id} def={{ color: "#f472b6", opacity: 0.8, size: 2, labels: true }} />
        </section>
        <section>
          <p class="muted small">
            {f?.count.toLocaleString()} features
            {f?.size ? ` · ${(f.size / 1048576).toFixed(1)} MB` : ""}. Colors set inside a KML file are kept.
          </p>
          <button class="btn sm ghost" onClick={() => (removeFile(id.slice(5)), close())}>
            <Trash2 size={13} /> Remove file
          </button>
        </section>
      </>
    );
  } else {
    const d = overlayDef(id);
    if (!d) return null;
    title = d.name;
    onToggle = {
      on: !!settings.value.ovl[id]?.on,
      set: (v) => setOvl(id, (x) => (x.on = v)),
    };
    body = <OverlayConfig d={d} />;
    if (d.feed !== "client") reload = () => refreshOverlay(id);
  }
  return (
    <div class="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class={`modal glass ovl-modal ${id === "base:alerts" ? "wide" : ""}`}>
        <div class="ovl-modal-head">
          <h3>{title}</h3>
          {onToggle && (
            <label class="toggle compact" title="Show on the map">
              <input type="checkbox" checked={onToggle.on} onChange={(e) => onToggle!.set((e.target as HTMLInputElement).checked)} />
              <i />
            </label>
          )}
          <KbdBadge id={id} />
          <button class={`icon-btn ${captureFor.value === id ? "on" : ""}`} title="Keyboard shortcut to toggle this layer" onClick={() => (captureFor.value = captureFor.value === id ? null : id)}>
            <Keyboard size={14} />
          </button>
          {/* data 0.8 */ !id.startsWith("base:") && (
            <button class="icon-btn" title="Export this layer's data (CSV / GeoJSON / KML)" onClick={() => (openExport(id.startsWith("file:") ? null : id), close())}>
              <FileDown size={14} />
            </button>
          )}
          {reload && (
            <button class="icon-btn" title="Reload now" onClick={reload}>
              <RefreshCw size={14} />
            </button>
          )}
          <button class="icon-btn" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {captureFor.value === id && <KeyCapture id={id} onClose={() => (captureFor.value = null)} />}
        <div class="ovl-modal-body">{body}</div>
      </div>
    </div>
  );
}

// ---------- 0.6: layers menu (Active · Favourites · ordered collapsible groups · search) ----------

type BaseKey = "alerts" | "sites" | "points" | "counties" | "states" | "rings";
const BASE_ROWS: {
  k: BaseKey;
  name: string;
  desc: string;
  group: string;
  gear?: boolean;
}[] = [
  {
    k: "alerts",
    name: "Weather alerts",
    desc: "NWS warnings, watches and advisories",
    group: "Alerts & warnings",
    gear: true,
  },
  {
    k: "sites",
    name: "Radar sites",
    desc: "NEXRAD / TDWR site markers",
    group: "Reference",
  },
  { k: "points", name: "My points", desc: "Saved places", group: "Reference" },
  {
    k: "counties",
    name: "County lines",
    desc: "US county boundaries",
    group: "Reference",
    gear: true,
  },
  {
    k: "states",
    name: "State lines",
    desc: "State and country boundaries",
    group: "Reference",
    gear: true,
  },
  {
    k: "rings",
    name: "Range rings",
    desc: "Distance rings around the radar",
    group: "Reference",
    gear: true,
  },
];

/** Menu group for each overlay (falls back to the overlay's own group). */
const MENU_GROUP: Record<string, string> = {
  watchbox: "Alerts & warnings",
  mcd: "Alerts & warnings",
  spc: "Severe",
  stormattr: "Severe",
  rotation: "Severe",
  rotscan: "Severe",
  lsr: "Severe",
  glm: "Severe",
  nhc: "Tropical",
  gtwo: "Tropical",
  atcf: "Tropical",
  recon: "Tropical",
  vdm: "Tropical",
  ero: "Precipitation & winter",
  wssi: "Precipitation & winter",
  nohrsc: "Precipitation & winter",
  riverflood: "Precipitation & winter",
  gauges: "Precipitation & winter",
  cpc: "Outlooks",
  cpchaz: "Outlooks",
  metar: "Observations",
  fronts: "Observations",
  sigmet: "Aviation",
  gairmet: "Aviation",
  pirep: "Aviation",
  airports: "Aviation",
  flights: "Aviation",
  ships: "Marine",
  buoys: "Marine",
  tides: "Marine",
  quakes: "Hazards",
  shake: "Hazards",
  volcanoes: "Hazards",
  fires: "Hazards",
  hmsfire: "Hazards",
  spcfire: "Hazards",
  airquality: "Environment & health",
  heatrisk: "Environment & health",
  smoke: "Environment & health",
  drought: "Environment & health",
  svi: "Environment & health",
  traffic: "Traffic & roads",
  trafficinc: "Traffic & roads",
  cameras: "Cameras",
  mycams: "Cameras",
  iss: "Space",
  aurora: "Space",
  spotters: "Chasers & reports",
  mping: "Chasers & reports",
  wfo: "Reference",
  waffle: "Fun",
};
const ALIAS: Record<string, string> = {
  Surface: "Observations",
  Environment: "Environment & health",
  Traffic: "Traffic & roads",
};
const GROUP_ORDER = [
  "Alerts & warnings",
  "Severe",
  "Tropical",
  "Precipitation & winter",
  "Outlooks",
  "Observations",
  "Aviation",
  "Marine",
  "Hazards",
  "Environment & health",
  "Traffic & roads",
  "Cameras",
  "Space",
  "Chasers & reports",
  "Reference",
  "My files",
  "Fun",
];

const menuGroup = (d: OverlayDef) => MENU_GROUP[d.id] ?? ALIAS[d.group] ?? d.group;

interface Item {
  key: string;
  name: string;
  desc: string;
  group: string;
  on: boolean;
  set: (v: boolean) => void;
  gear?: string;
  status?: any;
}

function items(): Item[] {
  const s = settings.value;
  const out: Item[] = BASE_ROWS.map((b) => ({
    key: `base:${b.k}`,
    name: b.name,
    desc: b.desc,
    group: b.group,
    on: !!s.overlays[b.k],
    set: (v: boolean) => update((x) => (x.overlays[b.k] = v)),
    gear: b.gear ? `base:${b.k}` : undefined,
    status: b.k === "alerts" && s.overlays.alerts ? <span class="ovl-count muted">{[...alerts.value.values()].filter((a) => alertVisible(a.properties.event)).length}</span> : null,
  }));
  for (const d of OVERLAYS) {
    if (d.hidden) continue;
    out.push({
      key: d.id,
      name: d.name,
      desc: d.note ?? "",
      group: menuGroup(d),
      on: !!s.ovl[d.id]?.on,
      set: (v) => setOvl(d.id, (x) => (x.on = v)),
      gear: d.id,
      status: <Status id={d.id} />,
    });
  }
  for (const f of fileOverlays.value) out.push(fileItem(f));
  return out;
}

function fileItem(f: { id: string; name: string; count: number }): Item {
  const key = `file:${f.id}`;
  return {
    key,
    name: f.name,
    desc: "Imported file",
    group: "My files",
    on: !!settings.value.ovl[key]?.on,
    set: (v) => setOvl(key, (x) => (x.on = v)),
    gear: key,
    status: <span class="ovl-count muted">{f.count.toLocaleString()}</span>,
  };
}

function ItemRow({ it, sub }: { it: Item; sub?: boolean }) {
  const fav = !!settings.value.ovl[it.key]?.fav;
  return (
    <div class={`ovl-row ${it.on ? "is-on" : ""}`} onContextMenu={(e) => (e.preventDefault(), (captureFor.value = it.key))}>
      <div class="ovl-line">
        <button class={`ovl-star ${fav ? "on" : ""}`} title={fav ? "Remove from favourites" : "Add to favourites"} onClick={() => setOvl(it.key, (x) => (x.fav = fav ? undefined : true))}>
          <Star size={12} />
        </button>
        <label class="ovl-toggle" title={`${it.name} · ${it.group}${it.desc ? `\n${it.desc}` : ""}\nRight-click to set a keyboard shortcut`}>
          <input type="checkbox" checked={it.on} onChange={(e) => it.set((e.target as HTMLInputElement).checked)} />
          <span>{it.name}</span>
          {sub && <small class="ovl-sub muted">{it.group}</small>}
        </label>
        <KbdBadge id={it.key} />
        {it.status}
        {it.gear && (
          <button class={`icon-btn gear ${configModal.value === it.gear ? "on" : ""}`} title="Settings" onClick={() => (configModal.value = it.gear!)}>
            <Settings2 size={13} />
          </button>
        )}
      </div>
      {captureFor.value === it.key && !configModal.value && <KeyCapture id={it.key} onClose={() => (captureFor.value = null)} />}
    </div>
  );
}

const OPEN_KEY = "tbw.layerGroupsOpen";
function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function OverlayGroups({ filter = "" }: { filter?: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const toggle = (g: string, def: boolean) =>
    setOpen((o) => {
      const n = { ...o, [g]: !(o[g] ?? def) };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(n));
      } catch {
        /* private mode */
      }
      return n;
    });
  const q = filter.trim().toLowerCase();
  const all = items();
  const words = q.split(/\s+/).filter(Boolean);
  const match = (it: Item) => words.every((w) => `${it.name} ${it.desc} ${it.group}`.toLowerCase().includes(w));
  const groups = [...new Set([...GROUP_ORDER, ...all.map((i) => i.group)])];
  // unknown groups go before Reference
  groups.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a),
      ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? GROUP_ORDER.indexOf("Reference") - 0.5 : ia) - (ib < 0 ? GROUP_ORDER.indexOf("Reference") - 0.5 : ib);
  });

  if (q) {
    const hits = all.filter(match);
    return (
      <section class="ovl-group">
        <div class="ovl-ghead static">
          <span>
            {hits.length} match{hits.length === 1 ? "" : "es"}
          </span>
        </div>
        {hits.map((it) => (
          <ItemRow key={it.key} it={it} sub />
        ))}
        {!hits.length && <div class="muted small">No layer matches “{filter}”.</div>}
      </section>
    );
  }

  const active = all.filter((i) => i.on);
  const favs = all.filter((i) => settings.value.ovl[i.key]?.fav);
  const allOff = () =>
    update((s) => {
      for (const k of Object.keys(s.ovl)) if (s.ovl[k]?.on) s.ovl[k] = { ...s.ovl[k], on: false };
    });
  const head = (g: string, isOpen: boolean, n: number, on: number, extra?: any) => (
    <div class="ovl-ghead2">
      <button class="ovl-gtoggle" onClick={() => toggle(g, false)} aria-expanded={isOpen}>
        <ChevronRight size={13} class={isOpen ? "rot" : ""} />
        <span>{g}</span>
        <span class="ovl-gcount">{n}</span>
        {on > 0 && (
          <span class="ovl-badge" title={`${on} on`}>
            {on} on
          </span>
        )}
      </button>
      {extra}
    </div>
  );
  return (
    <>
      <section class="ovl-group pinned">
        <div class="ovl-ghead2">
          <button class="ovl-gtoggle" onClick={() => toggle("Active", true)}>
            <ChevronRight size={13} class={(open.Active ?? true) ? "rot" : ""} />
            <span>Active</span>
            <span class="ovl-badge">{active.length}</span>
          </button>
          {active.some((i) => !i.key.startsWith("base:")) && (
            <button class="btn xs ghost" title="Turn off every overlay and file layer (map lines and alerts stay)" onClick={allOff}>
              All off
            </button>
          )}
        </div>
        {(open.Active ?? true) && (active.length ? active.map((it) => <ItemRow key={it.key} it={it} />) : <div class="muted small ovl-empty">Nothing on.</div>)}
      </section>
      <section class="ovl-group pinned">
        <div class="ovl-ghead2">
          <button class="ovl-gtoggle" onClick={() => toggle("Favourites", true)}>
            <ChevronRight size={13} class={(open.Favourites ?? true) ? "rot" : ""} />
            <Star size={12} class="fav-ico" />
            <span>Favourites</span>
            <span class="ovl-gcount">{favs.length}</span>
          </button>
        </div>
        {(open.Favourites ?? true) && (favs.length ? favs.map((it) => <ItemRow key={it.key} it={it} />) : <div class="muted small ovl-empty">Star a layer to keep it here.</div>)}
      </section>
      {groups.map((g) => {
        if (g === "My files") return <MyFiles key={g} collapsible open={open[g] ?? false} onToggle={() => toggle(g, false)} />;
        const list = all.filter((i) => i.group === g);
        if (!list.length) return null;
        const isOpen = open[g] ?? false;
        return (
          <section key={g} class="ovl-group">
            {head(g, isOpen, list.length, list.filter((i) => i.on).length)}
            {isOpen && list.map((it) => <ItemRow key={it.key} it={it} />)}
          </section>
        );
      })}
    </>
  );
}

/** Imported map files (GeoJSON, KML, KMZ, GPX). */
export function MyFiles({ collapsible, open = true, onToggle }: { collapsible?: boolean; open?: boolean; onToggle?: () => void } = {}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const importing = Object.entries(fileImports.value);
  const nOn = fileOverlays.value.filter((f) => settings.value.ovl[`file:${f.id}`]?.on).length;
  return (
    <section class="ovl-group">
      <div class={collapsible ? "ovl-ghead2" : "ovl-ghead static"}>
        {collapsible ? (
          <button class="ovl-gtoggle" onClick={onToggle}>
            <ChevronRight size={13} class={open ? "rot" : ""} />
            <span>My files</span>
            <span class="ovl-gcount">{fileOverlays.value.length}</span>
            {nOn > 0 && <span class="ovl-badge">{nOn} on</span>}
          </button>
        ) : (
          <span>My files</span>
        )}
        <button class="btn sm" onClick={() => fileRef.current?.click()} title="GeoJSON, KML, KMZ or GPX (or drop on the map)">
          <Upload size={13} /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".geojson,.json,.kml,.kmz,.gpx"
          multiple
          hidden
          onChange={async (e) => {
            const fs = [...((e.target as HTMLInputElement).files ?? [])];
            (e.target as HTMLInputElement).value = "";
            for (const f of fs) await importFile(f);
          }}
        />
      </div>
      {open &&
        importing.map(([n, note]) => (
          <div key={n} class="ovl-row importing">
            <Loader size={12} class="spin muted" /> <span>{n}</span> <small class="muted">{note}</small>
          </div>
        ))}
      {open && fileOverlays.value.length === 0 && !importing.length && <div class="muted small">No files yet. GeoJSON, KML, KMZ or GPX.</div>}
      {open && fileOverlays.value.map((f) => <ItemRow key={f.id} it={fileItem(f)} />)}
    </section>
  );
}

/* data 0.8: export from a layer's settings */
import { FileDown } from "lucide-preact";
import { openExport } from "../export/export";
