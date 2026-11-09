// 0.8.4: clicks at steep camera angles. MapLibre's maxPitchScaleFactor() unprojects the top-left
// screen corner to scale the query padding. Once that corner is above the horizon (pitch over ~71°
// with the default field of view) the result is negative or huge, the padding shrinks the query box
// to nothing and queryRenderedFeatures finds no tile: nothing on the map could be clicked or hovered.

/** the largest padding scale used; below the horizon the real value is far smaller */
export const MAX_PITCH_SCALE = 16;

/** MapLibre's factor if it's usable, otherwise the largest padding scale */
export function pitchSafeFactor(v: number): number {
  return v > 0 && v <= MAX_PITCH_SCALE ? v : MAX_PITCH_SCALE;
}

/** 0.8.4: a map that can't rotate in 2D must end up facing north and flat */
export function flatten2D(map: { getBearing(): number; getPitch(): number; jumpTo(o: { bearing: number; pitch: number }): unknown }) {
  if (Math.abs(map.getBearing()) > 0.01 || map.getPitch() > 0.01) map.jumpTo({ bearing: 0, pitch: 0 });
}

const patched = new WeakSet<object>();

/** Corrects the factor for every map using this transform class (safe to call for each map). */
export function fixHighPitchPicking(map: object) {
  const m = map as { _camera?: { transform?: unknown }; transform?: unknown };
  const tr = m._camera?.transform ?? m.transform; // MapLibre 6 keeps it on the camera
  const proto = tr ? Object.getPrototypeOf(tr) : null;
  if (!proto || patched.has(proto) || typeof proto.maxPitchScaleFactor !== "function") return;
  patched.add(proto);
  const orig = proto.maxPitchScaleFactor;
  proto.maxPitchScaleFactor = function (this: unknown) {
    return pitchSafeFactor(orig.call(this));
  };
}
