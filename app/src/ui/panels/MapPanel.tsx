import { settings, update, uid, toast, type CustomBasemap } from "../../store";
import { BASEMAPS, customTiles, isDarkBasemap } from "../../map/basemaps";
import { useState } from "preact/hooks";
import { Plus, Trash2, Pencil, Check } from "lucide-preact";
import { Toggle } from "./RadarPanel";

/** Try one tile so a broken URL shows an error instead of an empty map. */
async function testTile(c: Omit<CustomBasemap, "id">): Promise<string | null> {
  const z = Math.max(c.minzoom, Math.min(c.maxzoom, 4));
  const n = 2 ** z;
  // tile over the middle of the US at that zoom
  const x = Math.floor(((-97 + 180) / 360) * n);
  const lat = (38 * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
  const url = customTiles({ ...c, id: "t" })[0].replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)).replace("{-y}", String(n - 1 - y)).replace("{r}", "");
  try {
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) return `HTTP ${r.status}`;
    const ct = r.headers.get("content-type") ?? "";
    if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) return `not an image (${ct})`;
    return null;
  } catch (e: any) {
    return e?.message ?? "unreachable";
  }
}

function CustomForm({ init, done }: { init?: CustomBasemap; done: () => void }) {
  const [f, setF] = useState<Omit<CustomBasemap, "id">>(init ?? { name: "", url: "", subdomains: "abc", minzoom: 0, maxzoom: 19, dark: true, labels: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = f.name.trim() && /^https?:\/\/.+/.test(f.url) && /\{z\}/.test(f.url) && /\{x\}/.test(f.url) && /\{-?y\}/.test(f.url);
  const save = async () => {
    setBusy(true);
    const e = await testTile(f);
    setBusy(false);
    if (e) setErr(`Test tile failed: ${e}. Saved anyway — check the URL if the map stays empty.`);
    const id = init?.id ?? uid();
    update((x) => {
      const c = { ...f, id, name: f.name.trim() };
      const i = x.customBasemaps.findIndex((y) => y.id === id);
      if (i >= 0) x.customBasemaps[i] = c;
      else x.customBasemaps.push(c);
      x.basemap = `custom:${id}`;
    });
    if (!e) {
      toast(`Using ${f.name.trim()}`);
      done();
    }
  };
  return (
    <div class="custom-bm-form">
      <input placeholder="Name" value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} />
      <input placeholder="https://{s}.example.com/{z}/{x}/{y}.png" value={f.url} onInput={(e) => setF({ ...f, url: (e.target as HTMLInputElement).value.trim() })} />
      <div class="row">
        <span>Subdomains</span>
        <input class="sm" placeholder="abc or mt0,mt1" value={f.subdomains} onInput={(e) => setF({ ...f, subdomains: (e.target as HTMLInputElement).value })} />
      </div>
      <div class="row">
        <span>Zoom</span>
        <input class="num" type="number" min={0} max={24} value={f.minzoom} onInput={(e) => setF({ ...f, minzoom: +(e.target as HTMLInputElement).value })} />
        <span>to</span>
        <input class="num" type="number" min={0} max={24} value={f.maxzoom} onInput={(e) => setF({ ...f, maxzoom: +(e.target as HTMLInputElement).value })} />
      </div>
      <Toggle label="Dark map (light overlays)" on={f.dark} set={(v) => setF({ ...f, dark: v })} />
      <Toggle label="Add CARTO place names on top" on={!!f.labels} set={(v) => setF({ ...f, labels: v })} />
      {err && <p class="err-text small">{err}</p>}
      <div class="row">
        <button class="btn sm" disabled={!valid || busy} onClick={save}>
          <Check size={13} /> {busy ? "Testing…" : init ? "Save" : "Add"}
        </button>
        <button class="btn sm ghost" onClick={done}>
          {err ? "Close" : "Cancel"}
        </button>
      </div>
      <p class="muted small">Use {"{x} {y} {z}"} (or {"{-y}"} for TMS) and optionally {"{s}"}. Only use tile servers you're allowed to use.</p>
    </div>
  );
}

function CustomBasemaps() {
  const s = settings.value;
  const [edit, setEdit] = useState<string | "new" | null>(null);
  return (
    <div class="custom-bm">
      {s.customBasemaps.map((c) =>
        edit === c.id ? (
          <CustomForm key={c.id} init={c} done={() => setEdit(null)} />
        ) : (
          <div key={c.id} class={`custom-bm-row ${s.basemap === `custom:${c.id}` ? "on" : ""}`}>
            <button class="custom-bm-name" onClick={() => update((x) => (x.basemap = `custom:${c.id}`))} title={customTiles(c)[0]}>
              {c.name}
            </button>
            <span class="muted small">
              z{c.minzoom}–{c.maxzoom}
            </span>
            <button class="icon-btn" title="Edit" onClick={() => setEdit(c.id)}>
              <Pencil size={12} />
            </button>
            <button class="icon-btn" title="Remove" onClick={() => update((x) => ((x.customBasemaps = x.customBasemaps.filter((y) => y.id !== c.id)), x.basemap === `custom:${c.id}` && (x.basemap = "dark")))}>
              <Trash2 size={13} />
            </button>
          </div>
        ),
      )}
      {edit === "new" ? (
        <CustomForm done={() => setEdit(null)} />
      ) : (
        <button class="btn sm ghost" onClick={() => setEdit("new")}>
          <Plus size={13} /> Custom tile server
        </button>
      )}
    </div>
  );
}

const SWATCH: Record<string, string> = {
  dark: "linear-gradient(135deg,#0b0e13,#1f2630)",
  light: "linear-gradient(135deg,#f4f5f7,#d9dde3)",
  road: "linear-gradient(135deg,#f2efe9,#f6c85f 60%,#f2efe9)",
  darkroad: "linear-gradient(135deg,#0d1117,#c9a227 55%,#0d1117)",
  terrain: "linear-gradient(135deg,#c8d3b0,#9a8c6a)",
  satellite: "linear-gradient(135deg,#1d3b2a,#4a5a3a 50%,#2a3f5a)",
  google: "linear-gradient(135deg,#21402e,#56663f 50%,#2d4766)",
  offline: "linear-gradient(135deg,#0b1016,#151b23)",
};

export function MapPanel() {
  const s = settings.value;
  const custom = s.basemap.startsWith("custom:");
  void isDarkBasemap;
  return (
    <div class="stack">
      <section>
        <label class="lbl">Basemap</label>
        <div class="basemaps">
          {BASEMAPS.map((b) => (
            <button key={b.id} class={`bm ${s.basemap === b.id ? "on" : ""}`} onClick={() => update((x) => (x.basemap = b.id))}>
              <span class="sw" style={{ background: SWATCH[b.id] }} />
              <span>{b.name}</span>
            </button>
          ))}
        </div>
        {["dark", "light", "road"].includes(s.basemap) && (
          <div class="row">
            <span>Map tiles</span>
            <div class="seg sm">
              {(["openfreemap", "carto"] as const).map((p) => (
                <button key={p} class={s.basemapProvider === p ? "on" : ""} onClick={() => update((x) => (x.basemapProvider = p))}>
                  {p === "openfreemap" ? "OpenFreeMap" : "CARTO"}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
      <section>
        <label class="lbl">Custom tile servers</label>
        <CustomBasemaps />
      </section>
      <section>
        <label class="lbl">Labels</label>
        <Toggle label={custom ? "Place names (if the tile server has none, turn on CARTO names in its settings)" : "Place names"} on={s.overlays.labels} set={(v) => update((x) => (x.overlays.labels = v))} />
      </section>
    </div>
  );
}
