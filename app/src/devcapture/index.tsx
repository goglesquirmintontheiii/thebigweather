// 0.8.2 TEMPORARY development-only feedback capture (Ctrl+Shift+K).
// To remove it: delete src/devcapture/, the import in src/main.tsx, the <DevCaptureSetting /> line in
// SettingsPanel.tsx and the "devcap" bits marked 0.8.2 in electron/preload.cjs + electron/main.cjs.

import { installDevCapture, captureEnabled, setCaptureEnabled } from "./DevCapture";
import { popoutSpec } from "../popout";
import { Toggle } from "../ui/panels/RadarPanel";

// main window and popped-out windows (0.8.2 integration: "win" / radio centre pop-outs too; not pane
// windows / widgets). The shot is of the window the shortcut was pressed in.
const POP_OK = ["win", "radiocenter"];
if (typeof window !== "undefined" && (!popoutSpec || POP_OK.includes(popoutSpec.kind)) && !/widget\.html$/.test(location.pathname)) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installDevCapture, { once: true });
  else installDevCapture();
}

/** Settings → Advanced */
export function DevCaptureSetting() {
  return (
    <section>
      <label class="lbl">Advanced</label>
      <Toggle label="Feedback capture (Ctrl+Shift+K)" on={captureEnabled.value} set={setCaptureEnabled} />
      <div class="muted small">Development tool: pick an element or area, add a note, and copy a code for the developer.</div>
    </section>
  );
}
