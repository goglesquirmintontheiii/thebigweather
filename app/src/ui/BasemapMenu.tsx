// 0.8.3: right-click menu on a basemap button (Basemap tab). Looks like the map's context menu;
// add entries with registerBasemapItem() (plugins / later features).

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";
import { CloudOff, Check } from "lucide-preact";
import { settings, update } from "../store";
import { openOfflineAreas } from "./OfflineAreas";
import { downloadPolicy } from "../offline/areas";
import { BASEMAPS } from "../map/basemaps";

export interface BasemapItem {
  id: string;
  label: string | ((bm: string) => string);
  icon?: any;
  run: (bm: string) => void;
  /** greyed out with this reason as the tooltip */
  disabled?: (bm: string) => string | null | undefined;
  hidden?: (bm: string) => boolean;
}

const ITEMS = signal<BasemapItem[]>([
  {
    id: "use",
    label: "Use this basemap",
    icon: Check,
    run: (bm) => update((x) => (x.basemap = bm as any)),
    hidden: (bm) => settings.value.basemap === bm,
  },
  {
    id: "offline",
    label: "Offline...",
    icon: CloudOff,
    run: (bm) => openOfflineAreas(bm as any),
    disabled: (bm) => {
      const p = downloadPolicy(bm as any);
      return p.ok ? null : `Can't download: ${p.reason}`;
    },
  },
]);

/** Add (or replace, same id) an entry; returns a function that removes it. */
export function registerBasemapItem(it: BasemapItem): () => void {
  ITEMS.value = [...ITEMS.value.filter((x) => x.id !== it.id), it];
  return () => (ITEMS.value = ITEMS.value.filter((x) => x !== it));
}

export const basemapMenu = signal<{
  bm: string;
  name?: string;
  x: number;
  y: number;
} | null>(null);

/** onContextMenu handler for a basemap button */
export const openBasemapMenu = (bm: string, name?: string) => (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  basemapMenu.value = { bm, name, x: e.clientX, y: e.clientY };
};

export function BasemapMenu() {
  const m = basemapMenu.value;
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.(".bm-menu")) basemapMenu.value = null;
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (basemapMenu.value = null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", close as any);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", close as any);
    };
  }, [m]);
  if (!m) return null;
  const items = ITEMS.value.filter((it) => !it.hidden?.(m.bm));
  const name = m.name ?? BASEMAPS.find((b) => b.id === m.bm)?.name ?? m.bm;
  const h = 34 + items.length * 32;
  // portal: the side panel's backdrop-filter would clip a fixed menu
  return createPortal(
    <div
      class="ctx glass rail-menu bm-menu"
      style={{
        left: `${Math.min(m.x + 6, window.innerWidth - 200)}px`,
        top: `${Math.min(m.y, window.innerHeight - h - 8)}px`,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div class="ctx-title">{name}</div>
      {items.map((it) => {
        const Icon = it.icon;
        const why = it.disabled?.(m.bm) || null;
        return (
          <button
            key={it.id}
            disabled={!!why}
            title={why ?? undefined}
            onClick={() => {
              basemapMenu.value = null;
              it.run(m.bm);
            }}
          >
            {Icon && <Icon size={13} />} {typeof it.label === "function" ? it.label(m.bm) : it.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
