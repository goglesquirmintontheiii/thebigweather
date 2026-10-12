// Sounding window: Skew-T, hodograph and indices from a RAOB or a model profile.

import { useEffect, useMemo, useState } from "preact/hooks";
import { Activity, RefreshCw, MapPin } from "lucide-preact";
import { api } from "../api";
import { settings } from "../store";
import { CenterModal } from "./CenterModal";
import { SkewT, Hodograph } from "./SkewT";
import { soundingReq, showStations, raobStations, loadStations, soundingUrl, type SndData, type SndModel } from "../sounding/state";
import { clean, analyze, type Parcel } from "../sounding/thermo";
import { distance, compass } from "../util";

export function SoundingCenter() {
  if (!soundingReq.value) return null;
  return <SoundingBody />;
}

const MODELS: [SndModel, string][] = [
  ["hrrr", "HRRR"],
  ["gfs", "GFS"],
  ["ecmwf", "ECMWF"],
];

/** last few 00Z / 12Z launch times */
function synoptic(n = 6): number[] {
  const h12 = 12 * 3600_000;
  const last = Math.floor((Date.now() - 90 * 60_000) / h12) * h12;
  return Array.from({ length: n }, (_, i) => last - i * h12);
}

function SoundingBody() {
  const req = soundingReq.value!;
  const [data, setData] = useState<SndData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pk, setPk] = useState<"SB" | "ML" | "MU">("ML");
  const [tick, setTick] = useState(0);
  const url = soundingUrl(req);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(null);
    api
      .get<SndData>(url)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [url, tick]);
  useEffect(() => {
    if (req.src === "raob") loadStations().catch(() => {});
  }, [req.src]);
  const set = (o: Partial<typeof req>) => (soundingReq.value = { ...req, ...o });
  const L = useMemo(() => (data?.levels?.length ? clean(data.levels) : []), [data]);
  const ix = useMemo(() => (L.length > 3 ? analyze(L) : null), [L]);
  const parcel: Parcel | null = ix ? (pk === "SB" ? ix.sb : pk === "ML" ? ix.ml : ix.mu) : null;
  const stations = useMemo(() => {
    const fs: any[] = raobStations.value?.features ?? [];
    return fs
      .map((f) => ({ id: String(f.properties?.id ?? ""), name: String(f.properties?.name ?? ""), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
      .map((s) => ({ ...s, d: distance(req.lat, req.lon, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);
  }, [raobStations.value, req.lat, req.lon]);
  const hours = data?.hours ?? [];
  const hi = Math.max(0, hours.indexOf(req.hour ?? (typeof data?.time === "string" ? data.time : "")));
  const when = data ? new Date(typeof data.time === "number" ? data.time : Date.parse(data.time)) : null;
  const fmtWhen = when && !isNaN(+when) ? when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "";
  const place = data ? (data.src === "raob" ? `${data.station ?? ""}${data.name ? ` · ${data.name}` : ""}` : `${(data.model ?? req.model).toUpperCase()} · ${data.lat.toFixed(2)}, ${data.lon.toFixed(2)}`) : `${req.lat.toFixed(2)}, ${req.lon.toFixed(2)}`;
  return (
    <CenterModal
      cls="snd"
      icon={<Activity size={20} />}
      title="Sounding"
      sub={`${place}${fmtWhen ? ` · ${fmtWhen}` : ""}`}
      onClose={() => (soundingReq.value = null)}
      actions={
        <>
          <label class="snd-chk" title="Show RAOB stations on the map (click one to open it)">
            <input type="checkbox" checked={showStations.value} onChange={(e) => (showStations.value = (e.target as HTMLInputElement).checked)} /> Stations on map
          </label>
          <button class="icon-btn" title="Reload" onClick={() => setTick(tick + 1)}>
            <RefreshCw size={15} class={busy ? "spin" : ""} />
          </button>
        </>
      }
    >
      <div class="snd-bar">
        <div class="seg sm">
          <button class={req.src === "model" ? "on" : ""} onClick={() => set({ src: "model" })}>
            Model
          </button>
          <button class={req.src === "raob" ? "on" : ""} onClick={() => set({ src: "raob", station: req.station ?? stations[0]?.id })}>
            RAOB
          </button>
        </div>
        {req.src === "model" ? (
          <>
            <div class="seg sm">
              {MODELS.map(([id, n]) => (
                <button key={id} class={req.model === id ? "on" : ""} onClick={() => set({ model: id, hour: undefined })}>
                  {n}
                </button>
              ))}
            </div>
            {hours.length > 1 && (
              <div class="snd-hour">
                <input type="range" min={0} max={hours.length - 1} value={hi} onChange={(e) => set({ hour: hours[+(e.target as HTMLInputElement).value] })} />
                <small>F{String(hi).padStart(2, "0")}</small>
              </div>
            )}
          </>
        ) : (
          <>
            <select value={req.station ?? ""} onChange={(e) => set({ station: (e.target as HTMLSelectElement).value })} title="Station">
              {!stations.length && <option value="">Nearest station</option>}
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} {s.name ? `· ${s.name}` : ""} ({Math.round(s.d / 1000)} km)
                </option>
              ))}
            </select>
            <select value={String(req.time ?? "")} onChange={(e) => set({ time: +(e.target as HTMLSelectElement).value || undefined })} title="Launch">
              <option value="">Latest</option>
              {synoptic().map((t) => (
                <option key={t} value={String(t)}>
                  {new Date(t).toISOString().slice(5, 13).replace("T", " ")}Z
                </option>
              ))}
            </select>
          </>
        )}
        <span class="snd-sp" />
        <span class="muted small">Parcel</span>
        <div class="seg sm">
          {(["SB", "ML", "MU"] as const).map((k) => (
            <button key={k} class={pk === k ? "on" : ""} onClick={() => setPk(k)}>
              {k}
            </button>
          ))}
        </div>
        <span class="muted small snd-at" title="Point">
          <MapPin size={11} /> {req.lat.toFixed(2)}, {req.lon.toFixed(2)}
        </span>
      </div>
      {err && <div class="err-text">{err}</div>}
      {!data && !err && <div class="muted">Loading sounding…</div>}
      {L.length > 3 && ix && (
        <div class="snd-main">
          <SkewT levels={L} parcel={parcel} tempUnit={settings.value.units.temp} />
          <div class="snd-side">
            <Hodograph levels={L} kin={ix.kin} />
            <Indices ix={ix} />
          </div>
        </div>
      )}
      {data && L.length <= 3 && !err && <div class="muted">Not enough levels in this sounding.</div>}
    </CenterModal>
  );
}

function Indices({ ix }: { ix: ReturnType<typeof analyze> }) {
  const u = settings.value.units;
  const m = (v: number | null | undefined) => (v == null ? "—" : u.distance === "km" ? `${Math.round(v)} m` : `${Math.round(v * 3.28084)} ft`);
  const n = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const pw = ix.pwat == null ? "—" : u.precip === "in" ? `${(ix.pwat / 25.4).toFixed(2)} in` : `${ix.pwat.toFixed(0)} mm`;
  const motion = (p: [number, number] | null) => {
    if (!p) return "—";
    const sp = Math.hypot(p[0], p[1]);
    const dir = ((Math.atan2(-p[0], -p[1]) * 180) / Math.PI + 360) % 360;
    return `${String(Math.round(dir)).padStart(3, "0")}°/${Math.round(sp)} kt`;
  };
  const row = (p: Parcel | null) => [n(p?.cape), n(p?.cin), m(p?.lclZ), p?.lfcP ? `${Math.round(p.lfcP)}` : "—", p?.elP ? `${Math.round(p.elP)}` : "—", n(p?.li, 1)];
  const k = ix.kin;
  return (
    <div class="snd-ix">
      <table>
        <thead>
          <tr>
            <th />
            <th>CAPE</th>
            <th>CIN</th>
            <th>LCL</th>
            <th>LFC</th>
            <th>EL</th>
            <th>LI</th>
          </tr>
        </thead>
        <tbody>
          {(["sb", "ml", "mu"] as const).map((key) => (
            <tr key={key}>
              <th>{key.toUpperCase()}</th>
              {row(ix[key]).map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div class="snd-grid">
        <Cell l="Shear 0–1 km" v={`${n(k.shear1)} kt`} />
        <Cell l="0–3 km" v={`${n(k.shear3)} kt`} />
        <Cell l="0–6 km" v={`${n(k.shear6)} kt`} hot={(k.shear6 ?? 0) >= 40} />
        <Cell l="SRH 0–1 km" v={n(k.srh1)} hot={(k.srh1 ?? 0) >= 150} />
        <Cell l="SRH 0–3 km" v={n(k.srh3)} hot={(k.srh3 ?? 0) >= 250} />
        <Cell l="Bunkers RM" v={motion(k.rm)} />
        <Cell l="Bunkers LM" v={motion(k.lm)} />
        <Cell l="Lapse 0–3 km" v={`${n(ix.lr03, 1)} °C/km`} />
        <Cell l="Lapse 700–500" v={`${n(ix.lr75, 1)} °C/km`} hot={(ix.lr75 ?? 0) >= 7.5} />
        <Cell l="PWAT" v={pw} />
        <Cell l="Freezing lvl" v={m(ix.frz)} />
        <Cell l="Wet-bulb zero" v={m(ix.wbz)} />
        <Cell l="STP" v={n(ix.stp, 1)} hot={(ix.stp ?? 0) >= 1} />
        <Cell l="SCP" v={n(ix.scp, 1)} hot={(ix.scp ?? 0) >= 4} />
        <Cell l="Mean wind 0–6" v={motion(k.mean6)} />
        <Cell l="Storm to" v={k.rm ? compass((((Math.atan2(k.rm[0], k.rm[1]) * 180) / Math.PI) + 360) % 360) : "—"} />
      </div>
      <p class="muted small">STP/SCP: fixed-layer, rough. Heights AGL. LFC/EL in hPa.</p>
    </div>
  );
}

function Cell({ l, v, hot }: { l: string; v: string; hot?: boolean }) {
  return (
    <div class={`snd-cell ${hot ? "hot" : ""}`}>
      <small>{l}</small>
      <b>{v}</b>
    </div>
  );
}
