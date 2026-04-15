import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "webview"),
  // Relative asset paths — the webview HTML sets <base href> to the
  // webview-safe URI for dist/webview/, so "./assets/foo.png" resolves
  // correctly through VS Code's resource protocol.
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "webview/index.html"),
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
