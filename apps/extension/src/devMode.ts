import * as vscode from "vscode";

export const VITE_DEV_PORT = 5173;
export const VITE_DEV_ORIGIN = `http://localhost:${VITE_DEV_PORT}`;
export const VITE_DEV_WS = `ws://localhost:${VITE_DEV_PORT}`;

// Answered by VS Code at activation time — never baked into the bundle.
// Values: Production (1) marketplace install, Development (2) F5 dev host,
// Test (3) vscode-test runner. We want the dev-server path only in (2).
export function isDevMode(mode: vscode.ExtensionMode): boolean {
  return mode === vscode.ExtensionMode.Development;
}

// VSCode intercepts localhost connections from webviews. Without
// portMapping the network layer silently drops fetches to the Vite dev
// server, even when CSP permits the origin. Merging this mapping into
// every Echo/Protege panel's options in dev mode is what actually makes
// HMR reachable.
export function devPortMapping(): vscode.WebviewPortMapping[] {
  return [{ webviewPort: VITE_DEV_PORT, extensionHostPort: VITE_DEV_PORT }];
}

// Dev HTML served inside the VSCode webview during HMR. Vite serves the
// app at http://localhost:5173; the webview loads both Vite's client
// (for HMR wiring) and the entry module from that origin. The CSP is
// intentionally relaxed — cross-origin scripts/styles from Vite + the
// HMR WebSocket — and is NEVER emitted in production.
export function renderDevHtml(
  webview: vscode.Webview,
  entry: "main" | "echo"
): string {
  const rootId = entry === "echo" ? "echo-root" : "root";
  const title = entry === "echo" ? "Protege Echo (dev)" : "Protege (dev)";
  const entryPath = entry === "echo" ? "/echo/main.tsx" : "/main.tsx";
  const csp = [
    "default-src 'none'",
    `style-src ${VITE_DEV_ORIGIN} ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `script-src ${VITE_DEV_ORIGIN} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
    `connect-src ${VITE_DEV_ORIGIN} ${VITE_DEV_WS} ${webview.cspSource} http://localhost:8787 http://127.0.0.1:8787`,
    `img-src ${VITE_DEV_ORIGIN} ${webview.cspSource} data: blob: https://avatars.githubusercontent.com`,
    `font-src ${VITE_DEV_ORIGIN} ${webview.cspSource} https://fonts.gstatic.com`,
    `media-src ${webview.cspSource} blob: data: http://localhost:8787 http://127.0.0.1:8787`,
  ].join("; ");

  // @vitejs/plugin-react injects its refresh preamble via Vite's
  // `transformIndexHtml` hook — which only runs when Vite serves the
  // HTML itself. We hand-build the HTML here, so the preamble has to be
  // added manually or the React entry throws
  //   "Uncaught Error: @vitejs/plugin-react can't detect preamble"
  // before any component renders.
  const reactRefreshPreamble = `
<script type="module">
  import RefreshRuntime from "${VITE_DEV_ORIGIN}/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${title}</title>
</head>
<body>
<div id="${rootId}"></div>
<script type="module" src="${VITE_DEV_ORIGIN}/@vite/client"></script>
${reactRefreshPreamble}
<script type="module" src="${VITE_DEV_ORIGIN}${entryPath}"></script>
</body>
</html>`;
}
