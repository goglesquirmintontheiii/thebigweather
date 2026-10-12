// Weather alert settings: show/hide by category or type, colors, borders, fill patterns, sounds
// and flashing for new alerts.

import { useState, useMemo } from "preact/hooks";
import { settings, update, type AlertTypeCfg } from "../store";
import { ALERT_COLORS, alerts } from "../alerts";
import { ALERT_CATS, alertCategory, alertStyle } from "../alertstyle";
import { ALERT_SOUNDS, playNamed } from "../sound";
import { StyleControls } from "./OverlayList";
import { Search, Play, RotateCcw } from "lucide-preact";

function setCfg(fn: (c: typeof settings.value.alertCfg) => void) {
  update((s) => {
    const c = structuredClone(s.alertCfg);
    fn(c);
    s.alertCfg = c;
  });
}

/** Small preview swatch drawn the way the map draws it. */
function Swatch({ st }: { st: Required<AlertTypeCfg> }) {
  const bg =
    st.fill === "none"
      ? "transparent"
      : st.fill === "stripes"
        ? `repeating-linear-gradient(135deg, ${st.color} 0 3px, transparent 3px 8px)`
        : st.fill === "checker"
          ? `repeating-conic-gradient(${st.color} 0 25%, transparent 0 50%) 0 0 / 8px 8px`
          : st.color;
  return (
    <span
      class="al-swatch"
      style={{
        background: bg,
        opacity: st.fill === "solid" ? Math.min(1, 0.35 + st.fillOpacity * 2.5) : 1,
        borderColor: st.border,
        borderStyle: st.line === "solid" ? "solid" : st.line,
        borderWidth: `${Math.max(1, Math.min(4, st.width))}px`,
      }}
    />
  );
}

function Editor({ target }: { target: { kind: "cat" | "type"; name: string } }) {
  const cfg = settings.value.alertCfg;
  const cur: AlertTypeCfg = (target.kind === "cat" ? cfg.cats[target.name] : cfg.types[target.name]) ?? {};
  // what it looks like now (for a type), or for a typical member of the category
  const sample = target.kind === "type" ? target.name : Object.keys(ALERT_COLORS).find((e) => alertCategory(e) === target.name) ?? "Special Weather Statement";
  const eff = alertStyle(sample);
  const set = (k: keyof AlertTypeCfg, v: any) =>
    setCfg((c) => {
      const bag = target.kind === "cat" ? c.cats : c.types;
      const o = { ...(bag[target.name] ?? {}) } as any;
      if (v === undefined || v === "") delete o[k];
      else o[k] = v;
      if (Object.keys(o).length) bag[target.name] = o;
      else delete bag[target.name];
    });
  const hidden = target.kind === "cat" ? cfg.hiddenCats.includes(target.name) : cfg.hidden.includes(target.name);
  return (
    <div class="al-editor">
      <div class="al-ehead">
        <Swatch st={eff} />
        <div>
          <b>{target.name}</b>
          <div class="muted small">{target.kind === "cat" ? "Applies to every alert in this category unless a type sets its own" : alertCategory(target.name)}</div>
        </div>
      </div>
      <label class="toggle">
        <span>Show on the map</span>
        <input
          type="checkbox"
          checked={!hidden}
          onChange={(e) =>
            setCfg((c) => {
              const on = (e.target as HTMLInputElement).checked;
              const list = target.kind === "cat" ? c.hiddenCats : c.hidden;
              const i = list.indexOf(target.name);
              if (on && i >= 0) list.splice(i, 1);
              if (!on && i < 0) list.push(target.name);
            })
          }
        />
        <i />
      </label>
      {target.kind === "type" && (
        <div class="row">
          <span>Fill color</span>
          <input type="color" value={cur.color ?? eff.color} onInput={(e) => set("color", (e.target as HTMLInputElement).value)} />
          {cur.color && (
            <button class="icon-btn" title="Default color" onClick={() => set("color", undefined)}>
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      )}
      <div class="row">
        <span>Border color</span>
        <input type="color" value={cur.border ?? eff.border} onInput={(e) => set("border", (e.target as HTMLInputElement).value)} />
        {cur.border && (
          <button class="icon-btn" title="Same as fill" onClick={() => set("border", undefined)}>
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      <div class="row">
        <span>Border</span>
        <div class="seg sm">
          {(["solid", "dashed", "dotted"] as const).map((v) => (
            <button key={v} class={eff.line === v ? "on" : ""} onClick={() => set("line", v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div class="row">
        <span>Border width</span>
        <input type="range" min={0.5} max={6} step={0.25} value={eff.width} onInput={(e) => set("width", +(e.target as HTMLInputElement).value)} />
        <span class="val">{eff.width.toFixed(1)}</span>
      </div>
      <div class="row">
        <span>Fill</span>
        <div class="seg sm">
          {(["solid", "stripes", "checker", "none"] as const).map((v) => (
            <button key={v} class={eff.fill === v ? "on" : ""} onClick={() => set("fill", v)}>
              {v === "checker" ? "Checkered" : v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {eff.fill !== "none" && (
        <div class="row">
          <span>Fill strength</span>
          <input type="range" min={0} max={0.6} step={0.02} value={eff.fillOpacity} onInput={(e) => set("fillOpacity", +(e.target as HTMLInputElement).value)} />
          <span class="val">{Math.round(eff.fillOpacity * 100)}%</span>
        </div>
      )}
      <div class="row">
        <span>Sound when new</span>
        <select value={eff.sound} onChange={(e) => set("sound", (e.target as HTMLSelectElement).value)}>
          {ALERT_SOUNDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button class="icon-btn" title="Preview" disabled={eff.sound === "off"} onClick={() => playNamed(eff.sound)}>
          <Play size={13} />
        </button>
      </div>
      <div class="row">
        <span>Flash when new</span>
        <select value={String(eff.flash)} onChange={(e) => set("flash", +(e.target as HTMLSelectElement).value)}>
          {[0, 10, 30, 60, 120, 300, 600, 1800].map((v) => (
            <option key={v} value={v}>
              {v === 0 ? "Off" : v < 60 ? `${v} seconds` : `${v / 60} minute${v === 60 ? "" : "s"}`}
            </option>
          ))}
        </select>
      </div>
      {Object.keys(cur).length > 0 && (
        <button
          class="btn sm ghost"
          onClick={() =>
            setCfg((c) => {
              if (target.kind === "cat") delete c.cats[target.name];
              else delete c.types[target.name];
            })
          }
        >
          <RotateCcw size={13} /> Reset {target.kind === "cat" ? "category" : "type"}
        </button>
      )}
    </div>
  );
}

/** Pick which saved points trigger sounds, with a tick for all. */
function SoundPoints() {
  const pts = settings.value.points;
  const skip = settings.value.alertCfg.soundSkip ?? [];
  if (!pts.length) return <p class="muted small">No saved points yet. Add them in the Points tab.</p>;
  const on = pts.filter((p) => !skip.includes(p.id)).length;
  return (
    <div class="al-pts">
      <label class="chk">
        <input
          type="checkbox"
          checked={on === pts.length}
          ref={(el) => {
            if (el) el.indeterminate = on > 0 && on < pts.length;
          }}
          onChange={(e) => setCfg((c) => (c.soundSkip = (e.target as HTMLInputElement).checked ? [] : pts.map((p) => p.id)))}
        />
        <b>All points</b>
        <small class="muted">
          {on}/{pts.length}
        </small>
      </label>
      {pts.map((p) => (
        <label key={p.id} class="chk">
          <input
            type="checkbox"
            checked={!skip.includes(p.id)}
            onChange={(e) =>
              setCfg((c) => {
                const s = new Set(c.soundSkip ?? []);
                (e.target as HTMLInputElement).checked ? s.delete(p.id) : s.add(p.id);
                c.soundSkip = [...s];
              })
            }
          />
          <i class="dot" style={{ background: p.color }} />
          {p.name}
        </label>
      ))}
    </div>
  );
}

export function AlertConfig() {
  const cfg = settings.value.alertCfg;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<{ kind: "cat" | "type"; name: string }>({ kind: "cat", name: ALERT_CATS[0] });
  const [open, setOpen] = useState<Record<string, boolean>>({ [ALERT_CATS[0]]: true });
  // every known type plus whatever is active right now
  const active = new Map<string, number>();
  for (const a of alerts.value.values()) active.set(a.properties.event, (active.get(a.properties.event) ?? 0) + 1);
  const types = useMemo(() => [...new Set([...Object.keys(ALERT_COLORS), ...active.keys()])].sort(), [alerts.value]);
  const qq = q.trim().toLowerCase();
  return (
    <div class="al-config">
      <div class="al-list">
        <div class="search">
          <Search size={13} />
          <input placeholder="Find an alert type" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        {ALERT_CATS.map((cat) => {
          const list = types.filter((t) => alertCategory(t) === cat && (!qq || t.toLowerCase().includes(qq)));
          if (qq && !list.length) return null;
          const catHidden = cfg.hiddenCats.includes(cat);
          const n = list.reduce((a, t) => a + (active.get(t) ?? 0), 0);
          return (
            <div key={cat} class="al-cat">
              <div class={`al-row cat ${sel.kind === "cat" && sel.name === cat ? "sel" : ""}`}>
                <input
                  type="checkbox"
                  checked={!catHidden}
                  title="Show this category"
                  onChange={(e) =>
                    setCfg((c) => {
                      const on = (e.target as HTMLInputElement).checked;
                      c.hiddenCats = on ? c.hiddenCats.filter((x) => x !== cat) : [...c.hiddenCats, cat];
                    })
                  }
                />
                <button class="al-name" onClick={() => (setSel({ kind: "cat", name: cat }), setOpen({ ...open, [cat]: !open[cat] || sel.name !== cat }))}>
                  {cat}
                </button>
                {n > 0 && <span class="ovl-badge">{n}</span>}
              </div>
              {(open[cat] || qq) &&
                list.map((t) => (
                  <div key={t} class={`al-row type ${sel.kind === "type" && sel.name === t ? "sel" : ""} ${catHidden ? "dim" : ""}`}>
                    <input
                      type="checkbox"
                      checked={!cfg.hidden.includes(t)}
                      onChange={(e) =>
                        setCfg((c) => {
                          const on = (e.target as HTMLInputElement).checked;
                          c.hidden = on ? c.hidden.filter((x) => x !== t) : [...c.hidden, t];
                        })
                      }
                    />
                    <Swatch st={alertStyle(t)} />
                    <button class="al-name" onClick={() => setSel({ kind: "type", name: t })}>
                      {t}
                    </button>
                    {active.get(t) ? <small class="muted">{active.get(t)}</small> : null}
                    {cfg.types[t] && <i class="al-dot" title="Customized" />}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      <div class="al-side">
        <Editor target={sel} />
        <section>
          <label class="lbl">All alerts</label>
          <StyleControls id="base:alerts" def={{ opacity: 1 }} generic={false} />
          <div class="row">
            <span>Sounds for</span>
            <div class="seg sm">
              {(["all", "points"] as const).map((v) => (
                <button key={v} class={(cfg.soundScope ?? "all") === v ? "on" : ""} onClick={() => setCfg((c) => (c.soundScope = v))}>
                  {v === "all" ? "Any new alert" : "My points only"}
                </button>
              ))}
            </div>
          </div>
          {cfg.soundScope === "points" && <SoundPoints />}
          <label class="toggle">
            <span>Read new warnings aloud</span>
            <input type="checkbox" checked={settings.value.speak} onChange={(e) => update((s) => (s.speak = (e.target as HTMLInputElement).checked))} />
            <i />
          </label>
          <div class="row">
            <span>Volume</span>
            <input type="range" min={0} max={1} step={0.05} value={settings.value.audio.volume} onInput={(e) => update((s) => (s.audio.volume = +(e.target as HTMLInputElement).value))} />
            <span class="val">{Math.round(settings.value.audio.volume * 100)}%</span>
          </div>
          {(cfg.hidden.length > 0 || cfg.hiddenCats.length > 0 || Object.keys(cfg.types).length > 0 || Object.keys(cfg.cats).length > 0) && (
            <button class="btn sm ghost" onClick={() => setCfg((c) => ((c.hidden = []), (c.hiddenCats = []), (c.types = {}), (c.cats = {})))}>
              <RotateCcw size={13} /> Reset all alert settings
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
