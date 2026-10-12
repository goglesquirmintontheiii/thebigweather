// workflow 0.6: Route weather panel (sidebar) — stops, route summary, ETA list, storm intercept.

import { useEffect, useState } from "preact/hooks";
import { MapPin, Plus, X, Navigation, Crosshair, Route as RouteIcon, Target, Loader2 } from "lucide-preact";
import { settings, update } from "../store";
import { mapClickHooks, mapRef } from "../map/mapview";
import { fix } from "../gps";
import { stops, picking, depart, route, etaPts, routeBusy, routeError, routeSummary, setStop, addWaypoint, removeStop, clearRoute, planRoute, geocode, intercept, planIntercept, describeOpt, cellLabel, OSRM_DEMO, type Stop } from "../route/route";
import { stormCellsNow, hhmm, fmtMi, fmtTempF, type Cell } from "../wf6data";
import { threat } from "../overlays/stormcells";
import { fmtTime } from "../util";

// map clicks fill the stop being picked
mapClickHooks.push((e) => {
  const i = picking.value;
  if (i === null) return false;
  setStop(i, { name: `${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`, lat: e.lngLat.lat, lon: e.lngLat.lng });
  picking.value = null;
  return true;
});

function StopInput({ i, s }: { i: number; s: Stop | null }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ name: string; label: string; lat: number; lon: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const n = stops.value.length;
  const label = i === 0 ? "Start" : i === n - 1 ? "Destination" : `Via ${i}`;
  const search = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      setRes((await geocode(q)).slice(0, 6));
    } catch (e: any) {
      setRes([]);
    } finally {
      setBusy(false);
    }
  };
  const quick: { name: string; lat: number; lon: number }[] = [...(fix.value ? [{ name: "My location", lat: fix.value.lat, lon: fix.value.lon }] : []), ...settings.value.points.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }))];
  return (
    <div class="rt-stop">
      <span class={`rt-dot ${i === 0 ? "a" : i === n - 1 ? "b" : ""}`}>{i === 0 ? "A" : i === n - 1 ? "B" : i}</span>
      {s ? (
        <div class="rt-set">
          <b title={s.name}>{s.name}</b>
          <button class="icon-btn" title="Change" onClick={() => setStop(i, null)}>
            <X size={13} />
          </button>
        </div>
      ) : (
        <div class="rt-search">
          <div class="row">
            <input placeholder={`${label}: search a place…`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && search()} />
            <button class={`icon-btn ${picking.value === i ? "on" : ""}`} title="Pick on the map" onClick={() => (picking.value = picking.value === i ? null : i)}>
              <Crosshair size={14} />
            </button>
            {busy && <Loader2 size={13} class="spin" />}
          </div>
          {(res.length > 0 || quick.length > 0) && (
            <div class="rt-results">
              {res.map((r) => (
                <button key={r.label} onClick={() => (setStop(i, { name: r.name || r.label.split(",")[0], lat: r.lat, lon: r.lon }), setRes([]), setQ(""))}>
                  <MapPin size={12} /> <span>{r.label}</span>
                </button>
              ))}
              {!res.length &&
                quick.slice(0, 4).map((r) => (
                  <button key={r.name} class="quick" onClick={() => setStop(i, r)}>
                    <Navigation size={12} /> <span>{r.name}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {n > 2 && i > 0 && i < n - 1 && (
        <button class="icon-btn" title="Remove stop" onClick={() => removeStop(i)}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function sevCls(s: number) {
  return ["ok", "minor", "mod", "bad"][s];
}

function Intercept() {
  const [cells, setCells] = useState<Cell[]>([]);
  const [sel, setSel] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    stormCellsNow()
      .then((c) => setCells(c.filter((x) => x.p.sknt > 0).sort((a, b) => threat(b.p) - threat(a.p)).slice(0, 25)))
      .catch((e) => setErr(e.message));
  }, []);
  const from = fix.value ? { lat: fix.value.lat, lon: fix.value.lon, label: "your location" } : stops.value[0] ? { lat: stops.value[0]!.lat, lon: stops.value[0]!.lon, label: stops.value[0]!.name } : settings.value.points[0] ? { lat: settings.value.points[0].lat, lon: settings.value.points[0].lon, label: settings.value.points[0].name } : null;
  const ic = intercept.value;
  return (
    <section>
      <label class="lbl">
        <Target size={12} /> Storm intercept
      </label>
      {err && <div class="muted small">{err}</div>}
      <div class="row">
        <select value={sel} onChange={(e) => setSel((e.target as HTMLSelectElement).value)}>
          <option value="">Choose a storm cell…</option>
          {cells.map((c, i) => (
            <option key={i} value={String(i)}>
              {cellLabel(c)} · threat {Math.round(threat(c.p))}
            </option>
          ))}
        </select>
        <button class="btn sm" disabled={!sel || !from || !!routeBusy.value} onClick={() => from && planIntercept(cells[+sel], from)}>
          Plan
        </button>
      </div>
      {!from && <div class="muted small">Needs a start point: GPS, the route start or a saved point.</div>}
      {ic && (
        <div class="rt-icpt">
          {ic.opts.map((o) => (
            <div key={o.min} class={`rt-icpt-row ${o.spare != null && o.spare >= 0 ? "ok" : "late"}`}>
              {describeOpt(o, ic.from.label)}
            </div>
          ))}
          <div class="muted small">Approximation: straight-line storm motion from the radar's cell track, nearest road found by the router. Never drive into the core — stay on the storm's safe side.</div>
        </div>
      )}
    </section>
  );
}

export function RoutePanel() {
  const r = route.value;
  const pts = etaPts.value;
  const s = settings.value.wf6;
  const [showCfg, setShowCfg] = useState(false);
  const dep = depart.value;
  return (
    <div class="stack rt-panel">
      <section>
        <label class="lbl">
          <RouteIcon size={12} /> Route
        </label>
        {stops.value.map((st, i) => (
          <StopInput key={i} i={i} s={st} />
        ))}
        {picking.value !== null && <div class="muted small">Click the map to set this stop · Esc to cancel</div>}
        <div class="row">
          <button class="btn sm ghost" onClick={addWaypoint}>
            <Plus size={13} /> Waypoint
          </button>
          <span>Leave</span>
          <input
            type="datetime-local"
            value={dep ? new Date(dep - new Date(dep).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).value;
              depart.value = v ? new Date(v).getTime() : null;
            }}
          />
        </div>
        <div class="row">
          <button class="btn sm" disabled={!!routeBusy.value} onClick={planRoute}>
            {routeBusy.value ? <Loader2 size={13} class="spin" /> : <Navigation size={13} />} {routeBusy.value || "Plan route & check weather"}
          </button>
          {(r || stops.value.some(Boolean)) && (
            <button class="btn sm ghost" onClick={clearRoute}>
              Clear
            </button>
          )}
        </div>
        {routeError.value && <div class="err small">{routeError.value}</div>}
      </section>
      {r && (
        <section>
          <div class="rt-head">
            <b>{fmtMi(r.dist)}</b> · <b>{Math.floor(r.dur / 3600) ? `${Math.floor(r.dur / 3600)} h ` : ""}{Math.round((r.dur % 3600) / 60)} min</b> · arrive {hhmm((dep ?? Date.now()) + r.dur * 1000)}
            <button class="icon-btn" title="Zoom to route" onClick={() => {
              const m = mapRef.value;
              if (!m) return;
              let w = 180, so = 90, e = -180, n = -90;
              for (const c of r.coords) (w = Math.min(w, c[0])), (e = Math.max(e, c[0])), (so = Math.min(so, c[1])), (n = Math.max(n, c[1]));
              m.fitBounds([w, so, e, n], { padding: 80, duration: 600 });
            }}>
              <MapPin size={13} />
            </button>
          </div>
          {routeSummary.value.length > 0 ? (
            <div class="rt-summary">
              {routeSummary.value.map((t) => (
                <div key={t}>{t}</div>
              ))}
            </div>
          ) : (
            pts.length > 0 && <div class="rt-summary ok">No warnings or significant precipitation expected along the route.</div>
          )}
          <div class="rt-list">
            {pts.map((p) => (
              <div key={p.i} class={`rt-pt ${sevCls(p.sev)}`} onClick={() => mapRef.value?.flyTo({ center: [p.lon, p.lat], zoom: Math.max(8, mapRef.value.getZoom()) })}>
                <span class="t">{hhmm(p.t)}</span>
                <span class="d">{fmtMi(p.d)}</span>
                <span class="w">
                  {p.warnings.slice(0, 2).map((w) => (
                    <i key={w.id} class="rt-warn" style={{ borderColor: w.color, color: w.color }}>
                      {w.event}
                    </i>
                  ))}
                  {Number.isFinite(p.dbz) && p.dbz >= 15 && (
                    <i class="rt-dbz" title={p.dbzSrc === "nowcast" ? "Radar nowcast at arrival time" : "Current radar (MRMS) — conditions may change by then"}>
                      {Math.round(p.dbz)} dBZ{p.dbzSrc === "nowcast" ? " (nowcast)" : ""}
                    </i>
                  )}
                  {p.fc && (
                    <i class="rt-fc">
                      {fmtTempF(p.fc.temp_f)} {p.fc.short}
                      {p.fc.pop ? ` · ${p.fc.pop}%` : ""}
                    </i>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div class="muted small">
            {r.provider} routing · radar = newest MRMS composite at each point (not a forecast unless marked nowcast) · forecast = hourly at the arrival time. Updated {fmtTime(Date.now())}.
          </div>
        </section>
      )}
      <Intercept />
      <section>
        <button class="btn sm ghost" onClick={() => setShowCfg(!showCfg)}>
          Routing server…
        </button>
        {showCfg && (
          <>
            <div class="row">
              <input placeholder={OSRM_DEMO} value={s.routeUrl} onChange={(e) => update((x) => (x.wf6.routeUrl = (e.target as HTMLInputElement).value.trim()))} />
            </div>
            <div class="muted small">
              Default: the public OSRM demo server (light use only — no heavy or automated use). Enter your own OSRM base URL, or a Valhalla URL (…/route or containing “valhalla”).
            </div>
          </>
        )}
      </section>
    </div>
  );
}
