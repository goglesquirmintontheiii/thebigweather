import { useEffect, useState } from "preact/hooks";
import { api } from "../../api";
import { settings, update } from "../../store";
import { mapRef } from "../../map/mapview";
import { Sun, Moon, Cloud, CloudSun, CloudMoon, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle, Wind, RefreshCw, MapPin, Maximize2 } from "lucide-preact";
import { forecastOpen } from "../ForecastCenter";

export function iconFor(text: string, day: boolean) {
  const t = (text ?? "").toLowerCase();
  if (/thunder|t-storm/.test(t)) return CloudLightning;
  if (/snow|flurr|sleet|ice|wintry/.test(t)) return CloudSnow;
  if (/drizzle/.test(t)) return CloudDrizzle;
  if (/rain|shower/.test(t)) return CloudRain;
  if (/fog|haze|smoke|mist/.test(t)) return CloudFog;
  if (/wind|breez|blust/.test(t)) return Wind;
  if (/partly|mostly sunny|mostly clear|few/.test(t)) return day ? CloudSun : CloudMoon;
  if (/cloud|overcast/.test(t)) return Cloud;
  return day ? Sun : Moon;
}

const tC = (f: number | null | undefined) => (f == null ? null : settings.value.units.temp === "C" ? Math.round((f - 32) / 1.8) : Math.round(f));
function wind(mph: number | null | undefined) {
  if (mph == null) return "—";
  const u = settings.value.units.speed;
  const v = u === "kt" ? mph / 1.15078 : u === "km/h" ? mph * 1.609 : u === "m/s" ? mph * 0.44704 : mph;
  return `${Math.round(v)} ${u}`;
}

/** Next 24 hours: temperature/dewpoint lines over precipitation-chance bars. */
function HourlyChart({ hours }: { hours: any[] }) {
  const h = hours.slice(0, 24);
  if (h.length < 2) return null;
  const W = 300;
  const H = 130;
  const temps = h.map((x) => tC(x.temp_f)).filter((x): x is number => x != null);
  const dews = h.map((x) => (x.dew_c == null ? null : settings.value.units.temp === "C" ? x.dew_c : x.dew_c * 1.8 + 32));
  const all = [...temps, ...(dews.filter((x) => x != null) as number[])];
  const lo = Math.floor(Math.min(...all) - 2);
  const hi = Math.ceil(Math.max(...all) + 2);
  const x = (i: number) => 24 + (i / (h.length - 1)) * (W - 30);
  const y = (v: number) => 12 + (1 - (v - lo) / (hi - lo || 1)) * (H - 40);
  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? "" : `${i && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .join("");
  return (
    <svg class="fc-chart" viewBox={`0 0 ${W} ${H}`} width="100%">
      {h.map((p, i) =>
        p.pop ? <rect key={i} x={x(i) - 4} y={H - 26 - (p.pop / 100) * 40} width={8} height={(p.pop / 100) * 40} fill="rgba(63,183,255,.35)" rx="1.5" /> : null,
      )}
      <path d={line(dews)} fill="none" stroke="#86efac" stroke-width="1.6" stroke-dasharray="3 2" />
      <path d={line(h.map((p) => tC(p.temp_f)))} fill="none" stroke="#fca5a5" stroke-width="2.2" />
      {h.map((p, i) =>
        i % 3 === 0 ? (
          <g key={i}>
            <text x={x(i)} y={y(tC(p.temp_f) ?? lo) - 5} text-anchor="middle" font-size="9" fill="#fca5a5">
              {tC(p.temp_f)}°
            </text>
            <text x={x(i)} y={H - 6} text-anchor="middle" font-size="8.5" fill="#8b97a6">
              {new Date(p.t).toLocaleTimeString(undefined, { hour: "numeric", timeZone: settings.value.utc ? "UTC" : undefined })}
            </text>
          </g>
        ) : null,
      )}
      <text x="2" y="10" font-size="8" fill="#8b97a6">
        temp · dew · rain %
      </text>
    </svg>
  );
}

export function ForecastPanel() {
  const s = settings.value;
  const pts = s.points;
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const sel = s.forecast.point;
  const where = (): { lat: number; lon: number; name: string } | null => {
    const p = pts.find((x) => x.id === sel);
    if (p) return { lat: p.lat, lon: p.lon, name: p.name };
    const c = center ?? (mapRef.value ? [mapRef.value.getCenter().lng, mapRef.value.getCenter().lat] : null);
    return c ? { lat: c[1], lon: c[0], name: "Map center" } : null;
  };
  const load = () => {
    const w = where();
    if (!w) return;
    setBusy(true);
    setErr(null);
    api
      .get(`/api/ovl/forecast?lat=${w.lat.toFixed(3)}&lon=${w.lon.toFixed(3)}`)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [sel, center?.[0], center?.[1]]);
  const days: any[] = [];
  for (const p of data?.periods ?? []) {
    if (p.day || !days.length) days.push({ ...p, lo: null, night: null });
    else {
      days[days.length - 1].lo = p.temp_f;
      days[days.length - 1].night = p;
    }
  }
  return (
    <div class="stack">
      <section>
        <div class="row">
          <select value={sel} onChange={(e) => update((x) => (x.forecast.point = (e.target as HTMLSelectElement).value))}>
            <option value="center">Map center</option>
            {pts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {sel === "center" && (
            <button class="btn sm ghost" title="Use the current map center" onClick={() => mapRef.value && setCenter([mapRef.value.getCenter().lng, mapRef.value.getCenter().lat])}>
              <MapPin size={13} /> Here
            </button>
          )}
          <button class="icon-btn" title="Refresh" onClick={load}>
            <RefreshCw size={14} class={busy ? "spin" : ""} />
          </button>
          <button class="icon-btn" title="Open big view" onClick={() => (forecastOpen.value = true)}>
            <Maximize2 size={14} />
          </button>
        </div>
        {data && (
          <div class="muted small">
            {data.place} · {data.source}
            {data.office ? ` (${data.office})` : ""}
          </div>
        )}
        {err && <div class="err-text small">{err}</div>}
      </section>
      {data?.hourly?.length > 0 && (
        <section>
          <label class="lbl">Next 24 hours</label>
          <HourlyChart hours={data.hourly} />
          <div class="fc-hours">
            {data.hourly.slice(0, 24).map((h: any) => {
              const I = iconFor(h.short, h.day);
              return (
                <div key={h.t} class="fc-hour" title={h.short}>
                  <small>{new Date(h.t).toLocaleTimeString(undefined, { hour: "numeric", timeZone: s.utc ? "UTC" : undefined })}</small>
                  <I size={16} />
                  <b>{tC(h.temp_f)}°</b>
                  <small class="pop">{h.pop ? `${h.pop}%` : ""}</small>
                  <small class="muted">
                    {h.dir ?? ""} {h.wind_mph != null ? Math.round(h.wind_mph) : ""}
                  </small>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {days.length > 0 && (
        <section>
          <label class="lbl">7 days</label>
          {days.slice(0, 8).map((d) => {
            const I = iconFor(d.short, d.day !== false);
            return (
              <div key={d.start} class="fc-day" title={d.text ?? d.short}>
                <span class="fc-name">{d.name}</span>
                <I size={18} />
                <span class="fc-short">{d.short}</span>
                <span class="fc-pop">{d.pop ? `${d.pop}%` : ""}</span>
                <span class="fc-temps">
                  <b>{tC(d.temp_f)}°</b>
                  {d.lo != null && <span class="muted"> / {tC(d.lo)}°</span>}
                </span>
                {d.wind_mph != null && <small class="muted fc-wind">{d.dir ?? ""} {wind(d.wind_mph)}</small>}
              </div>
            );
          })}
          {data?.attribution && <p class="muted small">{data.attribution}</p>}
        </section>
      )}
    </div>
  );
}
