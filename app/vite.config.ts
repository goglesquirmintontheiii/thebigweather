import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
    // workflow 0.6: desktop widget windows get their own small entry (widget.html)
    rollupOptions: { input: { main: "index.html", widget: "widget.html" } },
  },
  server: { port: 5173 },
  // radio 0.6: the Whisper worker lazy-imports transformers.js, which needs ES-module workers
  worker: { format: "es" },
});
