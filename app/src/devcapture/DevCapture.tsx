// 0.8.2 dev-only feedback capture (Ctrl+Shift+K): pick an element or drag an area, add a note,
// and get a compact STORMIQ-FB2 code on the clipboard to paste into the chat / checklist.

import { render } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { toast } from "../store";
import { encodeCapture, decodeCapture, fitScale } from "./code";
import { OWN, hookErrors, recentErrors, elementInfo, areaElements, containersOf, pageInfo, nameOf } from "./collect";
import "./devcapture.css";

const FLAG = "tbw.devcapture"; // "0" = turned off in Settings → Advanced
export const captureEnabled = signal(readFlag());
function readFlag() {
  try {
    return localStorage.getItem(FLAG) !== "0";
  } catch {
    return true;
  }
}
export function setCaptureEnabled(on: boolean) {
  captureEnabled.value = on;
  try {
    localStorage.setItem(FLAG, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!on) mode.value = null;
}

type Kind = "feature" | "change" | "bug" | "note";
type Prio = "high" | "med" | "low" | "none";
interface Picked {
  target: "element" | "area";
  el?: Element;
  rect: { x: number; y: number; w: number; h: number };
  shot?: { bytes: Uint8Array; type: string; w: number; h: number; scale: number } | null;
  label: string;
  count?: number;
}
/** null = idle; "pick" = choosing; Picked = writing the note */
const mode = signal<null | "pick" | Picked>(null);
const busy = signal(false);

/* ---------- screenshot ---------- */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
async function grab(rect: { x: number; y: number; w: number; h: number }, max = 1280) {
  const api = (window as any).tbw?.devcap;
  if (!api?.shot || rect.w < 4 || rect.h < 4) return null;
  try {
    const png: Uint8Array | null = await api.shot({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    if (!png) return null;
    const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
    const s = fitScale(bmp.width, bmp.height, max);
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    let blob = await c.convertToBlob({ type: "image/webp", quality: 0.6 });
    if (blob.type !== "image/webp") blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    // keep the code well under ~300 KB of text (base85 adds 25 %)
    if (blob.size > 200_000) blob = await c.convertToBlob({ type: blob.type, quality: 0.4 });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, w, h, scale: +(w / rect.w).toFixed(3) };
  } catch (e) {
    console.warn("devcapture: screenshot failed", e);
    return null;
  }
}

async function copy(text: string) {
  const api = (window as any).tbw?.devcap;
  if (api?.copy) return api.copy(text);
  await navigator.clipboard.writeText(text);
}

/* ---------- picking overlay ---------- */
function underPoint(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) if (!el.closest(`[${OWN}]`)) return el;
  return null;
}
const describe = (el: Element) => {
  const n = nameOf(el, 40);
  return `${el.tagName.toLowerCase()}${n ? ` · ${n}` : ""}`;
};

function Picker() {
  const [hover, setHover] = useState<{ el: Element; r: DOMRect } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const rectOf = (d: { x0: number; y0: number; x: number; y: number }) => ({ x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) });
  const isArea = (d: typeof drag) => !!d && (Math.abs(d.x - d.x0) > 6 || Math.abs(d.y - d.y0) > 6);

  const finish = async (p: Omit<Picked, "shot">) => {
    busy.value = true;
    mode.value = null; // hide the overlay before the screenshot
    await nextFrame();
    const shot = await grab(p.target === "area" ? p.rect : { x: p.rect.x - 4, y: p.rect.y - 4, w: p.rect.w + 8, h: p.rect.h + 8 }, p.target === "area" ? 1280 : 640);
    busy.value = false;
    mode.value = { ...p, shot };
  };

  return (
    <div
      class="devcap-layer"
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (d) return setDrag({ ...d, x: e.clientX, y: e.clientY });
        const el = underPoint(e.clientX, e.clientY);
        setHover(el ? { el, r: el.getBoundingClientRect() } : null);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* synthetic events */
        }
        setDrag({ x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        setDrag(null);
        if (!d) return;
        if (isArea(d)) {
          const r = rectOf({ ...d, x: e.clientX, y: e.clientY });
          finish({ target: "area", rect: r, label: `Area ${Math.round(r.w)}×${Math.round(r.h)}` });
        } else {
          const el = underPoint(e.clientX, e.clientY);
          if (!el) return;
          const r = el.getBoundingClientRect();
          finish({ target: "element", el, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, label: describe(el) });
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div class="devcap-hint">Click an element or drag an area · Esc to cancel</div>
      {drag && isArea(drag) ? (
        (() => {
          const r = rectOf(drag);
          return (
            <div class="devcap-area" style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }}>
              <span>
                {Math.round(r.w)}×{Math.round(r.h)}
              </span>
            </div>
          );
        })()
      ) : hover ? (
        <>
          <div class="devcap-box" style={{ left: `${hover.r.left}px`, top: `${hover.r.top}px`, width: `${hover.r.width}px`, height: `${hover.r.height}px` }} />
          <div class="devcap-tip" style={{ left: `${Math.min(hover.r.left, innerWidth - 260)}px`, top: `${hover.r.top > 26 ? hover.r.top - 24 : hover.r.bottom + 4}px` }}>
            {describe(hover.el)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------- note dialog ---------- */
const KINDS: [Kind, string][] = [
  ["feature", "Feature"],
  ["change", "Change"],
  ["bug", "Bug"],
  ["note", "Note"],
];
let lastCode = "";
let lastKind: Kind = "change";
let lastPrio: Prio = "med";

function NoteDialog({ p }: { p: Picked }) {
  const [kind, setKind] = useState<Kind>(lastKind);
  const [prio, setPrio] = useState<Prio>(lastPrio);
  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    ta.current?.focus();
    if (!p.shot) return;
    const u = URL.createObjectURL(new Blob([p.shot.bytes as BlobPart], { type: p.shot.type }));
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [p]);
  const [count] = useState(() => (p.target === "area" ? areaElements(p.rect).length : 0));
  const ok = async () => {
    if (working) return;
    setWorking(true);
    lastKind = kind;
    lastPrio = prio;
    try {
      const pg = await pageInfo();
      const centerEl = p.el ?? document.elementsFromPoint(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2).find((e) => !e.closest(`[${OWN}]`));
      const r = (v: number) => Math.round(v);
      const json = {
        tool: "stormiq-feedback",
        v: 2,
        kind,
        priority: prio,
        text: text.trim(),
        target: p.target,
        at: Date.now(),
        ...pg,
        element: p.target === "element" && p.el ? elementInfo(p.el) : undefined,
        area: p.target === "area" ? { x: r(p.rect.x), y: r(p.rect.y), w: r(p.rect.w), h: r(p.rect.h) } : undefined,
        elements: p.target === "area" ? areaElements(p.rect) : undefined,
        containers: centerEl ? containersOf(centerEl).map(({ tag, name }) => ({ tag, name })) : undefined,
        notes: recentErrors(),
        shot: p.shot ? { type: p.shot.type, w: p.shot.w, h: p.shot.h, scale: p.shot.scale } : undefined,
      };
      const code = await encodeCapture(json, p.shot?.bytes);
      await copy(code);
      lastCode = code;
      mode.value = null;
      toast(`Capture copied (${Math.max(1, Math.round(code.length / 1024))} KB)`);
    } catch (e: any) {
      toast(`Capture failed: ${e?.message ?? e}`, "error");
      setWorking(false);
    }
  };
  return (
    <div class="devcap-back" onPointerDown={(e) => e.target === e.currentTarget && (mode.value = null)}>
      <div class="devcap-dlg" role="dialog" aria-label="Capture note" onKeyDown={(e) => (e.key === "Enter" && (e.ctrlKey || e.metaKey) ? (e.preventDefault(), ok()) : undefined)}>
        <div class="devcap-dlg-h">
          <b>Capture</b>
          <span class="muted small">
            {p.label}
            {p.target === "area" ? ` · ${count} element${count === 1 ? "" : "s"}` : ""}
            {p.shot ? " · screenshot" : ""}
          </span>
        </div>
        {preview && <img class="devcap-prev" src={preview} alt="" />}
        <div class="seg sm">
          {KINDS.map(([k, l]) => (
            <button key={k} class={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
        <label class="devcap-row">
          <span>Priority</span>
          <select value={prio} onChange={(e) => setPrio((e.target as HTMLSelectElement).value as Prio)}>
            <option value="high">High</option>
            <option value="med">Medium</option>
            <option value="low">Low</option>
            <option value="none">None</option>
          </select>
        </label>
        <textarea ref={ta} rows={4} placeholder={'e.g. "Make this say xyz instead of abc" or "This button doesn\'t work"'} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <div class="devcap-btns">
          <span class="muted small">Ctrl+Enter</span>
          <button class="btn sm ghost" onClick={() => (mode.value = null)}>
            Cancel
          </button>
          <button class="btn sm" disabled={working} onClick={ok}>
            {working ? "Copying…" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Root() {
  const m = mode.value;
  useEffect(() => {
    if (!m) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        mode.value = null;
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [m]);
  if (busy.value) return <div class="devcap-busy" />;
  if (m === "pick") return <Picker />;
  if (m) return <NoteDialog p={m} />;
  return null;
}

let installed = false;
/** Mount the tool (main window only) and listen for Ctrl+Shift+K. */
export function installDevCapture() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  hookErrors();
  const host = document.createElement("div");
  host.setAttribute(OWN, "");
  document.body.appendChild(host);
  render(<Root />, host);
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyK") return;
      if (!captureEnabled.peek()) return;
      e.preventDefault();
      e.stopPropagation();
      mode.value = mode.peek() ? null : "pick";
    },
    true,
  );
  (window as any).__tbwDevCapture = { mode, start: () => (mode.value = "pick"), last: () => lastCode, decode: decodeCapture };
}
