// panes 0.8: Settings → Pane layouts. Custom grid layouts: pick rows × columns, drag across cells
// to merge them into one pane, split a pane back into cells, choose which one is the main map.
// Saved layouts appear in the toolbar's panes menu.

import { useState } from "preact/hooks";
import { settings, update, uid, toast, type PaneLayoutDef } from "../store";
import { LayoutIcon, MAX_MAPS } from "./Panes";
import { Plus, Trash2, Pencil, Check, X, Scissors, Star, Copy } from "lucide-preact";
import { type Cell, unitCells, hits, order, merge, bounds, unit, sameCell } from "./paneGrid"; // 0.8.1: testable grid maths

/** touch/pen capture the pointer on press; release it so the cells under the finger get pointerenter */
const free = (e: PointerEvent) => (e.target as Element).hasPointerCapture?.(e.pointerId) && (e.target as Element).releasePointerCapture(e.pointerId);

function Editor({ init, onDone }: { init: PaneLayoutDef; onDone: () => void }) {
  const [d, setD] = useState<PaneLayoutDef>(init);
  const [sel, setSel] = useState(0);
  // 0.8.1: the drag spans from the cell it started on to the cell under the pointer (both whole)
  const [drag, setDrag] = useState<{ a: Cell; b: Cell } | null>(null);
  const setGrid = (rows: number, cols: number) => (setD({ ...d, rows, cols, cells: unitCells(rows, cols) }), setSel(0));
  const rect = (g: { a: Cell; b: Cell }): Cell => bounds(g.a, g.b);
  const finish = () => {
    if (!drag) return;
    const R = rect(drag);
    setDrag(null);
    // a click (or a drag within one pane) selects that pane instead of merging
    const same = d.cells.findIndex((x) => sameCell(x, R));
    if (same >= 0) return setSel(same);
    const cells = order(merge(d.cells, R), d.cells[0]);
    setD({ ...d, cells });
    setSel(cells.indexOf(cells.find((x) => x.r === R.r && x.c === R.c && x.rs === R.rs)!));
  };
  const split = () => {
    const x = d.cells[sel];
    if (!x || (x.rs === 1 && x.cs === 1)) return;
    const units = unitCells(x.rs, x.cs).map((u) => ({ ...u, r: u.r + x.r, c: u.c + x.c }));
    const cells = order([...d.cells.filter((y) => y !== x), ...units], d.cells[0] === x ? units[0] : d.cells[0]);
    setD({ ...d, cells });
  };
  const makeMain = () => {
    const x = d.cells[sel];
    if (!x) return;
    setD({ ...d, cells: order(d.cells, x) });
    setSel(0);
  };
  const tooMany = d.cells.length > MAX_MAPS;
  const save = (use: boolean) => {
    if (tooMany) return;
    const name = d.name.trim() || `${d.cells.length} maps`;
    update((s) => {
      const l = [...(s.paneLayouts ?? [])];
      const i = l.findIndex((x) => x.id === d.id);
      const v = { ...d, name };
      if (i >= 0) l[i] = v;
      else l.push(v);
      s.paneLayouts = l;
      if (use) s.panes.layout = `custom:${d.id}`;
    });
    toast(`Layout "${name}" saved`, "info", 1800);
    onDone();
  };
  const cur = drag ? rect(drag) : null;
  return (
    <div class="ple-ed">
      <div class="row">
        <span>Name</span>
        <input value={d.name} placeholder="e.g. Big + 3 strip" aria-label="Layout name" onInput={(e) => setD({ ...d, name: (e.target as HTMLInputElement).value })} />
      </div>
      <div class="row">
        <span>Rows</span>
        <select value={d.rows} aria-label="Rows" onChange={(e) => setGrid(+(e.target as HTMLSelectElement).value, d.cols)}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span>Columns</span>
        <select value={d.cols} aria-label="Columns" onChange={(e) => setGrid(d.rows, +(e.target as HTMLSelectElement).value)}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div class="muted small">Drag across cells to merge them into one pane · click a pane to select it.</div>
      <div
        class="ple-grid"
        style={{ gridTemplateRows: `repeat(${d.rows}, 1fr)`, gridTemplateColumns: `repeat(${d.cols}, 1fr)` }}
        onPointerUp={finish}
        onPointerLeave={() => drag && finish()}
        role="grid"
        aria-label="Layout grid"
      >
        {Array.from({ length: d.rows * d.cols }, (_, i) => {
          const r = Math.floor(i / d.cols), c = i % d.cols;
          return (
            <div
              key={`u${i}`}
              class={`ple-unit ${cur && hits(cur, r, c) ? "hl" : ""}`}
              style={{ gridArea: `${r + 1} / ${c + 1}` }}
              onPointerDown={(e) => (e.preventDefault(), free(e), setDrag({ a: unit(r, c), b: unit(r, c) }))}
              onPointerEnter={() => drag && setDrag({ ...drag, b: unit(r, c) })}
            />
          );
        })}
        {d.cells.map((x, i) => (
          <button
            key={`c${x.r}-${x.c}-${x.rs}-${x.cs}`}
            class={`ple-cell ${i === 0 ? "main" : ""} ${i === sel ? "sel" : ""}`}
            style={{ gridArea: `${x.r + 1} / ${x.c + 1} / span ${x.rs} / span ${x.cs}` }}
            aria-label={`${i === 0 ? "Main map" : `Pane ${i + 1}`}: row ${x.r + 1}, column ${x.c + 1}, ${x.rs} by ${x.cs}`}
            onPointerDown={(e) => (e.preventDefault(), free(e), setDrag({ a: x, b: x }))}
            onPointerEnter={() => drag && setDrag({ ...drag, b: x })}
            onClick={(e) => e.detail === 0 && setSel(i) /* keyboard; pointer clicks are handled on pointer-up */}
          >
            {i === 0 ? "Main" : i + 1}
          </button>
        ))}
      </div>
      <div class="row ple-acts">
        <button class="btn sm ghost" disabled={!d.cells[sel] || (d.cells[sel].rs === 1 && d.cells[sel].cs === 1)} onClick={split} title="Split the selected pane back into single cells">
          <Scissors size={13} /> Split
        </button>
        <button class="btn sm ghost" disabled={sel === 0} onClick={makeMain} title="The selected pane shows the main map">
          <Star size={13} /> Make main
        </button>
        <span class={`small ${tooMany ? "err-text" : "muted"}`}>
          {d.cells.length} map{d.cells.length === 1 ? "" : "s"}
          {tooMany ? ` · max ${MAX_MAPS}: merge some cells` : ""}
        </span>
      </div>
      <div class="row ple-acts">
        <button class="btn sm" disabled={tooMany} onClick={() => save(true)}>
          <Check size={13} /> Save & use
        </button>
        <button class="btn sm ghost" disabled={tooMany} onClick={() => save(false)}>
          Save
        </button>
        <button class="btn sm ghost" onClick={onDone}>
          <X size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

export function PaneLayoutsSection() {
  const list = settings.value.paneLayouts ?? [];
  const cur = settings.value.panes.layout;
  const [edit, setEdit] = useState<PaneLayoutDef | null>(null);
  const fresh = (): PaneLayoutDef => ({ id: uid(), name: "", rows: 2, cols: 3, cells: [{ r: 0, c: 0, rs: 2, cs: 2 }, { r: 0, c: 2, rs: 1, cs: 1 }, { r: 1, c: 2, rs: 1, cs: 1 }] });
  return (
    <section data-set="pane-layouts">
      <label class="lbl">Pane layouts</label>
      {list.map((l) => (
        <div key={l.id} class={`ple-row ${cur === `custom:${l.id}` ? "on" : ""}`}>
          <button class="ple-use" title="Use this layout" onClick={() => update((s) => (s.panes.layout = `custom:${l.id}`))}>
            <LayoutIcon spec={l} size={22} />
            <span>
              <b>{l.name}</b>
              <small>
                {l.rows} × {l.cols} · {Math.min(MAX_MAPS, l.cells.length)} maps
              </small>
            </span>
          </button>
          <button class="icon-btn" title="Edit" aria-label={`Edit layout ${l.name}`} onClick={() => setEdit(structuredClone(l))}>
            <Pencil size={14} />
          </button>
          <button class="icon-btn" title="Duplicate" aria-label={`Duplicate layout ${l.name}`} onClick={() => setEdit({ ...structuredClone(l), id: uid(), name: `${l.name} copy` })}>
            <Copy size={14} />
          </button>
          <button
            class="icon-btn danger"
            title="Delete"
            aria-label={`Delete layout ${l.name}`}
            onClick={() =>
              update((s) => {
                s.paneLayouts = (s.paneLayouts ?? []).filter((x) => x.id !== l.id);
                if (s.panes.layout === `custom:${l.id}`) s.panes.layout = "1";
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {edit ? (
        <Editor key={edit.id} init={edit} onDone={() => setEdit(null)} />
      ) : (
        <button class="btn sm ghost" onClick={() => setEdit(fresh())}>
          <Plus size={13} /> New layout
        </button>
      )}
      {!list.length && !edit && <div class="muted small">Your own grid of maps (up to {MAX_MAPS}). Saved layouts appear in the toolbar's panes menu.</div>}
    </section>
  );
}
