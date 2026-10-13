// Webcam auto-timelapses (server: GET|PUT /api/timelapse/cams, GET /api/timelapse/list?cam=,
// POST /api/timelapse/build). The server captures a still every few minutes and builds one MP4 per
// camera per day, with chapters for the warnings and storm reports near the camera that day.
// A "Daily timelapse" toggle sits in each snapshot camera's viewer; the Recordings panel lists the
// cameras and their days with a player.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Clapperboard, RefreshCw, Trash2, Hammer } from "lucide-preact";
import { api, ApiError } from "../api";
import { toast } from "../store";
import { fileUrl } from "./panels/RecordPanel";
import type { CamView } from "./CameraPanels";

export interface TlCam {
  id: string;
  name: string;
  url: string;
  cam_id: string;
  lat?: number | null;
  lon?: number | null;
  interval_min: number;
  daylight_only: boolean;
  retention_days: number;
  fps: number;
  enabled: boolean;
  event_mi?: number;
}
export interface TlStatus {
  last_capture: number;
  frames_today: number;
  last_error: string;
  next_capture: number;
  daylight?: boolean;
}
export interface TlChapter {
  t: number;
  offset_s: number;
  title: string;
  kind: "warning" | "lsr" | string;
}
export interface TlItem {
  cam: string;
  date: string;
  video: string;
  poster: string | null;
  frames: number;
  fps: number;
  duration_s: number;
  size: number;
  partial?: boolean;
  chapters?: TlChapter[];
}

export const tlCams = signal<TlCam[]>([]);
export const tlStatus = signal<Record<string, TlStatus>>({});
export const tlFfmpeg = signal(true);
/** null = not loaded, false = the server has no timelapses */
export const tlSupported = signal<boolean | null>(null);

export async function loadTl() {
  try {
    const r: any = await api.get("/api/timelapse/cams");
    tlCams.value = r.cams ?? [];
    tlStatus.value = r.status ?? {};
    tlFfmpeg.value = r.ffmpeg !== false;
    tlSupported.value = true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) tlSupported.value = false;
  }
}
api.on("connected", () => {
  tlSupported.value = null;
  loadTl();
});
api.on("timelapse", () => loadTl());

async function putCams(cams: TlCam[]) {
  try {
    const r: any = await api.send("PUT", "/api/timelapse/cams", { cams });
    tlCams.value = r.cams ?? cams;
    tlStatus.value = r.status ?? tlStatus.value;
    return true;
  } catch (e: any) {
    toast(`Timelapse: ${e.message}`, "error", 7000);
    return false;
  }
}

/** a camera viewer → the server's timelapse camera (proxied cameras are resolved by id on the server) */
function fromView(c: CamView): TlCam {
  const proxy = c.img === "proxy" || !c.img;
  return { id: c.id, name: c.name, url: proxy ? "" : c.img!, cam_id: proxy ? c.id : "", lat: c.lat ?? null, lon: c.lon ?? null, interval_min: 5, daylight_only: c.lat != null, retention_days: 14, fps: 24, enabled: true, event_mi: 15 };
}
export function setTimelapse(c: CamView, on: boolean) {
  const rest = tlCams.value.filter((x) => x.id !== c.id);
  return putCams(on ? [...rest, fromView(c)] : rest).then((ok) => ok && toast(on ? `Daily timelapse on for ${c.name}` : `Daily timelapse off for ${c.name}`));
}

/** "Daily timelapse" toggle for a snapshot camera's viewer header */
export function TimelapseToggle({ c }: { c: CamView }) {
  useEffect(() => {
    if (tlSupported.value == null) loadTl();
  }, []);
  if (c.type !== "img" || tlSupported.value !== true) return null;
  const on = tlCams.value.some((x) => x.id === c.id && x.enabled);
  const st = tlStatus.value[c.id];
  const stop = (e: Event) => e.stopPropagation();
  return (
    <button
      class={`cam-rec cam-tl ${on ? "on" : ""}`}
      title={on ? `Daily timelapse on${st ? ` · ${st.frames_today} frames today${st.last_error ? ` · ${st.last_error}` : ""}` : ""} (click to turn off). Videos: Recordings → Timelapses` : tlFfmpeg.value ? "Daily timelapse: the server takes a still every 5 minutes and makes a video each day" : "Install ffmpeg on the server for timelapses"}
      disabled={!on && !tlFfmpeg.value}
      onPointerDown={stop}
      onClick={() => setTimelapse(c, !on)}
    >
      <Clapperboard size={11} /> TL
    </button>
  );
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Recordings panel section: timelapse cameras, their days and a player */
export function TimelapseSection() {
  const [cam, setCam] = useState<string>("");
  const [items, setItems] = useState<TlItem[] | null>(null);
  const [play, setPlay] = useState<TlItem | null>(null);
  const [busy, setBusy] = useState(false);
  const vref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    loadTl();
  }, []);
  const cams = tlCams.value;
  const cur = cams.find((x) => x.id === cam) ?? cams[0];
  const load = () =>
    cur &&
    api
      .get(`/api/timelapse/list?cam=${encodeURIComponent(cur.id)}`)
      .then((r: any) => setItems(r.items ?? []))
      .catch(() => setItems([]));
  useEffect(() => {
    setItems(null);
    setPlay(null);
    load();
  }, [cur?.id]);
  if (tlSupported.value === false) return null;
  const set = (fn: (x: TlCam) => void) => {
    if (!cur) return;
    const x = structuredClone(cur);
    fn(x);
    putCams(cams.map((y) => (y.id === cur.id ? x : y)));
  };
  const build = async () => {
    if (!cur) return;
    setBusy(true);
    try {
      await api.send("POST", "/api/timelapse/build", { cam: cur.id });
      toast("Today's timelapse built (so far)");
      load();
    } catch (e: any) {
      toast(`Timelapse: ${e.message}`, "warn", 7000);
    } finally {
      setBusy(false);
    }
  };
  const st = cur ? tlStatus.value[cur.id] : undefined;
  return (
    <section class="tl-sec">
      <div class="row">
        <label class="lbl" style={{ flex: 1 }}>
          <Clapperboard size={11} /> Timelapses · {cams.length}
        </label>
        <button class="icon-btn" title="Refresh" onClick={() => (loadTl(), load())}>
          <RefreshCw size={13} />
        </button>
      </div>
      {!tlFfmpeg.value && <div class="muted small">Install ffmpeg on the server to build the daily videos.</div>}
      {!cams.length ? (
        <div class="muted small">No timelapse cameras. Open a snapshot camera and press TL in its title bar.</div>
      ) : (
        <>
          <div class="row tl-cam">
            <select value={cur?.id} onChange={(e) => setCam((e.target as HTMLSelectElement).value)}>
              {cams.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                  {c.enabled ? "" : " (paused)"}
                </option>
              ))}
            </select>
            <button class="icon-btn" title="Build today's video now (partial day)" disabled={busy || !tlFfmpeg.value} onClick={build}>
              <Hammer size={13} class={busy ? "spin" : ""} />
            </button>
            <button class="icon-btn danger" title="Stop this camera's timelapse (videos already made stay until they expire)" onClick={() => cur && confirm(`Stop the timelapse of ${cur.name}?`) && putCams(cams.filter((x) => x.id !== cur.id))}>
              <Trash2 size={13} />
            </button>
          </div>
          {cur && (
            <div class="row tl-opts">
              <label class="sk-chk">
                <input type="checkbox" checked={cur.enabled} onChange={(e) => set((x) => (x.enabled = (e.target as HTMLInputElement).checked))} /> On
              </label>
              <select value={String(cur.interval_min)} title="Minutes between stills" onChange={(e) => set((x) => (x.interval_min = +(e.target as HTMLSelectElement).value))}>
                {[1, 2, 5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    every {m} min
                  </option>
                ))}
              </select>
              <label class="sk-chk" title={cur.lat == null ? "Needs the camera's location" : "Only between dawn and dusk"}>
                <input type="checkbox" disabled={cur.lat == null} checked={cur.daylight_only} onChange={(e) => set((x) => (x.daylight_only = (e.target as HTMLInputElement).checked))} /> Daylight only
              </label>
              <select value={String(cur.retention_days)} title="Keep the daily videos" onChange={(e) => set((x) => (x.retention_days = +(e.target as HTMLSelectElement).value))}>
                {[3, 7, 14, 30, 90, 365].map((d) => (
                  <option key={d} value={d}>
                    keep {d} d
                  </option>
                ))}
              </select>
            </div>
          )}
          {st && (
            <div class="muted small">
              {st.frames_today} frame{st.frames_today === 1 ? "" : "s"} today
              {st.last_capture ? ` · last ${new Date(st.last_capture).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
              {st.daylight === false ? " · night (paused)" : ""}
              {st.last_error ? <span class="err-text"> · {st.last_error}</span> : null}
            </div>
          )}
          {play && (
            <div class="tl-player">
              <video ref={vref} src={fileUrl(play.video)} poster={play.poster ? fileUrl(play.poster) : undefined} controls autoplay muted playsInline />
              {!!play.chapters?.length && (
                <div class="tl-chaps">
                  {play.chapters.map((ch, i) => (
                    <button key={i} class={`chip tl-ch ${ch.kind}`} title={new Date(ch.t).toLocaleString()} onClick={() => vref.current && ((vref.current.currentTime = ch.offset_s), vref.current.play().catch(() => {}))}>
                      {fmtDur(ch.offset_s)} {ch.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div class="tl-days">
            {items == null && <div class="muted small">Loading…</div>}
            {items?.length === 0 && <div class="muted small">No videos yet: the first one is made after midnight (or press the hammer).</div>}
            {(items ?? []).map((it) => (
              <button key={it.date} class={`tl-day ${play?.date === it.date ? "on" : ""}`} onClick={() => setPlay(play?.date === it.date ? null : it)}>
                <b>{it.date}</b>
                <small class="muted">
                  {it.duration_s ? fmtDur(it.duration_s) : "—"} · {it.frames ?? 0} frames · {fmtSize(it.size)}
                  {it.partial ? " · partial" : ""}
                </small>
                {!!it.chapters?.length && <span class="tl-tags">{it.chapters.length} event{it.chapters.length === 1 ? "" : "s"}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
