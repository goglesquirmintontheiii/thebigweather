import { render } from "preact";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { App } from "./ui/App";

setWorkerUrl(new URL(workerUrl, location.href).href);

render(<App />, document.getElementById("root")!);
