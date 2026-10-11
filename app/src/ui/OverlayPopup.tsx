// Details for a clicked overlay feature (reports, stations, cameras, ships, satellites…).

import { useEffect, useState } from "preact/hooks";
import { popup } from "../overlays/manager";
import { openCamera, openStream } from "./CameraPanels";
import { nextPass } from "../overlays/iss";
import { api } from "../api";
import { settings, update } from "../store";
import { mapRef } from "../map/mapview";
import { X, ExternalLink, Video, Trash2 } from "lucide-preact";
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
        <button class="icon-btn" onClick={() => (popup.value = null)}>
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
      {p.kind === "metar" && props.id && <Taf id={props.id} />}
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
