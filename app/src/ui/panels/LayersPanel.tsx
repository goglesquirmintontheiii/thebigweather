import { settings, update } from "../../store";
import { showRadar } from "../../radar/controller";
import { Toggle } from "./RadarPanel";
import { activeLabel, selectWeather } from "../../weather";
import { OverlayGroups, configModal } from "../OverlayList";
import { useState } from "preact/hooks";
import { Settings2, Search } from "lucide-preact";
import { alerts } from "../../alerts";
import { alertVisible } from "../../alertstyle";
import { Slider, smoothLabel } from "../controls";

type BaseKey = "alerts" | "sites" | "points" | "counties" | "states" | "labels" | "rings";

function BaseRow({ label, k, gear }: { label: string; k: BaseKey; gear?: boolean }) {
  const on = settings.value.overlays[k];
  return (
    <div class="ovl-row">
      <div class="ovl-line">
        <label class="ovl-toggle">
          <input type="checkbox" checked={on} onChange={(e) => update((x) => (x.overlays[k] = (e.target as HTMLInputElement).checked))} />
          <span>{label}</span>
        </label>
        {k === "alerts" && <span class="ovl-count muted">{[...alerts.value.values()].filter((a) => alertVisible(a.properties.event)).length}</span>}
        {gear && (
          <button class="icon-btn gear" title="Settings" onClick={() => (configModal.value = `base:${k}`)}>
            <Settings2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

const WEATHER_LATER = ["Air quality", "HeatRisk", "International radar"];

export function LayersPanel() {
  const s = settings.value;
  const [q, setQ] = useState("");
  return (
    <div class="stack">
      <div class="search">
        <Search size={14} />
        <input placeholder="Find a layer" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
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
                <Slider label="Smoothing" value={s.grid.smooth} min={0} max={1} step={0.05} fmt={smoothLabel} set={(v) => update((x) => (x.grid.smooth = v))} />
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
      {(!q || "weather alerts radar sites my points county state lines range rings".includes(q.toLowerCase())) && (
        <section>
          <label class="lbl">Map</label>
          <BaseRow label="Weather alerts" k="alerts" gear />
          <BaseRow label="Radar sites" k="sites" />
          <BaseRow label="My points" k="points" />
          <BaseRow label="County lines" k="counties" gear />
          <BaseRow label="State lines" k="states" gear />
          <BaseRow label="Range rings" k="rings" gear />
        </section>
      )}
      <OverlayGroups filter={q} />
    </div>
  );
}
