// data 0.8: Chaser toolkit panel — position sharing (Team), storm-relative motion for you and
// teammates, a rough safe-zone guide around a selected storm, route flood / closure warnings and
// auto-saved chase logs (GPS track + radar snapshots + photos) with .zip export.

import { useEffect, useState } from "preact/hooks";
import { Car, Users, Play, Square, Camera, ImagePlus, Download, Trash2, ShieldAlert, Navigation, RefreshCw, StickyNote, Crosshair } from "lucide-preact";
import { settings, toast } from "../store";
import { FloatPanel } from "./FloatPanel";
import { fix, gpsError, recording } from "../gps";
import { teamOpen, team, prefs, setPosMode, memberList } from "../share/collab";
import { stormCells } from "../overlays/stormcells";
import { mapRef, mapClickHooks } from "../map/mapview";
import { compass, fmtDist, speedFactor, distance } from "../util";
import { chaseOpen, C8, setC8, srList, selCell, selectCell, cellId, safeZones, ZONES, routeHaz, checkRoute, type Cell } from "../chase/chase";
import { chaseLogs, activeLog, startChaseLog, stopChaseLog, snapshot, addPhotos, addNote, exportLog, deleteLog } from "../chase/log";
import { route } from "../route/route";
import { openPanel } from "../store";

const spd = (ms: number) => `${Math.round(ms * speedFactor())} ${settings.value.units.speed}`;
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const cellName = (c: Cell) => `${c.p.nexrad ? `${c.p.nexrad} ` : ""}${c.p.storm_id ?? "cell"}`;

export function ChaserPanel() {
  if (!chaseOpen.value) return null;
  return (
    <FloatPanel title={<><Car size={14} /> Chaser toolkit</>} x={Math.max(16, window.innerWidth - 440)} y={78} w={400} cls="p8-chase" onClose={() => (chaseOpen.value = false)}>
      <Body />
    </FloatPanel>
  );
}

function Body() {
  const [drag, setDrag] = useState(false);
  return (
    <div
      class={`p8-chase-body ${drag ? "drop" : ""}`}
      onDragOver={(e) => (e.preventDefault(), e.stopPropagation(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        addPhotos([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <Position />
      <StormRelative />
      <SafeZone />
      <RouteWarnings />
      <Logs />
    </div>
  );
}

function Position() {
  const f = fix.value;
  const sharing = prefs.value.pos === "gps";
  const n = memberList.value.filter((m) => m.pos).length;
  return (
    <section>
      <label class="lbl">Position</label>
      <div class="row p8-pos">
        <span class={`p8-dot ${f ? "ok" : recording.value ? "wait" : ""}`} />
        <span class="small">{f ? `GPS ${f.lat.toFixed(4)}, ${f.lon.toFixed(4)} · ±${Math.round(f.acc)} m · ${ago(f.t)} ago` : recording.value ? "Waiting for a GPS fix…" : "GPS off (starts with a chase log)"}</span>
      </div>
      {gpsError.value && <div class="err-text small">{gpsError.value}</div>}
      <div class="row">
        <button class={`btn sm ${sharing ? "on" : "ghost"}`} disabled={!team.value} title={team.value ? "Share your GPS position with the team" : "Join a team first"} onClick={() => setPosMode(sharing ? "off" : "gps")}>
          <Users size={13} /> {sharing ? "Sharing position" : "Share position"}
        </button>
        <button class="btn sm ghost" onClick={() => (teamOpen.value = true)}>
          {team.value ? `Team ${team.value.name} · ${n} on map` : "Join a team…"}
        </button>
      </div>
    </section>
  );
}

function StormRelative() {
  const list = srList.value;
  const c8 = C8();
  return (
    <section>
      <div class="row">
        <label class="lbl">Storm-relative motion</label>
        <label class="d6-chk small">
          <input type="checkbox" checked={c8.vectors} onChange={(e) => setC8((x) => (x.vectors = (e.target as HTMLInputElement).checked))} /> vectors on map
        </label>
      </div>
      {!stormCells.value.cells.length && <div class="muted small">Turn on the Storm cells layer (Severe) to get cell motion.</div>}
      {stormCells.value.cells.length > 0 && !list.length && <div class="muted small">No positions yet: start a chase log (GPS) or share positions in a team.</div>}
      {list.map((s) => {
        const closing = s.closing < -0.3;
        return (
          <div key={s.person.id} class="p8-sr" style={{ borderColor: s.person.color }}>
            <div class="p8-sr-h">
              <b style={{ color: s.person.color }}>{s.person.name}</b>
              <small class="muted">
                vs {cellName(s.cell)} · {fmtDist(s.cell.d)} · you are {s.side}
              </small>
            </div>
            <div class="p8-sr-g">
              <span>Storm</span>
              <b>{s.sSpd > 0 ? `${compass(s.sDir)} ${spd(s.sSpd)}` : "stationary / unknown"}</b>
              <span>You (ground)</span>
              <b>{s.person.spd != null && s.person.dir != null && s.person.spd > 0.5 ? `${compass(s.person.dir)} ${spd(s.person.spd)}` : "stopped"}</b>
              <span>Storm-relative</span>
              <b>{s.srSpd > 0.5 ? `${compass(s.srDir)} ${spd(s.srSpd)}` : "≈ 0"}</b>
              <span>Distance</span>
              <b class={closing ? "p8-bad" : "p8-ok"}>{closing ? `closing ${spd(-s.closing)}` : s.closing > 0.3 ? `opening ${spd(s.closing)}` : "steady"}</b>
              {s.tca != null && s.tca < 90 && (
                <>
                  <span>Closest</span>
                  <b class={s.dca < 5000 ? "p8-bad" : ""}>
                    {fmtDist(s.dca)} in {Math.round(s.tca)} min
                  </b>
                </>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function SafeZone() {
  const c8 = C8();
  const sel = selCell.value;
  const [picking, setPicking] = useState(false);
  const f = fix.value;
  const ref = f ? { lat: f.lat, lon: f.lon } : mapRef.value ? { lat: mapRef.value.getCenter().lat, lon: mapRef.value.getCenter().lng } : null;
  const near = ref ? stormCells.value.cells.map((c) => ({ c, d: distance(ref.lat, ref.lon, c.lat, c.lon) })).sort((a, b) => a.d - b.d).slice(0, 12) : [];
  useEffect(() => {
    if (!picking) return;
    const hook = (e: any) => {
      const p = e.lngLat;
      let best: Cell | null = null;
      let bd = 25_000;
      for (const c of stormCells.value.cells) {
        const d = distance(p.lat, p.lng, c.lat, c.lon);
        if (d < bd) ((bd = d), (best = c));
      }
      setPicking(false);
      if (best) selectCell(best);
      else toast("No storm cell within 25 km of that click", "warn");
      return true;
    };
    mapClickHooks.unshift(hook);
    return () => {
      const i = mapClickHooks.indexOf(hook);
      if (i >= 0) mapClickHooks.splice(i, 1);
    };
  }, [picking]);
  const z = sel ? safeZones(sel) : null;
  return (
    <section>
      <div class="row">
        <label class="lbl">
          <ShieldAlert size={11} /> Safe-zone guide
        </label>
        <label class="d6-chk small">
          <input type="checkbox" checked={c8.safeZone} onChange={(e) => setC8((x) => (x.safeZone = (e.target as HTMLInputElement).checked))} /> on map
        </label>
      </div>
      <div class="row">
        <select value={sel ? cellId(sel) : ""} onChange={(e) => selectCell(stormCells.value.cells.find((c) => cellId(c) === (e.target as HTMLSelectElement).value) ?? null)}>
          <option value="">Choose a storm…</option>
          {sel && !near.some((n) => n.c === sel) && <option value={cellId(sel)}>{cellName(sel)}</option>}
          {near.map(({ c, d }) => (
            <option key={cellId(c)} value={cellId(c)}>
              {cellName(c)} · {fmtDist(d)}
              {c.p.tvs && String(c.p.tvs).toUpperCase() !== "NONE" ? " · TVS" : +c.p.meso > 0 ? " · meso" : ""}
              {c.p.max_dbz ? ` · ${Math.round(c.p.max_dbz)} dBZ` : ""}
            </option>
          ))}
        </select>
        <button class={`icon-btn ${picking ? "on" : ""}`} title="Pick a storm on the map" onClick={() => setPicking(!picking)}>
          <Crosshair size={14} />
        </button>
      </div>
      {sel && z && (
        <>
          <div class="p8-zones">
            {Object.values(ZONES).map((k) => (
              <div key={k.kind}>
                <i style={{ background: k.color }} />
                <b>{k.name}</b>
                <small class="muted">{k.hint}</small>
              </div>
            ))}
          </div>
          <div class="muted small">
            Storm scale ≈ {fmtDist(z.R * 1000)}, moving {compass(z.dir)} at {spd(z.spdKmh / 3.6)}; path drawn for 30 min.
          </div>
        </>
      )}
      <div class="p8-warn small">Rough guidance only, drawn from the cell's position, motion and size — not from the storm's actual structure. Real storms differ: watch the radar and your surroundings, and never rely on this to decide you are safe.</div>
    </section>
  );
}

function RouteWarnings() {
  const h = routeHaz.value;
  const r = route.value;
  return (
    <section>
      <div class="row">
        <label class="lbl">
          <Navigation size={11} /> Route: flooding & closures
        </label>
        <button class="btn sm ghost" disabled={h.busy} onClick={() => (r ? checkRoute() : (openPanel.value = "route"))}>
          <RefreshCw size={12} class={h.busy ? "spin" : ""} /> {r ? "Check route" : "Plan a route"}
        </button>
      </div>
      {h.err && <div class="err-text small">{h.err}</div>}
      {h.t > 0 && !h.busy && !h.err && !h.list.length && <div class="muted small">Nothing found along the route (flood / severe warnings, closures, high water, river flooding).</div>}
      <div class="p8-haz">
        {h.list.map((x, i) => (
          <button key={i} class="p8-haz-row" onClick={() => mapRef.value?.flyTo({ center: [x.lon, x.lat], zoom: Math.max(mapRef.value.getZoom(), 10) })}>
            <i style={{ background: x.color }} />
            <span>{x.text}</span>
            <small class="muted">{fmtDist(x.km * 1000)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function Logs() {
  const c8 = C8();
  const act = activeLog.value;
  const [note, setNote] = useState("");
  const pick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.multiple = true;
    inp.onchange = () => addPhotos([...(inp.files ?? [])]);
    inp.click();
  };
  return (
    <section>
      <label class="lbl">Chase log</label>
      <div class="row">
        {act ? (
          <button class="btn sm danger" onClick={stopChaseLog}>
            <Square size={12} /> Stop & save
          </button>
        ) : (
          <button class="btn sm" onClick={startChaseLog}>
            <Play size={12} /> Start chase log
          </button>
        )}
        <span class="small muted">Snapshot every</span>
        <select value={String(c8.snapMin)} onChange={(e) => setC8((x) => (x.snapMin = +(e.target as HTMLSelectElement).value))}>
          {[1, 2, 5, 10, 15, 30].map((m) => (
            <option key={m} value={String(m)}>
              {m} min
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <button class="btn sm ghost" disabled={!act} onClick={() => snapshot().then((ok) => ok && toast("Snapshot saved"))}>
          <Camera size={12} /> Snapshot
        </button>
        <button class="btn sm ghost" disabled={!chaseLogs.value.length} onClick={pick} title="Add photos (or drop them on this panel)">
          <ImagePlus size={12} /> Photos
        </button>
        <input class="p8-note" placeholder="Note…" value={note} disabled={!act} onInput={(e) => setNote((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && (addNote(note), setNote(""))} />
        <button class="icon-btn" disabled={!act || !note.trim()} title="Add note" onClick={() => (addNote(note), setNote(""))}>
          <StickyNote size={13} />
        </button>
      </div>
      <div class="p8-logs">
        {chaseLogs.value.length === 0 && <div class="muted small">No chase logs yet. Drop photos here to add them to the newest log.</div>}
        {chaseLogs.value.slice(0, 12).map((l) => (
          <div key={l.id} class={`p8-log ${l.id === act ? "on" : ""}`}>
            <div>
              <b>{l.name}</b>
              <small class="muted">
                {l.id === act ? "recording · " : ""}
                {l.pts.length} pts · {l.imgs.filter((i) => i.kind === "snap").length} snapshots · {l.imgs.filter((i) => i.kind === "photo").length} photos{l.notes.length ? ` · ${l.notes.length} notes` : ""}
              </small>
            </div>
            <button class="icon-btn" title="Export .zip (GPX, JSON, images)" onClick={() => exportLog(l.id)}>
              <Download size={13} />
            </button>
            <button class="icon-btn danger" title="Delete" onClick={() => confirm(`Delete ${l.name}?`) && deleteLog(l.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
