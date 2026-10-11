import { hover, centerReadout, fps } from "../map/mapview";
import { crosshair, settings } from "../store";
import { activeLegend } from "../active";
import { fmtValue, fmtGrid, fmtDist, compass } from "../util";

function heightStr(m: number) {
  const ft = m * 3.28084;
  return settings.value.units.distance === "km" ? `${(m / 1000).toFixed(1)} km` : `${(ft / 1000).toFixed(1)} kft`;
}

function fmt(v: number) {
  const L = activeLegend.value;
  if (!L) return "—";
  return L.grid ? fmtGrid(v, L.units, L.table.labels) : fmtValue(v, L.table.units, L.table.labels);
}

export function StatusBar() {
  const h = hover.value;
  if (!h) return null;
  const L = activeLegend.value;
  const hasVal = L && !Number.isNaN(h.value);
  return (
    <div class="statusbar">
      <span>
        {h.lat.toFixed(4)}, {h.lon.toFixed(4)}
      </span>
      {h.range > 0 && (
        <span>
          {fmtDist(h.range)} {Math.round(h.az)}° {compass(h.az)} · beam {heightStr(h.height)}
        </span>
      )}
      {hasVal && <b class="sval">{fmt(h.value)}</b>}
    </div>
  );
}

export function Crosshair() {
  if (!crosshair.value) return null;
  const r = centerReadout.value;
  return (
    <div class="crosshair">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="9" fill="none" stroke="#000" stroke-width="4" opacity=".55" />
        <circle cx="22" cy="22" r="9" fill="none" stroke="#fff" stroke-width="1.6" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" stroke="#000" stroke-width="4" opacity=".55" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" stroke="#fff" stroke-width="1.6" />
      </svg>
      {r && (
        <div class="ch-val glass">
          <b>{fmt(r.value)}</b>
          {r.range > 0 && (
            <span>
              {fmtDist(r.range)} · {heightStr(r.height)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function FpsMeter() {
  if (!settings.value.showFps) return null;
  const f = fps.value;
  return (
    <div class={`fps ${f === null ? "idle" : f < 30 ? "low" : ""}`} title="Map frames drawn per second (idle when nothing is changing)">
      {f === null ? "idle" : `${f} fps`}
    </div>
  );
}
