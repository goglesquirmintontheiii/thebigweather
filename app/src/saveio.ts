// Save a file to Downloads/TheBigWeather (Electron IPC) or as a browser download; pick a file to open.

import { toast } from "./store";

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Returns the saved path (Electron) or the file name (browser download). */
export async function saveFile(name: string, data: Blob | ArrayBuffer | Uint8Array | string, mime = "application/octet-stream"): Promise<string | null> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const io = (window as any).tbw?.saveFile as ((n: string, b: ArrayBuffer) => Promise<string>) | undefined;
  if (io) {
    try {
      return await io(name, await blob.arrayBuffer());
    } catch (e: any) {
      toast(`Save failed: ${e?.message ?? e}`, "error");
      return null;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return name;
}

/** Let the user pick a file; resolves with its text (null when cancelled). */
export function pickTextFile(accept = ".json"): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    inp.click();
  });
}
