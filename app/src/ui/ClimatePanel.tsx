// data 0.6: climate for a point from the server's NOAA ACIS proxy (/api/climate): the nearest
// station, today's normals and records, the last 30 days against normal, and month-to-date
// departures. The parser is defensive (field names vary between ACIS products).

import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { settings } from "../store";
import { LineChart } from "./Meteogram";

// ---------- parsing ----------

export interface ClimDay {
  t: number;
  hi?: number | null;
  lo?: number | null;
  nhi?: number | null;
  nlo?: number | null;
  pcp?: number | null;
  npcp?: number | null;
  snow?: number | null;
}
export interface Climate {
  station: { name: string; id?: string; dist?: string; years?: string };
  /** °F and inches internally */
  today: { nhi?: number | null; nlo?: number | null; rhi?: number | null; rhiY?: string; rlo?: number | null; rloY?: string; rpcp?: number | null; rpcpY?: string; npcp?: number | null; hi?: number | null; lo?: number | null };
  days: ClimDay[];
  mtd: { hiDep?: number | null; loDep?: number | null; avgDep?: number | null; pcp?: number | null; npcp?: number | null; pcpDep?: number | null; snow?: number | null; nsnow?: number | null };
  ytd?: { pcp?: number | null; npcp?: number | null };
  metric: boolean;
  recordsToday?: boolean;
}

const lc = (o: any) => {
  const m: Record<string, any> = {};
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) m[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
  return m;
};
/** first defined field among several spellings (case / separators ignored) */
function pick(o: any, ...names: string[]): any {
  const m = lc(o);
  for (const n of names) {
    const v = m[n.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (v !== undefined && v !== null && v !== "" && v !== "M") return v;
  }
  return undefined;
}
/** ACIS values: numbers, "T" (trace), "M" (missing), "S"/"A" flags, [value, year] pairs */
function num(v: any): number | null {
  if (v == null) return null;
  if (Array.isArray(v)) return num(v[0]);
  if (typeof v === "object") return num(pick(v, "value", "v", "val"));
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === "T") return 0.001;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function yearOf(v: any, ...alt: any[]): string | undefined {
  if (Array.isArray(v) && v[1] != null) return String(v[1]).slice(0, 4);
  if (v && typeof v === "object") {
    const y = pick(v, "year", "yr", "date");
    if (y != null) return String(y).slice(0, 4);
  }
  for (const a of alt) if (a != null) return String(a).slice(0, 4);
}
const tOf = (v: any) => {
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00Z`) : Date.parse(s);
};

export function parseClimate(j: any): Climate {
  const st = pick(j, "station", "meta", "site") ?? {};
  const name = typeof st === "string" ? st : pick(st, "name", "station_name") ?? pick(j, "station_name", "name") ?? "Nearest station";
  const sid = typeof st === "object" ? pick(st, "id", "sid", "sids", "uid") : undefined;
  const dist = typeof st === "object" ? pick(st, "dist_mi", "distance_mi", "dist_km", "distance_km", "dist", "distance") : pick(j, "dist_km", "dist_mi");
  const distUnit = typeof st === "object" && (pick(st, "dist_mi", "distance_mi") != null || pick(j, "dist_mi") != null) ? "mi" : "km";
  const units = String(pick(j, "units", "unit") ?? "").toLowerCase();
  const metric = /metric|°c|^c$|si/.test(units);
  const todayRaw = pick(j, "today", "normals", "normal", "daily_normal") ?? {};
  // server: today = { date, normal: { maxt, mint, pcpn }, records: { maxt|lomax|mint|himin|pcpn|snow: { value, year } } }
  const tn = pick(todayRaw, "normal", "normals");
  const today0 = tn && typeof tn === "object" ? tn : todayRaw;
  const rec = pick(j, "records", "record", "extremes") ?? pick(todayRaw, "records") ?? {};
  const rhiRaw = pick(rec, "hi", "high", "maxt", "max", "record_hi", "record_high") ?? pick(today0, "record_hi", "record_high", "rhi", "record_max");
  const rloRaw = pick(rec, "lo", "low", "mint", "min", "record_lo", "record_low") ?? pick(today0, "record_lo", "record_low", "rlo", "record_min");
  const rpRaw = pick(rec, "pcpn", "precip", "pcp", "record_pcpn", "record_precip") ?? pick(today0, "record_pcpn", "record_precip");
  const today: Climate["today"] = {
    nhi: num(pick(today0, "normal_hi", "normal_high", "nhi", "hi", "high", "maxt", "max")),
    nlo: num(pick(today0, "normal_lo", "normal_low", "nlo", "lo", "low", "mint", "min")),
    npcp: num(pick(today0, "normal_pcpn", "normal_precip", "pcpn", "precip")),
    rhi: num(rhiRaw),
    rhiY: yearOf(rhiRaw, pick(rec, "hi_year", "high_year", "maxt_year"), pick(today0, "record_hi_year", "record_high_year")),
    rlo: num(rloRaw),
    rloY: yearOf(rloRaw, pick(rec, "lo_year", "low_year", "mint_year"), pick(today0, "record_lo_year", "record_low_year")),
    rpcp: num(rpRaw),
    rpcpY: yearOf(rpRaw, pick(rec, "pcpn_year", "precip_year"), pick(today0, "record_pcpn_year")),
  };
  const list = pick(j, "recent", "days", "daily", "obs", "last30", "data") ?? [];
  const days: ClimDay[] = [];
  if (Array.isArray(list))
    for (const r of list) {
      // ACIS arrays: [date, maxt, mint, pcpn, snow, ...]
      if (Array.isArray(r)) {
        days.push({ t: tOf(r[0]), hi: num(r[1]), lo: num(r[2]), pcp: num(r[3]), snow: num(r[4]) });
        continue;
      }
      days.push({
        t: tOf(pick(r, "date", "day", "t", "time")),
        hi: num(pick(r, "hi", "high", "maxt", "max", "tmax")),
        lo: num(pick(r, "lo", "low", "mint", "min", "tmin")),
        nhi: num(pick(r, "normal_hi", "normal_high", "nhi", "norm_maxt", "normal_maxt")),
        nlo: num(pick(r, "normal_lo", "normal_low", "nlo", "norm_mint", "normal_mint")),
        pcp: num(pick(r, "pcpn", "precip", "pcp", "prcp")),
        npcp: num(pick(r, "normal_pcpn", "normal_precip", "npcp")),
        snow: num(pick(r, "snow", "snwd_new", "snowfall")),
      });
    }
  days.sort((a, b) => a.t - b.t);
  const mt = pick(j, "mtd", "month", "month_to_date", "monthtodate") ?? {};
  const avg = (k: "hi" | "lo" | "nhi" | "nlo") => {
    const m0 = new Date();
    const xs = days.filter((d) => new Date(d.t).getUTCMonth() === m0.getUTCMonth() && new Date(d.t).getUTCFullYear() === m0.getUTCFullYear()).map((d) => d[k]).filter((x) => x != null) as number[];
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sum = (k: "pcp" | "npcp" | "snow") => {
    const m0 = new Date();
    const xs = days.filter((d) => new Date(d.t).getUTCMonth() === m0.getUTCMonth()).map((d) => d[k]);
    return xs.some((x) => x != null) ? xs.reduce((a: number, b) => a + (b ?? 0), 0) : null;
  };
  const dH = avg("hi") != null && avg("nhi") != null ? avg("hi")! - avg("nhi")! : null;
  const dL = avg("lo") != null && avg("nlo") != null ? avg("lo")! - avg("nlo")! : null;
  const mtd: Climate["mtd"] = {
    hiDep: num(pick(mt, "dep_maxt", "hi_dep", "high_dep", "maxt_dep", "hidep", "max_departure")) ?? dH,
    loDep: num(pick(mt, "dep_mint", "lo_dep", "low_dep", "mint_dep", "lodep", "min_departure")) ?? dL,
    avgDep: num(pick(mt, "avg_dep", "avgt_dep", "mean_dep", "temp_dep", "departure")) ?? (dH != null && dL != null ? (dH + dL) / 2 : null),
    pcp: num(pick(mt, "pcpn", "precip", "pcp")) ?? sum("pcp"),
    npcp: num(pick(mt, "normal_pcpn", "normal_precip", "npcp", "pcpn_normal", "precip_normal")) ?? sum("npcp"),
    pcpDep: num(pick(mt, "dep_pcpn", "pcpn_dep", "precip_dep", "pcpdep")),
    snow: num(pick(mt, "snow", "snowfall")),
    nsnow: num(pick(mt, "normal_snow", "snow_normal")),
  };
  if (mtd.pcpDep == null && mtd.pcp != null && mtd.npcp != null) mtd.pcpDep = mtd.pcp - mtd.npcp;
  const yt = pick(j, "ytd", "year_to_date", "year");
  const last = days[days.length - 1];
  today.hi = last?.hi;
  today.lo = last?.lo;
  return {
    station: { name: String(name), id: Array.isArray(sid) ? String(sid[0]) : sid != null ? String(sid) : undefined, dist: dist != null ? `${Math.round(+dist)} ${distUnit}` : undefined, years: pick(j, "por", "period") ?? (typeof st === "object" ? (pick(st, "por_start") ? `since ${String(pick(st, "por_start")).slice(0, 4)}` : pick(st, "por", "period", "valid_daterange")) : undefined) },
    today,
    days,
    mtd,
    ytd: yt ? { pcp: num(pick(yt, "pcpn", "precip")), npcp: num(pick(yt, "normal_pcpn", "normal_precip", "npcp")) } : undefined,
    metric,
    recordsToday: !!pick(j, "records_today", "records_map"),
  };
}

// ---------- display ----------

const U = () => settings.value.units;
function T(f: number | null | undefined, metric: boolean, dep = false): string {
  if (f == null) return "—";
  const c = metric ? f : dep ? f / 1.8 : (f - 32) / 1.8;
  const v = U().temp === "F" ? (metric ? (dep ? f * 1.8 : f * 1.8 + 32) : f) : c;
  const s = `${dep && v > 0 ? "+" : ""}${Math.round(v * (dep ? 10 : 1)) / (dep ? 10 : 1)}°`;
  return s;
}
function P(inch: number | null | undefined, metric: boolean, dep = false): string {
  if (inch == null) return "—";
  if (inch > 0 && inch < 0.005 && !dep) return "T";
  const inches = metric ? inch / 25.4 : inch;
  const sgn = dep && inches > 0 ? "+" : "";
  return U().precip === "in" ? `${sgn}${inches.toFixed(2)} in` : `${sgn}${(inches * 25.4).toFixed(1)} mm`;
}
const tC = (f: number | null | undefined, metric: boolean) => (f == null ? null : U().temp === "F" ? (metric ? f * 1.8 + 32 : f) : metric ? f : (f - 32) / 1.8);
const pC = (x: number | null | undefined, metric: boolean) => (x == null ? null : U().precip === "in" ? (metric ? x / 25.4 : x) : metric ? x : x * 25.4);

const cache = new Map<string, { at: number; v: any }>();

export function ClimatePanel({ lat, lon }: { lat: number; lon: number }) {
  const [raw, setRaw] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const c = cache.get(k);
    if (c && Date.now() - c.at < 30 * 60_000) return setRaw(c.v);
    setRaw(null);
    setErr(null);
    api
      .get(`/api/climate?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`)
      .then((v) => (cache.set(k, { at: Date.now(), v }), setRaw(v)))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [lat, lon]);
  const c = useMemo(() => (raw ? parseClimate(raw) : null), [raw]);
  if (err) return <div class="err-text">Climate data unavailable: {err}</div>;
  if (!c) return <div class="muted">Loading climate (NOAA ACIS)…</div>;
  const m = c.metric;
  const d30 = c.days.slice(-30);
  const t = d30.map((d) => d.t);
  const hasNormals = d30.some((d) => d.nhi != null);
  const dep = (x: number | null | undefined) => (x == null ? "" : x > 0.05 ? "warm" : x < -0.05 ? "cold" : "");
  return (
    <div class="d6-clim">
      <div class="d6-clim-head">
        <div>
          <b>{c.station.name}</b>
          <small class="muted">
            {[c.station.id, c.station.dist ? `${c.station.dist} away` : "", c.station.years ? `records ${Array.isArray(c.station.years) ? c.station.years.join("–") : c.station.years}` : ""].filter(Boolean).join(" · ")}
          </small>
        </div>
      </div>
      <div class="d6-cards">
        <div class="d6-card">
          <small class="muted">Normal today</small>
          <b>
            <span class="hi">{T(c.today.nhi, m)}</span> / <span class="lo">{T(c.today.nlo, m)}</span>
          </b>
          {c.today.npcp != null && <span>precip {P(c.today.npcp, m)}</span>}
        </div>
        <div class="d6-card">
          <small class="muted">Record high</small>
          <b class="hi">{T(c.today.rhi, m)}</b>
          <span>{c.today.rhiY ?? ""}</span>
        </div>
        <div class="d6-card">
          <small class="muted">Record low</small>
          <b class="lo">{T(c.today.rlo, m)}</b>
          <span>{c.today.rloY ?? ""}</span>
        </div>
        {c.today.rpcp != null && (
          <div class="d6-card">
            <small class="muted">Record precip</small>
            <b>{P(c.today.rpcp, m)}</b>
            <span>{c.today.rpcpY ?? ""}</span>
          </div>
        )}
        <div class="d6-card">
          <small class="muted">Month to date</small>
          <b class={dep(c.mtd.avgDep)}>{T(c.mtd.avgDep, m, true)}</b>
          <span>
            highs {T(c.mtd.hiDep, m, true)} · lows {T(c.mtd.loDep, m, true)}
          </span>
        </div>
        <div class="d6-card">
          <small class="muted">Precip this month</small>
          <b>{P(c.mtd.pcp, m)}</b>
          <span>
            {c.mtd.npcp != null ? `normal ${P(c.mtd.npcp, m)}` : ""}
            {c.mtd.pcpDep != null ? ` · ${P(c.mtd.pcpDep, m, true)}` : ""}
          </span>
        </div>
        {c.ytd?.pcp != null && (
          <div class="d6-card">
            <small class="muted">Precip this year</small>
            <b>{P(c.ytd.pcp, m)}</b>
            <span>{c.ytd.npcp != null ? `normal ${P(c.ytd.npcp, m)}` : ""}</span>
          </div>
        )}
      </div>
      {d30.length > 1 && (
        <>
          <LineChart
            t={t}
            daily
            title="Last 30 days"
            unit={`°${U().temp}`}
            band={hasNormals ? { lo: d30.map((d) => tC(d.nlo, m)), hi: d30.map((d) => tC(d.nhi, m)), color: "rgba(148,163,184,.25)", name: "Normal" } : undefined}
            series={[
              { id: "hi", name: "High", color: "#f87171", v: d30.map((d) => tC(d.hi, m)) },
              { id: "lo", name: "Low", color: "#60a5fa", v: d30.map((d) => tC(d.lo, m)) },
            ]}
            h={170}
          />
          <LineChart t={t} daily title="Precipitation" unit={U().precip} zero fmt={(v) => v.toFixed(U().precip === "in" ? 2 : 1)} series={[{ id: "p", name: "Precip", color: "#38bdf8", v: d30.map((d) => pC(d.pcp, m)), bar: true }]} h={115} />
          <div class="fcc-table-wrap d6-clim-table">
            <table class="fcc-table">
              <thead>
                <tr>
                  <th class="l">Date</th>
                  <th>High</th>
                  <th>Low</th>
                  {hasNormals && <th>Normal</th>}
                  {hasNormals && <th>Dep.</th>}
                  <th>Precip</th>
                  {d30.some((d) => d.snow) && <th>Snow</th>}
                </tr>
              </thead>
              <tbody>
                {[...d30].reverse().map((d) => {
                  const dp = d.hi != null && d.lo != null && d.nhi != null && d.nlo != null ? (d.hi + d.lo - d.nhi - d.nlo) / 2 : null;
                  return (
                    <tr key={d.t}>
                      <td class="l">{new Date(d.t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</td>
                      <td class="hi">{T(d.hi, m)}</td>
                      <td class="lo">{T(d.lo, m)}</td>
                      {hasNormals && (
                        <td class="muted">
                          {T(d.nhi, m)}/{T(d.nlo, m)}
                        </td>
                      )}
                      {hasNormals && <td class={dep(dp)}>{T(dp, m, true)}</td>}
                      <td>{P(d.pcp, m)}</td>
                      {d30.some((x) => x.snow) && <td>{d.snow ? (U().precip === "in" ? `${(m ? d.snow / 25.4 : d.snow).toFixed(1)}"` : `${((m ? d.snow : d.snow * 25.4) / 10).toFixed(1)} cm`) : ""}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p class="muted small">NOAA ACIS (RCC). Normals 1991–2020. Departures are from the daily normal.</p>
    </div>
  );
}
