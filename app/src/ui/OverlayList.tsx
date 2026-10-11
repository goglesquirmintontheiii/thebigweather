// Overlay toggles with a config gear per layer (style + layer options).

import { useState, useRef } from "preact/hooks";
import { settings, update, type OvlSettings } from "../store";
import { OVERLAYS, styleFor, optsFor, type OverlayDef } from "../overlays/defs";
import { ovlStatus, ovlMeta } from "../overlays/manager";
import { fileOverlays, importFile, removeFile } from "../overlays/files";
import { Settings2, ChevronRight, Upload, Trash2, Loader, AlertTriangle } from "lucide-preact";
import { camDialog } from "./Overlays";

function setOvl(id: string, fn: (o: OvlSettings) => void) {
  update((s) => {
    const o = { ...(s.ovl[id] ?? {}) };
    fn(o);
    s.ovl[id] = o;
  });
}

function Status({ id }: { id: string }) {
  const st = ovlStatus.value[id];
  if (!settings.value.ovl[id]?.on || !st) return null;
  if (st.loading && st.count === undefined) return <Loader size={12} class="spin muted" />;
  if (st.error)
    return (
      <span class="ovl-err" title={st.error}>
        <AlertTriangle size={12} />
      </span>
    );
  if (st.note) return <span class="ovl-count muted">{st.note}</span>;
  return st.count !== undefined ? <span class="ovl-count muted">{st.count.toLocaleString()}</span> : null;
}

export function StyleControls({ id, def }: { id: string; def: Partial<{ color: string; opacity: number; size: number; labels: boolean }> }) {
  const o = settings.value.ovl[id] ?? {};
  return (
    <>
      {def.color !== undefined && (
        <div class="row">
          <span>Color</span>
          <input type="color" value={o.color ?? def.color} onInput={(e) => setOvl(id, (x) => (x.color = (e.target as HTMLInputElement).value))} />
        </div>
      )}
      {def.opacity !== undefined && (
        <div class="row">
          <span>Opacity</span>
          <input type="range" min={10} max={100} value={Math.round((o.opacity ?? def.opacity) * 100)} onInput={(e) => setOvl(id, (x) => (x.opacity = +(e.target as HTMLInputElement).value / 100))} />
          <span class="val">{Math.round((o.opacity ?? def.opacity) * 100)}%</span>
        </div>
      )}
      {def.size !== undefined && (
        <div class="row">
          <span>Size</span>
          <input type="range" min={30} max={300} value={Math.round(((o.size ?? def.size) / def.size) * 100)} onInput={(e) => setOvl(id, (x) => (x.size = (def.size! * +(e.target as HTMLInputElement).value) / 100))} />
          <span class="val">{Math.round(((o.size ?? def.size) / def.size) * 100)}%</span>
        </div>
      )}
      {def.labels !== undefined && (
        <label class="toggle">
          <span>Labels</span>
          <input type="checkbox" checked={o.labels ?? def.labels} onChange={(e) => setOvl(id, (x) => (x.labels = (e.target as HTMLInputElement).checked))} />
          <i />
        </label>
      )}
      {Object.keys(o).some((k) => k !== "on" && k !== "opts") && (
        <button class="btn sm ghost" onClick={() => setOvl(id, (x) => (delete x.color, delete x.opacity, delete x.size, delete x.labels))}>
          Reset style
        </button>
      )}
    </>
  );
}

function CameraSources() {
  const srcs: any[] = ovlMeta.value.cameras ?? [];
  if (!srcs.length) return <div class="muted small">Turn on to load the camera list.</div>;
  const offStr = settings.value.ovl.cameras?.opts?.off;
  const off = new Set(offStr !== undefined ? offStr.split(",").filter(Boolean) : srcs.filter((s) => s.off).map((s) => s.id));
  const toggle = (id: string, on: boolean) =>
    setOvl("cameras", (x) => {
      const n = new Set(off);
      if (on) n.delete(id);
      else n.add(id);
      x.opts = { ...(x.opts ?? {}), off: [...n].join(",") };
    });
  return (
    <div class="cam-srcs">
      {srcs.map((s) => (
        <label key={s.id} class="cam-src" title={s.attribution}>
          <input type="checkbox" checked={!off.has(s.id)} onChange={(e) => toggle(s.id, (e.target as HTMLInputElement).checked)} />
          <span>{s.name}</span>
          <small class="muted">
            {s.region} · {s.count}
          </small>
        </label>
      ))}
    </div>
  );
}

function MyCamList() {
  const cams = settings.value.myCams;
  return (
    <div class="cam-srcs">
      {cams.length === 0 && <div class="muted small">None yet.</div>}
      {cams.map((c) => (
        <div key={c.id} class="cam-src">
          <span title={c.url}>{c.name}</span>
          <small class="muted">{c.ship ? `ship: ${c.ship}` : `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`}</small>
          <button class="icon-btn" title="Remove" onClick={() => update((s) => (s.myCams = s.myCams.filter((x) => x.id !== c.id)))}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button class="btn sm ghost" onClick={() => (camDialog.value = { ship: "" })}>
        Add ship camera
      </button>
    </div>
  );
}

function Config({ d }: { d: OverlayDef }) {
  const opts = optsFor(d);
  return (
    <div class="ovl-config">
      {d.options?.map((op) => (
        <div class="row" key={op.key}>
          <span>{op.label}</span>
          <select value={opts[op.key]} onChange={(e) => setOvl(d.id, (x) => (x.opts = { ...(x.opts ?? {}), [op.key]: (e.target as HTMLSelectElement).value }))}>
            {op.choices.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      ))}
      <StyleControls id={d.id} def={d.style} />
      {d.id === "cameras" && <CameraSources />}
      {d.id === "mycams" && <MyCamList />}
      {d.note && <p class="muted small">{d.note}</p>}
      {ovlStatus.value[d.id]?.error && <p class="err-text small">{ovlStatus.value[d.id]?.error}</p>}
    </div>
  );
}

function Row({ d }: { d: OverlayDef }) {
  const [open, setOpen] = useState(false);
  const on = !!settings.value.ovl[d.id]?.on;
  void styleFor;
  return (
    <div class={`ovl-row ${open ? "open" : ""}`}>
      <div class="ovl-line">
        <label class="ovl-toggle">
          <input type="checkbox" checked={on} onChange={(e) => setOvl(d.id, (x) => (x.on = (e.target as HTMLInputElement).checked))} />
          <span>{d.name}</span>
        </label>
        <Status id={d.id} />
        <button class={`icon-btn gear ${open ? "on" : ""}`} title="Configure" onClick={() => setOpen(!open)}>
          <Settings2 size={13} />
        </button>
      </div>
      {open && <Config d={d} />}
    </div>
  );
}

function FileRow({ id, name, count }: { id: string; name: string; count: number }) {
  const [open, setOpen] = useState(false);
  const key = `file:${id}`;
  const on = !!settings.value.ovl[key]?.on;
  return (
    <div class={`ovl-row ${open ? "open" : ""}`}>
      <div class="ovl-line">
        <label class="ovl-toggle">
          <input type="checkbox" checked={on} onChange={(e) => setOvl(key, (x) => (x.on = (e.target as HTMLInputElement).checked))} />
          <span title={name}>{name}</span>
        </label>
        <span class="ovl-count muted">{count}</span>
        <button class={`icon-btn gear ${open ? "on" : ""}`} title="Configure" onClick={() => setOpen(!open)}>
          <Settings2 size={13} />
        </button>
      </div>
      {open && (
        <div class="ovl-config">
          <StyleControls id={key} def={{ color: "#f472b6", opacity: 0.8, size: 2, labels: true }} />
          <button class="btn sm ghost" onClick={() => removeFile(id)}>
            <Trash2 size={13} /> Remove file
          </button>
        </div>
      )}
    </div>
  );
}

export function OverlayGroups() {
  const groups = [...new Set(OVERLAYS.map((o) => o.group))];
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const count = (g: string) => OVERLAYS.filter((o) => o.group === g && settings.value.ovl[o.id]?.on).length;
  return (
    <>
      {groups.map((g) => (
        <section key={g} class="ovl-group">
          <button class="ovl-ghead" onClick={() => setShut({ ...shut, [g]: !shut[g] })}>
            <ChevronRight size={13} class={shut[g] ? "" : "rot"} />
            <span>{g}</span>
            {count(g) > 0 && <span class="ovl-badge">{count(g)}</span>}
          </button>
          {!shut[g] &&
            OVERLAYS.filter((o) => o.group === g).map((d) => (
              <Row key={d.id} d={d} />
            ))}
        </section>
      ))}
      <section class="ovl-group">
        <div class="ovl-ghead static">
          <span>My files</span>
          <button class="btn sm" onClick={() => fileRef.current?.click()} title="GeoJSON, KML, KMZ or GPX (or drop on the map)">
            <Upload size={13} /> Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".geojson,.json,.kml,.kmz,.gpx"
            multiple
            hidden
            onChange={async (e) => {
              const fs = [...((e.target as HTMLInputElement).files ?? [])];
              for (const f of fs) await importFile(f);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </div>
        {fileOverlays.value.length === 0 && <div class="muted small">No files yet. GeoJSON, KML, KMZ or GPX.</div>}
        {fileOverlays.value.map((f) => (
          <FileRow key={f.id} {...f} />
        ))}
      </section>
    </>
  );
}
