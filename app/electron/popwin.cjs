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

module.exports = { FRAMELESS, boundsKey, singleKey, onScreen };
