// workflow 0.6: Settings sections — Look (theme, radar style, terrain, precip effect), Wall/kiosk,
// Offline maps, Plugins.

import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Download, Trash2, RefreshCw, Square, MapPin, FolderOpen, Link, ClipboardPaste, Upload, AlertTriangle, Crop } from "lucide-preact";
import { settings, update, toast } from "../store";
import { Toggle } from "./panels/RadarPanel";
import { mapRef, mapClickHooks } from "../map/mapview";
import { setGeo, removeGeo } from "../map/wf6map";
import { countTiles, currentTemplates, estimateBytes, downloadRegion, deleteRegion, dlProgress, cancelDownload, storeUsage } from "../offline/tiles";
import { fmtBytes, fmtTime } from "../util";
import { pluginStatus, addPlugin, removePlugin, reloadPlugin, pluginFolder, getCode, setCode } from "../plugins/host";
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
      {ws.length === 0 && <div class="muted small">Save some workspaces first (Workspaces panel) — kiosk mode cycles through them.</div>}
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
const boxPick = signal<{ a?: [number, number] } | null>(null);
const box = signal<[number, number, number, number] | null>(null);
mapClickHooks.push((e) => {
  const p = boxPick.value;
  if (!p) return false;
  const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
  if (!p.a) boxPick.value = { a: pt };
  else {
    box.value = [Math.min(p.a[0], pt[0]), Math.min(p.a[1], pt[1]), Math.max(p.a[0], pt[0]), Math.max(p.a[1], pt[1])];
    boxPick.value = null;
  }
  return true;
});
function showBox(b: [number, number, number, number] | null, regions = settings.value.wf6.offline.regions) {
  const ring = (x: [number, number, number, number]) => [[x[0], x[1]], [x[2], x[1]], [x[2], x[3]], [x[0], x[3]], [x[0], x[1]]];
  const feats: any[] = regions.map((r) => ({ type: "Feature", properties: { k: "saved" }, geometry: { type: "Polygon", coordinates: [ring(r.bbox)] } }));
  if (b) feats.push({ type: "Feature", properties: { k: "new" }, geometry: { type: "Polygon", coordinates: [ring(b)] } });
  if (!feats.length) return removeGeo("wf6-offline-box");
  setGeo("wf6-offline-box", { type: "FeatureCollection", features: feats }, [
    { id: "wf6-off-fill", type: "fill", source: "wf6-offline-box", paint: { "fill-color": ["match", ["get", "k"], "new", "#3fb7ff", "#34d399"], "fill-opacity": 0.08 } },
    { id: "wf6-off-line", type: "line", source: "wf6-offline-box", paint: { "line-color": ["match", ["get", "k"], "new", "#3fb7ff", "#34d399"], "line-width": 2, "line-dasharray": [3, 2] } },
  ]);
}

export function OfflineSection() {
  const o = settings.value.wf6.offline;
  const [name, setName] = useState("");
  const [minz, setMinz] = useState(3);
  const [maxz, setMaxz] = useState(10);
  const [usage, setUsage] = useState<number | null>(null);
  const b = box.value;
  const prog = dlProgress.value;
  useEffect(() => {
    showBox(b, o.regions);
  }, [b, o.regions]);
  useEffect(() => {
    storeUsage().then(setUsage);
    return () => {
      boxPick.value = null;
      removeGeo("wf6-offline-box");
    };
  }, [o.regions.length]);
  const m = mapRef.value;
  // only while sizing a box (serialising the style on every render is wasteful)
  const tpl = m && b ? currentTemplates(m).templates : [];
  const n = b ? countTiles(b, minz, maxz) : 0;
  const useView = () => {
    if (!m) return;
    const bb = m.getBounds();
    box.value = [bb.getWest(), bb.getSouth(), bb.getEast(), bb.getNorth()];
    setMinz(Math.max(0, Math.floor(m.getZoom()) - 3));
    setMaxz(Math.min(14, Math.floor(m.getZoom()) + 3));
  };
  return (
    <section>
      <label class="lbl">Offline maps</label>
      <div class="muted small">Save the current basemap (tiles, place-name fonts) for an area, so the map works without internet. Weather data still needs the server.</div>
      <div class="row">
        <button class="btn sm ghost" onClick={useView}>
          <Crop size={13} /> Use current view
        </button>
        <button class={`btn sm ghost ${boxPick.value ? "on" : ""}`} onClick={() => (boxPick.value = boxPick.value ? null : {})}>
          <Square size={13} /> {boxPick.value ? (boxPick.value.a ? "Click the 2nd corner…" : "Click the 1st corner…") : "Draw a box"}
        </button>
      </div>
      {b && (
        <>
          <div class="row">
            <span>Zoom</span>
            <input type="number" min={0} max={16} style={{ width: "56px" }} value={minz} onChange={(e) => setMinz(Math.min(maxz, +(e.target as HTMLInputElement).value))} />
            <span>to</span>
            <input type="number" min={0} max={16} style={{ width: "56px" }} value={maxz} onChange={(e) => setMaxz(Math.max(minz, +(e.target as HTMLInputElement).value))} />
          </div>
          <div class={`small ${n * tpl.length > 60000 ? "err" : "muted"}`}>
            ≈ {(n * Math.max(1, tpl.length)).toLocaleString()} tiles · ~{fmtBytes(estimateBytes(n, tpl))} ({tpl.length ? `${tpl.length} tile source${tpl.length > 1 ? "s" : ""} of this basemap` : "this basemap can't be saved — use Dark, Light, Road or Terrain"})
          </div>
          <div class="row">
            <input placeholder="Region name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn sm" disabled={!!prog || !tpl.length} onClick={() => m && downloadRegion(m, name || `Region ${o.regions.length + 1}`, b, minz, maxz).then(() => (box.value = null))}>
              <Download size={13} /> Download
            </button>
          </div>
        </>
      )}
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
      {o.regions.map((r) => (
        <div key={r.id} class="off-row">
          <span>
            <b>{r.name}</b>
            <small>
              z{r.minz}–{r.maxz} · {r.tiles.toLocaleString()} tiles · {fmtBytes(r.bytes)} · {fmtTime(r.saved, true)}
            </small>
          </span>
          <button class="icon-btn" title="Show" onClick={() => mapRef.value?.fitBounds(r.bbox, { padding: 40 })}>
            <MapPin size={13} />
          </button>
          <button class="icon-btn" title="Update (download again)" disabled={!!prog} onClick={() => m && downloadRegion(m, r.name, r.bbox, r.minz, r.maxz, r)}>
            <RefreshCw size={13} />
          </button>
          <button class="icon-btn danger" title="Delete" onClick={() => deleteRegion(r.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {o.regions.length > 0 && <Toggle label="Prefer offline tiles (save bandwidth)" on={o.prefer} set={(v) => update((s) => (s.wf6.offline.prefer = v))} />}
      {usage != null && <div class="muted small">Offline store: {fmtBytes(usage)}</div>}
    </section>
  );
}

// ---------- plugins ----------
export function PluginsSection() {
  const list = settings.value.wf6.plugins;
  const st = pluginStatus.value;
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const [folder, setFolder] = useState<{ dir: string; files: { name: string; code: string }[] } | null>(null);
  useEffect(() => {
    pluginFolder().then(setFolder);
  }, []);
  const fromFile = () => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = ".js,.mjs,text/javascript";
    i.onchange = async () => {
      const f = i.files?.[0];
      if (f) await addPlugin(f.name, `file:${f.name}`, await f.text());
    };
    i.click();
  };
  const fromUrl = async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await addPlugin(url.split("/").pop() || "plugin", `url:${url}`, await r.text());
      setUrl("");
    } catch (e: any) {
      toast(`Couldn't load: ${e.message}`, "error");
    }
  };
  return (
    <section>
      <label class="lbl">Plugins</label>
      <div class="plg-warn">
        <AlertTriangle size={14} />
        <span>Plugins are JavaScript that runs inside the app with full access to it, your settings and the server. Only add code you wrote or trust.</span>
      </div>
      <div class="row">
        <button class="btn sm ghost" onClick={fromFile}>
          <Upload size={13} /> Load .js file
        </button>
        <button class="btn sm ghost" onClick={() => setPaste(paste === null ? "" : null)}>
          <ClipboardPaste size={13} /> Paste code
        </button>
      </div>
      <div class="row">
        <input placeholder="https://…/plugin.js" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        <button class="btn sm ghost" disabled={!/^https?:\/\//.test(url)} onClick={fromUrl}>
          <Link size={13} /> Add
        </button>
      </div>
      {paste !== null && (
        <>
          <textarea class="plg-code" rows={7} placeholder={"tbw.toast('hello');\n// or: export default function (tbw) { … }"} value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
          <button class="btn sm" disabled={!paste.trim()} onClick={() => addPlugin(`Pasted ${list.length + 1}`, "paste", paste!).then(() => setPaste(null))}>
            Add plugin
          </button>
        </>
      )}
      {folder && (
        <div class="muted small">
          <FolderOpen size={12} /> Plugin folder: {folder.dir}
          {folder.files
            .filter((f) => !list.some((p) => p.src === `folder:${f.name}`))
            .map((f) => (
              <button key={f.name} class="chip" onClick={() => addPlugin(f.name, `folder:${f.name}`, f.code)}>
                + {f.name}
              </button>
            ))}
        </div>
      )}
      {list.map((p) => (
        <div key={p.id} class={`plg-row ${st[p.id]?.error ? "err" : st[p.id]?.running ? "run" : ""}`}>
          <span>
            <b>{p.name}</b>
            <small>{st[p.id]?.error ? `Error: ${st[p.id].error}` : st[p.id]?.running ? "Running" : p.on ? "Starting…" : "Disabled"} · {p.src.replace(/^(\w+):/, "$1 · ")}</small>
          </span>
          <label class="toggle mini" title="Enabled">
            <input type="checkbox" checked={p.on} onChange={(e) => update((s) => (s.wf6.plugins.find((x) => x.id === p.id)!.on = (e.target as HTMLInputElement).checked))} />
            <i />
          </label>
          <button class="icon-btn" title="Reload" onClick={() => reloadPlugin(p).catch((e) => toast(e.message, "error"))}>
            <RefreshCw size={13} />
          </button>
          <button class="icon-btn danger" title="Remove" onClick={() => removePlugin(p.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div class="muted small">API: tbw.map, addGeoJSONLayer, addSource, addPanel, onFrame, onAlert, on, toast, fetchServer, settings — see docs/PLUGINS.md.</div>
    </section>
  );
}
export { getCode, setCode };
