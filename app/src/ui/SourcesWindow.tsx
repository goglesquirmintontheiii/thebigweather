// 0.8.2: Data sources (was a rail tab) opens as a window from Settings → "Data sources".

import { signal } from "@preact/signals";
import { Activity } from "lucide-preact";
import { CenterModal } from "./CenterModal";
import { SourcesPanel } from "./panels/SourcesPanel";
import { connection } from "../store";

export const sourcesOpen = signal(false);

export function SourcesWindow() {
  if (!sourcesOpen.value) return null;
  return (
    <CenterModal cls="srcwin" icon={<Activity size={18} />} title="Data sources" sub={connection.value === "online" ? "Connected" : `Server: ${connection.value}`} onClose={() => (sourcesOpen.value = false)}>
      <SourcesPanel />
    </CenterModal>
  );
}
