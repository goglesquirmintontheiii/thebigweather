// 0.8.2: dev-only feedback capture — the STORMIQ-FB2 code must decode with the reference decoder
// (copied verbatim from capture_format.md; the checklist page uses exactly this).
import { encodeCapture, b85encode, compact, decodeCapture, fitScale, PREFIX } from "../src/devcapture/code";

const assert = (c: any, m = "assertion failed") => {
  if (!c) throw new Error(m);
};

/* ----- reference decoder (verbatim) ----- */
const B85 = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(ch => !"\"&'*<>\\_`".includes(ch)).join("");
function b85decode(t: string) {
  const idx = new Map([...B85].map((ch, i) => [ch, i]));
  const out = new Uint8Array(Math.floor(t.length / 5) * 4 + 4); let o = 0;
  for (let i = 0; i < t.length; i += 5) {
    const g = t.slice(i, i + 5), n = g.length;
    if (n === 1) throw new Error("bad length");
    let v = 0;
    for (const ch of g.padEnd(5, B85[84])) { const d = idx.get(ch); if (d === undefined) throw new Error("bad character"); v = v * 85 + d; }
    for (let k = 3; k >= 0; k--) { const byte = v % 256; v = Math.floor(v / 256); if (k < n - 1) out[o + k] = byte; }
    o += n - 1;
  }
  return out.slice(0, o);
}
// then: inflate with DecompressionStream("deflate-raw"); n = DataView.getUint32(0); JSON = bytes[4..4+n]; image = rest
async function refDecode(code: string) {
  assert(code.startsWith("STORMIQ-FB2:"), "prefix");
  const bytes = b85decode(code.slice("STORMIQ-FB2:".length));
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const raw = new Uint8Array(await new Response(s).arrayBuffer());
  const n = new DataView(raw.buffer).getUint32(0);
  return { json: JSON.parse(new TextDecoder().decode(raw.slice(4, 4 + n))), image: raw.slice(4 + n) };
}
/* ----- end reference decoder ----- */

export function testAlphabet() {
  assert(B85.length === 85, "85 chars");
  for (const bad of "\"&'*<>\\_`") assert(!b85encode(new Uint8Array([0x22, 0x26, 0x27, 0x2a, 0xff, 0xfe, 9, 7, 1])).includes(bad), `no ${bad}`);
}

export function testB85AllPartialLengths() {
  // every partial group length round-trips through the reference decoder
  for (let len = 0; len < 40; len++) {
    const b = new Uint8Array(len).map((_, i) => (i * 97 + len * 13) & 255);
    if (len > 3) b[3] = 255;
    const enc = b85encode(b);
    assert(enc.length === Math.floor(len / 4) * 5 + (len % 4 ? (len % 4) + 1 : 0), `length ${len}`);
    const dec = b85decode(enc);
    assert(dec.length === len && dec.every((x, i) => x === b[i]), `round trip ${len}`);
  }
  // all-0xff group (max value) and all-zero group
  const ff = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
  assert(b85decode(b85encode(ff)).every((x, i) => x === ff[i]), "ff/00");
}

const sample = () => ({
  tool: "stormiq-feedback",
  v: 2,
  kind: "bug",
  priority: "high",
  text: "This button doesn't work\nClicking Install does nothing — “quotes” ünïcödé ⚡",
  target: "element",
  at: 1762560000000,
  app: { version: "0.8.2", platform: "linux", server: "0.8.2" },
  page: { path: "rail:plugins", heading: "Storm ETA chime", dialog: "", tabs: ["Marketplace"], viewport: { w: 1600, h: 960 }, theme: "dark", map: { center: [-97.5, 35.4], zoom: 6.2, layer: "radar:L2/REF", panes: 1 } },
  element: { selector: "div.plgm-d-actions > button.btn.sm", tag: "button", name: "Install", role: "button", disabled: false, sections: ["Plugins"], within: null, component: "plgm-d > plgm-d-head", html: '<button class="btn sm"><svg/> Install</button>' },
  containers: [{ tag: "div", name: "Storm ETA chime" }],
  notes: [],
});

export async function testRoundTripElement() {
  const code = await encodeCapture(sample());
  assert(code.startsWith(PREFIX), "prefix");
  assert(/^[!-~]+$/.test(code), "printable ascii, one line");
  const { json, image } = await refDecode(code);
  assert(json.kind === "bug" && json.priority === "high" && json.target === "element", "fields");
  assert(json.text === sample().text, "unicode text survives");
  assert(json.element.name === "Install" && json.page.map.center[0] === -97.5, "nested");
  assert(!("notes" in json) && !("dialog" in json.page) && !("within" in json.element), "empty fields omitted");
  assert(json.element.disabled === false, "false is kept");
  assert(image.length === 0, "no image");
}

export async function testRoundTripAreaWithShot() {
  const shot = new Uint8Array(50_000).map((_, i) => (i * 31 + (i >> 7)) & 255); // stands in for WebP bytes
  const j = { ...sample(), target: "area", element: undefined, area: { x: 10, y: 20, w: 300, h: 200 }, elements: Array.from({ length: 60 }, (_, i) => ({ n: i + 1, tag: "button", name: `B${i}`, role: "button", box: { x: i, y: i, w: 20, h: 10 } })), shot: { type: "image/webp", w: 300, h: 200, scale: 1 } };
  const code = await encodeCapture(j, shot);
  const { json, image } = await refDecode(code);
  assert(json.target === "area" && json.area.w === 300 && json.elements.length === 60, "area json");
  assert(json.shot.type === "image/webp", "shot meta");
  assert(image.length === shot.length && image.every((x, i) => x === shot[i]), "image bytes");
  // the app's own decoder agrees
  const own = await decodeCapture(code);
  assert(own.shot!.length === shot.length && own.json.elements[59].name === "B59", "own decoder");
}

export async function testCompactSize() {
  // a typical element capture without a screenshot stays small
  const code = await encodeCapture(sample());
  assert(code.length < 1200, `small (${code.length})`);
}

export function testCompactAndFit() {
  const c = compact({ a: "", b: [], c: {}, d: null, e: 0, f: false, g: { h: undefined, i: [{}, "x"] } });
  assert(JSON.stringify(c) === '{"e":0,"f":false,"g":{"i":["x"]}}', JSON.stringify(c));
  assert(fitScale(2560, 1440) === 0.5 && fitScale(800, 600) === 1, "fit");
}
