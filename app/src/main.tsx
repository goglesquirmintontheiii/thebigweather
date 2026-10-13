import { render } from "preact";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { App } from "./ui/App";
import { popoutSpec } from "./popout";
import { PopoutApp } from "./ui/Popout";
import { shareParam, initViewer } from "./share/share";

setWorkerUrl(new URL(workerUrl, location.href).href);

const go = () => render(popoutSpec && popoutSpec.kind !== "map" && popoutSpec.kind !== "pane" /* panes 0.8: App renders the pane window */ ? <PopoutApp spec={popoutSpec} /> : <App />, document.getElementById("root")!);
// share links (Phase 6): ?share=<id> loads the shared workspace first
if (shareParam) initViewer().finally(go);
else go();
