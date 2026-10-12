// Details for a clicked overlay feature (reports, stations, cameras, ships, satellites…).

import { useEffect, useState } from "preact/hooks";
import { popup, trackNote, showFlightTrack } from "../overlays/manager";
import { openCamera, openStream } from "./CameraPanels";
import { nextPass } from "../overlays/iss";
import { api } from "../api";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { X, ExternalLink, Video, Trash2, Radio } from "lucide-preact";
import { playStream } from "../radio";
import { camDialog } from "./Overlays";

const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined });

function Taf({ id }: { id: string }) {
  const [taf, setTaf] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!/^[A-Z0-9]{3,4}$/.test(id)) return setTaf(null);
    api
      .get(`/api/ovl/taf?ids=${id}`)
      .then((r) => setTaf(Array.isArray(r) && r[0]?.rawTAF ? r[0].rawTAF : null))
      .catch(() => setTaf(null));
  }, [id]);
  if (taf === undefined) return <div class="muted small">Loading TAF…</div>;
  if (!taf) return <div class="muted small">No TAF for {id}</div>;
  return <pre class="pop-raw">{taf}</pre>;
}

/** Sky layers from the raw METAR (FEW020 SCT045 BKN100 OVC250 VV005 CLR). */
export function skyLayers(raw: string): { cover: string; oktas: number; ft: number; cb?: boolean }[] {
  const out: { cover: string; oktas: number; ft: number; cb?: boolean }[] = [];
  const OK: Record<string, number> = { FEW: 2, SCT: 4, BKN: 6, OVC: 8, VV: 8 };
  for (const m of (raw ?? "").matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g)) out.push({ cover: m[1], oktas: OK[m[1]], ft: +m[2] * 100, cb: !!m[3] });
  return out;
}

function SkyGraph({ raw }: { raw: string }) {
  const layers = skyLayers(raw);
  const clear = /\b(CLR|SKC|NCD|NSC|CAVOK)\b/.test(raw ?? "");
  const W = 150;
  const H = 120;
  const top = 25000;
  // square-root height scale gives low clouds (what matters for flying) more room
  const y = (ft: number) => H - 14 - Math.sqrt(Math.min(ft, top) / top) * (H - 24);
  const ticks = [1000, 3000, 5000, 10000, 20000];
  return (
    <svg class="sky-graph" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <rect x="0" y="0" width={W} height={H} rx="6" fill="rgba(255,255,255,.03)" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1="34" x2={W - 4} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,.08)" />
          <text x="30" y={y(t) + 3} text-anchor="end" font-size="8.5" fill="#8b97a6">
            {t >= 1000 ? `${t / 1000}k` : t}
          </text>
        </g>
      ))}
      <line x1="34" x2={W - 4} y1={H - 14} y2={H - 14} stroke="#8b97a6" />
      {layers.map((l, i) => {
        const w = ((W - 44) * l.oktas) / 8;
        return (
          <g key={i}>
            <rect x={36} y={y(l.ft) - 4} width={w} height="8" rx="4" fill={l.cover === "VV" ? "#a3a3a3" : l.cb ? "#f59e0b" : "#e2e8f0"} opacity={0.35 + l.oktas / 16} />
            <text x={38 + w + 2 > W - 30 ? W - 6 : 38 + w + 2} y={y(l.ft) + 3} font-size="8.5" fill="#e7edf4" text-anchor={38 + w + 2 > W - 30 ? "end" : "start"}>
              {l.cover}
              {l.cb ? " CB" : ""}
            </text>
          </g>
        );
      })}
      {!layers.length && (
        <text x={W / 2 + 14} y={H / 2} text-anchor="middle" font-size="10" fill="#8b97a6">
          {clear ? "Clear skies" : "No cloud report"}
        </text>
      )}
      <text x={W / 2 + 14} y={H - 3} text-anchor="middle" font-size="8.5" fill="#8b97a6">
        Sky (ft above ground)
      </text>
    </svg>
  );
}

function WindCompass({ wd, ws, wg }: { wd?: number | null; ws?: number | null; wg?: number | null }) {
  const S = 120;
  const c = S / 2;
  const r = 44;
  const calm = !ws || ws < 1;
  const vrb = wd == null && !calm;
  const sp = settings.value.units.speed;
  const conv = sp === "mph" ? 1.15078 : sp === "km/h" ? 1.852 : sp === "m/s" ? 0.514444 : 1;
  const u = sp === "kt" ? "kt" : sp;
  // arrow points where the wind blows toward; the tail sits on the direction it comes from
  const a = (((wd ?? 0) - 90) * Math.PI) / 180;
  const tail = [c + Math.cos(a) * r, c + Math.sin(a) * r];
  const head = [c - Math.cos(a) * (r - 12), c - Math.sin(a) * (r - 12)];
  return (
    <svg class="wind-compass" width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
      <circle cx={c} cy={c} r={r + 6} fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.15)" />
      {Array.from({ length: 16 }, (_, i) => {
        const t = ((i * 22.5 - 90) * Math.PI) / 180;
        const l = i % 4 === 0 ? 7 : 3;
        return <line key={i} x1={c + Math.cos(t) * (r + 6)} y1={c + Math.sin(t) * (r + 6)} x2={c + Math.cos(t) * (r + 6 - l)} y2={c + Math.sin(t) * (r + 6 - l)} stroke="#8b97a6" />;
      })}
      {["N", "E", "S", "W"].map((d, i) => {
        const t = ((i * 90 - 90) * Math.PI) / 180;
        return (
          <text key={d} x={c + Math.cos(t) * (r - 6)} y={c + Math.sin(t) * (r - 6) + 3.5} text-anchor="middle" font-size="9.5" font-weight="700" fill="#b9c3cf">
            {d}
          </text>
        );
      })}
      {!calm && !vrb && (
        <>
          <line x1={tail[0]} y1={tail[1]} x2={head[0]} y2={head[1]} stroke="#3fb7ff" stroke-width="3" stroke-linecap="round" />
          <polygon
            points={`${head[0] - Math.cos(a) * 10 + Math.sin(a) * 6},${head[1] - Math.sin(a) * 10 - Math.cos(a) * 6} ${head[0] - Math.cos(a) * 10 - Math.sin(a) * 6},${head[1] - Math.sin(a) * 10 + Math.cos(a) * 6} ${head[0] - Math.cos(a) * 1},${head[1] - Math.sin(a) * 1}`}
            fill="#3fb7ff"
          />
        </>
      )}
      <circle cx={c} cy={c} r="17" fill="#0e1218" stroke="rgba(255,255,255,.12)" />
      <text x={c} y={c + 1} text-anchor="middle" font-size="12" font-weight="700" fill="#e7edf4">
        {calm ? "Calm" : Math.round((ws ?? 0) * conv)}
      </text>
      <text x={c} y={c + 11} text-anchor="middle" font-size="7.5" fill="#8b97a6">
        {calm ? "" : wg ? `G${Math.round(wg * conv)} ${u}` : u}
      </text>
      <text x={c} y={S - 2} text-anchor="middle" font-size="8.5" fill="#8b97a6">
        {calm ? "" : vrb ? "Variable" : `From ${Math.round(wd!)}°`}
      </text>
    </svg>
  );
}

function Tides({ id }: { id: string }) {
  const [p, setP] = useState<any[] | null | undefined>(undefined);
  useEffect(() => {
    api
      .get(`/api/ovl/tide?station=${id}`)
      .then((r) => setP(r.predictions))
      .catch(() => setP(null));
  }, [id]);
  if (p === undefined) return <div class="muted small">Loading tides…</div>;
  if (!p?.length) return <div class="muted small">No predictions</div>;
  const ft = settings.value.units.precip === "in";
  return (
    <table class="pop-table">
      <tbody>
        {p.slice(0, 8).map((x) => (
          <tr key={x.t}>
            <td>{x.type === "H" ? "High" : "Low"}</td>
            <td>{fmt(x.t)}</td>
            <td>{x.v == null ? "—" : ft ? `${(x.v * 3.28084).toFixed(1)} ft` : `${x.v.toFixed(2)} m`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pass({ name }: { name: string }) {
  const pts = settings.value.points;
  const c = mapRef.value?.getCenter();
  const where = pts[0] ? { name: pts[0].name, lat: pts[0].lat, lon: pts[0].lon } : c ? { name: "map center", lat: c.lat, lon: c.lng } : null;
  const [r, setR] = useState<ReturnType<typeof nextPass> | undefined>(undefined);
  useEffect(() => {
    if (!where) return;
    const t = setTimeout(() => setR(nextPass(name, where.lat, where.lon)), 30);
    return () => clearTimeout(t);
  }, [name]);
  if (!where) return null;
  return (
    <div class="pop-rows">
      <div>
        <span>Next pass ({where.name})</span>
        <b>{r === undefined ? "…" : r ? `${fmt(r.start)} · max ${Math.round(r.maxEl)}°` : "none in 36 h"}</b>
      </div>
    </div>
  );
}

export function OverlayPopup() {
  const s = popup.value;
  if (!s) return null;
  const { p } = s;
  const left = Math.min(s.x + 12, window.innerWidth - 340);
  const top = Math.min(s.y + 12, window.innerHeight - 260);
  const props = p.props ?? {};
  return (
    <div class="pop glass" style={{ left: `${left}px`, top: `${top}px` }} onPointerDown={(e) => e.stopPropagation()}>
      <div class="pop-head">
        <div>
          <b>{p.title}</b>
          {p.sub && <div class="muted small">{p.sub}</div>}
        </div>
        <button class="icon-btn" onClick={() => ((popup.value = null), p.kind === "flight" && showFlightTrack(null))}>
          <X size={14} />
        </button>
      </div>
      {p.rows && p.rows.length > 0 && (
        <div class="pop-rows">
          {p.rows.map(([k, v]) => (
            <div key={k}>
              <span>{k}</span>
              <b>{v}</b>
            </div>
          ))}
        </div>
      )}
      {p.kind === "iss" && (
        <>
          <div class="pop-rows">
            <div>
              <span>Altitude</span>
              <b>{props.alt} km</b>
            </div>
            <div>
              <span>Speed</span>
              <b>{Number(props.speed).toLocaleString()} km/h</b>
            </div>
          </div>
          <Pass name={props.name} />
          {props.name === "ISS" && (
            <button class="btn sm" onClick={() => openStream("ISS live (NASA)", "https://www.youtube.com/embed/videoseries?list=PL2aBZuCeDwlQMf6xMgQAUAY_nbHAgW5jz&autoplay=1&mute=1", "yt")}>
              <Video size={13} /> Watch live
            </button>
          )}
          {props.name === "ISS" && <div class="muted small">The feed can be blank or blue when the station is out of contact.</div>}
        </>
      )}
      {p.kind === "metar" && props.raw && (
        <div class="metar-viz">
          <WindCompass wd={props.wd} ws={props.ws} wg={props.wg} />
          <SkyGraph raw={props.raw} />
        </div>
      )}
      {p.kind === "metar" && props.id && <Taf id={props.id} />}
      {p.kind === "flight" && <div class="muted small">{trackNote.value || "Loading track…"}</div>}
      {p.kind === "tide" && <Tides id={props.id} />}
      {p.text && <pre class="pop-raw">{p.text}</pre>}
      <div class="pop-actions">
        {p.kind === "camera" && (
          <button class="btn sm" onClick={() => (openCamera(props), (popup.value = null))}>
            <Video size={13} /> {props.t === "page" ? "Open" : "View"}
          </button>
        )}
        {p.kind === "camera" && props.mine && (
          <button class="btn sm ghost" onClick={() => (update((st) => (st.myCams = st.myCams.filter((c) => c.id !== props.mine))), (popup.value = null))}>
            <Trash2 size={13} /> Remove
          </button>
        )}
        {p.kind === "buoy" && props.cam && (
          <button class="btn sm" onClick={() => openCamera({ id: `buoycam:${props.id}`, n: `BuoyCAM ${props.id}`, sn: "NOAA NDBC", t: "img", i: `https://www.ndbc.noaa.gov/buoycam.php?station=${props.id}`, r: 900, a: "NOAA NDBC" })}>
            <Video size={13} /> BuoyCAM
          </button>
        )}
        {p.kind === "ship" &&
          settings.value.myCams
            .filter((c) => c.ship && (c.ship === String(props.mmsi) || (props.name && c.ship.toLowerCase() === String(props.name).toLowerCase())))
            .map((c) => (
              <button key={c.id} class="btn sm" onClick={() => openStream(`${props.name || props.mmsi} · ${c.name}`, c.url, c.url.includes("youtu") ? "yt" : c.url.includes(".m3u8") ? "hls" : "img")}>
                <Video size={13} /> {c.name}
              </button>
            ))}
        {p.kind === "ship" && (
          <button class="btn sm ghost" onClick={() => ((camDialog.value = { ship: props.name || String(props.mmsi) }), (popup.value = null))}>
            <Video size={13} /> Add ship camera
          </button>
        )}
        {p.kind === "radio" && (
          <button class="btn sm" onClick={() => playStream({ id: props.id, name: `${props.city}, ${props.state}`, url: props.url, call: props.call, city: props.city, state: props.state })}>
            <Radio size={13} /> Listen
          </button>
        )}
        {p.kind === "waffle" && props.web && (
          <button class="btn sm ghost" onClick={() => window.open(props.web, "_blank")}>
            <ExternalLink size={13} /> Store page
          </button>
        )}
        {p.link && p.link[1] && (
          <button class="btn sm ghost" onClick={() => window.open(p.link![1], "_blank")}>
            <ExternalLink size={13} /> {p.link[0]}
          </button>
        )}
      </div>
    </div>
  );
}
