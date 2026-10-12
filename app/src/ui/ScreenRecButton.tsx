// Toolbar button: record the app window to a WebM video.

import { useEffect, useState } from "preact/hooks";
import { Video, Square } from "lucide-preact";
import { screenRecStart, toggleScreenRec } from "../screenrec";
import { fmtElapsed } from "../radarrec";

export function ScreenRecButton() {
  const start = screenRecStart.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!start) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [start]);
  return (
    <button class={`tb ${start ? "srec-on" : ""}`} title={start ? "Stop screen recording" : "Record the screen (saved to Downloads/TheBigWeather)"} onClick={toggleScreenRec}>
      {start ? <Square size={15} /> : <Video size={19} />}
      {start && (
        <span class="srec-badge">
          <i class="rec-pulse" />
          {fmtElapsed(Date.now() - start)}
        </span>
      )}
    </button>
  );
}
