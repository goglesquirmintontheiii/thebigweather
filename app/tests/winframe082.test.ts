// 0.8.2 windows: window stack, settings diff for pop-out sync, rail → window ids, pop-out keys.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { raise, topOf, centerId, changedKeys, livePeers, railWinId, RAIL_WIN } from "../src/ui/wincore";

const PW = createRequire(import.meta.url)("../electron/popwin.cjs");
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

export function testStack() {
  let s: string[] = [];
  s = raise(s, "a");
  s = raise(s, "b");
  s = raise(s, "a");
  assert.deepEqual(s, ["b", "a"]);
  assert.equal(topOf(s, () => false), "a");
  assert.equal(topOf(s, (id) => id === "a"), "b"); // the top one is minimized → the next
  assert.equal(topOf(s, () => true), null);
  assert.equal(topOf([], () => false), null);
}

export function testCenterId() {
  assert.equal(centerId("fcc", "Forecast"), "c:fcc");
  assert.equal(centerId("  sk sk-menu-win ", "x"), "c:sk");
  assert.equal(centerId("mlcenter ml-hidden", "x"), "c:mlcenter");
  assert.equal(centerId("", "Forecast"), "c:Forecast");
  assert.equal(centerId("", {}), "c:window");
}

export function testChangedKeys() {
  const a = { radar: { site: "KTLX" }, view: { zoom: 6 }, list: [1, 2] };
  const r1 = changedKeys({}, a);
  assert.deepEqual(Object.keys(r1.changed).sort(), ["list", "radar", "view"]);
  const r2 = changedKeys(r1.snap, { ...a, view: { zoom: 7 } });
  assert.deepEqual(r2.changed, { view: { zoom: 7 } });
  assert.equal(r1.snap.view, JSON.stringify({ zoom: 6 }), "the old snapshot is not changed");
  const r3 = changedKeys(r2.snap, { ...a, view: { zoom: 7 } });
  assert.deepEqual(r3.changed, {});
  const r4 = changedKeys(r3.snap, { ...a, view: { zoom: 7 }, radar: { site: "KLOT" } }, new Set(["radar"]));
  assert.deepEqual(r4.changed, {}, "skipped keys never sync");
  // cyclic values are skipped instead of throwing
  const cyc: any = {};
  cyc.self = cyc;
  assert.deepEqual(changedKeys({}, { cyc }).changed, {});
}

export function testLivePeers() {
  const p = { a: { id: "c:fcc", at: 1000 }, b: { id: "p:radar", at: 9500 } };
  assert.deepEqual(Object.keys(livePeers(p, 10_000)), ["b"]);
  assert.deepEqual(Object.keys(livePeers(p, 10_000, 20_000)).sort(), ["a", "b"]);
}

export function testRailIdsMatchWindows() {
  assert.equal(railWinId("radar"), "p:radar");
  assert.equal(railWinId("forecast"), "c:fcc");
  // every rail window id is the class its CenterModal really uses (minimize / pop-out state is keyed by it)
  const files: Record<string, string> = { fcc: "ui/ForecastCenter.tsx", rc: "ui/RadioCenter.tsx", sk: "ui/ShakeMenu.tsx", hstorm: "ui/HistStorms.tsx", mlcenter: "ui/ModelsCenter.tsx", "d6-space": "ui/SpacePanel.tsx", dash: "ui/Dashboard.tsx", atl: "ui/AlertTimeline.tsx" };
  for (const id of Object.values(RAIL_WIN)) {
    const cls = id.slice(2);
    const f = files[cls];
    assert.ok(f, `no file for ${id}`);
    assert.match(src(f), new RegExp(`cls=\\{?[\`"]${cls.replace("-", "\\-")}[\\s"$\`]`), `${f} has cls="${cls}"`);
  }
}

export function testPopwinKeys() {
  assert.ok(PW.FRAMELESS.has("win") && PW.FRAMELESS.has("camera") && !PW.FRAMELESS.has("map") && !PW.FRAMELESS.has("pane"));
  assert.equal(PW.boundsKey({ kind: "win", data: { id: "c:fcc" } }), "win:c:fcc");
  assert.equal(PW.boundsKey({ kind: "camera", data: { id: "x" } }), "camera");
  assert.equal(PW.singleKey({ kind: "win", data: { id: "p:radar" } }), "win:p:radar");
  assert.equal(PW.singleKey({ kind: "radiocenter" }), "radiocenter");
  assert.equal(PW.singleKey({ kind: "camera" }), null);
  const areas = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.ok(PW.onScreen({ x: 100, y: 100, width: 600, height: 400 }, areas));
  assert.ok(!PW.onScreen({ x: 2500, y: 100, width: 600, height: 400 }, areas), "monitor unplugged");
  assert.ok(!PW.onScreen(null, areas));
  assert.ok(!PW.onScreen({ x: 0, y: 0, width: 0, height: 10 }, areas));
}

export function testLabels() {
  // 0.8.2 user wording
  assert.match(src("share/DesktopSettings.tsx"), /label="X button minimizes"/);
  assert.match(src("ui/panels/SettingsPanel.tsx"), /name: "Data sources"/); // 0.8.4: a Settings category
  assert.doesNotMatch(src("ui/Sidebar.tsx"), /\{ id: "sources", icon/);
}
