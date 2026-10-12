// Screen recording (toolbar): records the app window to WebM. In Electron the chunks are streamed
// to Downloads/TheBigWeather through IPC (no big blob in memory); in a browser the user picks
// what to share and the file downloads when stopped.

import { signal } from "@preact/signals";
import { toast } from "./store";

export const screenRecStart = signal<number | null>(null);

let rec: MediaRecorder | null = null;
let stream: MediaStream | null = null;

function pickMime() {
  for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

export async function toggleScreenRec() {
  if (rec) return stopScreenRec();
  const io = (window as any).tbw?.screenRec as
    { open: () => Promise<{ id: string; file: string }>; write: (id: string, b: ArrayBuffer) => Promise<boolean>; close: (id: string) => Promise<string | null> } | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
      ...(io ? {} : { preferCurrentTab: true, selfBrowserSurface: "include" }),
    } as any);
  } catch (e: any) {
    if (e?.name !== "NotAllowedError") toast(`Screen recording failed: ${e?.message ?? e}`, "error", 6000);
    return;
  }
  const mimeType = pickMime();
  const r = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  rec = r;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let handle: { id: string; file: string } | null = null;
  const chunks: Blob[] = [];
  // writes run in order; stop waits for the last one
  let chain: Promise<unknown> = Promise.resolve();
  if (io) {
    try {
      handle = await io.open();
    } catch (e: any) {
      toast(`Can't save the recording: ${e?.message ?? e}`, "error");
    }
  }
  r.ondataavailable = (e) => {
    if (!e.data.size) return;
    if (handle) {
      const h = handle;
      chain = chain.then(() => e.data.arrayBuffer()).then((b) => io!.write(h.id, b));
    } else chunks.push(e.data);
  };
  r.onstop = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    rec = null;
    screenRecStart.value = null;
    await chain.catch(() => {});
    if (handle) {
      const f = await io!.close(handle.id);
      toast(f ? `Saved ${f}` : "Recording failed", f ? "info" : "error", 7000);
    } else if (chunks.length) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      a.download = `TheBigWeather-${ts}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
  };
  // the user ended sharing from the browser/OS
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopScreenRec());
  r.start(1000);
  screenRecStart.value = Date.now();
  console.log(`screenrec: MediaRecorder ${r.state} ${mimeType || "default"} ${stream.getVideoTracks()[0]?.label ?? ""}`);
}

export function stopScreenRec() {
  if (rec && rec.state !== "inactive") rec.stop();
}
