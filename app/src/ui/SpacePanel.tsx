// data 0.6: space weather window — SDO / SOHO LASCO images (auto-refresh), solar wind and X-ray
// mini charts, SWPC alerts and the aurora forecast timeline, from the server's /api/ovl/swpc
// (with public NOAA/NASA image URLs as a fallback). Opened from the Aurora layer's settings.

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Orbit, RefreshCw } from "lucide-preact";
import { api } from "../api";
import { settings } from "../store";
import { CenterModal } from "./CenterModal";
import { LineChart } from "./Meteogram";

export const spaceOpen = signal(false);
(window as any).__tbwSpace = spaceOpen; // console / screenshots

const FALLBACK_IMAGES: { name: string; url: string }[] = [
  { name: "SDO AIA 193 Å", url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg" },
  { name: "SDO AIA 304 Å", url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0304.jpg" },
  { name: "SDO HMI sunspots", url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_HMIIF.jpg" },
  { name: "LASCO C2", url: "https://soho.nascom.nasa.gov/data/realtime/c2/512/latest.jpg" },
  { name: "LASCO C3", url: "https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg" },
  { name: "Aurora (north)", url: "https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg" },
];

const lc = (o: any) => {
  const m: Record<string, any> = {};
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) m[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
  return m;
};
function pick(o: any, ...names: string[]): any {
  const m = lc(o);
  for (const n of names) {
    const v = m[n.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (v !== undefined && v !== null && v !== "") return v;
  }
}
const num = (v: any) => (v == null || v === "" ? null : Number.isFinite(+v) ? +v : null);
const tOf = (v: any) => (typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(String(v)) ? String(v) : `${String(v).replace(" ", "T")}Z`));
function abs(url: string): string {
  if (!url.startsWith("/")) return url;
  const tok = api.token ? `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(api.token)}` : "";
  return `${api.base}${url}${tok}`;
}
/** series from [{time, value…}] or [[time, value…]] (SWPC products put a header row first) */
function series(raw: any, ...keys: string[]): { t: number[]; v: Record<string, (number | null)[]> } {
  const out = { t: [] as number[], v: Object.fromEntries(keys.map((k) => [k, [] as (number | null)[]])) };
  if (!Array.isArray(raw)) return out;
  let rows = raw;
  let header: string[] | null = null;
  if (Array.isArray(rows[0]) && rows[0].some((x: any) => typeof x === "string" && /time/i.test(x))) {
    header = rows[0].map((x: any) => String(x).toLowerCase());
    rows = rows.slice(1);
  }
  for (const r of rows) {
    let t: number;
    if (Array.isArray(r)) {
      t = tOf(r[0]);
      for (const k of keys) {
        const i = header ? header.findIndex((h) => h.replace(/[^a-z0-9]/g, "").includes(k)) : keys.indexOf(k) + 1;
        out.v[k].push(num(r[i]));
      }
    } else {
      t = tOf(pick(r, "t", "time", "time_tag", "date"));
      for (const k of keys) out.v[k].push(num(pick(r, k, `${k}_kms`, `${k}_nt`, k === "speed" ? "v" : k, k === "flux" ? "value" : k)));
    }
    out.t.push(t);
  }
  return out;
}
export function xrayClass(flux: number | null | undefined): string {
  if (flux == null || !(flux > 0)) return "—";
  const cls = [["X", 1e-4], ["M", 1e-5], ["C", 1e-6], ["B", 1e-7], ["A", 1e-8]] as const;
  for (const [c, f] of cls) if (flux >= f) return `${c}${(flux / f).toFixed(1)}`;
  return "A0";
}

export interface Swpc {
  wind: { t: number[]; speed: (number | null)[]; bz: (number | null)[]; density: (number | null)[] };
  xray: { t: number[]; flux: (number | null)[] };
  xclass: string;
  kp?: number | null;
  /** NOAA G scale now (0–5) */
  g?: number | null;
  alerts: { t: number; title: string; text: string }[];
  images: { name: string; url: string }[];
  aurora: { t: number; kp?: number | null; label?: string; url?: string }[];
}
export function parseSwpc(j: any): Swpc {
  const w = pick(j, "solar_wind", "wind", "plasma") ?? {};
  const ws = Array.isArray(w) ? series(w, "speed", "bz", "density") : series(pick(w, "series", "data", "points") ?? [], "speed", "bz", "density");
  // server: solar_wind.bz_series [{t, bz, bt}] (separate cadence from plasma) → align by time
  const bzs = !Array.isArray(w) ? pick(w, "bz_series") : null;
  if (Array.isArray(bzs) && bzs.length && !ws.v.bz.some((x) => x != null)) {
    const m = series(bzs, "bz");
    ws.v.bz = ws.t.map((t) => {
      let best: number | null = null, bd = 6 * 60_000;
      m.t.forEach((u, i) => Math.abs(u - t) <= bd && ((bd = Math.abs(u - t)), (best = m.v.bz[i])));
      return best;
    });
  }
  const mag = pick(j, "mag", "magnetic");
  if (mag && !ws.v.bz.some((x) => x != null)) {
    const ms = series(Array.isArray(mag) ? mag : pick(mag, "series", "data") ?? [], "bz");
    if (ms.t.length === ws.t.length) ws.v.bz = ms.v.bz;
  }
  const xr = pick(j, "xray", "xrays", "x_ray");
  const xs = series(Array.isArray(xr) ? xr : pick(xr, "series", "data") ?? [], "flux");
  const lastFlux = [...xs.v.flux].reverse().find((x) => x != null);
  const xclass = String(pick(xr ?? {}, "class", "current", "flare") ?? pick(j, "xray_class", "xclass") ?? xrayClass(lastFlux));
  const al = pick(j, "alerts", "messages") ?? [];
  const alerts = (Array.isArray(al) ? al : []).map((a: any) => {
    const text = String(pick(a, "message", "text", "body") ?? (typeof a === "string" ? a : ""));
    const title = String(pick(a, "title", "headline", "product_id") ?? text.match(/(ALERT|WARNING|WATCH|SUMMARY|EXTENDED WARNING)[^\r\n]*/)?.[0] ?? "Alert");
    return { t: tOf(pick(a, "issue_datetime", "issued", "time", "t")), title, text };
  });
  const im = pick(j, "images", "imagery") ?? [];
  let images: { name: string; url: string }[] = [];
  if (Array.isArray(im)) images = im.map((x: any, i: number) => (typeof x === "string" ? { name: `Image ${i + 1}`, url: x } : { name: String(pick(x, "name", "title", "id") ?? `Image ${i + 1}`), url: String(pick(x, "url", "src", "href") ?? "") })).filter((x) => x.url);
  else if (im && typeof im === "object")
    // server: { sdo: [{name, url}], lasco: [{name, url}], suvi: {name, url} }
    for (const [k, v] of Object.entries(im)) {
      for (const x of Array.isArray(v) ? v : [v])
        if (typeof x === "string") images.push({ name: k.replace(/_/g, " ").toUpperCase(), url: x });
        else if (x && typeof x === "object" && pick(x, "url")) images.push({ name: String(pick(x, "name", "id") ?? k), url: String(pick(x, "url")) });
    }
  let au = pick(j, "aurora", "aurora_timeline", "kp_forecast", "forecast") ?? [];
  const anim = pick(pick(j, "animations") ?? {}, "ovation_north");
  if ((!Array.isArray(au) || !au.length) && Array.isArray(anim) && anim.length) {
    // server: OVATION frames [{url, time}] (no Kp) → at most 24 evenly spaced frames
    const step = Math.max(1, Math.ceil(anim.length / 24));
    au = anim.filter((_: any, i: number) => (anim.length - 1 - i) % step === 0);
  }
  const auList = Array.isArray(au) ? au : pick(au, "timeline", "series", "frames") ?? [];
  const aurora = (Array.isArray(auList) ? auList : []).map((x: any) => (Array.isArray(x) ? { t: tOf(x[0]), kp: num(x[1]), label: x[2] != null ? String(x[2]) : undefined } : { t: tOf(pick(x, "t", "time", "time_tag")), kp: num(pick(x, "kp", "value", "kp_index")), label: pick(x, "label", "observed", "scale"), url: pick(x, "url", "image") }));
  return {
    wind: { t: ws.t, speed: ws.v.speed, bz: ws.v.bz, density: ws.v.density },
    xray: { t: xs.t, flux: xs.v.flux },
    xclass,
    kp: num(pick(j, "kp", "kp_now")),
    g: num(pick(pick(pick(pick(j, "scales") ?? {}, "0") ?? {}, "G") ?? {}, "Scale")),
    alerts: alerts.filter((a) => a.text || a.title).sort((a, b) => b.t - a.t),
    images: images.length ? images : FALLBACK_IMAGES,
    aurora: aurora.filter((a) => Number.isFinite(a.t)),
  };
}

const tz = () => (settings.value.utc ? "UTC" : undefined);

export function SpacePanel() {
  if (!spaceOpen.value) return null;
  return <SpaceBody />;
}

function SpaceBody() {
  const [raw, setRaw] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [big, setBig] = useState<string | null>(null);
  const [aIdx, setAIdx] = useState<number | null>(null);
  const load = () => {
    setErr(null);
    api
      .get("/api/ovl/swpc")
      .then(setRaw)
      .catch((e) => (setErr(String(e.message ?? e)), setRaw((r: any) => r ?? {})));
  };
  useEffect(() => {
    load();
    const t = setInterval(() => (load(), setTick((k) => k + 1)), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  const s = useMemo(() => (raw ? parseSwpc(raw) : null), [raw]);
  const lastSpeed = s ? [...s.wind.speed].reverse().find((x) => x != null) : null;
  const lastBz = s ? [...s.wind.bz].reverse().find((x) => x != null) : null;
  const bust = (u: string) => (u.startsWith("data:") ? u : `${abs(u)}${abs(u).includes("?") ? "&" : "?"}r=${tick}`);
  const kpCol = (k: number | null | undefined) => (k == null ? "#6b7280" : k >= 7 ? "#ef4444" : k >= 5 ? "#f97316" : k >= 4 ? "#facc15" : "#22c55e");
  const aur = s?.aurora ?? [];
  const ai0 = aur.findIndex((a) => a.t >= Date.now());
  const ai = aIdx ?? (ai0 < 0 ? aur.length - 1 : ai0);
  return (
    <CenterModal
      cls="d6-space"
      icon={<Orbit size={20} />}
      title="Space weather"
      sub="NOAA SWPC · NASA SDO · ESA/NASA SOHO"
      onClose={() => (spaceOpen.value = false)}
      actions={
        <button class="icon-btn" title="Refresh" onClick={() => (load(), setTick((k) => k + 1))}>
          <RefreshCw size={15} />
        </button>
      }
    >
      {err && <div class="err-text small">Server data unavailable ({err}); images only.</div>}
      {s && (
        <>
          <div class="d6-cards">
            <div class="d6-card">
              <small class="muted">Solar wind</small>
              <b>{lastSpeed != null ? `${Math.round(lastSpeed)} km/s` : "—"}</b>
              <span>{lastSpeed == null ? "" : lastSpeed > 600 ? "Fast" : lastSpeed > 450 ? "Elevated" : "Normal"}</span>
            </div>
            <div class="d6-card" style={{ borderColor: lastBz != null && lastBz < -5 ? "#f97316" : undefined }}>
              <small class="muted">Bz (IMF)</small>
              <b>{lastBz != null ? `${lastBz.toFixed(1)} nT` : "—"}</b>
              <span>{lastBz == null ? "" : lastBz < -5 ? "South: aurora favourable" : lastBz < 0 ? "Slightly south" : "North"}</span>
            </div>
            <div class="d6-card" style={{ borderColor: /^[XM]/.test(s.xclass) ? "#ef4444" : undefined }}>
              <small class="muted">X-ray flux</small>
              <b>{s.xclass}</b>
              <span>{/^X/.test(s.xclass) ? "Major flare" : /^M/.test(s.xclass) ? "Moderate flare" : "Quiet"}</span>
            </div>
            {s.kp == null && s.g != null && (
              <div class="d6-card" style={{ borderColor: s.g >= 1 ? kpCol(s.g + 4) : undefined }}>
                <small class="muted">Geomagnetic</small>
                <b style={{ color: kpCol(s.g >= 1 ? s.g + 4 : 0) }}>G{s.g}</b>
                <span>{s.g >= 1 ? "Storm" : "No storm"}</span>
              </div>
            )}
            {s.kp != null && (
              <div class="d6-card" style={{ borderColor: kpCol(s.kp) }}>
                <small class="muted">Kp now</small>
                <b style={{ color: kpCol(s.kp) }}>{s.kp.toFixed(1)}</b>
                <span>{s.kp >= 5 ? `G${Math.min(5, Math.floor(s.kp) - 4)} storm` : "Below storm level"}</span>
              </div>
            )}
          </div>
          <div class="d6-space-imgs">
            {s.images.map((im) => (
              <figure key={im.url} onClick={() => setBig(big === im.url ? null : im.url)} class={big === im.url ? "big" : ""}>
                <img src={bust(im.url)} alt={im.name} loading="lazy" />
                <figcaption>{im.name}</figcaption>
              </figure>
            ))}
          </div>
          <div class="d6-two">
            {s.wind.t.length > 1 && (
              <div>
                <LineChart t={s.wind.t} series={[{ id: "sp", name: "Speed", color: "#fbbf24", v: s.wind.speed }]} title="Solar wind speed" unit="km/s" tz={tz()} h={110} />
                <LineChart t={s.wind.t} series={[{ id: "bz", name: "Bz", color: "#f472b6", v: s.wind.bz }]} title="Bz" unit="nT" tz={tz()} h={100} zero />
              </div>
            )}
            {s.xray.t.length > 1 && (
              <div>
                <LineChart
                  t={s.xray.t}
                  series={[{ id: "x", name: "X-ray", color: "#f87171", v: s.xray.flux.map((f) => (f && f > 0 ? Math.log10(f) : null)) }]}
                  title="GOES X-ray (A … X)"
                  tz={tz()}
                  h={110}
                  fixed={[-8.5, -3]}
                  fmt={(v) => (v >= -4 ? "X" : v >= -5 ? "M" : v >= -6 ? "C" : v >= -7 ? "B" : v >= -8 ? "A" : "")}
                />
              </div>
            )}
          </div>
          {aur.length > 0 && (
            <section class="fcc-sec">
              <label class="lbl">{aur.some((a) => a.kp != null) ? "Aurora / Kp forecast" : "Aurora (OVATION, north)"}</label>
              <div class="d6-aur">
                {aur.slice(0, 40).map((a, i) => (
                  <button key={i} class={`d6-aur-cell ${i === ai ? "on" : ""} ${a.t < Date.now() ? "past" : ""}`} style={{ background: kpCol(a.kp) }} title={`${new Date(a.t).toLocaleString(undefined, { timeZone: tz() })} · Kp ${a.kp ?? "—"}${a.label ? ` · ${a.label}` : ""}`} onClick={() => setAIdx(i)}>
                    {a.kp != null && <b>{a.kp.toFixed(0)}</b>}
                    <small>{new Date(a.t).toLocaleString(undefined, { weekday: "short", hour: "numeric", timeZone: tz() })}</small>
                  </button>
                ))}
              </div>
              {aur[ai]?.url && <img class="d6-aur-img" src={bust(aur[ai].url!)} alt="Aurora forecast" />}
            </section>
          )}
          <section class="fcc-sec">
            <label class="lbl">Alerts ({s.alerts.length})</label>
            {!s.alerts.length && <div class="muted small">No recent SWPC alerts.</div>}
            <div class="d6-alerts">
              {s.alerts.slice(0, 12).map((a, i) => (
                <details key={i}>
                  <summary>
                    <small class="muted">{Number.isFinite(a.t) ? new Date(a.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz() }) : ""}</small> {a.title}
                  </summary>
                  <pre>{a.text}</pre>
                </details>
              ))}
            </div>
          </section>
          <p class="muted small">Images refresh every 5 minutes. Click an image to enlarge.</p>
        </>
      )}
    </CenterModal>
  );
}
