// 0.8.3: snap-zone geometry for docking pop-out panes / windows back into the main window.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { snapAt, addEdge, splitCell, normalize, sameGrid, cellRect, inRect, edgeBand, homeFallback, matchLayout, type Grid } from "../src/ui/winsnap";
import { fitScale, shouldForward, raisesMain, paneWinOwnKey } from "../src/ui/wincore";

export function testPopoutKeyForwarding() {
  const k = (key: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });
  const plain = { field: false, button: false };
  for (const key of [" ", "ArrowLeft", "1", "d", "?", "[", ","]) assert.ok(shouldForward(k(key), plain), key);
  assert.ok(shouldForward(k("g", { ctrlKey: true, shiftKey: true }), plain)); // a user layer key
  assert.ok(shouldForward(k("k", { ctrlKey: true }), { field: true, button: false })); // palette from a text field
  assert.ok(!shouldForward(k("d"), { field: true, button: false }));
  assert.ok(!shouldForward(k("Escape"), plain));
  assert.ok(!shouldForward(k("Tab"), plain));
  assert.ok(!shouldForward(k("Shift"), plain));
  assert.ok(!shouldForward(k(" "), { field: false, button: true }));
  assert.ok(!shouldForward(k("c", { ctrlKey: true }), plain));
  assert.ok(raisesMain(k("?")) && raisesMain(k("k", { metaKey: true })) && !raisesMain(k("d")));
  // integration 0.8.3: a pane window keeps I (its Inspector) and B (its bearing tool)
  assert.ok(paneWinOwnKey(k("i")) && paneWinOwnKey(k("B")) && !paneWinOwnKey(k("i", { ctrlKey: true })) && !paneWinOwnKey(k("d")));
}

export function testFitScale() {
  assert.equal(fitScale(280, 1000, 280, 300), 1);
  assert.equal(fitScale(560, 1000, 280, 300), 2);
  assert.equal(fitScale(560, 450, 280, 300), 1.5); // height-bound
  assert.equal(fitScale(100, 100, 280, 300), 0.75); // clamped
  assert.equal(fitScale(0, 100, 280, 300), 1);
}

const PW = createRequire(import.meta.url)("../electron/popwin.cjs");
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

const ONE: Grid = { rows: 1, cols: 1, cells: [{ r: 0, c: 0, rs: 1, cs: 1 }] };
const TWO: Grid = { rows: 1, cols: 2, cells: [{ r: 0, c: 0, rs: 1, cs: 1 }, { r: 0, c: 1, rs: 1, cs: 1 }] };
const FOUR: Grid = { rows: 2, cols: 2, cells: [{ r: 0, c: 0, rs: 1, cs: 1 }, { r: 0, c: 1, rs: 1, cs: 1 }, { r: 1, c: 0, rs: 1, cs: 1 }, { r: 1, c: 1, rs: 1, cs: 1 }] };
const BOX = { x: 0, y: 0, w: 1000, h: 600 };

export function testSplitOneMapIsTwoSideBySide() {
  const g = splitCell(ONE, 0, "right");
  assert.ok(sameGrid(g, TWO));
  const t = splitCell(ONE, 0, "top");
  assert.deepEqual(t, { rows: 2, cols: 1, cells: [{ r: 1, c: 0, rs: 1, cs: 1 }, { r: 0, c: 0, rs: 1, cs: 1 }] });
}

export function testTopRightCornerOfTwo() {
  // right pane of "two side by side", near its top: the docked pane takes the top right quarter
  const h = snapAt(TWO, BOX, 800, 120)!;
  assert.equal(h.key, "cell:1:top");
  assert.deepEqual(h.rect, { x: 500, y: 0, w: 500, h: 300 });
  assert.equal(h.grid.cells.length, 3);
  // main pane untouched, old pane keeps its place below
  assert.deepEqual(h.grid.cells[0], { r: 0, c: 0, rs: 2, cs: 1 });
  assert.deepEqual(h.grid.cells[1], { r: 1, c: 1, rs: 1, cs: 1 });
}

export function testOuterEdgeAddsColumnAndRow() {
  const r = snapAt(TWO, BOX, 995, 300)!;
  assert.equal(r.key, "edge:right");
  assert.deepEqual(r.grid, { rows: 1, cols: 3, cells: [TWO.cells[0], TWO.cells[1], { r: 0, c: 2, rs: 1, cs: 1 }] });
  assert.ok(Math.abs(r.rect.x - 666.67) < 0.1 && Math.abs(r.rect.w - 333.33) < 0.1);
  const b = snapAt(FOUR, BOX, 500, 598)!;
  assert.equal(b.key, "edge:bottom");
  assert.equal(b.grid.rows, 3);
  assert.deepEqual(b.grid.cells[4], { r: 2, c: 0, rs: 1, cs: 2 });
  const l = addEdge(ONE, "left");
  assert.deepEqual(l.cells, [{ r: 0, c: 1, rs: 1, cs: 1 }, { r: 0, c: 0, rs: 1, cs: 1 }]);
}

export function testMiddleOutsideAndFullAreNoSpot() {
  assert.equal(snapAt(TWO, BOX, 250, 300), null); // middle of the main pane
  assert.equal(snapAt(TWO, BOX, -5, 300), null); // outside the map
  assert.equal(snapAt(null, BOX, 10, 10), null); // swipe compare (no grid)
  const six: Grid = { rows: 2, cols: 3, cells: Array.from({ length: 6 }, (_, i) => ({ r: Math.floor(i / 3), c: i % 3, rs: 1, cs: 1 })) };
  assert.equal(snapAt(six, BOX, 995, 300, 6), null);
  assert.ok(snapAt(six, BOX, 995, 300, 7));
}

export function testEveryHitTilesItsGrid() {
  for (const g of [ONE, TWO, FOUR])
    for (let x = 1; x < 1000; x += 37)
      for (let y = 1; y < 600; y += 29) {
        const h = snapAt(g, BOX, x, y);
        if (!h) continue;
        const n = new Array(h.grid.rows * h.grid.cols).fill(0);
        for (const c of h.grid.cells) for (let r = c.r; r < c.r + c.rs; r++) for (let k = c.c; k < c.c + c.cs; k++) n[r * h.grid.cols + k]++;
        assert.ok(n.every((v) => v === 1), `${h.key} tiles`);
        assert.equal(h.grid.cells.length, g.cells.length + 1);
        assert.ok(inRect(h.rect, x, y, 1) || h.key.startsWith("edge:"), `${h.key} under the cursor`);
      }
}

export function testNormalizeAndHelpers() {
  assert.deepEqual(normalize({ rows: 4, cols: 2, cells: [{ r: 0, c: 0, rs: 2, cs: 2 }, { r: 2, c: 0, rs: 2, cs: 2 }] }), { rows: 2, cols: 1, cells: [{ r: 0, c: 0, rs: 1, cs: 1 }, { r: 1, c: 0, rs: 1, cs: 1 }] });
  assert.deepEqual(cellRect(FOUR, FOUR.cells[3], { x: 10, y: 20, w: 100, h: 50 }), { x: 60, y: 45, w: 50, h: 25 });
  assert.ok(edgeBand(BOX) >= 14 && edgeBand(BOX) <= 48);
  const p = homeFallback("p:layers", { w: 1600, h: 900 });
  assert.ok(p.x > 0 && p.w <= 400);
  const c = homeFallback("c:fcc", { w: 1600, h: 900 }, { w: 1100, h: 760 });
  assert.deepEqual([c.x, c.w], [250, 1100]);
}

export function testMatchLayoutReorders() {
  const L = [
    { id: "2", ...TWO },
    { id: "3", rows: 2, cols: 2, cells: [{ r: 0, c: 0, rs: 2, cs: 1 }, { r: 0, c: 1, rs: 1, cs: 1 }, { r: 1, c: 1, rs: 1, cs: 1 }] },
  ];
  // "two side by side" + a pane dropped on the top of the right one = "three: one large + two stacked",
  // with the docked pane (index 2) first among the right-hand ones
  const g = snapAt(TWO, BOX, 800, 120)!.grid;
  assert.deepEqual(matchLayout(g, L), { id: "3", perm: [0, 2, 1] });
  assert.deepEqual(matchLayout(splitCell(ONE, 0, "right"), L), { id: "2", perm: [0, 1] });
  // main map on the right isn't "two side by side" (the main map stays the main map)
  assert.equal(matchLayout(splitCell(ONE, 0, "left"), L), null);
  assert.equal(matchLayout(addEdge(TWO, "right"), L), null);
}

export function testPopwinDragIds() {
  assert.equal(PW.dragId({ kind: "win", data: { id: "c:fcc" } }), "c:fcc");
  assert.equal(PW.dragId({ kind: "pane" }), "pane");
  assert.equal(PW.dragId({ kind: "radiocenter" }), "c:rc");
  assert.equal(PW.dragId({ kind: "camera" }), "cam");
  assert.equal(PW.dragId({ kind: "map" }), null);
  assert.equal(PW.inside({ x: 0, y: 0, width: 100, height: 50 }, { x: 99, y: 49 }), true);
  assert.equal(PW.inside({ x: 0, y: 0, width: 100, height: 50 }, { x: 100, y: 10 }), false);
}

export function testWindowButtonsOrderAndLabels() {
  const f = src("ui/winframe.tsx");
  // red · yellow · gray · green (pop out), the pop-out tooltip is just "Pop out"
  const i = ["wf-close", "wf-min", "wf-zoom", "wf-popl"].map((c) => f.indexOf(`"wf-l ${c}`));
  assert.ok(i.every((v) => v > 0) && i[0] < i[1] && i[1] < i[2] && i[2] < i[3], `order ${i}`);
  assert.match(f, /"Pop out"/);
  assert.doesNotMatch(f, /Pop out to its own window/);
  // the alert info panel has the shared title bar
  assert.match(src("ui/AlertDetail.tsx"), /<WinButtons/);
}
