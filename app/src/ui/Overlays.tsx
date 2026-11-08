import { toasts } from "../store";
import { contextMenu, addPointAt, hover } from "../map/mapview";
import { openSounding } from "../sounding/state"; // intl & forecast tools
import { displaySweep, activeTable } from "../radar/controller";
import { sampleAt } from "../radar/sweep";
import { fmtValue } from "../util";
import { toast, update, uid } from "../store";
import { camType } from "../overlays/mycams";
import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { openForecastAt } from "./ForecastCenter"; // data 0.6
/* 0.8.2: map menu labels, Nearest radar, alert layer options */
import { settings } from "../store";
import { mapRef, ALERT_HIT_LAYERS } from "../map/mapview";
import { alerts } from "../alerts";
import { sites, currentSite, selectSite } from "../radar/controller";
import { siteShown, type AnySite } from "../intl/sites";
import { intlSource, intlSources, groupOf, selectIntl } from "../intl/radar";
import { nearest, radarFamily } from "../alertlist";
import { openAlertLayerOptions } from "./AlertConfig";
import { AlertTypeMenu, alertTypeMenu } from "./panels/AlertsPanel";
import { Plus, SlidersHorizontal } from "lucide-preact";

/** "Add camera" dialog: at a map position, or linked to a ship (cruise bridge cams). */
export const camDialog = signal<{ lat?: number; lon?: number; ship?: string } | null>(null);

export function AddCameraDialog() {
  const d = camDialog.value;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [ship, setShip] = useState(d?.ship ?? "");
  if (!d) return null;
  const ok = /^https?:\/\/\S+$/.test(url.trim()) && (d.lat !== undefined || ship.trim());
  const save = () => {
    const u = url.trim();
    const n = name.trim() || (camType(u) === "yt" ? "YouTube stream" : "Camera");
    update((s) => {
      s.myCams.push({ id: uid(), name: n, lat: d.lat ?? NaN, lon: d.lon ?? NaN, url: u, ship: ship.trim() || undefined });
      s.ovl.mycams = { ...(s.ovl.mycams ?? {}), on: true };
    });
    toast(`Added ${n}`);
    camDialog.value = null;
    setName("");
    setUrl("");
  };
  return (
    <div class="modal-back" onClick={() => (camDialog.value = null)}>
      <div class="modal glass small-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{d.lat !== undefined ? "Add camera here" : "Add a ship camera"}</h3>
        <input autoFocus placeholder="Name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <input placeholder="URL: YouTube, .m3u8 stream, image or web page" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && ok && save()} />
        {d.lat === undefined && <input placeholder="Ship name or MMSI" value={ship} onInput={(e) => setShip((e.target as HTMLInputElement).value)} />}
        {d.lat !== undefined && <p class="muted small">{d.lat.toFixed(4)}, {d.lon!.toFixed(4)}</p>}
        <div class="row">
          <button class="btn" disabled={!ok} onClick={save}>
            Add
          </button>
          <button class="btn ghost" onClick={() => (camDialog.value = null)}>
            Cancel
          </button>
        </div>
        <p class="muted small">Feeds belong to their owners. YouTube is watch-only.</p>
      </div>
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast glass ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- 0.8.2: map right-click menu ---------- */
/** "Nearest radar": the closest radar of the current single-site product family, or null when the
 * weather layer isn't a single-site radar. */
function nearestRadar(lat: number, lon: number): { id: string; label: string; go: () => void } | null {
  const w = settings.value.weather;
  if (w.kind === "radar") {
    const cur = currentSite.value as AnySite | undefined;
    const fam = radarFamily((sites.value as AnySite[]).filter((x) => siteShown(x)), settings.value.radar.source, cur);
    const n = nearest(fam, lat, lon);
    if (!n) return null;
    return { id: n.item.id, label: n.item.id, go: () => selectSite(n.item.id) };
  }
  if (w.kind === "intl") {
    const src = intlSource(w.id);
    if (!src?.site) return null; // mosaics and groups aren't single-site
    const g = groupOf(src);
    const fam = intlSources.value.filter((x) => x.site && groupOf(x) === g).map((x) => ({ id: x.id, lat: x.site!.lat, lon: x.site!.lon, name: x.site!.name }));
    const n = nearest(fam, lat, lon);
    if (!n) return null;
    return { id: n.item.id, label: n.item.name || n.item.id, go: () => selectIntl(n.item.id) };
  }
  return null;
}

/** alert types under the right-click (most urgent first) */
function alertTypesAt(x: number, y: number): string[] {
  const map = mapRef.peek();
  if (!map) return [];
  const layers = ALERT_HIT_LAYERS.filter((l) => map.getLayer(l));
  if (!layers.length) return [];
  const ids = [...new Set(map.queryRenderedFeatures([x, y], { layers }).map((f) => String(f.properties?.id)))];
  const al = ids.map((id) => alerts.value.get(id)).filter(Boolean).sort((a: any, b: any) => b.properties.priority - a.properties.priority);
  return [...new Set(al.map((a: any) => String(a.properties.event)))].slice(0, 4);
}

export function ContextMenu() {
  return (
    <>
      <MapMenu />
      <AlertTypeMenu />
    </>
  );
}

function MapMenu() {
  const m = contextMenu.value;
  if (!m) return null;
  void hover.value;
  const s = displaySweep.value;
  const r = s ? sampleAt(s, m.lat, m.lon) : null;
  const close = () => (contextMenu.value = null);
  const types = alertTypesAt(m.x, m.y);
  const nr = nearestRadar(m.lat, m.lon);
  return (
    <div class="ctx glass" style={{ left: `${m.x + 8}px`, top: `${m.y + 8}px` }} onMouseLeave={close}>
      <div class="ctx-title">
        {m.lat.toFixed(4)}, {m.lon.toFixed(4)}
        {r && !Number.isNaN(r.value) && <b> · {fmtValue(r.value, activeTable.value.units, activeTable.value.labels)}</b>}
      </div>
      {types.map((t) => (
        <button
          key={t}
          class="ctx-alert"
          onClick={() => {
            close();
            openAlertLayerOptions(t);
          }}
        >
          <SlidersHorizontal size={13} /> Layer options for "{t}"...
        </button>
      ))}
      {types.length > 0 && <div class="ctx-sep" />}
      <button
        onClick={() => {
          addPointAt(m.lat, m.lon);
          close();
        }}
      >
        <Plus size={13} /> Point
      </button>
      <button
        onClick={() => {
          camDialog.value = { lat: m.lat, lon: m.lon };
          close();
        }}
      >
        <Plus size={13} /> Camera
      </button>
      {nr && (
        <button
          title={`Switch to the radar nearest this point (${nr.label})`}
          onClick={() => {
            nr.go();
            close();
          }}
        >
          Nearest radar <small class="muted">{nr.label}</small>
        </button>
      )}
      <button
        onClick={() => {
          openSounding(m.lat, m.lon);
          close();
        }}
      >
        Sounding
      </button>
      {/* data 0.6 */}
      <button
        onClick={() => {
          openForecastAt(m.lat, m.lon, "models");
          close();
        }}
      >
        Compare models
      </button>
      <button
        title="Forecast for this point (Climate is a tab there)"
        onClick={() => {
          openForecastAt(m.lat, m.lon, "fc");
          close();
        }}
      >
        Forecast
      </button>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(`${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`);
          toast("Copied coordinates");
          close();
        }}
      >
        Copy coordinates
      </button>
    </div>
  );
}
/* ---------- end 0.8.2 ---------- */

(window as any).__tbwAlerts = { contextMenu, alertTypeMenu, openAlertLayerOptions }; // 0.8.2: console / screenshots
