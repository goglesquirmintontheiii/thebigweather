// 0.8.2: searchable product dropdown for the main map and the map panes (a native <select> can't
// hold a search box). Type to filter, ↑/↓ to move, Enter to pick, Esc to close. The list is
// position: fixed so a pane's clipping never cuts it off.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { ChevronDown, Search } from "lucide-preact";
import { filterGroups, flatItems, stepIndex, type PGroup } from "./productFilter";

export function ProductPicker({ value, groups, onPick, fallback, title, "aria-label": aria }: { value: string; groups: PGroup[]; onPick: (v: string) => void; fallback?: string; title?: string; "aria-label"?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [act, setAct] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH: number; minW: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cur = flatItems(groups).find((i) => i.value === value);
  const shown = filterGroups(groups, q);
  const flat = flatItems(shown);
  const id = useRef(`pp82-${Math.random().toString(36).slice(2, 8)}`).current;

  const close = (focus = true) => {
    setOpen(false);
    setQ("");
    if (focus) btn.current?.focus();
  };
  const openWith = (text = "") => {
    const r = btn.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 260 && above > below;
    const maxH = Math.max(160, Math.min(480, up ? above : below));
    const w = Math.max(r.width, 260);
    setPos({ left: Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)), ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), maxH, minW: w });
    setQ(text);
    setOpen(true);
  };
  // highlight the current product when opening / the first match while searching
  useEffect(() => {
    if (!open) return;
    const i = q ? 0 : flat.findIndex((x) => x.value === value);
    setAct(i);
  }, [open, q]);
  useLayoutEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${act}"]`)?.scrollIntoView({ block: "nearest" });
  }, [act, open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const resize = () => close(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", resize);
    return () => (window.removeEventListener("pointerdown", down, true), window.removeEventListener("resize", resize));
  }, [open]);

  const pick = (v: string) => {
    close();
    if (v !== value) onPick(v);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // map / app shortcuts stay quiet while typing
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAct(stepIndex(act, e.key === "ArrowDown" ? 1 : -1, flat.length));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      setAct(Math.max(0, Math.min(flat.length - 1, (act < 0 ? 0 : act) + (e.key === "PageDown" ? 8 : -8))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[act] ?? flat[0];
      if (it) pick(it.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") close(false);
  };
  const onBtnKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      openWith();
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // type-to-search: the first letter opens the list with it
      e.preventDefault();
      e.stopPropagation();
      openWith(e.key);
    }
  };

  let n = -1;
  return (
    <>
      <button ref={btn} type="button" class={`pp82-btn ${open ? "open" : ""}`} title={title} aria-label={aria} aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? close() : openWith())} onKeyDown={onBtnKey}>
        <span class="pp82-cur">{cur?.label ?? fallback ?? value}</span>
        {cur?.hint && <span class="pp82-hint">{cur.hint}</span>}
        <ChevronDown size={13} />
      </button>
      {open &&
        pos &&
        createPortal(
        <div ref={list} class="pp82-pop" style={{ left: `${pos.left}px`, top: pos.top != null ? `${pos.top}px` : undefined, bottom: pos.bottom != null ? `${pos.bottom}px` : undefined, minWidth: `${pos.minW}px` }} onKeyDown={onKey}>
          <label class="pp82-search">
            <Search size={13} />
            <input
              ref={input}
              value={q}
              placeholder="Search products"
              role="combobox"
              aria-expanded="true"
              aria-controls={id}
              aria-activedescendant={act >= 0 ? `${id}-${act}` : undefined}
              aria-label="Search products"
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="pp82-list" id={id} role="listbox" style={{ maxHeight: `${pos.maxH - 44}px` }} aria-label={aria}>
            {shown.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div class="pp82-gh">{g.label}</div>
                {g.items.map((it) => {
                  const i = ++n;
                  return (
                    <div
                      key={it.value}
                      id={`${id}-${i}`}
                      data-i={i}
                      role="option"
                      aria-selected={it.value === value}
                      class={`pp82-it ${i === act ? "act" : ""} ${it.value === value ? "sel" : ""}`}
                      onPointerMove={() => i !== act && setAct(i)}
                      onClick={() => pick(it.value)}
                    >
                      <span>{it.label}</span>
                      {it.hint && <span class="pp82-hint">{it.hint}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!flat.length && <div class="pp82-none muted small">No product matches “{q}”</div>}
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}
