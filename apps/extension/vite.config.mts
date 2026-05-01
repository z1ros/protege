import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    // Per-icon tree-shaking for Iconify sets. Import like:
    //   import IconJavaScript from "~icons/devicon-plain/javascript";
    // Only the specific icons we reference end up in the bundle.
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  define: {
    // PROTEGE_SHOW_CODEIQ gates the legacy Code IQ tab — see the Echo
    // archive plan. Inlined at build time so the runtime check stays
    // tree-shakeable.
    "process.env.PROTEGE_SHOW_CODEIQ": JSON.stringify(
      process.env.PROTEGE_SHOW_CODEIQ ?? ""
    ),
    // Same backend URL the host extension uses (PROTEGE_BACKEND_URL),
    // injected so the webview can fetch /tts, /log, etc. against the
    // same server. Without this define the webview falls back to its
    // hardcoded `http://localhost:8787` default — which silently fails
    // on machines hitting the prod backend, leaving voice mode stuck
    // on "Speaking" because audio never starts.
    __PROTEGE_BACKEND_URL__: JSON.stringify(
      process.env.PROTEGE_BACKEND_URL ?? "http://localhost:8787"
    ),
  },
  root: resolve(__dirname, "webview"),
  // Relative asset paths — the webview HTML sets <base href> to the
  // webview-safe URI for dist/webview/, so "./assets/foo.png" resolves
  // correctly through VS Code's resource protocol.
  base: "./",
  // Dev server used by the HMR pipeline. During development the extension
  // panel HTML swaps in <script src="http://localhost:5173/..."> instead
  // of the bundled dist/ assets, so webview edits reload in ~100ms with
  // React state preserved. cors:true is required because the webview
  // origin (vscode-webview://...) fetches these scripts cross-origin.
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    // origin is critical for the VSCode webview use-case: Vite otherwise
    // rewrites module imports to root-relative paths like "/App.tsx",
    // which the webview resolves against its own vscode-webview:// origin
    // (404). Setting origin forces Vite to emit absolute URLs pointing
    // back at the dev server.
    origin: "http://localhost:5173",
    hmr: { port: 5173 },
  },
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "webview/index.html"),
        echo: resolve(__dirname, "webview/echo/index.html"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "echo" || chunk.facadeModuleId?.includes("/webview/echo/")) {
            return "echo/echo.js";
          }
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css") && assetInfo.name.includes("echo")) {
            return "echo/echo.css";
          }
          return "assets/[name].[ext]";
        },
      },
    },
  },
});
