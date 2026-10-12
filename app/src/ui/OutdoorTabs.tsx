// data 0.6: forecast center tabs "Health" (pollen for Europe, UV, air quality from the Open-Meteo
// Air Quality API) and "Stars" (cloud by level, darkness, moon, a seeing estimate from jet-level
// winds). All keyless, fetched directly from Open-Meteo.

import { useEffect, useMemo, useState } from "preact/hooks";
import { settings } from "../store";
import { LineChart, type LSeries } from "./Meteogram";
import { sunAlt, moonAlt, moonIllum, crossings, darkWindows } from "../astro";

const tzOpt = (tz?: string) => (settings.value.utc ? "UTC" : tz);
const hm = (t: number | undefined, tz?: string) => (t == null ? "—" : new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tzOpt(tz) }));

const cache = new Map<string, { at: number; v: any }>();
async function getJson(url: string, ttl = 30 * 60_000) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < ttl) return c.v;
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `Open-Meteo ${r.status}`;
    try {
      msg = (await r.json()).reason ?? msg;
    } catch {
      /* */
    }
    throw new Error(msg);
  }
  const v = await r.json();
  cache.set(url, { at: Date.now(), v });
  return v;
}
const times = (h: any): number[] => (h?.time ?? []).map((v: any) => (typeof v === "number" ? v * 1000 : Date.parse(v)));

function useFetch(url: string) {
  const [v, setV] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    getJson(url)
      .then(setV)
      .catch((e) => setErr(String(e.message ?? e)));
  }, [url]);
  return { v, err };
}

// ---------- Health ----------

const POLLEN = [
  { id: "birch_pollen", name: "Birch", color: "#a3e635", tree: true },
  { id: "alder_pollen", name: "Alder", color: "#84cc16", tree: true },
  { id: "olive_pollen", name: "Olive", color: "#65a30d", tree: true },
  { id: "grass_pollen", name: "Grass", color: "#facc15", tree: false },
  { id: "ragweed_pollen", name: "Ragweed", color: "#fb923c", tree: false },
  { id: "mugwort_pollen", name: "Mugwort", color: "#f472b6", tree: false },
];
/** grains/m³ → level (trees have higher thresholds than grasses and weeds) */
function pollenLevel(v: number | null | undefined, tree: boolean): [string, string] {
  if (v == null) return ["—", "#6b7280"];
  const t = tree ? [1, 10, 100, 1000] : [1, 5, 25, 100];
  if (v < t[0]) return ["None", "#6b7280"];
  if (v < t[1]) return ["Low", "#22c55e"];
  if (v < t[2]) return ["Moderate", "#facc15"];
  if (v < t[3]) return ["High", "#f97316"];
  return ["Very high", "#ef4444"];
}
function uvLevel(v: number | null | undefined): [string, string] {
  if (v == null) return ["—", "#6b7280"];
  if (v < 3) return ["Low", "#22c55e"];
  if (v < 6) return ["Moderate", "#facc15"];
  if (v < 8) return ["High", "#f97316"];
  if (v < 11) return ["Very high", "#ef4444"];
  return ["Extreme", "#a855f7"];
}
function aqiLevel(v: number | null | undefined, eu: boolean): [string, string] {
  if (v == null) return ["—", "#6b7280"];
  const t = eu ? [20, 40, 60, 80, 100] : [50, 100, 150, 200, 300];
  const n = ["Good", eu ? "Fair" : "Moderate", eu ? "Moderate" : "Unhealthy (sensitive)", eu ? "Poor" : "Unhealthy", eu ? "Very poor" : "Very unhealthy", eu ? "Extremely poor" : "Hazardous"];
  const c = ["#22c55e", "#facc15", "#f97316", "#ef4444", "#a855f7", "#7e0023"];
  const i = t.findIndex((x) => v <= x);
  return [n[i < 0 ? 5 : i], c[i < 0 ? 5 : i]];
}

/** index of the hour closest to now */
const nowIdx = (t: number[]) => {
  const now = Date.now();
  let b = 0;
  for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - now) < Math.abs(t[b] - now)) b = i;
  return b;
};

export function HealthTab({ lat, lon }: { lat: number; lon: number }) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=${POLLEN.map((p) => p.id).join(",")},uv_index,uv_index_clear_sky,us_aqi,european_aqi,pm2_5,ozone&timeformat=unixtime&timezone=auto&forecast_days=4`;
  const { v, err } = useFetch(url);
  const h = v?.hourly;
  const t = useMemo(() => times(h), [v]);
  if (err) return <div class="err-text">{err}</div>;
  if (!v) return <div class="muted">Loading air quality and pollen…</div>;
  const i0 = nowIdx(t);
  const pollen = POLLEN.filter((p) => (h[p.id] ?? []).some((x: any) => x != null));
  const peak = (id: string) => {
    const a = (h[id] ?? []).slice(i0, i0 + 24).filter((x: any) => x != null);
    return a.length ? Math.max(...a) : null;
  };
  const eu = lon > -30 && lon < 45 && lat > 30;
  const aqiKey = eu ? "european_aqi" : "us_aqi";
  const uvNow = h.uv_index?.[i0];
  const uvMax = Math.max(...(h.uv_index ?? []).slice(i0, i0 + 24).filter((x: any) => x != null), 0);
  const aqNow = h[aqiKey]?.[i0];
  const [uvL, uvC] = uvLevel(uvMax);
  const [aqL, aqC] = aqiLevel(aqNow, eu);
  const pSer: LSeries[] = pollen.map((p) => ({ id: p.id, name: p.name, color: p.color, v: h[p.id] }));
  return (
    <div class="d6-health">
      <div class="d6-cards">
        <div class="d6-card" style={{ borderColor: aqC }}>
          <small class="muted">Air quality now ({eu ? "European AQI" : "US AQI"})</small>
          <b style={{ color: aqC }}>{aqNow != null ? Math.round(aqNow) : "—"}</b>
          <span>{aqL}</span>
        </div>
        <div class="d6-card" style={{ borderColor: uvC }}>
          <small class="muted">UV index today (max)</small>
          <b style={{ color: uvC }}>{uvMax ? uvMax.toFixed(0) : "—"}</b>
          <span>
            {uvL}
            {uvNow != null ? ` · now ${uvNow.toFixed(0)}` : ""}
          </span>
        </div>
        {pollen.map((p) => {
          const pk = peak(p.id);
          const [l, c] = pollenLevel(pk, p.tree);
          return (
            <div key={p.id} class="d6-card" style={{ borderColor: c }}>
              <small class="muted">{p.name} pollen (24 h peak)</small>
              <b style={{ color: c }}>{pk != null ? Math.round(pk) : "—"}</b>
              <span>{l}</span>
            </div>
          );
        })}
      </div>
      {!pollen.length && <p class="muted small">Pollen forecasts (CAMS) cover Europe only.</p>}
      {pollen.length > 0 && <LineChart t={t} series={pSer} title="Pollen" unit="grains/m³" tz={v.timezone} zero />}
      <LineChart
        t={t}
        series={[
          { id: "uv", name: "UV index", color: "#facc15", v: h.uv_index ?? [] },
          { id: "uvc", name: "Clear sky", color: "#fde68a", v: h.uv_index_clear_sky ?? [], dash: true },
        ]}
        title="UV index"
        tz={v.timezone}
        zero
      />
      <LineChart
        t={t}
        series={[
          { id: "aqi", name: eu ? "European AQI" : "US AQI", color: "#f97316", v: h[aqiKey] ?? [] },
          { id: "pm", name: "PM2.5 µg/m³", color: "#a78bfa", v: h.pm2_5 ?? [] },
          { id: "o3", name: "Ozone µg/m³", color: "#22d3ee", v: h.ozone ?? [], dash: true },
        ]}
        title="Air quality"
        tz={v.timezone}
        zero
      />
      <p class="muted small">Open-Meteo Air Quality (CAMS). Pollen in grains/m³; UV index is for clear-sky noon at its peak.</p>
    </div>
  );
}

// ---------- Stars ----------

/** jet-level wind (m/s) → seeing 1 (bad) … 5 (excellent) */
export function seeing(ms: number | null | undefined): number | null {
  if (ms == null) return null;
  if (ms < 10) return 5;
  if (ms < 20) return 4;
  if (ms < 30) return 3;
  if (ms < 45) return 2;
  return 1;
}
const SEEING = ["", "Bad", "Poor", "Average", "Good", "Excellent"];

export function StarsTab({ lat, lon }: { lat: number; lon: number }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_250hPa,relative_humidity_2m,visibility&wind_speed_unit=ms&timeformat=unixtime&timezone=auto&forecast_days=4`;
  const { v, err } = useFetch(url);
  const h = v?.hourly;
  const t = useMemo(() => times(h), [v]);
  // nights: from local noon today, three nights
  const nights = useMemo(() => {
    if (!t.length) return [];
    const out: { noon: number; dark: { start: number; end: number; moonUp: boolean }[]; illum: ReturnType<typeof moonIllum>; mr?: number; ms?: number; dusk?: number; dawn?: number }[] = [];
    const n0 = Date.now() - (sunAlt(Date.now(), lat, lon) < 0 ? 12 * 3600_000 : 0);
    for (let k = 0; k < 3; k++) {
      const a = n0 + k * 86400_000;
      const b = a + 86400_000;
      const dark = darkWindows(lat, lon, a, b);
      const astro = crossings((x) => sunAlt(x, lat, lon), a, b, -18);
      const moon = crossings((x) => moonAlt(x, lat, lon), a, b, 0.13);
      const mid = dark[0] ? (dark[0].start + dark[dark.length - 1].end) / 2 : a + 12 * 3600_000;
      out.push({ noon: a, dark, illum: moonIllum(mid), mr: moon.up[0], ms: moon.down[0], dusk: astro.down[0], dawn: astro.up.find((x) => x > (astro.down[0] ?? a)) });
    }
    return out;
  }, [t, lat, lon]);
  if (err) return <div class="err-text">{err}</div>;
  if (!v) return <div class="muted">Loading sky forecast…</div>;
  const marks = nights.flatMap((n) => n.dark.map((d) => ({ t0: d.start, t1: d.end, color: d.moonUp ? "rgba(250,204,21,.07)" : "rgba(99,102,241,.16)" })));
  const at = (arr: any[], s: number, e: number) => {
    const xs = t.map((tt, i) => (tt >= s && tt < e ? arr?.[i] : null)).filter((x) => x != null) as number[];
    return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
  };
  const jet = (h.wind_speed_250hPa ?? []) as (number | null)[];
  return (
    <div class="d6-stars">
      <div class="d6-nights">
        {nights.map((n, k) => {
          const s = n.dark[0]?.start;
          const e = n.dark[n.dark.length - 1]?.end;
          const darkH = n.dark.reduce((p, d) => p + (d.end - d.start), 0) / 3600_000;
          const moonless = n.dark.filter((d) => !d.moonUp).reduce((p, d) => p + (d.end - d.start), 0) / 3600_000;
          const cloud = s != null ? at(h.cloud_cover, s, e!) : null;
          const sv = s != null ? seeing(at(jet, s, e!)) : null;
          const score = cloud == null ? null : Math.round(Math.max(0, 100 - cloud) * (0.55 + 0.45 * (moonless / Math.max(darkH, 0.1))) * (sv ? 0.8 + sv * 0.04 : 1));
          const sc = score == null ? "#6b7280" : score > 70 ? "#22c55e" : score > 40 ? "#facc15" : "#ef4444";
          return (
            <div key={k} class="d6-night">
              <div class="row">
                <b>{new Date(n.noon + 6 * 3600_000).toLocaleDateString(undefined, { weekday: "long", timeZone: tzOpt(v.timezone) })} night</b>
                <span class="d6-score" style={{ background: sc }} title="Overall: clear sky, moonless darkness and seeing">
                  {score ?? "—"}
                </span>
              </div>
              <MoonIcon phase={n.illum.phase} />
              <div class="d6-kv">
                <span>Moon</span>
                <b>
                  {n.illum.name} · {Math.round(n.illum.fraction * 100)}%
                </b>
                <span>Moonrise / set</span>
                <b>
                  {hm(n.mr, v.timezone)} / {hm(n.ms, v.timezone)}
                </b>
                <span>Astronomical dark</span>
                <b>{n.dark.length ? `${hm(n.dusk ?? s, v.timezone)} – ${hm(n.dawn ?? e, v.timezone)}` : "None (twilight all night)"}</b>
                <span>Dark hours</span>
                <b>
                  {darkH.toFixed(1)} h · {moonless.toFixed(1)} h moonless
                </b>
                <span>Cloud (dark hours)</span>
                <b>{cloud != null ? `${Math.round(cloud)}%` : "—"}</b>
                <span>Seeing</span>
                <b>{sv ? `${SEEING[sv]} (${sv}/5)` : "—"}</b>
              </div>
            </div>
          );
        })}
      </div>
      <LineChart
        t={t}
        series={[
          { id: "low", name: "Low cloud", color: "#e5e7eb", v: h.cloud_cover_low },
          { id: "mid", name: "Mid cloud", color: "#93c5fd", v: h.cloud_cover_mid },
          { id: "high", name: "High cloud", color: "#c4b5fd", v: h.cloud_cover_high },
          { id: "tot", name: "Total", color: "#fbbf24", v: h.cloud_cover, dash: true },
        ]}
        title="Cloud cover by level"
        unit="%"
        fmt={(x) => x.toFixed(0)}
        fixed={[0, 100]}
        tz={v.timezone}
        marks={marks}
        h={160}
      />
      <LineChart
        t={t}
        series={[{ id: "jet", name: "250 hPa wind", color: "#38bdf8", v: jet.map((x) => (x == null ? null : x * 1.94384)) }]}
        title="Jet-level wind (seeing: under 20 kt excellent, over 85 kt bad)"
        unit="kt"
        tz={v.timezone}
        marks={marks}
        zero
      />
      <p class="muted small">Blue bands: astronomical darkness with the moon down; yellow: moon up. Moon and darkness computed in the app; clouds and winds from Open-Meteo.</p>
    </div>
  );
}

function MoonIcon({ phase }: { phase: number }) {
  // lit part: an ellipse terminator; phase 0 new, 0.5 full
  const r = 16;
  const k = Math.cos(phase * 2 * Math.PI); // 1 new … -1 full
  const waxing = phase < 0.5;
  const rx = Math.abs(k) * r;
  const lit = `M ${r} 0 A ${r} ${r} 0 0 ${waxing ? 1 : 0} ${r} ${2 * r} A ${rx} ${r} 0 0 ${(k > 0) === waxing ? 0 : 1} ${r} 0 Z`;
  return (
    <svg class="d6-moon" viewBox={`-1 -1 ${2 * r + 2} ${2 * r + 2}`} width="34" height="34">
      <circle cx={r} cy={r} r={r} fill="#1f2937" stroke="#4b5563" />
      <path d={lit} fill="#f5f5dc" />
    </svg>
  );
}
