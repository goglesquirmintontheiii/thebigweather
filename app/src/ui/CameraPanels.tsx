// Floating camera viewers: snapshots (auto-refresh), HLS video, YouTube, or a link out.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import Hls from "hls.js";
import { api } from "../api";
import { activeServer } from "../store";
import { X, ExternalLink, RefreshCw } from "lucide-preact";

export interface CamView {
  id: string;
  name: string;
  source?: string;
  type: "img" | "hls" | "yt" | "page";
  img?: string | null;
  video?: string | null;
  page?: string | null;
  refresh?: number;
  attribution?: string;
  /** the URL breaks with a cache-buster query: refetch with no-store instead */
  nobust?: boolean;
  x: number;
  y: number;
}

export const camPanels = signal<CamView[]>([]);
let z = 10;

export function openCamera(p: any) {
  if (camPanels.value.some((c) => c.id === p.id)) return;
  const n = camPanels.value.length;
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
    x: 80 + ((n * 36) % 300),
    y: 90 + ((n * 36) % 240),
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

function Snapshot({ c }: { c: CamView }) {
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
          src={c.nobust ? blob ?? c.img ?? "" : imageUrl(c, bust)}
          referrerpolicy="no-referrer"
          onLoad={() => {
            setErr(false);
            setAt(Date.now());
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

function HlsVideo({ url }: { url: string }) {
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
      <video ref={ref} muted autoplay playsinline controls />
      {err && <div class="cam-empty">Stream unavailable ({err})</div>}
    </div>
  );
}

function Panel({ c }: { c: CamView }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zi, setZ] = useState(++z);
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
  const link = c.page || c.video || c.img;
  return (
    <div ref={ref} class="cam-panel glass" style={{ left: `${c.x}px`, top: `${c.y}px`, zIndex: zi }} onPointerDown={() => setZ(++z)}>
      <div class="cam-head" onPointerDown={onDown as any}>
        <span class="cam-title" title={c.name}>
          {c.name}
          {c.source && <small> · {c.source}</small>}
        </span>
        {link && link !== "proxy" && (
          <button class="icon-btn" title="Open in browser" onPointerDown={(e) => e.stopPropagation()} onClick={() => window.open(link, "_blank")}>
            <ExternalLink size={13} />
          </button>
        )}
        <button class="icon-btn" title="Close" onPointerDown={(e) => e.stopPropagation()} onClick={() => close(c.id)}>
          <X size={14} />
        </button>
      </div>
      {c.type === "yt" && c.video ? (
        <div class="cam-media yt">
          <iframe src={youtubeEmbed(c.video)} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerpolicy="strict-origin-when-cross-origin" />
        </div>
      ) : c.type === "hls" && c.video ? (
        <HlsVideo url={c.video} />
      ) : c.type === "img" ? (
        <Snapshot c={c} />
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
      <div class="cam-note">
        {c.attribution ? `${c.attribution}. ` : ""}Feeds belong to their owners; recording or sharing some may need permission.
      </div>
    </div>
  );
}

export function CameraPanels() {
  return (
    <>
      {camPanels.value.map((c) => (
        <Panel key={c.id} c={c} />
      ))}
    </>
  );
}
