// Static legend for international raster radar (the picture's own colors; no values on hover).

import { settings } from "../store";
import { intlLegend, intlSource, SMN_ALL } from "../intl/radar";

export function IntlLegend() {
  const w = settings.value.weather;
  if (w.kind !== "intl") return null;
  const l = intlLegend(w.id === SMN_ALL ? "smn" : w.id);
  const s = intlSource(w.id);
  return (
    <div class="legend glass cat intl-legend" title={s ? `${s.attribution}${s.license_note ? ` · ${s.license_note}` : ""}` : undefined}>
      <span class="il-title">
        {l.title} <small class="muted">{l.units}</small>
      </span>
      {l.stops.map(([c, t], i) => (
        <span key={i} class="cat-item">
          <i style={{ background: c }} />
          {t}
        </span>
      ))}
    </div>
  );
}
