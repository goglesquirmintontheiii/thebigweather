// Floating camera viewers: snapshots (auto-refresh), HLS video, YouTube, or a link out.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import Hls from "hls.js";
import { api } from "../api";
import { activeServer, settings, update, toast } from "../store";
import { X, ExternalLink, RefreshCw, Pause, Play as PlayIcon, PictureInPicture2, Circle, Square, Info, Trash2 } from "lucide-preact";
import { activeTime } from "../active";
import { fileUrl, recs, loadRecs, recordCamera, stopRec, ytdlp, ffmpeg } from "./panels/RecordPanel";
import { popout, canPopout } from "../popout";
import { mapRef } from "../map/mapview";
import { currentSite } from "../radar/controller";
import { distance, bearing, compass, fmtDist } from "../util";
import { fmtElapsed } from "../radarrec";
import { TimelapseToggle } from "./Timelapses"; // p8: daily webcam timelapse

export interface CamView {
  id: string;
  name: string;
  source?: string;
  type: "img" | "hls" | "yt" | "page" | "rec";
  rec?: { id: string; frames: { name: string; time: number; video: boolean }[] };
  img?: string | null;
  video?: string | null;
  page?: string | null;
  refresh?: number;
  attribution?: string;
  /** the URL breaks with a cache-buster query: refetch with no-store instead */
  nobust?: boolean;
  lat?: number;
  lon?: number;
  /** traffic / weather / buoy… */
  cat?: string;
  dir?: string;
  stale?: boolean;
  /** the raw feature properties (shown in Info) */
  props?: Record<string, any>;
  x: number;
  y: number;
}

export const camPanels = signal<CamView[]>([]);
/** bring an open viewer to the front */
const front = signal<{ id: string; n: number } | null>(null);
let z = 10;

/** default viewer size: big, clamped to the window; the user's last resize wins */
function camSize(): [number, number] {
  const [w, h] = settings.value.ui.camSize ?? [680, 590];
  return [Math.max(300, Math.min(w, window.innerWidth - 24)), Math.max(240, Math.min(h, window.innerHeight - 90))];
}

export function openCamera(p: any) {
  if (camPanels.value.some((c) => c.id === p.id)) {
    front.value = { id: p.id, n: (front.value?.n ?? 0) + 1 };
    return;
  }
  const n = camPanels.value.length;
  const [w, h] = camSize();
  const view: CamView = {
    id: p.id,
    name: p.n ?? p.name ?? "Camera",
    source: p.sn,
    type: p.t ?? "img",
    img: p.i,
    video: p.v,
    page: p.p,
    refresh: p.r,
    attribution: p.a ?? (String(p.s ?? "").startsWith("db:") ? `Camera database · ${String(p.s).slice(3)}` : undefined),
    nobust: !!p.nb,
    rec: p.rec,
    lat: typeof p.lat === "number" ? p.lat : undefined,
    lon: typeof p.lon === "number" ? p.lon : undefined,
    cat: p.k,
    dir: p.dir,
    stale: !!p.stale,
    props: p.rec ? undefined : { ...p },
    x: Math.max(8, Math.min(80 + ((n * 36) % 300), window.innerWidth - w - 12)),
    y: Math.max(56, Math.min(70 + ((n * 36) % 240), window.innerHeight - h - 12)),
  };
  camPanels.value = [...camPanels.value.slice(-5), view];
}

export function openStream(name: string, url: string, type: CamView["type"]) {
  openCamera({ id: `stream:${url}`, n: name, t: type, v: type === "img" ? null : url, i: type === "img" ? url : null, p: type === "page" ? url : null });
}

function close(id: string) {
  camPanels.value = camPanels.value.filter((c) => c.id !== id);
}

/** YouTube watch/short/live/playlist URL → embeddable URL. */
export function youtubeEmbed(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith("/embed/")) return url;
    const list = u.searchParams.get("list");
    let id = u.searchParams.get("v");
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    if (u.pathname.startsWith("/live/") || u.pathname.startsWith("/shorts/")) id = u.pathname.split("/")[2];
    const ch = u.pathname.match(/^\/channel\/([^/]+)/);
    if (!id && ch) return `https://www.youtube.com/embed/live_stream?channel=${ch[1]}&autoplay=1&mute=1`;
    if (!id && list) return `https://www.youtube.com/embed/videoseries?list=${list}&autoplay=1&mute=1`;
    return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1`;
  } catch {
    return url;
  }
}

function imageUrl(c: CamView, bust: number) {
  if (c.img === "proxy") {
    const s = activeServer.value;
    const tok = s?.token ? `&token=${encodeURIComponent(s.token)}` : "";
    return `${api.base}/api/camimg?id=${encodeURIComponent(c.id)}${tok}&_=${bust}`;
  }
  if (!c.img) return "";
  return c.img + (c.img.includes("?") ? "&" : "?") + `_tbw=${bust}`;
}

interface Meta {
  at?: number;
  w?: number;
  h?: number;
}

function Snapshot({ c, onMeta }: { c: CamView; onMeta?: (m: Meta) => void }) {
  const [bust, setBust] = useState(() => Math.floor(Date.now() / 1000));
  const [err, setErr] = useState(false);
  const [at, setAt] = useState(0);
  const [blob, setBlob] = useState<string | null>(null);
  // cameras whose URL can't take a cache-buster: fetch without the browser cache
  useEffect(() => {
    if (!c.nobust || !c.img) return;
    let gone = false;
    fetch(c.img, { cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (gone) return;
        setBlob((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(b);
        });
      })
      .catch(() => !gone && setBlob(null));
    return () => {
      gone = true;
    };
  }, [bust, c.id]);
  useEffect(() => () => blob && URL.revokeObjectURL(blob), []);
  useEffect(() => {
    const ms = Math.max(5, Math.min(c.refresh ?? 60, 300)) * 1000;
    const t = setInterval(() => setBust(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [c.id]);
  return (
    <div class="cam-media">
      {err ? (
        <div class="cam-empty">Image unavailable</div>
      ) : (
        <img
          src={c.nobust ? (blob ?? c.img ?? "") : imageUrl(c, bust)}
          referrerpolicy="no-referrer"
          onLoad={(e) => {
            setErr(false);
            setAt(Date.now());
            const im = e.currentTarget as HTMLImageElement;
            onMeta?.({ at: Date.now(), w: im.naturalWidth, h: im.naturalHeight });
          }}
          onError={() => setErr(true)}
          alt={c.name}
        />
      )}
      <div class="cam-bar">
        <span>{at ? `Loaded ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Loading…"}</span>
        <button class="icon-btn" title="Refresh" onClick={() => (setErr(false), setBust(Date.now()))}>
          <RefreshCw size={12} />
        </button>
      </div>
    </div>
  );
}

function HlsVideo({ url, onMeta }: { url: string; onMeta?: (m: Meta) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const v = ref.current!;
    let hls: Hls | null = null;
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      // plain video file / stream the browser can play itself
      v.src = url;
    } else if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, maxBufferLength: 20, backBufferLength: 10 });
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) setErr(d.details || "stream error");
      });
    } else v.src = url;
    v.play().catch(() => {});
    return () => {
      hls?.destroy();
      v.removeAttribute("src");
      v.load();
    };
  }, [url]);
  return (
    <div class="cam-media">
      <video
        ref={ref}
        muted
        autoplay
        playsinline
        controls
        onLoadedMetadata={(e) => onMeta?.({ w: (e.currentTarget as HTMLVideoElement).videoWidth, h: (e.currentTarget as HTMLVideoElement).videoHeight })}
      />
      {err && <div class="cam-empty">Stream unavailable ({err})</div>}
    </div>
  );
}

/** Recorded camera: image sequence (or video pieces) with a scrubber, optionally following the
 * radar/satellite time on screen. */
function RecPlayer({ c }: { c: CamView }) {
  const fr = c.rec!.frames;
  const [i, setI] = useState(fr.length - 1);
  const [play, setPlay] = useState(false);
  const [sync, setSync] = useState(false);
  const vref = useRef<HTMLVideoElement>(null);
  const vids = fr.some((f) => f.video);
  useEffect(() => {
    if (!play || sync) return;
    const t = setInterval(() => setI((x) => (x + 1) % fr.length), vids ? 0 : 1000 / Math.max(1, settings.value.anim.fps));
    return () => clearInterval(t);
  }, [play, sync, fr.length]);
  // follow the time of the weather layer on screen
  const at = activeTime.value;
  useEffect(() => {
    if (!sync || !at) return;
    let best = 0;
    for (let k = 0; k < fr.length; k++) if (fr[k].time <= at) best = k;
    setI(best);
    if (vids && vref.current) {
      const off = (at - fr[best].time) / 1000;
      if (off >= 0 && Math.abs(vref.current.currentTime - off) > 2) vref.current.currentTime = off;
    }
  }, [sync, at]);
  const f = fr[Math.min(i, fr.length - 1)];
  const url = fileUrl(`/api/rec/${c.rec!.id}/file/${encodeURIComponent(f.name)}`);
  return (
    <div class="cam-media">
      {f.video ? <video ref={vref} key={url} src={url} controls autoplay muted playsinline /> : <img src={url} alt={c.name} />}
      <div class="cam-bar">
        <button class="icon-btn" title={play ? "Pause" : "Play"} onClick={() => setPlay(!play)} disabled={sync}>
          {play ? <Pause size={12} /> : <PlayIcon size={12} />}
        </button>
        <input type="range" min={0} max={fr.length - 1} value={i} onInput={(e) => (setSync(false), setI(+(e.target as HTMLInputElement).value))} />
        <span>{new Date(f.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: vids ? undefined : "2-digit", timeZone: settings.value.utc ? "UTC" : undefined })}</span>
        <label class="rec-sync" title="Follow the time of the radar/satellite loop">
          <input type="checkbox" checked={sync} onChange={(e) => setSync((e.target as HTMLInputElement).checked)} /> Sync
        </label>
      </div>
    </div>
  );
}

const TYPE_NAME: Record<string, string> = { img: "Still image", hls: "Live video (HLS)", yt: "YouTube", page: "Web page", rec: "Recording" };
const KNOWN = new Set(["id", "n", "name", "s", "sn", "t", "i", "v", "p", "r", "k", "a", "dir", "nb", "stale", "lat", "lon", "mine", "rec", "x", "y"]);
const ytRecordable = (u: string) => /\/watch|youtu\.be\/|\/live\/|\/embed\/|\/shorts\//i.test(u) && !/live_stream\?channel/i.test(u);

/** 0.8.1: change when a running recording stops (minutes from now; null = until stopped) */
function setRecEnd(id: string, minutes: number | null) {
  return api
    .send("POST", `/api/rec/${id}/end`, minutes ? { minutes } : { end: null })
    .then(loadRecs)
    .catch((e: any) => toast(e.status === 404 || e.status === 405 ? "Update the server to change a running recording" : e.message, "warn", 6000));
}

const QUICK = [15, 30, 60, 120];
const fmtMin = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/** 0.8.1: "Record for…" menu: until stopped, quick durations, or a custom number of minutes/hours */
function DurMenu({ running, onPick }: { running: boolean; onPick: (minutes: number | null) => void }) {
  const [n, setN] = useState(3);
  const [unit, setUnit] = useState(60);
  return (
    <div class="cam-rec-menu glass" onPointerDown={(e) => e.stopPropagation()}>
      <button onClick={() => onPick(null)} title={running ? "Keep recording until you stop it" : "Record until you press stop"}>
        {running ? "Until stopped" : "Start (until stopped)"}
      </button>
      <small class="cam-rec-sub">{running ? "Stop after" : "Record for"}</small>
      {QUICK.map((m) => (
        <button key={m} onClick={() => onPick(m)}>
          {fmtMin(m)}
        </button>
      ))}
      <div class="cam-rec-custom">
        <input type="number" min={1} max={unit === 1 ? 1440 : 720} value={n} onInput={(e) => setN(Math.max(1, +(e.target as HTMLInputElement).value || 1))} aria-label="Duration" />
        <select value={unit} onChange={(e) => setUnit(+(e.target as HTMLSelectElement).value)} aria-label="Unit">
          <option value={1}>min</option>
          <option value={60}>h</option>
        </select>
        <button class="go" onClick={() => onPick(Math.min(n * unit, 30 * 1440))}>
          {running ? "Set" : "Go"}
        </button>
      </div>
    </div>
  );
}

/** Record / stop for this camera (server recording): manual start/stop, or for a set time. */
function RecControl({ c }: { c: CamView }) {
  const [menu, setMenu] = useState(false);
  const [, tick] = useState(0);
  const r = recs.value.find((x) => x.kind === "camera" && x.camera?.id === c.id && (x.status === "recording" || x.status === "scheduled"));
  useEffect(() => {
    if (!r) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [!!r]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const t = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    return () => (clearTimeout(t), window.removeEventListener("pointerdown", close));
  }, [menu]);
  if (c.type === "rec" || c.type === "page") return null;
  const stop = (e: Event) => e.stopPropagation();
  if (r) {
    const left = r.end ? r.end - Date.now() : null;
    return (
      <span class="cam-rec-wrap" onPointerDown={stop}>
        <button class="cam-rec on" title={r.end ? `Recording · stops at ${new Date(r.end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} (click to change)` : "Recording until stopped (click to set a duration)"} onClick={() => setMenu(!menu)}>
          <i class="rec-pulse" />
          {fmtElapsed(Date.now() - (r.t0 || r.start || r.created))}
          {left != null && <small class="cam-rec-left">−{fmtElapsed(left)}</small>}
        </button>
        <button class="cam-rec on stop" title="Stop recording" onClick={() => (setMenu(false), stopRec(r.id))}>
          <Square size={11} />
        </button>
        {menu && <DurMenu running onPick={(m) => (setMenu(false), setRecEnd(r.id, m))} />}
      </span>
    );
  }
  const why =
    c.type === "yt" && !ytdlp.value
      ? "Install yt-dlp on the server to record YouTube"
      : c.type === "yt" && c.video && !ytRecordable(c.video)
        ? "Only single YouTube videos/streams can be recorded"
        : (c.type === "hls" || c.type === "yt") && !ffmpeg.value
          ? "Install ffmpeg on the server to record video"
          : "";
  return (
    <span class="cam-rec-wrap" onPointerDown={stop}>
      <button class="cam-rec" disabled={!!why} title={why || "Record this camera on the server: until stopped, or for a set time"} onClick={() => setMenu(!menu)}>
        <Circle size={10} class="rec-dot" /> Rec
      </button>
      {menu && <DurMenu running={false} onPick={(m) => (setMenu(false), recordCamera({ id: c.id, n: c.name, t: c.type, i: c.img, v: c.video, r: c.refresh, lat: c.lat, lon: c.lon }, m ?? 0))} />}
    </span>
  );
}

function fmtVal(v: any): string {
  if (v == null || v === "") return "";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 120);
  return String(v);
}

function CamInfo({ c, meta }: { c: CamView; meta: Meta }) {
  const p = c.props ?? {};
  const rows: [string, any][] = [];
  const src = c.source ?? String(p.s ?? "").replace(/^db:/, "");
  if (src) rows.push(["Source", src]);
  rows.push(["Type", `${TYPE_NAME[c.type] ?? c.type}${c.cat ? ` · ${c.cat}` : ""}`]);
  if (c.lat != null && c.lon != null) rows.push(["Location", `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`]);
  for (const k of ["road", "route", "highway", "rt", "city", "county", "state", "region"]) if (p[k] != null && p[k] !== "") rows.push([k[0].toUpperCase() + k.slice(1), fmtVal(p[k])]);
  if (c.dir) rows.push(["Facing", c.dir]);
  if (c.type === "img" && c.refresh) rows.push(["Refresh", c.refresh >= 60 ? `every ${Math.round(c.refresh / 60)} min` : `every ${c.refresh} s`]);
  if (meta.at) rows.push(["Updated", new Date(meta.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined })]);
  if (meta.w && meta.h) rows.push(["Size", `${meta.w}×${meta.h}`]);
  if (c.stale) rows.push(["Status", "May be out of date"]);
  if (c.lat != null && c.lon != null) {
    const m = mapRef.value?.getCenter();
    if (m) rows.push(["From map center", `${fmtDist(distance(m.lat, m.lng, c.lat, c.lon))} ${compass(bearing(m.lat, m.lng, c.lat, c.lon))}`]);
    const s = currentSite.value;
    if (s) rows.push([`From ${s.id}`, `${fmtDist(distance(s.lat, s.lon, c.lat, c.lon))} ${compass(bearing(s.lat, s.lon, c.lat, c.lon))}`]);
  }
  for (const [k, v] of Object.entries(p)) if (!KNOWN.has(k) && !rows.some((r) => r[0].toLowerCase() === k) && fmtVal(v)) rows.push([k, fmtVal(v)]);
  if (p.id ?? c.id) rows.push(["ID", String(p.id ?? c.id)]);
  const links = [c.page && ["Page", c.page], c.video && ["Stream", c.video], c.img && c.img !== "proxy" && ["Image", c.img]].filter(Boolean) as [string, string][];
  return (
    <div class="cam-info" onPointerDown={(e) => e.stopPropagation()}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <b title={String(v)}>{v}</b>
        </div>
      ))}
      {links.map(([k, u]) => (
        <div key={k}>
          <span>{k}</span>
          <a href={u} target="_blank" rel="noreferrer" title={u}>
            {u.replace(/^https?:\/\//, "")}
          </a>
        </div>
      ))}
      {p.mine && (
        <div>
          <span />
          <button class="btn xs ghost" onClick={() => (update((st) => (st.myCams = st.myCams.filter((x) => x.id !== p.mine))), close(c.id))}>
            <Trash2 size={12} /> Remove from my cameras
          </button>
        </div>
      )}
    </div>
  );
}

function Panel({ c }: { c: CamView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zi, setZ] = useState(++z);
  const [size, setSize] = useState<[number, number]>(camSize);
  const [info, setInfo] = useState(c.type !== "rec");
  const [meta, setMeta] = useState<Meta>({});
  const f = front.value;
  useEffect(() => {
    if (f?.id === c.id) setZ(++z);
  }, [f?.n]);
  const onDown = (e: PointerEvent) => {
    const el = ref.current!;
    setZ(++z);
    const ox = e.clientX - el.offsetLeft;
    const oy = e.clientY - el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - ox))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - oy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onResize = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current!;
    const sx = e.clientX;
    const sy = e.clientY;
    const [w0, h0] = [el.offsetWidth, el.offsetHeight];
    let wh: [number, number] = [w0, h0];
    const move = (ev: PointerEvent) => {
      wh = [Math.max(300, Math.min(window.innerWidth - el.offsetLeft - 4, w0 + ev.clientX - sx)), Math.max(220, Math.min(window.innerHeight - el.offsetTop - 4, h0 + ev.clientY - sy))];
      el.style.width = `${wh[0]}px`;
      el.style.height = `${wh[1]}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSize(wh);
      update((s) => (s.ui.camSize = wh));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const link = c.page || c.video || c.img;
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div ref={ref} class="cam-panel sized glass" style={{ left: `${c.x}px`, top: `${c.y}px`, width: `${size[0]}px`, height: `${size[1]}px`, zIndex: zi }} onPointerDown={() => setZ(++z)}>
      <div class="cam-head" onPointerDown={onDown as any}>
        <span class="cam-title" title={c.name}>
          {c.name}
          {c.source && <small> · {c.source}</small>}
        </span>
        <RecControl c={c} />
        <TimelapseToggle c={c} />
        {c.type !== "rec" && (
          <button class={`icon-btn ${info ? "on" : ""}`} title="Camera info" onPointerDown={stop} onClick={() => setInfo(!info)}>
            <Info size={13} />
          </button>
        )}
        {canPopout() && c.type !== "rec" && (
          <button
            class="icon-btn"
            title="Pop out to its own window"
            onPointerDown={stop}
            onClick={() => (popout({ kind: "camera", title: c.name, width: 720, height: 480, data: { ...c, x: 0, y: 0 } }), close(c.id))}
          >
            <PictureInPicture2 size={13} />
          </button>
        )}
        {link && link !== "proxy" && (
          <button class="icon-btn" title="Open in browser" onPointerDown={stop} onClick={() => window.open(link, "_blank")}>
            <ExternalLink size={13} />
          </button>
        )}
        <button class="icon-btn" title="Close" onPointerDown={stop} onClick={() => close(c.id)}>
          <X size={14} />
        </button>
      </div>
      {c.type === "rec" && c.rec ? (
        <RecPlayer c={c} />
      ) : c.type === "yt" && c.video ? (
        <div class="cam-media yt">
          <iframe src={youtubeEmbed(c.video)} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerpolicy="strict-origin-when-cross-origin" />
        </div>
      ) : c.type === "hls" && c.video ? (
        <HlsVideo url={c.video} onMeta={setMeta} />
      ) : c.type === "img" ? (
        <Snapshot c={c} onMeta={setMeta} />
      ) : (
        <div class="cam-media">
          <div class="cam-empty">
            This camera opens on its own website.
            {link && (
              <button class="btn sm" onClick={() => window.open(link, "_blank")}>
                <ExternalLink size={13} /> Open
              </button>
            )}
          </div>
        </div>
      )}
      {info && c.type !== "rec" && <CamInfo c={c} meta={meta} />}
      <div class="cam-note">{c.attribution ? `${c.attribution}. ` : ""}Feeds belong to their owners; recording or sharing some may need permission.</div>
      <div class="cam-resize" title="Resize" onPointerDown={onResize as any} />
    </div>
  );
}

/** A single camera filling a pop-out window. */
export function CameraFull({ c }: { c: CamView }) {
  return (
    <div class="cam-full">
      {c.type === "yt" && c.video ? (
        <div class="cam-media yt">
          <iframe src={youtubeEmbed(c.video)} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerpolicy="strict-origin-when-cross-origin" />
        </div>
      ) : c.type === "hls" && c.video ? (
        <HlsVideo url={c.video} />
      ) : c.type === "img" ? (
        <Snapshot c={c} />
      ) : (
        <div class="cam-empty">This camera opens on its own website.</div>
      )}
      <div class="cam-note">{c.attribution ? `${c.attribution}. ` : ""}Feeds belong to their owners.</div>
    </div>
  );
}

export function CameraPanels() {
  const open = camPanels.value.length > 0;
  // keep the recording state fresh while a viewer is open
  useEffect(() => {
    if (!open) return;
    loadRecs();
    const t = setInterval(loadRecs, 10_000);
    return () => clearInterval(t);
  }, [open]);
  return (
    <>
      {camPanels.value.map((c) => (
        <Panel key={c.id} c={c} />
      ))}
    </>
  );
}
