import { settings, update } from "../../store";
import { BASEMAPS } from "../../map/basemaps";
import { showRadar } from "../../radar/controller";
import { Toggle } from "./RadarPanel";
import { activeLabel, selectWeather } from "../../weather";
import { OverlayGroups, StyleControls } from "../OverlayList";
import { isDarkBasemap, customTiles } from "../../map/basemaps";
import { useState } from "preact/hooks";
import { uid, type CustomBasemap } from "../../store";
import { Settings2, Plus, Trash2 } from "lucide-preact";

type BaseKey = "alerts" | "sites" | "points" | "counties" | "states" | "labels" | "rings";

function BaseRow({ label, k, style }: { label: string; k: BaseKey; style?: Partial<{ color: string; opacity: number; size: number }> }) {
  const [open, setOpen] = useState(false);
  const on = settings.value.overlays[k];
  return (
    <div class={`ovl-row ${open ? "open" : ""}`}>
      <div class="ovl-line">
        <label class="ovl-toggle">
          <input type="checkbox" checked={on} onChange={(e) => update((x) => (x.overlays[k] = (e.target as HTMLInputElement).checked))} />
          <span>{label}</span>
        </label>
        {style && (
          <button class={`icon-btn gear ${open ? "on" : ""}`} title="Configure" onClick={() => setOpen(!open)}>
            <Settings2 size={13} />
          </button>
        )}
      </div>
      {open && style && (
        <div class="ovl-config">
          <StyleControls id={`base:${k}`} def={style} />
        </div>
      )}
    </div>
  );
}

function CustomBasemaps() {
  const s = settings.value;
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<Omit<CustomBasemap, "id">>({ name: "", url: "", subdomains: "abc", minzoom: 0, maxzoom: 19, dark: true });
  const valid = f.name.trim() && /^https?:\/\/.+\{z\}.*/.test(f.url) && f.url.includes("{x}") && f.url.includes("{y}");
  return (
    <div class="custom-bm">
      {s.customBasemaps.map((c) => (
        <div key={c.id} class={`custom-bm-row ${s.basemap === `custom:${c.id}` ? "on" : ""}`}>
          <button class="custom-bm-name" onClick={() => update((x) => (x.basemap = `custom:${c.id}`))} title={customTiles(c)[0]}>
            {c.name}
          </button>
          <span class="muted small">
            z{c.minzoom}–{c.maxzoom}
          </span>
          <button class="icon-btn" title="Remove" onClick={() => update((x) => ((x.customBasemaps = x.customBasemaps.filter((y) => y.id !== c.id)), x.basemap === `custom:${c.id}` && (x.basemap = "dark")))}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {adding ? (
        <div class="custom-bm-form">
          <input placeholder="Name" value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} />
          <input placeholder="https://{s}.example.com/{z}/{x}/{y}.png" value={f.url} onInput={(e) => setF({ ...f, url: (e.target as HTMLInputElement).value.trim() })} />
          <div class="row">
            <span>Subdomains</span>
            <input class="sm" placeholder="abc or mt0,mt1" value={f.subdomains} onInput={(e) => setF({ ...f, subdomains: (e.target as HTMLInputElement).value })} />
          </div>
          <div class="row">
            <span>Zoom</span>
            <input class="num" type="number" min={0} max={24} value={f.minzoom} onInput={(e) => setF({ ...f, minzoom: +(e.target as HTMLInputElement).value })} />
            <span>to</span>
            <input class="num" type="number" min={0} max={24} value={f.maxzoom} onInput={(e) => setF({ ...f, maxzoom: +(e.target as HTMLInputElement).value })} />
          </div>
          <Toggle label="Dark map (light overlays)" on={f.dark} set={(v) => setF({ ...f, dark: v })} />
          <div class="row">
            <button
              class="btn sm"
              disabled={!valid}
              onClick={() => {
                const id = uid();
                update((x) => {
                  x.customBasemaps.push({ ...f, id, name: f.name.trim() });
                  x.basemap = `custom:${id}`;
                });
                setAdding(false);
                setF({ name: "", url: "", subdomains: "abc", minzoom: 0, maxzoom: 19, dark: true });
              }}
            >
              Add
            </button>
            <button class="btn sm ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <p class="muted small">Use {"{x} {y} {z}"} and optionally {"{s}"}. Only use tile servers you're allowed to use.</p>
        </div>
      ) : (
        <button class="btn sm ghost" onClick={() => setAdding(true)}>
          <Plus size={13} /> Custom tile server
        </button>
      )}
    </div>
  );
}

const SWATCH: Record<string, string> = {
  dark: "linear-gradient(135deg,#0b0e13,#1f2630)",
  light: "linear-gradient(135deg,#f4f5f7,#d9dde3)",
  road: "linear-gradient(135deg,#f2efe9,#f6c85f 60%,#f2efe9)",
  darkroad: "linear-gradient(135deg,#0d1117,#c9a227 55%,#0d1117)",
  terrain: "linear-gradient(135deg,#c8d3b0,#9a8c6a)",
  satellite: "linear-gradient(135deg,#1d3b2a,#4a5a3a 50%,#2a3f5a)",
  google: "linear-gradient(135deg,#21402e,#56663f 50%,#2d4766)",
  offline: "linear-gradient(135deg,#0b1016,#151b23)",
};

const WEATHER_LATER = ["Air quality", "HeatRisk", "International radar"];

export function LayersPanel() {
  const s = settings.value;
  const dark = isDarkBasemap(s.basemap, s.customBasemaps);
  return (
    <div class="stack">
      <section>
        <label class="lbl">Basemap</label>
        <div class="basemaps">
          {BASEMAPS.map((b) => (
            <button key={b.id} class={`bm ${s.basemap === b.id ? "on" : ""}`} onClick={() => update((x) => (x.basemap = b.id))}>
              <span class="sw" style={{ background: SWATCH[b.id] }} />
              <span>{b.name}</span>
            </button>
          ))}
        </div>
        {["dark", "light", "road"].includes(s.basemap) && (
          <div class="row">
            <span>Map tiles</span>
            <div class="seg sm">
              {(["openfreemap", "carto"] as const).map((p) => (
                <button key={p} class={s.basemapProvider === p ? "on" : ""} onClick={() => update((x) => (x.basemapProvider = p))}>
                  {p === "openfreemap" ? "OpenFreeMap" : "CARTO"}
                </button>
              ))}
            </div>
          </div>
        )}
        <CustomBasemaps />
      </section>
      <section>
        <label class="lbl">Weather layer</label>
        <div class="row">
          <b>{activeLabel.value.title}</b>
          <span class="muted small">{activeLabel.value.group}</span>
        </div>
        <p class="muted small">Change it from the layer menu at the top left of the header.</p>
        {s.weather.kind === "radar" ? (
          <Toggle label="Show radar" on={showRadar.value} set={(v) => (showRadar.value = v)} />
        ) : (
          <>
            <div class="row">
              <span>Frames</span>
              <input type="range" min={2} max={36} value={s.grid.frames} onChange={(e) => update((x) => (x.grid.frames = +(e.target as HTMLInputElement).value))} />
              <span class="val">{s.grid.frames}</span>
            </div>
            <div class="row">
              <span>Opacity</span>
              <input type="range" min={10} max={100} value={Math.round(s.grid.opacity * 100)} onInput={(e) => update((x) => (x.grid.opacity = +(e.target as HTMLInputElement).value / 100))} />
              <span class="val">{Math.round(s.grid.opacity * 100)}%</span>
            </div>
            {s.weather.kind === "grid" && (
              <>
                <div class="row">
                  <span>Detail</span>
                  <input type="range" min={50} max={150} step={25} value={Math.round(s.grid.quality * 100)} onChange={(e) => update((x) => (x.grid.quality = +(e.target as HTMLInputElement).value / 100))} />
                  <span class="val">{Math.round(s.grid.quality * 100)}%</span>
                </div>
                <Toggle label="Smoothing" on={s.grid.smooth} set={(v) => update((x) => (x.grid.smooth = v))} />
              </>
            )}
            <button class="btn sm ghost" onClick={() => selectWeather({ kind: "radar" })}>
              Back to radar
            </button>
          </>
        )}
        <div class="later">
          {WEATHER_LATER.map((w) => (
            <span key={w} class="tag dim" title="Coming in a later phase">
              {w}
            </span>
          ))}
        </div>
      </section>
      <section>
        <label class="lbl">Map</label>
        <BaseRow label="Weather alerts" k="alerts" style={{ opacity: 1 }} />
        <BaseRow label="Radar sites" k="sites" />
        <BaseRow label="My points" k="points" />
        <BaseRow label="County lines" k="counties" style={{ color: dark ? "#8a96a6" : "#6b7280", opacity: 0.55, size: 1 }} />
        <BaseRow label="State lines" k="states" style={{ color: dark ? "#c9d1d9" : "#374151", opacity: 1, size: 1 }} />
        <BaseRow label="Map labels" k="labels" />
        <BaseRow label="Range rings" k="rings" style={{ color: "#9fb3c8", opacity: 0.55 }} />
      </section>
      <OverlayGroups />
    </div>
  );
}
