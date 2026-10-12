// Layer shortcut capture ("Press keys…"), the small kbd badge and the `?` shortcuts dialog.

import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { settings } from "../store";
import { stepOf, CHORD_MS, conflictsFor, setKeybind, fmtCombo, layerName, allLayers, shortcutsOpen } from "../keybinds";
import { BUILTIN_HOTKEYS } from "./hotkeys";
import { Keyboard, X, Trash2, AlertTriangle } from "lucide-preact";

export function Kbd({ combo }: { combo: string }) {
  return (
    <span class="kbd-combo">
      {fmtCombo(combo)
        .split(" then ")
        .map((s, i) => (
          <Fragment key={i}>
            {i > 0 && <i>then</i>}
            <kbd>{s}</kbd>
          </Fragment>
        ))}
    </span>
  );
}

/** Badge showing a layer's shortcut (nothing when unbound). */
export function KbdBadge({ id }: { id: string }) {
  const c = settings.value.keybinds?.[id];
  return c ? (
    <span class="kbd-badge" title={`Shortcut: ${fmtCombo(c)}`}>
      {fmtCombo(c).replace(/ then /g, " ")}
    </span>
  ) : null;
}

/** Inline "Press keys…" capture: modifiers + key, or two keys within 0.8 s. */
export function KeyCapture({ id, onClose }: { id: string; onClose: () => void }) {
  const cur = settings.value.keybinds?.[id];
  const [steps, setSteps] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    let timer: number | undefined;
    let got: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !got.length) return onClose();
      const st = stepOf(e);
      if (!st) return;
      got = [...got, st];
      setSteps(got);
      clearTimeout(timer);
      if (got.length >= 2) setDone(true);
      else timer = window.setTimeout(() => setDone(true), CHORD_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [done]);
  const combo = steps.join(" ");
  const warn = done && combo ? conflictsFor(combo, id, BUILTIN_HOTKEYS) : [];
  return (
    <div class="kcap" onClick={(e) => e.stopPropagation()}>
      {!done ? (
        <div class="kcap-listen">
          <Keyboard size={13} />
          {steps.length ? <Kbd combo={combo} /> : <span>Press keys…</span>}
          <small class="muted">{steps.length ? "second key for a chord…" : "modifiers ok · 2 keys = chord · Esc cancels"}</small>
        </div>
      ) : (
        <>
          <div class="kcap-listen">
            <Keyboard size={13} />
            <Kbd combo={combo} />
          </div>
          {warn.map((w) => (
            <div key={w} class="kcap-warn">
              <AlertTriangle size={11} /> {w}
            </div>
          ))}
        </>
      )}
      <div class="kcap-btns">
        {done && (
          <button class="btn xs" onClick={() => (setKeybind(id, combo), onClose())}>
            Save
          </button>
        )}
        {done && (
          <button class="btn xs ghost" onClick={() => (setSteps([]), setDone(false))}>
            Again
          </button>
        )}
        {cur && (
          <button class="btn xs ghost" onClick={() => (setKeybind(id, null), onClose())}>
            Remove {fmtCombo(cur)}
          </button>
        )}
        <button class="btn xs ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** `?`: built-in keys plus the user's layer shortcuts (add / change / remove). */
export function ShortcutsDialog() {
  const [edit, setEdit] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  useEffect(() => {
    if (!shortcutsOpen.value) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && !edit && (shortcutsOpen.value = false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [shortcutsOpen.value, edit]);
  if (!shortcutsOpen.value) return null;
  const binds = Object.entries(settings.value.keybinds ?? {});
  const layers = allLayers();
  const close = () => (shortcutsOpen.value = false);
  return (
    <div class="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal glass ovl-modal keys-modal">
        <div class="ovl-modal-head">
          <h3>Keyboard shortcuts</h3>
          <button class="icon-btn" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div class="ovl-modal-body keys-body">
          <section>
            <label class="lbl">Layer shortcuts</label>
            {binds.length === 0 && !edit && <div class="muted small">None yet. Right-click a layer in the Layers menu, or add one here.</div>}
            {binds.map(([id, c]) => (
              <div key={id}>
                <div class="keys-row">
                  <span>{layerName(id)}</span>
                  <Kbd combo={c} />
                  <button class="icon-btn" title="Change" onClick={() => setEdit(id)}>
                    <Keyboard size={13} />
                  </button>
                  <button class="icon-btn" title="Remove" onClick={() => setKeybind(id, null)}>
                    <Trash2 size={12} />
                  </button>
                </div>
                {edit === id && <KeyCapture id={id} onClose={() => setEdit(null)} />}
              </div>
            ))}
            <div class="row">
              <select value={add} onChange={(e) => setAdd((e.target as HTMLSelectElement).value)}>
                <option value="">Add shortcut for…</option>
                {layers
                  .filter((l) => !settings.value.keybinds?.[l.id])
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.group} · {l.name}
                    </option>
                  ))}
              </select>
            </div>
            {add && !settings.value.keybinds?.[add] && <KeyCapture id={add} onClose={() => setAdd("")} />}
          </section>
          <section>
            <label class="lbl">Built in</label>
            <div class="keys-grid">
              {BUILTIN_HOTKEYS.map(([k, what]) => (
                <div key={k} class="keys-row">
                  <span>{what}</span>
                  <Kbd combo={k} />
                </div>
              ))}
              <div class="keys-row">
                <span>Value under cursor (hold)</span>
                <Kbd combo="Shift" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
