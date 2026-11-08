import assert from "node:assert/strict";
import { recGroup, groupRecs, loadCollapsed, saveCollapsed, fmtSize } from "../src/ui/recgroups";

export function testRecGroups() {
  assert.equal(recGroup({ kind: "radar" }), "radar");
  assert.equal(recGroup({ kind: "camera", camera: { kind: "img", url: "https://x/a.jpg" } }), "camera");
  assert.equal(recGroup({ kind: "camera", camera: { kind: "hls", url: "https://x/a.m3u8" } }), "video");
  assert.equal(recGroup({ kind: "camera", camera: { kind: "yt", url: "https://www.youtube.com/watch?v=a" } }), "video");
  // older recordings may carry the YouTube URL with another kind
  assert.equal(recGroup({ kind: "camera", camera: { kind: "img", url: "https://youtu.be/abc" } }), "video");
  assert.equal(recGroup({ kind: "radar", imported: true }), "other");
  assert.equal(recGroup({ kind: "camera" }), "other");
  assert.equal(recGroup({ kind: "radio" }), "other");

  const g = groupRecs([
    { kind: "radar", bytes: 10 },
    { kind: "camera", camera: { kind: "img" }, bytes: 5 },
    { kind: "radar", bytes: 20 },
    { kind: "camera", camera: { kind: "yt" }, bytes: 1 },
  ]);
  assert.deepEqual(
    g.map((x) => [x.id, x.items.length, x.bytes]),
    [
      ["camera", 1, 5],
      ["video", 1, 1],
      ["radar", 2, 30],
      ["other", 0, 0],
    ],
  );
  assert.equal(fmtSize(2.5e9), "2.5 GB");
  assert.equal(fmtSize(3e6 + 1), "3.0 MB");
}

export function testCollapsedRemembered() {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(loadCollapsed(store).size, 0);
  saveCollapsed(new Set(["radar", "tl"]), store);
  assert.deepEqual([...loadCollapsed(store)].sort(), ["radar", "tl"]);
  m.set("tbw.recSections", "{bad json");
  assert.equal(loadCollapsed(store).size, 0);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(loadCollapsed(throwing).size, 0);
  saveCollapsed(new Set(["x"]), throwing); // doesn't throw
  assert.equal(loadCollapsed(undefined).size, 0);
}
