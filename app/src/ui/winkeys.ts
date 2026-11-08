// 0.8.3: keyboard shortcuts in pop-out windows. A pop-out (a popped window, camera, radio, or a pane
// window) passes the keys it doesn't use itself to the main window, which runs them through its
// normal shortcut handling (hotkeys.ts, user layer keys, legend / info-panel keys). A pane window
// keeps the keys that are about its own pane (1–6 product, ↑ / ↓ tilt). Keys that open something in
// the main window (?, Ctrl+K) bring the main window to the front. Full map windows run the whole app,
// shortcuts included, so they don't pass anything on.

import { popoutSpec } from "../popout";
import { IN_OS_WIN } from "./winframe";
import { paneKey } from "./hotkeys";
import { shouldForward, raisesMain, type KeyMsg } from "./wincore";

const isMain = !popoutSpec;
const isPaneWin = popoutSpec?.kind === "pane";
const ch = typeof BroadcastChannel !== "undefined" && (isMain || IN_OS_WIN || isPaneWin) ? new BroadcastChannel("tbw-keys") : null;

if (ch && isMain) {
  // replay the key here as if it was pressed in the main window
  ch.onmessage = (e) => {
    const m = e.data as KeyMsg;
    if (m?.t !== "key" || typeof m.key !== "string") return;
    const ev = new KeyboardEvent("keydown", { key: m.key, code: m.code, ctrlKey: m.ctrlKey, shiftKey: m.shiftKey, altKey: m.altKey, metaKey: m.metaKey, repeat: m.repeat, bubbles: true, cancelable: true });
    (document.body ?? document.documentElement).dispatchEvent(ev);
  };
} else if (ch) {
  // bubble phase: the pop-out's own handlers (lists, pickers, the info panel's [ ]) go first
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target as HTMLElement | null;
    const field = !!t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);
    const button = !!t?.closest?.("button, a, [role=button], [role=menuitem], [role=option], [role=tab], [role=radio], [role=checkbox], [role=switch]");
    if (!shouldForward(e, { field, button })) return;
    if (isPaneWin && !field && paneKey(e, 1)) return;
    e.preventDefault();
    const m: KeyMsg = { t: "key", key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat };
    ch.postMessage(m);
    if (raisesMain(m))
      try {
        (window as any).tbw?.win?.focusMain?.();
      } catch {
        /* browser */
      }
  });
}
