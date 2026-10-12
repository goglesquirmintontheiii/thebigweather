// workflow 0.6: desktop widget views.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { X, Zap, CloudLightning, CloudRain, CloudSnow, Cloud, CloudSun, Sun, Moon, CloudFog, Wind, TriangleAlert, Timer } from "lucide-preact";
import { settings, type WidgetCfg } from "../store";
import { api } from "../api";
import { pointInGeometry, compass, fmtAge } from "../util";
import { pointById, forecastAt, feelsLikeF, fmtTempF, nearestMetar, nextArrival, nearestStrike, mrmsFrames, rasterFor, fmtMi, hhmm } from "../wf6data";
import { BUILTIN, rasterize, TEX_SIZE } from "../radar/colormaps";
import { rasterValue } from "../grid/raster";

const cfgOf = (id: string): WidgetCfg | undefined => settings.value.wf6?.widgets.find((w) => w.id === id);
function place(cfg?: WidgetCfg) {
  const p = pointById(cfg?.point ?? "");
  if (p) return { lat: p.lat, lon: p.lon, name: p.name };
  const c = settings.value.view.center;
  return { lat: c[1], lon: c[0], name: "Map center" };
}
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
/** run `fn` now and every `ms` (and when the server connects) */
function usePoll<T>(fn: () => Promise<T>, ms: number, deps: any[] = []): [T | null, string] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    const run = () =>
      fn()
        .then((x) => alive && (setV(x), setErr("")))
        .catch((e) => alive && setErr(e?.message ?? String(e)));
    run();
    const t = setInterval(run, ms);
    const off = api.on("connected", run);
    return () => {
      alive = false;
      clearInterval(t);
      off();
    };
  }, deps);
  return [v, err];
}

function Shell({ title, id, children, cls = "" }: { title: string; id: string; children: any; cls?: string }) {
  const close = () => {
    const io = (window as any).tbw?.wf6;
    if (io?.widgetClose) io.widgetClose(id);
    else window.close();
  };
  return (
    <div class={`wg ${cls}`}>
      <div class="wg-head">
        <span>{title}</span>
        <button class="wg-x" title="Close widget" onClick={close}>
          <X size={12} />
        </button>
      </div>
      <div class="wg-body">{children}</div>
    </div>
  );
}

function wxIcon(short: string, day = true, size = 34) {
  const s = short.toLowerCase();
  if (/thunder/.test(s)) return <CloudLightning size={size} />;
  if (/snow|flurr|sleet/.test(s)) return <CloudSnow size={size} />;
  if (/rain|shower|drizzle/.test(s)) return <CloudRain size={size} />;
  if (/fog|haze|smoke/.test(s)) return <CloudFog size={size} />;
  if (/wind/.test(s)) return <Wind size={size} />;
  if (/partly|mostly sunny|mostly clear/.test(s)) return <CloudSun size={size} />;
  if (/cloud|overcast/.test(s)) return <Cloud size={size} />;
  return day ? <Sun size={size} /> : <Moon size={size} />;
}

// ---------- current conditions ----------
function Current({ id }: { id: string }) {
  const p = place(cfgOf(id));
  const [d, err] = usePoll(async () => {
    const [fc, m] = await Promise.all([forecastAt(p.lat, p.lon), nearestMetar(p.lat, p.lon).catch(() => null)]);
    return { fc, m };
  }, 600_000, [p.lat, p.lon]);
  const h = d?.fc?.hourly.find((x) => Date.parse(x.t) + 3600_000 > Date.now()) ?? d?.fc?.hourly[0];
  const obsF = d?.m && d.m.dist < 30_000 && d.m.t != null ? d.m.t * 1.8 + 32 : null;
  const t = obsF ?? h?.temp_f ?? null;
  const feels = t != null ? feelsLikeF(t, h?.rh, h?.wind_mph) : null;
  return (
    <Shell title={p.name} id={id} cls="wg-current">
      {!h ? (
        <div class="wg-muted">{err || "Loading…"}</div>
      ) : (
        <>
          <div class="wg-now">
            <span class="wg-ic">{wxIcon(h.short, h.day !== false)}</span>
            <span class="wg-temp">{fmtTempF(t)}</span>
            <span class="wg-meta">
              <b>{h.short}</b>
              <small>Feels {fmtTempF(feels)}</small>
              <small>
                Wind {h.dir ?? ""} {h.wind_mph != null ? `${Math.round(h.wind_mph)} mph` : "—"}
                {h.gust_mph ? ` G${Math.round(h.gust_mph)}` : ""}
              </small>
            </span>
          </div>
          <div class="wg-hours">
            {(d?.fc?.hourly ?? [])
              .filter((x) => Date.parse(x.t) > Date.now())
              .slice(0, 6)
              .map((x) => (
                <div key={x.t}>
                  <small>{new Date(x.t).toLocaleTimeString(undefined, { hour: "numeric" })}</small>
                  {wxIcon(x.short, x.day !== false, 16)}
                  <b>{fmtTempF(x.temp_f).replace(/[FC]$/, "")}</b>
                  <small class="pop">{x.pop ? `${x.pop}%` : ""}</small>
                </div>
              ))}
          </div>
          {obsF != null && <div class="wg-foot">Observed at {d!.m!.id} · forecast {d?.fc?.source}</div>}
        </>
      )}
    </Shell>
  );
}

// ---------- alert ticker ----------
const alertMap = signal<Map<string, any>>(new Map());
let alertsStarted = false;
function startAlertFeed() {
  if (alertsStarted) return;
  alertsStarted = true;
  const load = () =>
    api
      .get("/api/alerts")
      .then((fc) => (alertMap.value = new Map((fc.features ?? []).map((f: any) => [f.properties.id, f]))))
      .catch(() => {});
  load();
  api.on("connected", load);
  api.on("alerts", (msg) => {
    const m = new Map(alertMap.value);
    for (const id of msg.removed ?? []) m.delete(id);
    for (const f of [...(msg.added ?? []), ...(msg.updated ?? [])]) m.set(f.properties.id, f);
    alertMap.value = m;
  });
}
function Ticker({ id }: { id: string }) {
  useEffect(startAlertFeed, []);
  const pts = settings.value.points;
  const items: { ev: string; where: string; until: string }[] = [];
  for (const a of alertMap.value.values()) {
    const p = a.properties;
    const hits = pts.filter((pt) => pointInGeometry(pt.lon, pt.lat, a.geometry)).map((pt) => pt.name);
    if (pts.length ? !hits.length : !String(p.event).endsWith("Warning")) continue;
    items.push({ ev: p.event, where: hits.join(", ") || String(p.areaDesc ?? "").split(";").slice(0, 2).join(","), until: p.ends ?? p.expires ?? "" });
  }
  const warn = items.some((i) => i.ev.endsWith("Warning"));
  const text = items.map((i) => `${i.ev} — ${i.where}${i.until ? ` until ${hhmm(Date.parse(i.until))}` : ""}`).join("     •     ");
  return (
    <Shell title={`Alerts${items.length ? ` (${items.length})` : ""}`} id={id} cls={`wg-ticker ${warn ? "warn" : ""}`}>
      <div class="wg-tick">
        <TriangleAlert size={16} />
        <div class="wg-tick-track">
          {items.length ? (
            <span class="wg-tick-text" style={{ animationDuration: `${Math.max(12, text.length / 7)}s` }}>
              {text}
            </span>
          ) : (
            <span class="wg-muted">No active alerts for {pts.length ? "your points" : "the US (warnings)"}</span>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------- storm countdown ----------
function Countdown({ id }: { id: string }) {
  const p = place(cfgOf(id));
  const [a, err] = usePoll(() => nextArrival(p), 60_000, [p.lat, p.lon]);
  useTick(1000);
  const left = a ? Math.max(0, a.at - Date.now()) : 0;
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  return (
    <Shell title={`Storm arrival · ${p.name}`} id={id} cls={`wg-count ${a ? (a.flags ? "bad" : "on") : ""}`}>
      {a ? (
        <>
          <div class="wg-big">
            <Timer size={22} /> {left <= 0 ? "Now" : `${mm}:${String(ss).padStart(2, "0")}`}
          </div>
          <div class="wg-sub">
            Cell {a.cell.p.storm_id} ({a.cell.p.nexrad}){a.flags ? ` · ${a.flags}` : ""} · ~{hhmm(a.at)}
          </div>
        </>
      ) : (
        <div class="wg-muted">{err || `No tracked storm heading for ${p.name} in the next hour`}</div>
      )}
    </Shell>
  );
}

// ---------- lightning ----------
function Lightning({ id }: { id: string }) {
  const p = place(cfgOf(id));
  const [s, err] = usePoll(() => nearestStrike(p.lat, p.lon, 15, 160_000), 60_000, [p.lat, p.lon]);
  useTick(15_000);
  const near = s && s.dist < 16_000;
  return (
    <Shell title={`Lightning · ${p.name}`} id={id} cls={`wg-ltg ${near ? "bad" : s ? "on" : ""}`}>
      {s ? (
        <>
          <div class="wg-big">
            <Zap size={22} /> {fmtMi(s.dist)} {compass(s.brg)}
          </div>
          <div class="wg-sub">
            {Math.max(1, Math.round(s.age / 60000))} min ago · {s.count} flash{s.count === 1 ? "" : "es"} within 100 mi (15 min)
          </div>
        </>
      ) : (
        <div class="wg-muted">{err || "No lightning within 100 mi in the last 15 min"}</div>
      )}
    </Shell>
  );
}

// ---------- clock ----------
function Clock({ id }: { id: string }) {
  useTick(1000);
  const [f] = usePoll(() => mrmsFrames("cref", 1), 60_000);
  const t = f?.at(-1)?.time;
  const d = new Date();
  return (
    <Shell title="Clock" id={id} cls="wg-clock">
      <div class="wg-time">{d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>
      <div class="wg-sub">
        {d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {d.toISOString().slice(11, 16)}Z
      </div>
      <div class={`wg-age ${t && Date.now() - t > 15 * 60_000 ? "old" : ""}`}>Radar {t ? fmtAge(t) : "—"}</div>
    </Shell>
  );
}

// ---------- mini radar ----------
const LUT = (() => {
  const t = BUILTIN.REF;
  return { px: rasterize(t), min: t.min, max: t.max };
})();
function MiniRadar({ id }: { id: string }) {
  const cfg = cfgOf(id);
  const p = place(cfg);
  const [zoom, setZoom] = useState(cfg?.zoom ?? 7);
  const cv = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState("Loading…");
  const st = useRef<{ base: HTMLCanvasElement | null; frames: { time: number; img: HTMLCanvasElement }[]; i: number }>({ base: null, frames: [], i: 0 });
  useEffect(() => {
    let alive = true;
    const el = cv.current!;
    const W = el.clientWidth, H = el.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    el.width = W * dpr;
    el.height = H * dpr;
    const size = 256 * 2 ** zoom;
    const cx = ((p.lon + 180) / 360) * size;
    const sl = Math.sin((p.lat * Math.PI) / 180);
    const cy = (0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI)) * size;
    const x0 = cx - W / 2, y0 = cy - H / 2;
    const lonOf = (x: number) => (x / size) * 360 - 180;
    const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI;
    // basemap tiles (CARTO dark with labels)
    const base = document.createElement("canvas");
    base.width = el.width;
    base.height = el.height;
    const bg = base.getContext("2d")!;
    bg.fillStyle = "#0b0e13";
    bg.fillRect(0, 0, base.width, base.height);
    st.current.base = base;
    const n = 2 ** zoom;
    const loads: Promise<void>[] = [];
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
      for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const img = new Image();
        img.crossOrigin = "anonymous";
        const sub = "abcd"[(tx + ty) & 3];
        img.src = `https://${sub}.basemaps.cartocdn.com/dark_all/${zoom}/${((tx % n) + n) % n}/${ty}${dpr > 1 ? "@2x" : ""}.png`;
        loads.push(
          new Promise((r) => {
            img.onload = () => {
              bg.drawImage(img, (tx * 256 - x0) * dpr, (ty * 256 - y0) * dpr, 256 * dpr, 256 * dpr);
              r();
            };
            img.onerror = () => r();
          }),
        );
      }
    // radar frames
    const loadFrames = async () => {
      try {
        const fs = await mrmsFrames("cref", 8);
        const w = lonOf(x0), e = lonOf(x0 + W), nN = latOf(y0), s = latOf(y0 + H);
        const rw = Math.round(W / 1.5), rh = Math.round(H / 1.5);
        const out: { time: number; img: HTMLCanvasElement }[] = [];
        for (const f of fs) {
          const r = await rasterFor(f.key, w, s, e, nN, rw, rh).catch(() => null);
          if (!r || !alive) continue;
          const c = document.createElement("canvas");
          c.width = rw;
          c.height = rh;
          const g = c.getContext("2d")!;
          const im = g.createImageData(rw, rh);
          for (let j = 0; j < rh; j++)
            for (let i = 0; i < rw; i++) {
              const v = rasterValue(r, latOf(y0 + ((j + 0.5) / rh) * H), lonOf(x0 + ((i + 0.5) / rw) * W));
              if (!(v >= 5)) continue;
              const k = Math.max(0, Math.min(TEX_SIZE - 1, Math.floor(((v - LUT.min) / (LUT.max - LUT.min)) * TEX_SIZE))) * 4;
              const o = (j * rw + i) * 4;
              im.data[o] = LUT.px[k];
              im.data[o + 1] = LUT.px[k + 1];
              im.data[o + 2] = LUT.px[k + 2];
              im.data[o + 3] = Math.min(235, LUT.px[k + 3]);
            }
          g.putImageData(im, 0, 0);
          out.push({ time: f.time, img: c });
        }
        if (alive) {
          st.current.frames = out;
          st.current.i = out.length - 1;
          if (!out.length) setInfo("No radar data");
        }
      } catch (e: any) {
        if (alive) setInfo(e.message);
      }
    };
    loadFrames();
    const refresh = setInterval(loadFrames, 120_000);
    Promise.all(loads).then(() => draw());
    const draw = () => {
      const g = el.getContext("2d")!;
      if (st.current.base) g.drawImage(st.current.base, 0, 0);
      const fr = st.current.frames[st.current.i];
      if (fr) {
        g.imageSmoothingEnabled = true;
        g.drawImage(fr.img, 0, 0, el.width, el.height);
        setInfo(`${hhmm(fr.time)} · ${st.current.i + 1}/${st.current.frames.length}`);
      }
      g.fillStyle = "#fff";
      g.strokeStyle = "#000";
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(el.width / 2, el.height / 2, 4 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    };
    let last = 0;
    const loop = setInterval(() => {
      const f = st.current.frames;
      if (!f.length) return draw();
      const now = Date.now();
      const atEnd = st.current.i === f.length - 1;
      if (atEnd && now - last < 1500) return;
      last = now;
      st.current.i = (st.current.i + 1) % f.length;
      draw();
    }, 400);
    return () => {
      alive = false;
      clearInterval(loop);
      clearInterval(refresh);
    };
  }, [p.lat, p.lon, zoom]);
  return (
    <Shell title={`Radar · ${p.name}`} id={id} cls="wg-radar">
      <canvas ref={cv} class="wg-canvas" onWheel={(e) => setZoom((z) => Math.max(4, Math.min(10, z + (e.deltaY < 0 ? 1 : -1))))} />
      <div class="wg-radar-info">MRMS · {info}</div>
    </Shell>
  );
}

export function WidgetApp({ kind, id }: { kind: string; id: string }) {
  switch (kind) {
    case "radar":
      return <MiniRadar id={id} />;
    case "current":
      return <Current id={id} />;
    case "alerts":
      return <Ticker id={id} />;
    case "countdown":
      return <Countdown id={id} />;
    case "lightning":
      return <Lightning id={id} />;
    default:
      return <Clock id={id} />;
  }
}
