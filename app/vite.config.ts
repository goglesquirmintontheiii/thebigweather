import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  server: { port: 5173 },
});
