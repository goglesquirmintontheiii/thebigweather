import { hover, centerReadout } from "../map/mapview";
import { crosshair, settings } from "../store";
import { activeTable, displaySweep } from "../radar/controller";
import { fmtValue, fmtDist, compass } from "../util";

function heightStr(m: number) {
  const ft = m * 3.28084;
  return settings.value.units.distance === "km" ? `${(m / 1000).toFixed(1)} km` : `${(ft / 1000).toFixed(1)} kft`;
}

export function StatusBar() {
  const h = hover.value;
  const t = activeTable.value;
  const s = displaySweep.value;
  if (!h) return null;
  const hasVal = s && !Number.isNaN(h.value);
  return (
    <div class="statusbar">
      <span>
        {h.lat.toFixed(4)}, {h.lon.toFixed(4)}
      </span>
      {s && h.range > 0 && (
        <span>
          {fmtDist(h.range)} {Math.round(h.az)}° {compass(h.az)} · beam {heightStr(h.height)}
        </span>
      )}
      {hasVal && <b class="sval">{fmtValue(h.value, t.units, t.labels)}</b>}
    </div>
  );
}

export function Crosshair() {
  if (!crosshair.value) return null;
  const r = centerReadout.value;
  const t = activeTable.value;
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
          <b>{fmtValue(r.value, t.units, t.labels)}</b>
          <span>
            {fmtDist(r.range)} · {heightStr(r.height)}
          </span>
        </div>
      )}
    </div>
  );
}
