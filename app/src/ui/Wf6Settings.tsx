// workflow 0.6: Settings sections — Look (theme, radar style, terrain, precip effect), Wall/kiosk,
// Offline maps, Plugins.

import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Download, Trash2, RefreshCw, Square, MapPin, FolderOpen, Link, ClipboardPaste, Upload, AlertTriangle, Crop, Puzzle /* 0.8.2 */ } from "lucide-preact";
import { settings, update, toast, openPanel } from "../store"; // 0.8.2: openPanel
import { Toggle } from "./panels/RadarPanel";
import { mapRef } from "../map/mapview";
import { setGeo, removeGeo } from "../map/wf6map";
import { deleteRegion, dlProgress, cancelDownload, storeUsage } from "../offline/tiles";
import { areaJob, deleteArea, basemapName } from "../offline/areas"; // 0.8.2
import { openOfflineAreas } from "./OfflineAreas"; // 0.8.2
import { fmtBytes, fmtTime } from "../util";
import { getCode, setCode } from "../plugins/host"; // 0.8.2: plugin UI moved to plugins/PluginsPanel.tsx
import { enterKiosk } from "../kiosk";

// ---------- look ----------
export function LookSection() {
  const w = settings.value.wf6;
  const set = (fn: (x: typeof w) => void) => update((s) => fn(s.wf6));
  return (
    <>
      <div class="row">
        <span>Theme</span>
        <div class="seg">
          {(["dark", "light", "auto"] as const).map((m) => (
            <button key={m} class={w.themeMode === m ? "on" : ""} onClick={() => set((x) => (x.themeMode = m))}>
              {m === "dark" ? "Dark" : m === "light" ? "Light" : "Auto"}
            </button>
          ))}
        </div>
      </div>
      <div class="muted small">Light/Dark also switches the Dark ↔ Light and Dark roadmap ↔ Road basemaps. Auto follows the system.</div>
      <div class="row">
        <span>Radar look</span>
        <div class="seg">
          {(["classic", "smooth"] as const).map((m) => (
            <button
              key={m}
              class={w.radarStyle === m ? "on" : ""}
              onClick={() =>
                update((s) => {
                  s.wf6.radarStyle = m;
                  s.radar.smooth = m === "smooth" ? 0.75 : 0;
                  s.grid.smooth = m === "smooth" ? 0.75 : 0.5;
                })
              }
            >
              {m === "classic" ? "Classic" : "Smooth"}
            </button>
          ))}
        </div>
      </div>
      <Toggle label="Terrain hillshade" on={w.terrain.on} set={(v) => set((x) => (x.terrain.on = v))} hint="Shaded relief from AWS Terrain Tiles (keyless), drawn under the weather" />
      {w.terrain.on && (
        <>
          <div class="row">
            <span>Relief strength</span>
            <input type="range" min={0.5} max={3} step={0.25} value={w.terrain.exag} onInput={(e) => set((x) => (x.terrain.exag = +(e.target as HTMLInputElement).value))} />
            <span class="val">{w.terrain.exag.toFixed(2)}×</span>
          </div>
          <Toggle label="3D terrain (tilt with right-drag)" on={w.terrain.tilt} set={(v) => set((x) => (x.terrain.tilt = v))} hint="MapLibre 3D terrain; radar is drawn flat on the map plane" />
        </>
      )}
      <Toggle label="Animated snow / rain on Precip Type" on={w.precipFx} set={(v) => set((x) => (x.precipFx = v))} hint="Only while the MRMS Precipitation Type layer is shown" />
    </>
  );
}

// ---------- kiosk ----------
export function KioskSection() {
  const k = settings.value.wf6.kiosk;
  const ws = settings.value.workspaces;
  const set = (fn: (x: typeof k) => void) => update((s) => fn(s.wf6.kiosk));
  return (
    <section>
      <label class="lbl">Wall / kiosk mode</label>
      <div class="muted small">Kiosk mode cycles through your workspaces.</div>{/* 0.8.3 */}
      <div class="ks-ws">
        {ws.map((w) => (
          <label key={w.id} class="chk">
            <input type="checkbox" checked={k.workspaces.includes(w.id)} onChange={(e) => set((x) => (x.workspaces = (e.target as HTMLInputElement).checked ? [...x.workspaces, w.id] : x.workspaces.filter((y) => y !== w.id)))} />
            {w.name}
          </label>
        ))}
      </div>
      <div class="row">
        <span>Each for</span>
        <input type="number" min={5} style={{ width: "64px" }} value={k.seconds} onChange={(e) => set((x) => (x.seconds = Math.max(5, +(e.target as HTMLInputElement).value)))} />
        <span>s · resume after</span>
        <input type="number" min={10} style={{ width: "64px" }} value={k.resume} onChange={(e) => set((x) => (x.resume = Math.max(10, +(e.target as HTMLInputElement).value)))} />
        <span>s idle</span>
      </div>
      <button class="btn sm" onClick={enterKiosk}>
        Start kiosk mode
      </button>
      <div class="muted small">Or start the app with --kiosk. Esc exits.</div>
    </section>
  );
}

// ---------- offline maps ----------
// 0.8.2: areas are drawn as polygons from the Basemap tab (right-click a basemap); this section
// lists them (and the 0.6 box regions, which can still be shown and deleted).
function showRegions(regions = settings.value.wf6.offline.regions) {
  const ring = (x: [number, number, number, number]) => [[x[0], x[1]], [x[2], x[1]], [x[2], x[3]], [x[0], x[3]], [x[0], x[1]]];
  const feats: any[] = regions.map((r) => ({ type: "Feature", properties: { k: "saved" }, geometry: { type: "Polygon", coordinates: [ring(r.bbox)] } }));
  if (!feats.length) return removeGeo("wf6-offline-box");
  setGeo("wf6-offline-box", { type: "FeatureCollection", features: feats }, [
    { id: "wf6-off-fill", type: "fill", source: "wf6-offline-box", paint: { "fill-color": "#34d399", "fill-opacity": 0.08 } },
    { id: "wf6-off-line", type: "line", source: "wf6-offline-box", paint: { "line-color": "#34d399", "line-width": 2, "line-dasharray": [3, 2] } },
  ]);
}

export function OfflineSection() {
  const o = settings.value.wf6.offline;
  const areas = o.areas ?? [];
  const [usage, setUsage] = useState<number | null>(null);
  const prog = dlProgress.value;
  const job = areaJob.value;
  useEffect(() => {
    showRegions(o.regions);
  }, [o.regions]);
  useEffect(() => {
    storeUsage().then(setUsage);
    return () => removeGeo("wf6-offline-box");
  }, [o.regions.length, areas.length, !!job]);
  const fit = (b: [number, number, number, number]) => mapRef.value?.fitBounds(b, { padding: 40 });
  return (
    <section>
      <label class="lbl">Offline maps</label>
      <div class="muted small">Save a basemap area (Basemap tab → R-Click the basemap → draw an area → Download) and you'll find it here.</div>{/* 0.8.3 */}
      {prog && (
        <div class="off-prog">
          <div class="bar">
            <i style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} />
          </div>
          <span>
            {prog.name}: {prog.done.toLocaleString()} / {prog.total.toLocaleString()} · {fmtBytes(prog.bytes)}
            {prog.failed ? ` · ${prog.failed} failed` : ""}
          </span>
          <button class="btn sm ghost" onClick={cancelDownload}>
            Stop
          </button>
        </div>
      )}
      {job && (
        <div class="muted small">
          Downloading “{job.name}”: {job.done.toLocaleString()} / {job.total.toLocaleString()}
          {job.paused ? " · paused" : ""}
        </div>
      )}
      {areas.map((r) => (
        <div key={r.id} class="off-row">
          <span>
            <b>{r.name}</b>
            <small>
              {basemapName(r.basemap)} · z0–{r.maxz} · {r.tiles.toLocaleString()} tiles · {fmtBytes(r.bytes)} · {fmtTime(r.saved, true)}
            </small>
          </span>
          <button
            class="icon-btn"
            title="Show / edit on the map"
            onClick={() => {
              openOfflineAreas(r.basemap as any);
              const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1]);
              fit([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
            }}
          >
            <MapPin size={13} />
          </button>
          <button class="icon-btn danger" title="Delete" disabled={!!job} onClick={() => deleteArea(r.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {o.regions.map((r) => (
        <div key={r.id} class="off-row">
          <span>
            <b>{r.name}</b>
            <small>
              box (0.6) · z{r.minz}–{r.maxz} · {r.tiles.toLocaleString()} tiles · {fmtBytes(r.bytes)} · {fmtTime(r.saved, true)}
            </small>
          </span>
          <button class="icon-btn" title="Show" onClick={() => fit(r.bbox)}>
            <MapPin size={13} />
          </button>
          <button class="icon-btn danger" title="Delete" disabled={!!prog} onClick={() => deleteRegion(r.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {o.regions.length + areas.length > 0 && <Toggle label="Prefer offline tiles (save bandwidth)" on={o.prefer} set={(v) => update((s) => (s.wf6.offline.prefer = v))} />}
      {usage != null && <div class="muted small">Offline store: {fmtBytes(usage)}</div>}
    </section>
  );
}

// ---------- plugins ----------
// 0.8.2: plugins moved to their own rail tab (src/plugins/PluginsPanel.tsx); this points there
export function PluginsSection() {
  return (
    <section>
      <label class="lbl">Plugins</label>
      <div class="row">
        <span class="muted small">Plugins and the marketplace are in the Plugins tab.</span>
        <button class="btn sm ghost" onClick={() => (openPanel.value = "plugins")}>
          <Puzzle size={13} /> Open Plugins
        </button>
      </div>
    </section>
  );
}
export { getCode, setCode };
