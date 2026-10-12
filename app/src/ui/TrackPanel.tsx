// GPS track panel: record / stop, live stats, nearest spotters and warning, saved tracks (GPX).

import { useEffect, useState } from "preact/hooks";
import { FloatPanel } from "./FloatPanel";
import { trackPanel, recording, fix, gpsError, tracks, shownTrack, startTrack, stopTrack, trackLength, exportGpx, nearestSpotters, nearestWarning } from "../gps";
import { mapRef } from "../map/mapview";
import { fmtDist, compass } from "../util";
import { alertColor } from "../alerts";
import { Circle, Square, Download, Eye, EyeOff, Trash2 } from "lucide-preact";

const dur = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export function TrackPanel() {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!trackPanel.value) return;
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [trackPanel.value]);
  if (!trackPanel.value) return null;
  const r = recording.value;
  const f = fix.value;
  const c = mapRef.value?.getCenter();
  const at = f ? { lat: f.lat, lon: f.lon } : c ? { lat: c.lat, lon: c.lng } : null;
  const warn = at ? nearestWarning(at.lat, at.lon) : null;
  const spot = at ? nearestSpotters(at.lat, at.lon) : [];
  return (
    <FloatPanel cls="track-panel" w={300} x={Math.max(8, window.innerWidth - 380)} y={Math.max(60, window.innerHeight - 560)} onClose={() => (trackPanel.value = false)} title="GPS track">
      <div class="trk-rec">
        {r ? (
          <button class="btn sm danger" onClick={() => stopTrack()}>
            <Square size={12} /> Stop &amp; save
          </button>
        ) : (
          <button class="btn sm" onClick={startTrack}>
            <Circle size={12} fill="#ef4444" color="#ef4444" /> Record
          </button>
        )}
        <span class="muted small">{r ? `${r.pts.length} pts · ${fmtDist(trackLength(r))} · ${dur(Date.now() - r.start)}` : "Not recording"}</span>
      </div>
      {f && r && (
        <div class="muted small">
          ±{Math.round(f.acc)} m{f.speed != null ? ` · ${fmtDist(f.speed * 3600)}/h` : ""}
          {f.hdg != null && !Number.isNaN(f.hdg) ? ` · ${compass(f.hdg)}` : ""}
        </div>
      )}
      {gpsError.value && <div class="err-text small">{gpsError.value}</div>}
      <label class="lbl">Nearby {f ? "" : <small class="muted">(from map centre)</small>}</label>
      <div class="trk-near">
        {warn ? (
          <div>
            <i class="cat-dot" style={{ background: alertColor(warn.event) }} />
            <span>{warn.event}</span>
            <b>{warn.dist === 0 ? "You're inside" : `${fmtDist(warn.dist)} ${compass(warn.brg)}`}</b>
          </div>
        ) : (
          <div class="muted small">No warnings</div>
        )}
        {spot.map((s, i) => (
          <div key={i}>
            <i class="cat-dot" style={{ background: s.stream ? "#ef4444" : "#22d3ee" }} />
            <span>{s.name}</span>
            <b>
              {fmtDist(s.dist)} {compass(s.brg)}
            </b>
          </div>
        ))}
        {!spot.length && <div class="muted small">Turn on Spotter Network to see chasers nearby</div>}
      </div>
      <label class="lbl">Saved tracks</label>
      <div class="trk-list">
        {tracks.value.map((t) => (
          <div key={t.id} class="trk-row">
            <span>
              <b>{t.name}</b>
              <small class="muted">
                {fmtDist(trackLength(t))} · {dur(t.end - t.start)}
              </small>
            </span>
            <button class={`icon-btn ${shownTrack.value === t.id ? "on" : ""}`} title="Show on map" onClick={() => (shownTrack.value = shownTrack.value === t.id ? null : t.id)}>
              {shownTrack.value === t.id ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button class="icon-btn" title="Export GPX" onClick={() => exportGpx(t)}>
              <Download size={13} />
            </button>
            <button class="icon-btn danger" title="Delete" onClick={() => (tracks.value = tracks.value.filter((x) => x.id !== t.id))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {!tracks.value.length && <div class="muted small">No saved tracks</div>}
      </div>
    </FloatPanel>
  );
}
