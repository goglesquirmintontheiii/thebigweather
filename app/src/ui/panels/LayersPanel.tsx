import { settings, update } from "../../store";
import { BASEMAPS } from "../../map/basemaps";
import { showRadar } from "../../radar/controller";
import { Toggle } from "./RadarPanel";
import { activeLabel, selectWeather } from "../../weather";

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
const OVERLAYS_LATER = ["SPC outlooks & MDs", "Tropical", "METARs", "Lightning", "Storm reports", "Cameras", "Aviation", "Spotters & chasers"];

export function LayersPanel() {
  const s = settings.value;
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
        <label class="lbl">Overlays</label>
        <Toggle label="Weather alerts" on={s.overlays.alerts} set={(v) => update((x) => (x.overlays.alerts = v))} />
        <Toggle label="Radar sites" on={s.overlays.sites} set={(v) => update((x) => (x.overlays.sites = v))} />
        <Toggle label="My points" on={s.overlays.points} set={(v) => update((x) => (x.overlays.points = v))} />
        <Toggle label="County lines" on={s.overlays.counties} set={(v) => update((x) => (x.overlays.counties = v))} />
        <Toggle label="State lines" on={s.overlays.states} set={(v) => update((x) => (x.overlays.states = v))} />
        <Toggle label="Map labels" on={s.overlays.labels} set={(v) => update((x) => (x.overlays.labels = v))} />
        <Toggle label="Range rings" on={s.overlays.rings} set={(v) => update((x) => (x.overlays.rings = v))} />
        <div class="later">
          {OVERLAYS_LATER.map((o) => (
            <span key={o} class="tag dim" title="Coming in phase 3">
              {o}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
