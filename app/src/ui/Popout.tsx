// Content of a pop-out window (camera or radio). Map pop-outs run the full app instead.

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

export function PopoutApp({ spec }: { spec: PopoutSpec }) {
  useEffect(() => {
    document.title = spec.title ?? "TheBigWeather";
    api.configure(activeServer.value);
    if (spec.kind === "radio" && spec.data) playStream(spec.data);
  }, []);
  return (
    <div class={`popout popout-${spec.kind}`}>
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
