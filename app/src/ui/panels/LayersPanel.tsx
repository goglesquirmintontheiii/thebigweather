import { settings, update } from "../../store";
import { BASEMAPS } from "../../map/basemaps";
import { showRadar } from "../../radar/controller";
import { Toggle } from "./RadarPanel";

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

const WEATHER_LATER = ["MRMS", "Models", "Satellite", "METAR analysis", "NDFD forecast", "Air quality", "HeatRisk"];
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
      </section>
      <section>
        <label class="lbl">Weather layer</label>
        <div class="list">
          <button class="opt on wide">Radar (NEXRAD · TDWR)</button>
          {WEATHER_LATER.map((w) => (
            <button key={w} class="opt wide na" disabled title="Coming in phase 2">
              {w} <span class="sub">soon</span>
            </button>
          ))}
        </div>
        <Toggle label="Show radar" on={showRadar.value} set={(v) => (showRadar.value = v)} />
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
