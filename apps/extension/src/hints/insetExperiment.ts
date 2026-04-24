import * as vscode from "vscode";
import { findSuggestionAtLine } from "../review/liveReview.js";
import { log } from "../log.js";

/**
 * Inset Preview — EXPERIMENTAL, opt-in, does NOT replace the CodeLens.
 *
 * Renders a Protege finding as a webview inset BETWEEN code lines using
 * the `editorInsets` proposed API (already enabled in package.json).
 * Unlike CodeLens — which is single-line and cannot wrap — this surface
 * is HTML/CSS, so the card responds to editor width with flexbox + media
 * queries. Actions wrap, text wraps, buttons reflow.
 *
 * Enable with the command-palette action:
 *   "Protege: Preview inset-style finding (experimental)"
 *
 * Run the command a second time to turn it off. The existing Ghost
 * Mentor CodeLens stays visible either way — the two surfaces coexist so
 * you can A/B them side-by-side. If you like the inset and want to kill
 * the CodeLens, that's a separate follow-up.
 *
 * Architecture:
 *   - Shows ONE inset at a time (the cursor-parked finding).
 *   - Follows the cursor with a 300ms debounce.
 *   - Dismissing the card (✕) disposes it; moving to a new finding swaps.
 *   - Toggle off → disposes every inset and unsubscribes.
 */

const DEBOUNCE_MS = 300;
// Height of the inset in editor lines. Insets are fixed-height; content
// that exceeds it gets an internal scrollbar. 7 lines fits the card
// comfortably with room to wrap on most narrow widths.
const INSET_HEIGHT_LINES = 7;

interface InsetHandle {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  dispose(): void;
}

let enabled = false;
let activeInset: { inset: InsetHandle; uri: string; line: number } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let cursorSub: vscode.Disposable | null = null;
let editorSub: vscode.Disposable | null = null;

function isInsetApiAvailable(): boolean {
  const w = vscode.window as unknown as { createWebviewTextEditorInset?: unknown };
  return typeof w.createWebviewTextEditorInset === "function";
}

export function registerInsetExperiment(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("protege.toggleInsetPreview", async () => {
      if (!isInsetApiAvailable()) {
        vscode.window.showWarningMessage(
          "Editor inset API unavailable. Launch with --enable-proposed-api protege.protege, or use Cursor which exposes it by default."
        );
        return;
      }
      enabled = !enabled;
      if (enabled) {
        attachListeners();
        // Fire once immediately so the user sees the card on the
        // currently-parked finding without moving the cursor.
        refresh();
        vscode.window.showInformationMessage(
          "Inset preview ON — card renders between lines. Run command again to turn off."
        );
      } else {
        detachListeners();
        disposeActive();
        vscode.window.showInformationMessage("Inset preview OFF.");
      }
      log("insetExperiment", `toggled · enabled=${enabled}`);
    })
  );

  disposables.push({
    dispose() {
      detachListeners();
      disposeActive();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
  });

  return disposables;
}

function attachListeners(): void {
  if (cursorSub || editorSub) return;
  cursorSub = vscode.window.onDidChangeTextEditorSelection(() => {
    if (!enabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
  });
  editorSub = vscode.window.onDidChangeActiveTextEditor(() => {
    if (!enabled) return;
    disposeActive();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
  });
}

function detachListeners(): void {
  cursorSub?.dispose();
  cursorSub = null;
  editorSub?.dispose();
  editorSub = null;
}

function disposeActive(): void {
  if (!activeInset) return;
  try {
    activeInset.inset.dispose();
  } catch {}
  activeInset = null;
}

function refresh(): void {
  if (!enabled) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    disposeActive();
    return;
  }
  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;
  const suggestion = findSuggestionAtLine(uri, line);
  if (!suggestion) {
    disposeActive();
    return;
  }

  // If the inset is already pointing at this finding, leave it alone.
  if (activeInset && activeInset.uri === uri && activeInset.line === line) {
    return;
  }

  disposeActive();

  const w = vscode.window as unknown as {
    createWebviewTextEditorInset: (
      editor: vscode.TextEditor,
      line: number,
      height: number,
      options?: vscode.WebviewOptions
    ) => InsetHandle;
  };

  try {
    const inset = w.createWebviewTextEditorInset(editor, line, INSET_HEIGHT_LINES, {
      enableScripts: true,
    });
    inset.webview.html = renderCardHtml(suggestion, uri);

    inset.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "close":
        case "dismiss":
          void vscode.commands.executeCommand("protege.dismissWhisper", {
            uri,
            line: suggestion.range.start.line,
          });
          disposeActive();
          return;
        case "fix":
          void vscode.commands.executeCommand("protege.smartFix", {
            uri,
            line: suggestion.range.start.line,
          });
          disposeActive();
          return;
        case "teach":
          void vscode.commands.executeCommand(
            "protege.teachConcept",
            suggestion.ruleId
          );
          disposeActive();
          return;
      }
    });

    inset.onDidDispose(() => {
      if (activeInset && activeInset.inset === inset) activeInset = null;
    });

    activeInset = { inset, uri, line };
    log("insetExperiment", `render · ${suggestion.ruleId}@${line}`);
  } catch (err) {
    log(
      "insetExperiment",
      `failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---- HTML renderer ----
//
// Intentionally small + fully responsive. Uses flex + flex-wrap so
// action buttons reflow to a new row on narrow widths. Text wraps
// naturally. CSS variables pick up VS Code theme colors so it fits
// light/dark without extra work.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCardHtml(
  s: ReturnType<typeof findSuggestionAtLine> & {},
  _uri: string
): string {
  const title = s!.label || s!.ruleId.replace(/[-_]/g, " ");
  const message = s!.message;
  const kindBadge =
    s!.kind === "praise"
      ? { text: "nice", hue: "#5ac8fa" }
      : s!.kind === "concept"
      ? { text: "concept", hue: "#9eccff" }
      : s!.kind === "watch-out"
      ? { text: "watch out", hue: "#ffb86b" }
      : s!.severity === "warn"
      ? { text: "watch out", hue: "#ffb86b" }
      : s!.severity === "perf"
      ? { text: "perf", hue: "#ffd280" }
      : { text: "tip", hue: "#9eccff" };
  const hasFix = !!s!.fix;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --fg-dim: color-mix(in oklab, var(--fg) 65%, transparent);
    --border: color-mix(in oklab, var(--fg) 14%, transparent);
    --btn-bg: color-mix(in oklab, var(--fg) 8%, transparent);
    --btn-bg-hover: color-mix(in oklab, var(--fg) 15%, transparent);
    --accent: ${kindBadge.hue};
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    background: color-mix(in oklab, var(--bg) 80%, transparent);
    backdrop-filter: blur(8px);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid color-mix(in oklab, var(--accent) 40%, transparent);
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
    text-transform: capitalize;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }
  .msg {
    color: var(--fg-dim);
    /* wraps naturally; no single-line constraint unlike CodeLens */
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    color: var(--fg);
    background: var(--btn-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover { background: var(--btn-bg-hover); }
  button.primary { border-color: color-mix(in oklab, var(--accent) 45%, transparent); }
  .close {
    margin-left: auto;
    padding: 0 6px;
    opacity: 0.6;
  }
  .close:hover { opacity: 1; }

  /* Narrow container — stack header vertically and let action buttons
     fan out to equal widths. Scoped to .actions button so the .close
     icon in the header doesn't balloon to full width. */
  @container (max-width: 280px) {
    .head { flex-direction: column; align-items: flex-start; }
    .actions { width: 100%; }
    .actions button { flex: 1; }
  }
</style>
</head>
<body>
<div class="card" style="container-type: inline-size;">
  <div class="head">
    <span class="badge" style="color: ${kindBadge.hue};">${escapeHtml(kindBadge.text)}</span>
    <span class="title">${escapeHtml(title)}</span>
    <button class="close" title="Dismiss" onclick="send('close')">✕</button>
  </div>
  <div class="msg">${escapeHtml(message)}</div>
  <div class="actions">
    ${hasFix ? `<button class="primary" onclick="send('fix')">Apply fix</button>` : ""}
    <button onclick="send('teach')">Teach</button>
    <button onclick="send('dismiss')">Dismiss</button>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function send(type) { vscode.postMessage({ type }); }
</script>
</body>
</html>`;
}
