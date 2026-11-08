// 0.8.2 windows: pure helpers for pop-out OS windows (main.cjs). No Electron imports: unit-tested.

/** pop-out kinds without an OS frame: the page draws the shared title bar */
const FRAMELESS = new Set(["camera", "radio", "metar", "radiocenter", "win"]);

/** where a pop-out's size / position is remembered (one per window; per kind for cameras etc.) */
function boundsKey(spec) {
  if (spec.kind === "win") return `win:${(spec.data && spec.data.id) || ""}`;
  return String(spec.kind || "");
}

/** pop-outs that exist once (asking again focuses it); null = may open several */
function singleKey(spec) {
  if (spec.kind === "win") return `win:${(spec.data && spec.data.id) || ""}`;
  if (spec.kind === "radiocenter") return "radiocenter";
  return null;
}

/** saved bounds still (mostly) on one of the displays' work areas */
function onScreen(b, areas) {
  if (!b || !(b.width > 0) || !(b.height > 0)) return false;
  return (areas || []).some((a) => b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 30 && b.y + b.height > a.y + 30);
}

// 0.8.3: drag a pop-out back into the main window
const OLD_KIND_WIN = { radiocenter: "c:rc", camera: "cam", metar: "metar", radio: "radio" };
/** what a dragged pop-out docks as: a window id, "pane", or null (full map windows don't dock) */
function dragId(spec) {
  if (!spec) return null;
  if (spec.kind === "win") return String((spec.data && spec.data.id) || "") || null;
  if (spec.kind === "pane") return "pane";
  return OLD_KIND_WIN[spec.kind] || null;
}
/** point inside a {x, y, width, height} rectangle */
function inside(b, p) {
  return !!b && !!p && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

module.exports = { FRAMELESS, boundsKey, singleKey, onScreen, dragId, inside };
