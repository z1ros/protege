import * as vscode from "vscode";
import type { Suggestion } from "./reviewEngine.js";

/**
 * TipInset — our fully custom, fully-styled Protege card rendered INLINE in
 * the editor via the `editorInsets` proposed API. Zero stacking with VS
 * Code/TS/Cursor hovers because it isn't a hover at all — it's a webview
 * docked between code lines.
 *
 * Requires the extension to be launched with the proposed API enabled.
 * In Cursor: add to ~/.cursor/argv.json:
 *   "enable-proposed-api": ["protege.protege"]
 * Or launch with `--enable-proposed-api protege.protege`.
 *
 * If the API is unavailable, the caller falls back to the sidebar overlay.
 */

const CARD_HEIGHT_LINES = 10;

interface InsetArgs {
  suggestion: Suggestion;
  editor: vscode.TextEditor;
  line: number;
  currentLine: string;
  lang: string;
}

// Track active insets so we can dispose before creating a new one
const activeByUri = new Map<string, { dispose(): void }>();

export function isInsetApiAvailable(): boolean {
  const w = vscode.window as unknown as {
    createWebviewTextEditorInset?: unknown;
  };
  return typeof w.createWebviewTextEditorInset === "function";
}

export function showTipInset(args: InsetArgs): boolean {
  const w = vscode.window as unknown as {
    createWebviewTextEditorInset?: (
      editor: vscode.TextEditor,
      line: number,
      height: number,
      options?: vscode.WebviewOptions
    ) => {
      readonly webview: vscode.Webview;
      readonly onDidDispose: vscode.Event<void>;
      dispose(): void;
    };
  };

  if (typeof w.createWebviewTextEditorInset !== "function") {
    return false;
  }

  const key = args.editor.document.uri.toString();
  const existing = activeByUri.get(key);
  if (existing) {
    try {
      existing.dispose();
    } catch {}
    activeByUri.delete(key);
  }

  try {
    const inset = w.createWebviewTextEditorInset(
      args.editor,
      args.line,
      CARD_HEIGHT_LINES,
      { enableScripts: true }
    );

    inset.webview.html = renderCardHtml(args);

    inset.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "close") {
        try { inset.dispose(); } catch {}
        activeByUri.delete(key);
        return;
      }
      if (msg.type === "applyFix" && args.suggestion.fix) {
        vscode.commands.executeCommand(
          "protege.applyReviewFix",
          JSON.stringify({
            uri: args.editor.document.uri.toString(),
            line: args.suggestion.range.start.line,
            fix: args.suggestion.fix,
          })
        );
        try { inset.dispose(); } catch {}
        activeByUri.delete(key);
        return;
      }
      if (msg.type === "teach") {
        vscode.commands.executeCommand(
          "protege.teachConcept",
          args.suggestion.ruleId
        );
        try { inset.dispose(); } catch {}
        activeByUri.delete(key);
        return;
      }
    });

    inset.onDidDispose(() => {
      activeByUri.delete(key);
    });

    activeByUri.set(key, inset);
    return true;
  } catch (err) {
    console.warn("[protege] Editor inset failed:", err);
    return false;
  }
}

// ---- HTML renderer — matches tokens.css / TipDetailOverlay design ----

const ACCENT: Record<Suggestion["severity"], { hex: string; label: string }> = {
  warn: { hex: "#ffb86b", label: "WARN" },
  perf: { hex: "#ffd280", label: "PERF" },
  info: { hex: "#9eccff", label: "TIP" },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleForRule(ruleId: string, severity: Suggestion["severity"]): string {
  const clean = ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const prefix = severity === "warn" ? "Potential bug" : severity === "perf" ? "Perf hit" : "Heads up";
  return `${prefix} — ${clean}`;
}

function renderCardHtml(args: InsetArgs): string {
  const a = ACCENT[args.suggestion.severity];
  const title = titleForRule(args.suggestion.ruleId, args.suggestion.severity);
  const body = args.suggestion.message;
  const before = args.currentLine;
  const after = args.suggestion.fix?.trim();
  const ruleId = args.suggestion.ruleId;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  :root {
    --accent: ${a.hex};
    --ink: #07060d;
    --ink-2: #0d0b18;
    --text: #f5f6fa;
    --text-dim: rgba(245,246,250,0.72);
    --text-faint: rgba(245,246,250,0.45);
    --glass-1: rgba(255,255,255,0.055);
    --glass-border: rgba(255,255,255,0.14);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
    color: var(--text);
    background: transparent;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .card {
    position: relative;
    padding: 12px 14px 10px 14px;
    border-radius: 10px;
    background:
      radial-gradient(120% 80% at 0% 0%, rgba(74,158,255,0.10), transparent 60%),
      linear-gradient(180deg, rgba(255,255,255,0.04), transparent 45%);
    background-color: rgba(13,11,24,0.96);
    border: 1px solid var(--glass-border);
    box-shadow: 0 10px 32px rgba(0,0,0,0.5);
    overflow: hidden;
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.85;
  }
  .hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .logo {
    width: 14px; height: 14px;
  }
  .brand {
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .chip {
    font-family: "SF Mono", Menlo, monospace;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 1.6px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    padding: 2px 7px;
    border-radius: 999px;
  }
  .close {
    margin-left: auto;
    width: 22px; height: 22px;
    display: grid; place-items: center;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    color: var(--text-dim);
    cursor: pointer;
    transition: background 120ms, color 120ms;
  }
  .close:hover { background: rgba(255,255,255,0.08); color: var(--text); }
  .title {
    font-size: 13.5px;
    font-weight: 600;
    margin: 2px 0 4px;
    color: var(--text);
  }
  .body {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .diff { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .code {
    position: relative;
    background: rgba(7,6,13,0.6);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 6px;
    padding: 7px 10px;
    font-family: "Geist Mono", "SF Mono", Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    color: rgba(245,246,250,0.92);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .lbl {
    position: absolute;
    top: 4px; right: 8px;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 1.4px;
    opacity: 0.9;
  }
  .lbl.before { color: #ff8fa8; }
  .lbl.after  { color: #a0ffc8; }
  .arrow { text-align: center; color: var(--text-faint); font-size: 11px; line-height: 1; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    padding: 7px 11px;
    border-radius: 8px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    color: var(--text);
    cursor: pointer;
    transition: background 120ms, border-color 120ms, transform 120ms;
  }
  .btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.18); }
  .btn:active { transform: translateY(1px); }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #07060d;
  }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.ghost { background: transparent; color: var(--text-faint); }
  .btn.ghost:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .footer {
    margin-top: 8px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 1.4px;
    color: var(--accent);
    text-transform: uppercase;
  }
</style></head>
<body>
  <div class="card">
    <div class="hdr">
      <svg class="logo" viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r="10.5" fill="none" stroke="#d0d5e8" stroke-width="2"/>
        <circle cx="23.42" cy="8.58" r="3" fill="#d0d5e8"/>
      </svg>
      <span class="brand">Protege</span>
      <span class="chip">${escapeHtml(a.label)}</span>
      <button class="close" id="close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M6 18L18 6"/>
        </svg>
      </button>
    </div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="body">${escapeHtml(body)}</div>
    ${before || after ? `<div class="diff">` : ""}
      ${before ? `<div class="code"><span class="lbl before">CURRENT</span>${escapeHtml(before)}</div>` : ""}
      ${after ? `<div class="arrow">↓</div><div class="code"><span class="lbl after">SUGGESTED</span>${escapeHtml(after)}</div>` : ""}
    ${before || after ? `</div>` : ""}
    <div class="actions">
      ${after ? `<button class="btn primary" id="fix">Apply fix</button>` : ""}
      <button class="btn" id="teach">Teach me</button>
      <button class="btn ghost" id="dismiss">Dismiss</button>
    </div>
    <div class="footer">${escapeHtml(ruleId)}</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const on = (id, type) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => vscode.postMessage({ type }));
    };
    on("close", "close");
    on("dismiss", "close");
    on("fix", "applyFix");
    on("teach", "teach");
  </script>
</body></html>`;
}
