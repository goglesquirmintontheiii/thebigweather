// Content of a pop-out window (camera, radio, METAR, the radio centre, or — 0.8.2 — any window
// from winreg.tsx). Map pop-outs run the full app instead. 0.8.2: these windows are frameless; the
// shared title bar (dock back · close · minimize · maximize) drags the OS window.

import { useEffect } from "preact/hooks";
import type { PopoutSpec } from "../popout";
import { CameraFull } from "./CameraPanels";
import { NowPlaying } from "./panels/RadioPanel";
import { playStream } from "../radio";
import { api } from "../api";
import { activeServer } from "../store";
import { RadioCenter } from "./RadioCenter";
import { RadioPlayers } from "./RadioPlayer";
import { MetarFull } from "./MetarPanels"; // workflow
import { WinButtons } from "./winframe"; // 0.8.2
import { PopWin } from "./winreg"; // 0.8.2

export function PopoutApp({ spec }: { spec: PopoutSpec }) {
  useEffect(() => {
    document.title = spec.title ?? "TheBigWeather";
    api.configure(activeServer.value);
    if (spec.kind === "radio" && spec.data) playStream(spec.data);
  }, []);
  if (spec.kind === "win") return <PopWin id={String(spec.data?.id ?? "")} arg={spec.data?.arg} />; // 0.8.2
  // 0.8.2: camera / radio / METAR get the shared title bar (the radio centre draws its own)
  const bar = spec.kind !== "radiocenter" && (
    <div class="wf-osbar wf-bar">
      <WinButtons os onClose={() => {}} />
      <span class="wf-ostitle">{spec.title}</span>
    </div>
  );
  return (
    <div class={`popout popout-${spec.kind}`}>
      {bar}
      {spec.kind === "camera" && spec.data && <CameraFull c={spec.data} />}
      {spec.kind === "radio" && <NowPlaying />}
      {/* workflow */ spec.kind === "metar" && spec.data && <MetarFull id={spec.data.id} />}
      {spec.kind === "radiocenter" && (
        <>
          <RadioCenter popped />
          <RadioPlayers />
        </>
      )}
    </div>
  );
}
