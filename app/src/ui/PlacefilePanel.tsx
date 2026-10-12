// radar 0.6: Placefiles panel (rail button) and the placefile hover tooltip.

import { useRef, useState } from "preact/hooks";
import { settings, update } from "../store";
import { pfState, pfHover, addPlacefileUrl, addPlacefileFile, removePlacefile, reloadPlacefile } from "../radar/placefiles";
import { RefreshCw, Trash2, Upload, Plus } from "lucide-preact";

const ago = (t?: number) => {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

export function PlacefilePanel() {
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const list = settings.value.placefiles ?? [];
  const st = pfState.value;
  const set = (id: string, fn: (p: any) => void) => update((s) => s.placefiles.forEach((p) => p.id === id && fn(p)));
  return (
    <div class="stack r6-pf">
      <section>
        <label class="lbl">Add placefile</label>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) addPlacefileUrl(url);
            setUrl("");
          }}
        >
          <input type="url" placeholder="https://… placefile URL" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
          <button class="btn" type="submit" title="Add URL" disabled={!url.trim()}>
            <Plus size={15} />
          </button>
        </form>
        <div class="row">
          <button class="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Open file…
          </button>
          <span class="muted small">or drop a .txt / .pf file on the map</span>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.pf,.placefile,.plc,text/plain"
            multiple
            hidden
            onChange={(e) => {
              const fs = [...((e.target as HTMLInputElement).files ?? [])];
              fs.forEach((f) => addPlacefileFile(f));
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </div>
        <div class="muted small">GRLevelX placefiles: icons, lines, polygons, text and images. URLs are fetched through your server and refreshed as the file asks.</div>
      </section>
      <section>
        <label class="lbl">My placefiles</label>
        {!list.length && <div class="muted small">None yet.</div>}
        {list.map((p) => {
          const s = st[p.id] ?? {};
          return (
            <div class={`r6-pf-item ${p.on ? "on" : ""}`} key={p.id}>
              <div class="row">
                <label class="r6-pf-name" title={p.url || "Local file"}>
                  <input type="checkbox" checked={p.on} onChange={(e) => set(p.id, (x) => (x.on = (e.target as HTMLInputElement).checked))} />
                  <span>{p.name || s.title || p.url || "Placefile"}</span>
                </label>
                <button class="icon-btn" title="Reload now" onClick={() => reloadPlacefile(p.id)} disabled={!p.on}>
                  <RefreshCw size={14} class={s.loading ? "spin" : ""} />
                </button>
                <button class="icon-btn" title="Remove" onClick={() => removePlacefile(p.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div class="muted small r6-pf-meta">
                {s.error ? <span class="err">{s.error}</span> : s.loading ? "Loading…" : s.count != null ? `${s.count} items · ${p.url ? `updated ${ago(s.at)}` : "local file"}${s.refresh && p.url ? ` · every ${s.refresh >= 60 ? `${Math.round(s.refresh / 60)} min` : `${s.refresh}s`}` : ""}${s.warnings ? ` · ${s.warnings} unknown lines` : ""}` : p.on ? "" : "Off"}
              </div>
              {p.on && (
                <div class="row">
                  <span>Opacity</span>
                  <input type="range" min={10} max={100} value={Math.round(p.opacity * 100)} onChange={(e) => set(p.id, (x) => (x.opacity = +(e.target as HTMLInputElement).value / 100))} />
                  <span class="val">{Math.round(p.opacity * 100)}%</span>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

export function PlacefileHover() {
  const h = pfHover.value;
  if (!h) return null;
  return (
    <div class="r6-pf-hover glass" style={{ left: `${h.x + 14}px`, top: `${h.y + 14}px` }}>
      {h.text}
    </div>
  );
}
