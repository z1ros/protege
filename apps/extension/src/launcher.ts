import * as vscode from "vscode";
import { openProtegePanel } from "./panel.js";

/**
 * Tiny placeholder in the activity bar. Its job: open the real Protege
 * panel on the right as an editor tab when the user clicks the shield.
 */
export class LauncherProvider implements vscode.WebviewViewProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "open") openProtegePanel(this.ctx);
    });

    const openIfVisible = () => {
      if (view.visible) openProtegePanel(this.ctx);
    };
    openIfVisible();
    view.onDidChangeVisibility(openIfVisible);
  }

  private html() {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    --ink: #07060d;
    --glow: #ffffff;
    --text: #f5f6fa;
    --text-dim: rgba(245, 246, 250, 0.62);
    --text-faint: rgba(245, 246, 250, 0.32);
    --electric: #4a9eff;
    --electric-deep: #1a5ed8;
    --glass-1: rgba(255, 255, 255, 0.035);
    --glass-border: rgba(255, 255, 255, 0.1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--text);
    background:
      linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px),
      radial-gradient(ellipse 90% 60% at 50% 0%, rgba(74, 158, 255, 0.18), transparent 60%),
      var(--ink);
    background-size: 40px 40px, 40px 40px, auto, auto;
    padding: 22px 16px 18px;
    font-size: 12px;
    line-height: 1.5;
  }
  .mark {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--electric), var(--electric-deep));
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 18px;
    font-weight: 700;
    color: var(--glow);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.14) inset,
      0 8px 22px rgba(74, 158, 255, 0.4);
    margin-bottom: 14px;
  }
  .microcaps {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-dim);
  }
  .title {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 22px;
    color: var(--glow);
    letter-spacing: -0.01em;
    margin: 4px 0 4px;
  }
  .desc {
    color: var(--text-dim);
    margin-bottom: 14px;
    font-size: 11px;
    line-height: 1.55;
  }
  button {
    width: 100%;
    padding: 9px 12px;
    background: linear-gradient(135deg, var(--electric), var(--electric-deep));
    color: var(--glow);
    border: 1px solid rgba(74, 158, 255, 0.6);
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    font-size: 11px;
    letter-spacing: 0.04em;
    box-shadow: 0 4px 20px rgba(74, 158, 255, 0.35);
    transition: transform 120ms ease, box-shadow 150ms ease;
  }
  button:hover { transform: translateY(-1px); box-shadow: 0 6px 26px rgba(74, 158, 255, 0.5); }
  button:active { transform: translateY(0); }
  .hint {
    color: var(--text-faint);
    margin-top: 10px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
  }
</style>
</head>
<body>
  <div class="mark">P</div>
  <div class="microcaps">AI MENTOR</div>
  <div class="title">Protege</div>
  <div class="desc">Your personal AI coding mentor. Opens as a tab on the right.</div>
  <button id="open">Open Protege
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-left:6px;vertical-align:-2px;">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  </button>
  <div class="hint">Auto-opens on click</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => {
      vscode.postMessage({ type: 'open' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
