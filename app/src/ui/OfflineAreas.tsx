// 0.8.2 offline areas: right-click a basemap under Basemap → draw a polygon on the map → (max zoom)
// → Download. Click a saved area's polygon → Delete, or Edit → drag its points → Update.
// The map shows the areas saved for that basemap; this bar floats over the map while it's open.

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { MapMouseEvent, Map as MLMap } from "maplibre-gl";
import { X, Download, Trash2, Pencil, Pause, Play, Undo2, MapPin, Check } from "lucide-preact";
import { settings, update, type Basemap } from "../store";
import { mapRef, mapClickHooks } from "../map/mapview";
import { setGeo, removeGeo } from "../map/wf6map";
import { fmtBytes, fmtTime } from "../util";
import { metresPerPixel, pointInPoly, type LngLat } from "../offline/cover";
import { downloadPolicy, basemapName, areasOf, basemapTemplates, planFor, limitError, estimateUrls, saveArea, deleteArea, areaJob, pauseAreaJob, resumeAreaJob, cancelAreaJob, type OfflineArea } from "../offline/areas";
import "./offlineareas.css";

type Step = "idle" | "draw" | "config" | "selected" | "edit";
interface Mode {
  basemap: Basemap;
  step: Step;
  /** polygon being drawn / edited */
  draft: LngLat[];
  sel?: string;
  maxz: number;
  name: string;
}
export const areaMode = signal<Mode | null>(null);
const cursor = signal<LngLat | null>(null);

const set = (p: Partial<Mode>) => areaMode.value && (areaMode.value = { ...areaMode.value, ...p });

/** Basemap tab → right-click on a basemap. */
export function openOfflineAreas(b: Basemap) {
  if (settings.value.basemap !== b) update((s) => (s.basemap = b));
  const z = mapRef.value ? Math.floor(mapRef.value.getZoom()) : 8;
  areaMode.value = { basemap: b, step: "idle", draft: [], maxz: Math.max(6, Math.min(12, z + 3)), name: "" };
}
export function closeOfflineAreas() {
  areaMode.value = null;
}

const SRC = "wf6-off-areas";
function render(m: Mode | null) {
  if (!m) return removeGeo(SRC);
  const feats: any[] = [];
  const ring = (p: LngLat[]) => [...p, p[0]];
  for (const a of areasOf(m.basemap)) {
    if ((m.step === "edit" || m.step === "config") && a.id === m.sel) continue;
    const k = a.id === m.sel ? "sel" : "saved";
    feats.push({ type: "Feature", properties: { k, id: a.id, lbl: `${a.name} · z${a.maxz}` }, geometry: { type: "Polygon", coordinates: [ring(a.poly)] } });
  }
  const d = m.draft;
  if (m.step === "draw") {
    const line = cursor.value ? [...d, cursor.value] : d;
    if (line.length >= 2) feats.push({ type: "Feature", properties: { k: "draft" }, geometry: { type: "LineString", coordinates: line } });
    d.forEach((p, i) => feats.push({ type: "Feature", properties: { k: i === 0 && d.length >= 3 ? "first" : "v", i }, geometry: { type: "Point", coordinates: p } }));
  } else if ((m.step === "config" || m.step === "edit") && d.length >= 3) {
    feats.push({ type: "Feature", properties: { k: "draft" }, geometry: { type: "Polygon", coordinates: [ring(d)] } });
    if (m.step === "edit") {
      d.forEach((p, i) => {
        feats.push({ type: "Feature", properties: { k: "v", i }, geometry: { type: "Point", coordinates: p } });
        const q = d[(i + 1) % d.length];
        feats.push({ type: "Feature", properties: { k: "mid", i }, geometry: { type: "Point", coordinates: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] } });
      });
    }
  }
  const col = ["match", ["get", "k"], "saved", "#34d399", "sel", "#3fb7ff", "#f59e0b"];
  setGeo(SRC, { type: "FeatureCollection", features: feats }, [
    { id: "wf6-offa-fill", type: "fill", source: SRC, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": col as any, "fill-opacity": ["match", ["get", "k"], "sel", 0.16, 0.09] } },
    { id: "wf6-offa-line", type: "line", source: SRC, filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": col as any, "line-width": ["match", ["get", "k"], "sel", 2.5, 2], "line-dasharray": [3, 1.5] } },
    { id: "wf6-offa-label", type: "symbol", source: SRC, filter: ["has", "lbl"], layout: { "text-field": ["get", "lbl"], "text-font": ["Noto Sans Regular"], "text-size": 11 }, paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.3 } },
    { id: "wf6-offa-mid", type: "circle", source: SRC, filter: ["==", ["get", "k"], "mid"], paint: { "circle-radius": 4, "circle-color": "#f59e0b", "circle-opacity": 0.55, "circle-stroke-color": "#000", "circle-stroke-width": 1 } },
    { id: "wf6-offa-vtx", type: "circle", source: SRC, filter: ["in", ["get", "k"], ["literal", ["v", "first"]]], paint: { "circle-radius": ["match", ["get", "k"], "first", 7, 5], "circle-color": "#fff", "circle-stroke-color": "#f59e0b", "circle-stroke-width": 2 } },
  ]);
}

const px = (map: MLMap, p: LngLat) => map.project(p as any);
const near = (map: MLMap, a: LngLat, e: MapMouseEvent, r = 10) => {
  const q = px(map, a);
  return Math.hypot(q.x - e.point.x, q.y - e.point.y) <= r;
};

/** drop repeated points (a double-click adds two) */
function clean(map: MLMap, d: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of d) {
    const l = out[out.length - 1];
    if (l) {
      const a = px(map, l), b = px(map, p);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 4) continue;
    }
    out.push(p);
  }
  return out;
}

function useMapInteraction(active: boolean) {
  useEffect(() => {
    const map = mapRef.value;
    if (!active || !map) return;
    const dz = map.doubleClickZoom.isEnabled();
    map.doubleClickZoom.disable();
    let drag: number | null = null;
    const finish = () => {
      const m = areaMode.value;
      if (!m) return;
      const d = clean(map, m.draft);
      if (d.length < 3) return;
      cursor.value = null;
      set({ draft: d, step: "config" });
    };
    const hook = (e: MapMouseEvent) => {
      const m = areaMode.value;
      if (!m) return false;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (m.step === "draw") {
        if (m.draft.length >= 3 && near(map, m.draft[0], e)) finish();
        else set({ draft: [...m.draft, p] });
        return true;
      }
      if (m.step === "idle" || m.step === "selected") {
        // smallest saved area under the click
        const hit = areasOf(m.basemap)
          .filter((a) => pointInPoly(p, a.poly))
          .sort((a, b) => spanOf(a.poly) - spanOf(b.poly))[0];
        if (hit) set({ step: "selected", sel: hit.id, maxz: hit.maxz, name: hit.name });
        else if (m.step === "selected") set({ step: "idle", sel: undefined });
        else if (downloadPolicy(m.basemap).ok && !areaJob.value) set({ step: "draw", draft: [p], sel: undefined, name: "" });
        return true;
      }
      return true; // config / edit: the map doesn't open popups meanwhile
    };
    mapClickHooks.unshift(hook);
    const onMove = (e: MapMouseEvent) => {
      const m = areaMode.value;
      if (!m) return;
      if (drag !== null && m.step === "edit") {
        const d = m.draft.slice();
        d[drag] = [e.lngLat.lng, e.lngLat.lat];
        set({ draft: d });
        return;
      }
      if (m.step === "draw") cursor.value = [e.lngLat.lng, e.lngLat.lat];
      const hot = m.step === "edit" && map.queryRenderedFeatures(e.point, { layers: ["wf6-offa-vtx", "wf6-offa-mid"].filter((l) => map.getLayer(l)) }).length > 0;
      map.getCanvas().style.cursor = m.step === "draw" ? "crosshair" : hot ? "grab" : "";
    };
    const onDown = (e: MapMouseEvent) => {
      const m = areaMode.value;
      if (!m || m.step !== "edit" || e.originalEvent.button !== 0) return;
      const f = map.queryRenderedFeatures(e.point, { layers: ["wf6-offa-vtx", "wf6-offa-mid"].filter((l) => map.getLayer(l)) })[0];
      if (!f) return;
      e.preventDefault();
      map.dragPan.disable();
      const i = Number(f.properties?.i);
      if (f.properties?.k === "mid") {
        const d = m.draft.slice();
        d.splice(i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
        set({ draft: d });
        drag = i + 1;
      } else drag = i;
      map.getCanvas().style.cursor = "grabbing";
    };
    const onUp = () => {
      if (drag === null) return;
      drag = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    };
    const onDbl = (e: MapMouseEvent) => {
      const m = areaMode.value;
      if (!m) return;
      e.preventDefault();
      if (m.step === "draw") return finish();
      if (m.step === "edit" && m.draft.length > 3) {
        // double-click a point to remove it
        const i = m.draft.findIndex((p) => near(map, p, e, 8));
        if (i >= 0) set({ draft: m.draft.filter((_, k) => k !== i) });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !areaMode.value) return;
      const m = areaMode.value;
      if (m.step === "draw" || m.step === "config") set({ step: "idle", draft: [] });
      else if (m.step === "edit") set({ step: "selected", draft: [] });
      else if (m.step === "selected") set({ step: "idle", sel: undefined });
      else closeOfflineAreas();
    };
    map.on("mousemove", onMove);
    map.on("mousedown", onDown);
    map.on("mouseup", onUp);
    map.on("dblclick", onDbl);
    window.addEventListener("keydown", onKey);
    return () => {
      const i = mapClickHooks.indexOf(hook);
      if (i >= 0) mapClickHooks.splice(i, 1);
      map.off("mousemove", onMove);
      map.off("mousedown", onDown);
      map.off("mouseup", onUp);
      map.off("dblclick", onDbl);
      window.removeEventListener("keydown", onKey);
      if (dz) map.doubleClickZoom.enable();
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      cursor.value = null;
    };
  }, [active, mapRef.value]);
}

function spanOf(p: LngLat[]) {
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

/** Tile templates of the open basemap (async: OpenFreeMap's TileJSON). */
function useTemplates(b: Basemap | undefined) {
  const [t, setT] = useState<{ b: string; v: Awaited<ReturnType<typeof basemapTemplates>> | null; err?: string } | null>(null);
  useEffect(() => {
    if (!b || !downloadPolicy(b).ok) return;
    let live = true;
    basemapTemplates(b)
      .then((v) => live && setT({ b, v }))
      .catch((e) => live && setT({ b, v: null, err: e?.message ?? String(e) }));
    return () => void (live = false);
  }, [b, settings.value.basemapProvider]);
  return t?.b === b ? t : null;
}

function ZoomPick({ m, max }: { m: Mode; max: number }) {
  const c = m.draft.length ? m.draft.reduce((s, p) => s + p[1], 0) / m.draft.length : mapRef.value?.getCenter().lat ?? 40;
  const mpp = metresPerPixel(m.maxz, c);
  return (
    <div class="offa-row">
      <span>Max zoom</span>
      <input type="range" min={1} max={max} value={Math.min(m.maxz, max)} onInput={(e) => set({ maxz: +(e.target as HTMLInputElement).value })} />
      <b>{Math.min(m.maxz, max)}</b>
      <span class="muted small" title="Ground resolution at that zoom">
        ≈ {mpp >= 1000 ? `${(mpp / 1000).toFixed(1)} km` : `${mpp >= 10 ? Math.round(mpp) : mpp.toFixed(1)} m`}/px
      </span>
    </div>
  );
}

function Estimate({ m, tpl }: { m: Mode; tpl: Awaited<ReturnType<typeof basemapTemplates>> }) {
  const old = m.sel ? areasOf(m.basemap).find((a) => a.id === m.sel) : undefined;
  const plan = useMemo(() => {
    if (m.draft.length < 3) return null;
    const next: OfflineArea = { id: old?.id ?? "__new", basemap: m.basemap, name: m.name, poly: m.draft, minz: 0, maxz: m.maxz, templates: old?.templates ?? tpl.templates, extra: old?.extra ?? tpl.extra, tiles: 0, bytes: 0, saved: 0 };
    return planFor(next);
  }, [m.draft, m.maxz, tpl, old?.id]);
  if (!plan) return null;
  const pol = downloadPolicy(m.basemap);
  const err = limitError(pol, plan.add);
  return (
    <div class={`small ${err ? "err" : "muted"}`}>
      {plan.add.length.toLocaleString()} tiles to download · ~{fmtBytes(estimateUrls(plan.add))}
      {plan.del.length ? ` · ${plan.del.length.toLocaleString()} to delete` : ""}
      {err ? <div>{err}</div> : pol.note ? <div>{pol.note}</div> : null}
    </div>
  );
}

export function OfflineAreaBar() {
  const m = areaMode.value;
  void cursor.value;
  useMapInteraction(!!m);
  useEffect(() => {
    render(m);
  }, [m, cursor.value, settings.value.wf6.offline.areas]);
  useEffect(() => () => removeGeo(SRC), []);
  const tpl = useTemplates(m?.basemap);
  const job = areaJob.value;
  if (!m) return null;
  const pol = downloadPolicy(m.basemap);
  const list = areasOf(m.basemap);
  const sel = list.find((a) => a.id === m.sel);
  const maxZoom = Math.min(16, tpl?.v?.maxzoom ?? 14);
  const busy = !!job;
  const zoomTo = (a: OfflineArea) => {
    const xs = a.poly.map((p) => p[0]), ys = a.poly.map((p) => p[1]);
    mapRef.value?.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 60 });
  };
  return (
    <div class="offa-bar glass" role="dialog" aria-label="Offline areas">
      <div class="offa-head">
        <b>Offline · {basemapName(m.basemap)}</b>
        <span class="muted small">
          {list.length} area{list.length === 1 ? "" : "s"}
        </span>
        <button class="icon-btn" title="Close (Esc)" onClick={closeOfflineAreas}>
          <X size={14} />
        </button>
      </div>
      {!pol.ok && <div class="offa-cant small">Can't download: {pol.reason}</div>}
      {job ? (
        <div class="off-prog">
          <div class="bar">
            <i style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
          </div>
          <span>
            {job.name}: {job.done.toLocaleString()} / {job.total.toLocaleString()} · {fmtBytes(job.bytes)}
            {job.failed ? ` · ${job.failed} failed` : ""}
            {job.paused ? " · paused" : ""}
          </span>
          <button class="btn sm ghost" onClick={job.paused ? resumeAreaJob : pauseAreaJob}>
            {job.paused ? <Play size={13} /> : <Pause size={13} />} {job.paused ? "Resume" : "Pause"}
          </button>
          <button class="btn sm ghost" onClick={cancelAreaJob}>
            Cancel
          </button>
        </div>
      ) : m.step === "idle" ? (
        <div class="muted small">{pol.ok ? "Click on the map to draw an area; double-click or click the first point to finish. Click a saved area to edit or delete it." : list.length ? "Click a saved area to delete it." : ""}</div>
      ) : m.step === "draw" ? (
        <div class="offa-row">
          <span class="small">{m.draft.length} point{m.draft.length === 1 ? "" : "s"} · double-click to finish</span>
          <button class="btn sm ghost" disabled={!m.draft.length} onClick={() => set({ draft: m.draft.slice(0, -1) })}>
            <Undo2 size={13} /> Undo
          </button>
          <button class="btn sm" disabled={m.draft.length < 3} onClick={() => set({ draft: clean(mapRef.value!, m.draft), step: "config" })}>
            <Check size={13} /> Done
          </button>
          <button class="btn sm ghost" onClick={() => set({ step: "idle", draft: [] })}>
            Cancel
          </button>
        </div>
      ) : m.step === "config" ? (
        <>
          <div class="offa-row">
            <input placeholder={`Area ${(settings.value.wf6.offline.areas ?? []).length + 1}`} value={m.name} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
          </div>
          <ZoomPick m={m} max={maxZoom} />
          {tpl?.v ? <Estimate m={m} tpl={tpl.v} /> : <div class="muted small">{tpl?.err ? `Can't read the basemap: ${tpl.err}` : "Reading the basemap…"}</div>}
          <div class="offa-row">
            <button class="btn sm" disabled={!tpl?.v || busy} onClick={() => saveArea({ basemap: m.basemap, name: m.name, poly: m.draft, maxz: Math.min(m.maxz, maxZoom) }).then((ok) => ok && set({ step: "idle", draft: [] }))}>
              <Download size={13} /> Download
            </button>
            <button class="btn sm ghost" onClick={() => set({ step: "idle", draft: [] })}>
              Cancel
            </button>
          </div>
        </>
      ) : m.step === "selected" && sel ? (
        <>
          <div class="small">
            <b>{sel.name}</b>
            <span class="muted">
              {" "}
              · z0–{sel.maxz} · {sel.tiles.toLocaleString()} tiles · {fmtBytes(sel.bytes)} · {fmtTime(sel.saved, true)}
              {sel.failed ? ` · ${sel.failed} failed` : ""}
            </span>
          </div>
          <div class="offa-row">
            <button class="btn sm ghost" disabled={!pol.ok || busy} title={pol.ok ? "Reshape or change the max zoom" : pol.reason} onClick={() => set({ step: "edit", draft: sel.poly.slice(), maxz: sel.maxz, name: sel.name })}>
              <Pencil size={13} /> Edit
            </button>
            <button class="btn sm ghost danger" disabled={busy} onClick={() => deleteArea(sel.id).then(() => set({ step: "idle", sel: undefined }))}>
              <Trash2 size={13} /> Delete
            </button>
            <button class="icon-btn" title="Zoom to the area" onClick={() => zoomTo(sel)}>
              <MapPin size={13} />
            </button>
          </div>
        </>
      ) : m.step === "edit" && sel ? (
        <>
          <div class="muted small">Drag points to reshape · drag a middle dot to add a point · double-click a point to remove it</div>
          <ZoomPick m={m} max={Math.min(16, Math.max(...sel.templates.map((t) => t.maxzoom)))} />
          <Estimate m={m} tpl={{ templates: sel.templates, extra: sel.extra, maxzoom: 0 }} />
          <div class="offa-row">
            <button class="btn sm" disabled={busy || m.draft.length < 3} onClick={() => saveArea({ id: sel.id, basemap: m.basemap, name: sel.name, poly: m.draft, maxz: m.maxz }).then((ok) => ok && set({ step: "selected", draft: [] }))}>
              <Check size={13} /> Update
            </button>
            <button class="btn sm ghost" onClick={() => set({ step: "selected", draft: [] })}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

(window as any).__tbwOffAreas = { areaMode, openOfflineAreas, mapRef }; // console / screenshots
