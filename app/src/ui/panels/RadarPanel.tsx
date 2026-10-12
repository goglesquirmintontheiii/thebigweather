import { useMemo, useState, useRef } from "preact/hooks";
import { settings, update, toast } from "../../store";
import { sites, tilts, l3Products, L2_MOMENTS, selectSite, currentSite, tableKeyFor, backToLatest, pinned, openLocalFile } from "../../radar/controller";
import { BUILTIN, COLORBLIND, parsePal } from "../../radar/colormaps";
import { mapRef, flyToSite } from "../../map/mapview";
import { distance, fmtDist } from "../../util";
import { Search, Upload, Crosshair } from "lucide-preact";
import { Slider, smoothLabel } from "../controls";
import { siteMatches, siteShown, siteRegion, siteRegions, hiddenRegions, toggleRegion, noLevel3, REGION_NAMES, type AnySite } from "../../intl/sites"; // intl & forecast tools

export function RadarPanel() {
  const r = settings.value.radar;
  return (
    <div class="stack">
      <SitePicker />
      <section>
        <div class="seg">
          {(["L2", "L3"] as const).filter((src) => src === "L2" || !noLevel3(currentSite.value)).map((src) => (
            <button
              key={src}
              class={r.source === src ? "on" : ""}
              onClick={() =>
                update((s) => {
                  s.radar.source = src;
                  const tdwr = currentSite.value?.type === "TDWR";
                  if (src === "L3") s.radar.product = tdwr ? "TZL" : "N0B";
                  else s.radar.product = "REF";
                })
              }
            >
              {src === "L2" ? "Level II" : "Level III"}
            </button>
          ))}
        </div>
      </section>
      {r.source === "L2" ? <L2Products /> : <L3ProductList />}
      {r.source === "L2" && <TiltPicker />}
      <DisplayOptions />
      <ColorTablePicker />
      <HistoryBox />
    </div>
  );
}

function SitePicker() {
  const [q, setQ] = useState("");
  const list = sites.value;
  const center = mapRef.value?.getCenter();
  const shown = useMemo(() => {
    const qq = q.trim().toUpperCase();
    let l = (list as AnySite[]).filter(siteShown).map((s) => ({ s, d: center ? distance(center.lat, center.lng, s.lat, s.lon) : 0 }));
    if (qq) l = l.filter(({ s }) => siteMatches(s, qq));
    l.sort((a, b) => a.d - b.d);
    return l.slice(0, qq ? 30 : 6);
  }, [q, list, center?.lat, center?.lng, settings.value.ovl["base:sites"]]);
  const regs = siteRegions.value;
  const hidden = hiddenRegions();
  return (
    <section>
      <label class="lbl">Radar site</label>
      <div class="search">
        <Search size={14} />
        <input value={q} placeholder="ID, city or state" onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && shown[0] && (selectSite(shown[0].s.id), setQ(""))} />
        <button class="icon-btn" title="Center map on radar" onClick={flyToSite}>
          <Crosshair size={14} />
        </button>
      </div>
      {regs.length > 1 && (
        <div class="site-regs" title="Radar sites shown on the map and in this list">
          {regs.map((r) => (
            <button key={r} class={`chip ${hidden.has(r) ? "" : "on"}`} onClick={() => toggleRegion(r)}>
              {REGION_NAMES[r]}
            </button>
          ))}
        </div>
      )}
      <div class="site-list">
        {shown.map(({ s, d }) => (
          <button
            key={s.id}
            class={`site-row ${s.id === settings.value.radar.site ? "on" : ""} ${settings.value.extraSites.includes(s.id) ? "extra" : ""}`}
            title="Click to view · Ctrl+click to add alongside the current radar"
            onClick={(e) => (selectSite(s.id, e.ctrlKey || e.metaKey), setQ(""))}
          >
            <span class="sid">{s.id}</span>
            <span class="sname">{[...new Set([s.name, s.state, (s as AnySite).country && siteRegion(s) !== "US" ? (s as AnySite).country : ""].filter(Boolean))].join(", ")}</span>
            {s.type === "TDWR" && <span class="tag tdwr">TDWR</span>}
            {siteRegion(s) !== "US" && <span class="tag intl">{(s as AnySite).kind === "odim" ? "ODIM" : siteRegion(s)}</span>}
            <span class="sdist">{fmtDist(d)}</span>
          </button>
        ))}
        {!list.length && <div class="muted">Connect to a server to list radars.</div>}
      </div>
    </section>
  );
}

function L2Products() {
  const r = settings.value.radar;
  const avail = new Set(tilts.value.flatMap((t) => t.moments));
  return (
    <section>
      <label class="lbl">Product</label>
      <div class="grid2">
        {L2_MOMENTS.map((m) => (
          <button key={m.id} class={`opt ${r.product === m.id ? "on" : ""} ${avail.size && !avail.has(m.id) ? "na" : ""}`} onClick={() => update((s) => (s.radar.product = m.id))}>
            {m.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function L3ProductList() {
  const r = settings.value.radar;
  const tdwr = currentSite.value?.type === "TDWR";
  const prods = l3Products.value.filter((p) => !!p.tdwr === tdwr);
  const groups = [...new Set(prods.map((p) => p.group))];
  const cur = l3Products.value.find((p) => p.id === r.product);
  // one button per product family (same product code at different tilts)
  const fams = new Map<string, typeof prods>();
  for (const p of prods) {
    const k = `${p.code}|${p.name}`;
    fams.set(k, [...(fams.get(k) ?? []), p].sort((a, b) => a.tilt - b.tilt));
  }
  const curFam = cur ? fams.get(`${cur.code}|${cur.name}`) : undefined;
  return (
    <section>
      {groups.map((g) => (
        <div key={g}>
          <label class="lbl">{g}</label>
          <div class="grid2">
            {[...fams.values()]
              .filter((f) => f[0].group === g)
              .map((f) => {
                const on = f.some((p) => p.id === r.product);
                // keep the current tilt when switching family if it exists
                const target = f.find((p) => p.tilt === cur?.tilt) ?? f[0];
                return (
                  <button key={f[0].id} class={`opt ${on ? "on" : ""}`} onClick={() => update((s) => (s.radar.product = target.id))} title={f.map((p) => p.id).join(" · ")}>
                    {f[0].name}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
      {curFam && curFam.length > 1 && (
        <div>
          <label class="lbl">Tilt (↑ ↓)</label>
          <div class="tilts">
            {curFam.map((p) => (
              <button key={p.id} class={`tilt ${p.id === r.product ? "on" : ""}`} onClick={() => update((s) => (s.radar.product = p.id))} title={p.id}>
                {L3_TILT_LABEL(p.tilt, tdwr)}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Nominal elevation of the Nth Level III tilt (actual angle depends on the VCP; header shows the real one). */
function L3_TILT_LABEL(t: number, tdwr: boolean) {
  const a = tdwr ? [0.3, 0.6, 1.0, 1.5] : [0.5, 0.9, 1.3, 1.8];
  return `T${t + 1} · ~${a[t] ?? "?"}°`;
}

function TiltPicker() {
  const r = settings.value.radar;
  const ts = tilts.value.filter((t) => t.moments.includes(r.product));
  const angles = [...new Map(ts.map((t) => [t.angle.toFixed(1), t])).values()];
  if (!angles.length) return null;
  let best = angles[0];
  for (const t of angles) if (Math.abs(t.angle - r.tiltAngle) < Math.abs(best.angle - r.tiltAngle)) best = t;
  return (
    <section>
      <label class="lbl">Tilt</label>
      <div class="tilts">
        {angles.map((t) => (
          <button key={t.angle} class={`tilt ${t === best ? "on" : ""}`} onClick={() => update((s) => (s.radar.tiltAngle = t.angle))}>
            {t.angle.toFixed(1)}°
          </button>
        ))}
      </div>
    </section>
  );
}

function DisplayOptions() {
  const r = settings.value.radar;
  return (
    <section class="opts">
      {settings.value.anim.mode === "count" ? (
        <Slider label="Frames" value={r.frames} min={1} max={120} live={false} set={(v) => update((s) => (s.radar.frames = v))} />
      ) : (
        <div class="row muted small">Frames: last {settings.value.anim.minutes} min (timeline settings)</div>
      )}
      <div class="row">
        <span>Opacity</span>
        <input type="range" min={10} max={100} value={Math.round(r.opacity * 100)} onInput={(e) => update((s) => (s.radar.opacity = +(e.target as HTMLInputElement).value / 100))} />
        <span class="val">{Math.round(r.opacity * 100)}%</span>
      </div>
      <Slider label="Smoothing" value={r.smooth} min={0} max={1} step={0.05} fmt={smoothLabel} set={(v) => update((s) => (s.radar.smooth = v))} />
      {r.source === "L2" && <Toggle label="RapidSweep (live chunks)" on={r.live} set={(v) => update((s) => (s.radar.live = v))} />}
      {/* radar 0.6: velocity dealiasing (VEL and SRV) */ r.source === "L2" && r.product === "VEL" && <DealiasToggle />}
    </section>
  );
}

export function Toggle({ label, on, set, hint }: { label: string; on: boolean; set: (v: boolean) => void; hint?: string }) {
  return (
    <label class="toggle" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={on} onChange={(e) => set((e.target as HTMLInputElement).checked)} />
      <i />
    </label>
  );
}

function ColorTablePicker() {
  const r = settings.value.radar;
  const base = tableKeyFor(r.product);
  const chosen = settings.value.tables[base] ?? base;
  const fileRef = useRef<HTMLInputElement>(null);
  const customs = Object.keys(settings.value.customPals);
  const options = [{ id: base, name: BUILTIN[base]?.name ?? base }];
  if (COLORBLIND[base]) options.push({ id: base, name: "" });
  return (
    <section>
      <label class="lbl">Color table</label>
      <div class="row">
        <select
          value={chosen}
          onChange={(e) =>
            update((s) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === base) delete s.tables[base];
              else s.tables[base] = v;
            })
          }
        >
          <option value={base}>Default{settings.value.colorblind && COLORBLIND[base] ? " (colorblind)" : ""}</option>
          {customs.map((c) => (
            <option key={c} value={`custom:${c}`}>
              {c}
            </option>
          ))}
        </select>
        <button class="btn sm" onClick={() => fileRef.current?.click()} title="Import a .pal color table">
          <Upload size={13} /> .pal
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pal,.txt"
          hidden
          onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            const text = await f.text();
            const name = f.name.replace(/\.(pal|txt)$/i, "");
            try {
              parsePal(text, name);
              update((s) => {
                s.customPals[name] = text;
                s.tables[base] = `custom:${name}`;
              });
              toast(`Imported ${name}`);
            } catch (err: any) {
              toast(`Bad palette: ${err.message}`, "error");
            }
            (e.target as HTMLInputElement).value = "";
          }}
        />
      </div>
    </section>
  );
}

function HistoryBox() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <section>
      <label class="lbl">Files</label>
      <p class="muted small">History: calendar button on the toolbar or timeline.</p>
      <div class="row">
        {pinned.value && (
          <button class="btn sm ghost" onClick={backToLatest}>
            Back to latest
          </button>
        )}
        <button class="btn sm ghost" onClick={() => fileRef.current?.click()} title="Open a Level II file from disk (or drop it on the map)">
          <Upload size={13} /> Open Level II file
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) openLocalFile(f);
            (e.target as HTMLInputElement).value = "";
          }}
        />
      </div>
    </section>
  );
}

/* ---------- radar 0.6 ---------- */
import { dealiasState } from "../../radar/dealias";
function DealiasToggle() {
  const st = dealiasState.value;
  const on = !!settings.value.radar6?.dealias;
  return (
    <>
      <Toggle label="Dealias" hint="Unfold aliased velocities for display (also storm-relative velocity). Uses the scan's Nyquist velocity." on={on} set={(v) => update((s) => (s.radar6 = { ...s.radar6, dealias: v }))} />
      {on && <div class="row muted small r6-dealias-note">{st.busy ? "Dealiasing…" : st.error ? `Dealias failed: ${st.error}` : st.last ? `Nyquist ${st.last.vn.toFixed(1)} m/s · ${st.last.ms} ms` : ""}</div>}
    </>
  );
}
/* ---------- end radar 0.6 ---------- */
