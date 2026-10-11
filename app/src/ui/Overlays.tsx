import { toasts } from "../store";
import { contextMenu, addPointAt, hover } from "../map/mapview";
import { displaySweep, activeTable } from "../radar/controller";
import { sampleAt } from "../radar/sweep";
import { fmtValue } from "../util";
import { toast, update, uid } from "../store";
import { camType } from "../overlays/mycams";
import { signal } from "@preact/signals";
import { useState } from "preact/hooks";

/** "Add camera" dialog: at a map position, or linked to a ship (cruise bridge cams). */
export const camDialog = signal<{ lat?: number; lon?: number; ship?: string } | null>(null);

export function AddCameraDialog() {
  const d = camDialog.value;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [ship, setShip] = useState(d?.ship ?? "");
  if (!d) return null;
  const ok = /^https?:\/\/\S+$/.test(url.trim()) && (d.lat !== undefined || ship.trim());
  const save = () => {
    const u = url.trim();
    const n = name.trim() || (camType(u) === "yt" ? "YouTube stream" : "Camera");
    update((s) => {
      s.myCams.push({ id: uid(), name: n, lat: d.lat ?? NaN, lon: d.lon ?? NaN, url: u, ship: ship.trim() || undefined });
      s.ovl.mycams = { ...(s.ovl.mycams ?? {}), on: true };
    });
    toast(`Added ${n}`);
    camDialog.value = null;
    setName("");
    setUrl("");
  };
  return (
    <div class="modal-back" onClick={() => (camDialog.value = null)}>
      <div class="modal glass small-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{d.lat !== undefined ? "Add camera here" : "Add a ship camera"}</h3>
        <input autoFocus placeholder="Name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <input placeholder="URL: YouTube, .m3u8 stream, image or web page" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && ok && save()} />
        {d.lat === undefined && <input placeholder="Ship name or MMSI" value={ship} onInput={(e) => setShip((e.target as HTMLInputElement).value)} />}
        {d.lat !== undefined && <p class="muted small">{d.lat.toFixed(4)}, {d.lon!.toFixed(4)}</p>}
        <div class="row">
          <button class="btn" disabled={!ok} onClick={save}>
            Add
          </button>
          <button class="btn ghost" onClick={() => (camDialog.value = null)}>
            Cancel
          </button>
        </div>
        <p class="muted small">Feeds belong to their owners. YouTube is watch-only.</p>
      </div>
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast glass ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ContextMenu() {
  const m = contextMenu.value;
  if (!m) return null;
  void hover.value;
  const s = displaySweep.value;
  const r = s ? sampleAt(s, m.lat, m.lon) : null;
  const close = () => (contextMenu.value = null);
  return (
    <div class="ctx glass" style={{ left: `${m.x + 8}px`, top: `${m.y + 8}px` }} onMouseLeave={close}>
      <div class="ctx-title">
        {m.lat.toFixed(4)}, {m.lon.toFixed(4)}
        {r && !Number.isNaN(r.value) && <b> · {fmtValue(r.value, activeTable.value.units, activeTable.value.labels)}</b>}
      </div>
      <button
        onClick={() => {
          addPointAt(m.lat, m.lon);
          close();
        }}
      >
        Add point here
      </button>
      <button
        onClick={() => {
          camDialog.value = { lat: m.lat, lon: m.lon };
          close();
        }}
      >
        Add camera here
      </button>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(`${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}`);
          toast("Copied coordinates");
          close();
        }}
      >
        Copy coordinates
      </button>
    </div>
  );
}
