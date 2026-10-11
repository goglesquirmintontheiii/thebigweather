import { render } from "preact";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { App } from "./ui/App";
import { popoutSpec } from "./popout";
import { PopoutApp } from "./ui/Popout";

setWorkerUrl(new URL(workerUrl, location.href).href);

render(popoutSpec && popoutSpec.kind !== "map" ? <PopoutApp spec={popoutSpec} /> : <App />, document.getElementById("root")!);
