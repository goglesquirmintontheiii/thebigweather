// Pop-out windows (Electron): a camera, the radio player or a second map in its own OS window.

export interface PopoutSpec {
  kind: "camera" | "radio" | "map" | "radiocenter" | "metar" /* workflow */;
  title?: string;
  width?: number;
  height?: number;
  /** camera view, radio stream, or map settings overrides */
  data?: any;
}

/** The spec when this window is a pop-out. */
export const popoutSpec: PopoutSpec | null = (() => {
  const m = location.hash.match(/popout=([^&]+)/);
  if (!m) return null;
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
})();

export const canPopout = () => !!(window as any).tbw?.popout;

export function popout(spec: PopoutSpec) {
  const t = (window as any).tbw;
  if (t?.popout) return t.popout(spec);
  // browser fallback: a plain new tab with the same hash
  window.open(`${location.pathname}#popout=${encodeURIComponent(JSON.stringify(spec))}`, "_blank");
}
