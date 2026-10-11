// Recordings: record radar or cameras on the server (now, scheduled, or when warnings come
// in), play them back, export/import as .zip.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { api } from "../../api";
import { settings, update, toast, activeServer } from "../../store";
import { pinned, playingRec, l3Products, currentSite } from "../../radar/controller";
import { ALERT_COLORS } from "../../alerts";
import { openCamera } from "../CameraPanels";
import { Circle, Square, Play, Trash2, Download, Upload, RefreshCw, Film } from "lucide-preact";
import { Toggle } from "./RadarPanel";

export interface Rec {
  id: string;
  kind: "radar" | "camera";
  title: string;
  created: number;
  start: number;
  end: number | null;
  status: "scheduled" | "recording" | "done" | "error";
  error: string;
  radar?: { site: string; source: string; products: string[] };
  camera?: { id: string; name: string; url: string; kind: string; refresh: number; lat: number; lon: number };
  trigger: string;
  files: number;
  bytes: number;
  t0: number;
  t1: number;
}
interface Rules {
  enabled: boolean;
  events: string[];
  minutes: number;
  max_cams: number;
  radar: boolean;
  points: [number, number][];
}

export const recs = signal<Rec[]>([]);
const rules = signal<Rules | null>(null);
const ffmpeg = signal(true);

export async function loadRecs() {
  try {
    const r = await api.get("/api/rec");
    recs.value = r.recs;
    rules.value = r.rules;
    ffmpeg.value = r.ffmpeg;
  } catch {
    /* offline */
  }
}
let t: number | undefined;
api.on("recording", () => {
  clearTimeout(t);
  t = window.setTimeout(loadRecs, 400);
});
api.on("connected", loadRecs);

export function fileUrl(path: string) {
  const s = activeServer.value;
  const tok = s?.token ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(s.token)}` : "";
  return `${api.base}${path}${tok}`;
}

/** Start recording a camera (from its popup). */
export async function recordCamera(p: any, minutes = 60) {
  const url = p.t === "hls" ? p.v : p.i;
  try {
    await api.send("POST", "/api/rec", {
      kind: "camera",
      end: Date.now() + minutes * 60_000,
      camera: { id: p.id ?? "", name: p.n ?? "Camera", url, kind: p.t, refresh: p.r ?? 60, lat: 0, lon: 0 },
    });
    toast(`Recording ${p.n ?? "camera"} for ${minutes} min (Recordings panel)`);
    loadRecs();
  } catch (e: any) {
    toast(e.message, "error", 7000);
  }
}

export async function playRec(r: Rec) {
  try {
    const res = await api.get(`/api/rec/${r.id}/frames`);
    const fr: any[] = res.frames;
    if (!fr.length) return toast("Nothing recorded yet", "info");
    if (r.kind === "radar") {
      const l3 = r.radar?.source === "L3";
      update((s) => {
        s.weather = { kind: "radar" };
        s.radar.site = r.radar!.site.length === 3 ? `K${r.radar!.site}` : r.radar!.site;
        s.radar.source = l3 ? "L3" : "L2";
        if (l3) s.radar.product = r.radar!.products[0];
        else if (r.radar!.products[0]) s.radar.product = r.radar!.products[0];
      });
      // after the site switch has settled
      setTimeout(() => {
        pinned.value = fr.map((f) => ({ key: f.key, time: f.time, product: f.product || undefined }));
        playingRec.value = r.title;
      }, 200);
    } else {
      openCamera({ id: `rec:${r.id}`, n: r.title, sn: "Recording", t: "rec", rec: { id: r.id, frames: fr }, a: "Recorded on your server" });
    }
  } catch (e: any) {
    toast(e.message, "error");
  }
}

async function download(path: string, name: string) {
  const url = fileUrl(path);
  const tbw = (window as any).tbw;
  if (tbw?.download) {
    toast("Exporting…");
    const f = await tbw.download(url, name);
    toast(f ? `Saved ${f}` : "Export failed", f ? "info" : "error", 7000);
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  }
}

const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);
const when = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined }) : "—");

const DURATIONS: [number, string][] = [
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 h"],
  [120, "2 h"],
  [360, "6 h"],
  [0, "Until I stop it"],
];

function NewRadar() {
  const r = settings.value.radar;
  const [src, setSrc] = useState<"L2" | "L3">(r.source);
  const [prods, setProds] = useState<string[]>(r.source === "L3" ? [r.product] : [r.product]);
  const [mins, setMins] = useState(60);
  const [at, setAt] = useState("");
  const site = currentSite.value;
  const l3 = l3Products.value.filter((p) => !!p.tdwr === (site?.type === "TDWR"));
  const go = async () => {
    const start = at ? Date.parse(at) : 0;
    const begin = start || Date.now();
    try {
      await api.send("POST", "/api/rec", { kind: "radar", start, end: mins ? begin + mins * 60_000 : null, radar: { site: r.site, source: src, products: prods.slice(0, 4) } });
      toast(start > Date.now() ? "Recording scheduled" : `Recording ${r.site}`);
      loadRecs();
    } catch (e: any) {
      toast(e.message, "error", 7000);
    }
  };
  return (
    <div class="rec-new">
      <div class="row">
        <span>Radar</span>
        <b>{r.site}</b>
        <div class="seg sm">
          {(["L2", "L3"] as const).map((x) => (
            <button key={x} class={src === x ? "on" : ""} onClick={() => (setSrc(x), setProds(x === "L3" ? [l3.find((p) => p.id === r.product)?.id ?? l3[0]?.id ?? "N0B"] : ["REF"]))}>
              {x === "L2" ? "Level II" : "Level III"}
            </button>
          ))}
        </div>
      </div>
      {src === "L3" && (
        <div class="chips">
          {l3.slice(0, 40).map((p) => (
            <button
              key={p.id}
              class={`chip ${prods.includes(p.id) ? "on" : ""}`}
              title={p.name}
              onClick={() => setProds(prods.includes(p.id) ? prods.filter((x) => x !== p.id) : [...prods, p.id].slice(-4))}
            >
              {p.id}
            </button>
          ))}
        </div>
      )}
      {src === "L2" && <p class="muted small">Whole volumes are saved, so every product and tilt plays back.</p>}
      {src === "L3" && <p class="muted small">Up to 4 products ({prods.length} picked).</p>}
      <div class="row">
        <span>For</span>
        <select value={String(mins)} onChange={(e) => setMins(+(e.target as HTMLSelectElement).value)}>
          {DURATIONS.map(([m, l]) => (
            <option key={m} value={m}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <span>Start</span>
        <input type="datetime-local" value={at} onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
        {at && (
          <button class="btn xs ghost" onClick={() => setAt("")}>
            Now
          </button>
        )}
      </div>
      <button class="btn sm rec-btn" onClick={go} disabled={src === "L3" && !prods.length}>
        <Circle size={12} class="rec-dot" /> {at ? "Schedule" : "Record radar"}
      </button>
    </div>
  );
}

const ALERT_EVENTS = Object.keys(ALERT_COLORS).filter((e) => e.endsWith("Warning") || e.endsWith("Emergency"));

function RulesBox() {
  const r = rules.value;
  if (!r) return null;
  const save = async (n: Rules) => {
    rules.value = n;
    try {
      await api.send("PUT", "/api/rec/rules", n);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  const pts = settings.value.points;
  return (
    <div class="rec-new">
      <Toggle label="Record when new warnings come in" on={r.enabled} set={(v) => save({ ...r, enabled: v })} />
      {r.enabled && (
        <>
          <div class="chips">
            {ALERT_EVENTS.map((e) => (
              <button key={e} class={`chip ${r.events.includes(e) ? "on" : ""}`} onClick={() => save({ ...r, events: r.events.includes(e) ? r.events.filter((x) => x !== e) : [...r.events, e] })}>
                {e.replace(" Warning", "")}
              </button>
            ))}
          </div>
          <div class="row">
            <span>For</span>
            <select value={String(r.minutes)} onChange={(e) => save({ ...r, minutes: +(e.target as HTMLSelectElement).value })}>
              {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
          <Toggle label="Nearest radar (Level II)" on={r.radar} set={(v) => save({ ...r, radar: v })} />
          <div class="row">
            <span>Cameras inside</span>
            <input type="range" min={0} max={8} value={r.max_cams} onInput={(e) => save({ ...r, max_cams: +(e.target as HTMLInputElement).value })} />
            <span class="val">{r.max_cams}</span>
          </div>
          <Toggle
            label={`Only warnings covering my points (${pts.length})`}
            on={r.points.length > 0}
            set={(v) => save({ ...r, points: v ? pts.map((p) => [p.lon, p.lat] as [number, number]) : [] })}
          />
          {!ffmpeg.value && <p class="muted small">Video cameras are skipped: ffmpeg isn't installed on the server.</p>}
        </>
      )}
    </div>
  );
}

function RecRow({ r }: { r: Rec }) {
  const live = r.status === "recording";
  return (
    <div class={`rec-row ${r.status}`}>
      <span class={`rec-status ${r.status}`} title={r.status} />
      <div class="rec-main">
        <b title={r.title}>{r.title}</b>
        <small class="muted">
          {r.status === "scheduled" ? `starts ${when(r.start)}` : `${when(r.t0 || r.start)}${r.t1 ? ` – ${new Date(r.t1).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: settings.value.utc ? "UTC" : undefined })}` : ""}`} · {r.files} {r.kind === "radar" ? "volumes" : "files"} · {size(r.bytes)}
          {r.trigger.startsWith("alert") ? ` · ${r.trigger}` : ""}
        </small>
        {r.error && <small class="err-text">{r.error}</small>}
      </div>
      {r.files > 0 && (
        <button class="icon-btn" title="Play" onClick={() => playRec(r)}>
          <Play size={13} />
        </button>
      )}
      {r.kind === "camera" && r.camera?.kind === "img" && r.files > 1 && ffmpeg.value && (
        <button class="icon-btn" title="Timelapse video" onClick={() => download(`/api/rec/${r.id}/timelapse?fps=10`, `${r.id}-timelapse.mp4`)}>
          <Film size={13} />
        </button>
      )}
      {(live || r.status === "scheduled") && (
        <button class="icon-btn" title="Stop" onClick={() => api.send("POST", `/api/rec/${r.id}/stop`, {}).then(loadRecs)}>
          <Square size={13} />
        </button>
      )}
      <button class="icon-btn" title="Export (.zip)" onClick={() => download(`/api/rec/export?ids=${r.id}`, `${r.id}.zip`)}>
        <Download size={13} />
      </button>
      <button
        class="icon-btn"
        title="Delete"
        onClick={() => {
          if (confirmDelete(r)) api.send("DELETE", `/api/rec/${r.id}`, {}).then(loadRecs);
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

const armed = new Map<string, number>();
/** Delete needs two clicks within 3 s (no blocking dialogs in the app). */
function confirmDelete(r: Rec) {
  const t = armed.get(r.id);
  if (t && Date.now() - t < 3000) {
    armed.delete(r.id);
    return true;
  }
  armed.set(r.id, Date.now());
  toast(`Click delete again to remove "${r.title}"`, "warn", 3000);
  return false;
}

export function RecordPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadRecs();
    const i = setInterval(() => recs.value.some((r) => r.status === "recording") && loadRecs(), 15000);
    return () => clearInterval(i);
  }, []);
  const list = recs.value;
  return (
    <div class="stack">
      <section>
        <label class="lbl">New radar recording</label>
        <NewRadar />
        <p class="muted small">To record a camera, click it on the map → Record. YouTube is watch-only.</p>
      </section>
      <section>
        <label class="lbl">Record on warnings</label>
        <RulesBox />
      </section>
      <section>
        <div class="row">
          <label class="lbl" style={{ flex: 1 }}>
            Library · {list.length}
          </label>
          <button class="icon-btn" title="Refresh" onClick={loadRecs}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div class="row">
          <button class="btn sm ghost" disabled={!list.length} onClick={() => download("/api/rec/export", "TheBigWeather-recordings.zip")}>
            <Download size={13} /> Export all
          </button>
          <button class="btn sm ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> {busy ? "Importing…" : "Import .zip"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            hidden
            onChange={async (e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              (e.target as HTMLInputElement).value = "";
              if (!f) return;
              setBusy(true);
              try {
                const r = await api.send("POST", "/api/rec/import", f, false);
                toast(`Imported ${r.imported.length} recording${r.imported.length === 1 ? "" : "s"}`);
                loadRecs();
              } catch (err: any) {
                toast(err.message, "error", 7000);
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
        {list.length === 0 && <div class="muted small">No recordings yet.</div>}
        {list.map((r) => (
          <RecRow key={r.id} r={r} />
        ))}
        <p class="muted small">Recordings stay on the server until you delete them. Recording or sharing some camera feeds may need the owner's permission.</p>
      </section>
    </div>
  );
}
