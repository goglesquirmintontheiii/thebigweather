// Drawing tools bar (above the bottom toolbar while drawing mode is on).

import { useEffect, useRef, useState } from "preact/hooks";
import { drawTool, drawStyle, undo, redo, clearAll, canUndo, canRedo, COLORS, textInput, addText, finishPoly, setKeep, newDrawing, currentCount, drawings, type DrawKind } from "../map/draw";
import { settings, tool } from "../store";
import { Pencil, Minus, MoveUpRight, Square, Circle, Pentagon, Type, Eraser, Hand, Undo2, Redo2, Trash2, X, PaintBucket, FilePlus2 } from "lucide-preact";

const TOOLS: [DrawKind, any, string][] = [
  ["free", Pencil, "Freehand"],
  ["line", Minus, "Line"],
  ["arrow", MoveUpRight, "Arrow"],
  ["rect", Square, "Rectangle"],
  ["circle", Circle, "Circle"],
  ["poly", Pentagon, "Polygon (click points, double-click or Enter to finish)"],
  ["text", Type, "Text"],
  ["erase", Eraser, "Erase (click a drawing)"],
  ["pan", Hand, "Move the map"],
];

export function DrawBar() {
  const t = drawTool.value;
  const st = drawStyle.value;
  return (
    <div class="draw-bar glass">
      <div class="draw-tools">
        {TOOLS.map(([k, Icon, title]) => (
          <button key={k} class={`tb sm ${t === k ? "on" : ""}`} title={title} onClick={() => (k !== "poly" && finishPoly(), (drawTool.value = k))}>
            <Icon size={16} />
          </button>
        ))}
      </div>
      <span class="tl-sep" />
      <div class="draw-colors">
        {COLORS.map((c) => (
          <button key={c} class={`swatch ${st.color === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => (drawStyle.value = { ...st, color: c })} />
        ))}
        <input type="color" value={st.color} title="Custom color" onInput={(e) => (drawStyle.value = { ...st, color: (e.target as HTMLInputElement).value })} />
      </div>
      <input class="draw-width" type="range" min={1} max={14} value={st.width} title={`Brush size ${st.width}`} onInput={(e) => (drawStyle.value = { ...st, width: +(e.target as HTMLInputElement).value })} />
      <button class={`tb sm ${st.fill ? "on" : ""}`} title="Fill shapes" onClick={() => (drawStyle.value = { ...st, fill: !st.fill })}>
        <PaintBucket size={16} />
      </button>
      <span class="tl-sep" />
      <button class="tb sm" title="Undo (Ctrl+Z)" disabled={!canUndo.value} onClick={undo}>
        <Undo2 size={16} />
      </button>
      <button class="tb sm" title="Redo (Ctrl+Y)" disabled={!canRedo.value} onClick={redo}>
        <Redo2 size={16} />
      </button>
      <span class="tl-sep" />
      <button class="draw-new" title="Start a new, separate drawing (its own × to delete it; undo works within it)" disabled={currentCount() === 0} onClick={newDrawing}>
        <FilePlus2 size={15} /> New drawing
      </button>
      <span class="draw-count muted" title="Shapes in the current drawing">
        {(void drawings.value, currentCount())} shape{currentCount() === 1 ? "" : "s"}
      </span>
      <button class="tb sm" title="Clear all drawings" onClick={clearAll}>
        <Trash2 size={16} />
      </button>
      <label class="draw-keep" title="Keep drawings on the map after closing drawing mode">
        <input type="checkbox" checked={settings.value.drawKeep} onChange={(e) => setKeep((e.target as HTMLInputElement).checked)} /> Keep
      </label>
      <button class="tb sm" title="Close drawing mode" onClick={() => (tool.value = "none")}>
        <X size={16} />
      </button>
      <TextBox />
    </div>
  );
}

function TextBox() {
  const t = textInput.value;
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (t) {
      setV("");
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [t?.x, t?.y]);
  if (!t) return null;
  return (
    <div class="draw-text-in glass" style={{ left: `${t.x}px`, top: `${t.y}px` }}>
      <input
        ref={ref}
        value={v}
        placeholder="Text, then Enter"
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") addText(v);
          if (e.key === "Escape") textInput.value = null;
        }}
        onBlur={() => addText(v)}
      />
    </div>
  );
}
