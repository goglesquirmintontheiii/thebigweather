// 0.8.4: steep-camera picking, leaving 3D, the radar link, pane window menus, the stats window tiers, the dock grip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pitchSafeFactor, fixHighPitchPicking, flatten2D, MAX_PITCH_SCALE } from "../src/map/pitchpick";
import { radarLinked, siteClickTarget, siteLinkOn } from "../src/radar/insp083";
import { paneWinMenuKey, statsTier, STATS_NAT_W } from "../src/ui/wincore";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

export function testPitchFactorSafe() {
  assert.equal(pitchSafeFactor(1), 1);
  assert.equal(pitchSafeFactor(11.8), 11.8);
  // values MapLibre 6.13 returns once the top corner is above the horizon
  for (const v of [-38.6, -1.1, 0, 500, NaN]) assert.equal(pitchSafeFactor(v), MAX_PITCH_SCALE, String(v));
}

export function testPitchFixPatchesOncePerClass() {
  class T {
    calls = 0;
    maxPitchScaleFactor() {
      this.calls++;
      return -2;
    }
  }
  const a = new T();
  fixHighPitchPicking({ transform: a });
  fixHighPitchPicking({ transform: new T() });
  assert.equal(a.maxPitchScaleFactor(), MAX_PITCH_SCALE);
  assert.equal(a.calls, 1, "wrapped once, not once per map");
  // MapLibre 6's production build keeps the transform on map._camera
  class C {
    maxPitchScaleFactor() {
      return -5;
    }
  }
  const c = new C();
  fixHighPitchPicking({ _camera: { transform: c } });
  assert.equal(c.maxPitchScaleFactor(), MAX_PITCH_SCALE);
  fixHighPitchPicking({}); // no transform yet: nothing to do
  assert.match(src("map/mapview.ts"), /fixHighPitchPicking\(map\)/);
  assert.match(src("map/panes.ts"), /fixHighPitchPicking\(this\.map\)/);
}

export function testExit3DCannotLockRotated() {
  const v = src("ui/View3D.tsx");
  // an interrupted ease still ends facing north before rotation is locked
  assert.match(v, /if \(!tilt\) flatten2D\(map\);\s+map\.setMaxPitch\(maxP\);/);
  // re-entering during the ease back must not save the half-eased camera
  assert.match(v, /this\.saved \?\?= this\.leaving \?\?/);
}

export function testFlatten2D() {
  const flat = (bearing: number, pitch: number) => {
    const m: any = { getBearing: () => bearing, getPitch: () => pitch, jumped: null as any, jumpTo: (o: any) => (m.jumped = o) };
    flatten2D(m);
    return m.jumped;
  };
  assert.deepEqual(flat(37, 0), { bearing: 0, pitch: 0 });
  assert.deepEqual(flat(0, 12), { bearing: 0, pitch: 0 });
  assert.equal(flat(0, 0), null);
}

const LK = { pos: true, time: true, layers: true };

export function testRadarLinkDefaultsAndClickTarget() {
  // unset: as before, a fully linked pane follows
  assert.equal(radarLinked(LK), true);
  assert.equal(radarLinked({ ...LK, pos: false }), false);
  assert.equal(radarLinked({ ...LK, radar: false }), false);
  assert.equal(radarLinked({ pos: false, time: false, layers: false, radar: true }), true);
  assert.equal(siteClickTarget({ ...LK, radar: false }, true), "pane");
  assert.equal(siteClickTarget({ pos: false, time: true, layers: true, radar: true }, true), "main");
}

export function testSiteLinkPerKind() {
  assert.equal(siteLinkOn("pane", { ...LK, pos: false }), false); // pane window: radar link (unset: needs all links)
  assert.equal(siteLinkOn("pane", { ...LK, pos: false, radar: true }), true);
  assert.equal(siteLinkOn("map", { ...LK, pos: false }), false); // map windows keep following position
  assert.equal(siteLinkOn("map", { ...LK, radar: false }), true);
}

export function testUnlinkedPanesKeepTheirRadar() {
  const p = src("map/panes.ts");
  assert.match(p, /radarLinked\(paneLink\(i \+ 1\)\)/);
  assert.match(p, /site: prev/);
  const w = src("linkwin.ts");
  assert.match(w, /if \(!acceptsSite\(m\)\) break;/);
  assert.match(w, /wantsSite\(\)/);
  const u = src("ui/Panes.tsx");
  assert.match(u, /radar\.can/);
  assert.match(u, /site: on \? undefined : cfg\.site \?\? s0\.radar\.site/);
}

export function testPaneWinMenuKeys() {
  const k = (key: string, m: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
  assert.equal(paneWinMenuKey(k("k", { ctrlKey: true })), "palette");
  assert.equal(paneWinMenuKey(k("K", { metaKey: true })), "palette");
  assert.equal(paneWinMenuKey(k("?", { shiftKey: true })), "keys");
  assert.equal(paneWinMenuKey(k("k")), null);
  assert.equal(paneWinMenuKey(k("?", { ctrlKey: true })), null);
  const u = src("ui/Panes.tsx");
  assert.match(u, /<ShortcutsDialog \/>\s*<CommandPalette \/>/);
  assert.match(src("ui/winkeys.ts"), /paneWinMenuKey\(e\)/);
  assert.match(src("ui/CommandPalette.tsx"), /tbw-palette-run/);
}

export function testStatsTiers() {
  assert.equal(statsTier(280, 400), 0);
  assert.equal(statsTier(500, 300), 1);
  assert.equal(statsTier(800, 400), 1);
  assert.equal(statsTier(720, 520), 2);
  assert.ok(STATS_NAT_W[0] === 280 && STATS_NAT_W[1] > STATS_NAT_W[0] && STATS_NAT_W[2] > STATS_NAT_W[1]);
}

export function testDockGripUsesRealDnd() {
  const d = src("ui/WinDrop.tsx");
  assert.match(d, /t: "dragstart"/);
  assert.match(d, /"dragover"/);
  assert.match(d, /"drop"/);
  assert.match(d, /t: "dropat"/);
  const f = src("ui/winframe.tsx");
  assert.match(f, /draggable/);
  assert.match(f, /tbw-dock-drag-start/);
}
