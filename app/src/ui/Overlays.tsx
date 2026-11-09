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
import { siteShown, hiddenRegions, type AnySite } from "../intl/sites";
import { intlSource, intlSources, groupOf, selectIntl } from "../intl/radar";
import { rvRadars, rvRegion } from "../intl/rvcore"; // 0.8.4
import { selectRv } from "../intl/rainviewer"; // 0.8.4
import { radarFamily } from "../alertlist";
import { openAlertLayerOptions } from "./AlertConfig";
import { AlertTypeMenu, alertTypeMenu } from "./panels/AlertsPanel";
import { Plus, SlidersHorizontal } from "lucide-preact";
import { paneMap } from "../map/panes"; // 0.8.2 integration: right-click in a map pane
import { paneLink } from "../map/panes"; // 0.8.3 inspector
import { nearestN, siteClickTarget } from "../radar/insp083"; // 0.8.3 inspector
import { fmtDist } from "../util";
import { ChevronDown } from "lucide-preact";

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
/* 0.8.3 inspector (R8): the three closest radars (the button takes the first, its dropdown lists the next two) */
type NearPick = { id: string; label: string; km: number; go: () => void };
function nearestRadar(lat: number, lon: number, pane?: number): NearPick[] {
  const w = settings.value.weather;
  // 0.8.2 integration: a pane with its own radar site switches that pane (others follow the main radar);
  // 0.8.3 inspector: so does an unlinked pane (same rule as clicking a radar site there)
  const pc = pane ? settings.value.panes.list[pane - 1] : undefined;
  if (pc?.weather.kind === "radar" && (pc.site || siteClickTarget(paneLink(pane!), true) === "pane")) {
    const cur = (sites.value as AnySite[]).find((x) => x.id === (pc.site ?? settings.value.radar.site));
    const fam = radarFamily((sites.value as AnySite[]).filter((x) => siteShown(x)), pc.source ?? "L2", cur);
    return nearestN(fam, lat, lon, 3).map((n) => ({
      id: n.item.id,
      label: n.item.id,
      km: n.km,
      go: () =>
        update((s) => {
          const c = s.panes.list[pane! - 1];
          if (c?.weather.kind === "radar") s.panes.list[pane! - 1] = { ...c, site: n.item.id };
        }),
    }));
  }
  if (w.kind === "radar") {
    const cur = currentSite.value as AnySite | undefined;
    const fam = radarFamily((sites.value as AnySite[]).filter((x) => siteShown(x)), settings.value.radar.source, cur);
    return nearestN(fam, lat, lon, 3).map((n) => ({ id: n.item.id, label: n.item.id, km: n.km, go: () => selectSite(n.item.id) }));
  }
  if (w.kind === "intl") {
    // 0.8.4: RainViewer radars: every one in the shown regions, not just those already opened
    if (w.id.startsWith("rv_")) {
      const hidden = hiddenRegions();
      const fam = rvRadars.value.filter((x) => !hidden.has(rvRegion(x.country)));
      return nearestN(fam, lat, lon, 3).map((n) => ({ id: n.item.id, label: n.item.name || n.item.id, km: n.km, go: () => void selectRv(n.item) }));
    }
    const src = intlSource(w.id);
    if (!src?.site) return []; // mosaics and groups aren't single-site
    const g = groupOf(src);
    const fam = intlSources.value.filter((x) => x.site && groupOf(x) === g).map((x) => ({ id: x.id, lat: x.site!.lat, lon: x.site!.lon, name: x.site!.name }));
    return nearestN(fam, lat, lon, 3).map((n) => ({ id: n.item.id, label: n.item.name || n.item.id, km: n.km, go: () => selectIntl(n.item.id) }));
  }
  return [];
}

/** alert types under the right-click (most urgent first) */
function alertTypesAt(x: number, y: number, pane?: number): string[] {
  const map = pane ? paneMap(pane) : mapRef.peek(); // 0.8.2 integration
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

/** 0.8.3 inspector (R8): "Nearest radar" plus a dropdown of the closest radars (0.8.4: the nearest too) */
function NearestRadarItem({ list, close }: { list: NearPick[]; close: () => void }) {
  const [open, setOpen] = useState(false);
  const first = list[0];
  const pick = (n: NearPick) => {
    n.go();
    close();
  };
  return (
    <>
      <div class="i83-near">
        <button class="i83-near-main" title={`Switch to the radar nearest this point (${first.label}, ${fmtDist(first.km * 1000)})`} onClick={() => pick(first)}>
          Nearest radar <small class="muted">{first.label}</small>
        </button>
        {list.length > 1 && (
          <button class={`i83-near-more ${open ? "on" : ""}`} title="Closest radars" aria-label="Closest radars" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown size={13} />
          </button>
        )}
      </div>
      {open &&
        list.map((n) => (
          <button key={n.id} class="i83-near-alt" title={`Switch to ${n.label}`} onClick={() => pick(n)}>
            {n.label} <small class="muted">{fmtDist(n.km * 1000)}</small>
          </button>
        ))}
    </>
  );
}

function MapMenu() {
  const m = contextMenu.value;
  if (!m) return null;
  void hover.value;
  const s = displaySweep.value;
  const r = s && !m.pane ? sampleAt(s, m.lat, m.lon) : null; // 0.8.2 integration: a pane shows its own product
  const close = () => (contextMenu.value = null);
  const types = m.pane ? alertTypesAt(m.px ?? 0, m.py ?? 0, m.pane) : alertTypesAt(m.x, m.y);
  const nr = nearestRadar(m.lat, m.lon, m.pane);
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
      {nr.length > 0 && <NearestRadarItem key={`${m.x},${m.y}`} list={nr} close={close} /> /* 0.8.3 inspector */}
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
