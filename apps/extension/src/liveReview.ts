import * as vscode from "vscode";
import type { HostToWebview } from "@protege/types";
import { reviewDocument, type Suggestion } from "./reviewEngine.js";

/**
 * Live Code Review — JARVIS Layer 4.
 *
 * When active, Protege runs the AI review engine (on-device Qwen or Claude)
 * on the active file shortly after the user stops typing. Suggestions render
 * as subtle underlines with hover tooltips showing the issue + an "Apply fix"
 * action when a fix is available.
 *
 * AI calls are not free or instant, so we:
 *   - Debounce 3s after the last keystroke
 *   - Skip tiny edits (< 4 chars of change) so cursor moves don't trigger
 *   - Cancel in-flight results when a newer scan starts
 *   - Broadcast scanning state so the UI can show a spinner
 */

const warnDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy",
  light: { textDecoration: "underline wavy rgba(200, 120, 50, 0.6)" },
  dark: { textDecoration: "underline wavy rgba(122, 162, 247, 0.5)" },
  overviewRulerColor: "rgba(122, 162, 247, 0.4)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const infoDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline dotted",
  light: { textDecoration: "underline dotted rgba(100, 100, 100, 0.4)" },
  dark: { textDecoration: "underline dotted rgba(122, 162, 247, 0.3)" },
});

let active = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let changeListener: vscode.Disposable | null = null;
let editorListener: vscode.Disposable | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let currentSuggestions: Suggestion[] = [];
let scanSeq = 0;
let pendingChangeSize = 0;
let lastScannedText: string | null = null;
let isScanning = false;

const DEBOUNCE_MS = 3_000;
const MIN_CHANGE_CHARS = 4;
const HEALTH_CHECK_MS = 60_000;

let statusItem: vscode.StatusBarItem | null = null;

function getStatusItem(): vscode.StatusBarItem {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90
    );
    statusItem.command = "protege.toggleLiveReview";
  }
  return statusItem;
}

function updateStatusBar(): void {
  const item = getStatusItem();
  if (!active) {
    item.hide();
    return;
  }
  if (isScanning) {
    item.text = "$(sync~spin) Protege · scanning…";
    item.tooltip = "Protege is reviewing this file with AI";
  } else {
    const count = currentSuggestions.length;
    item.text = count > 0
      ? `$(eye) Protege Live · ${count} issue${count === 1 ? "" : "s"}`
      : "$(eye) Protege Live";
    item.tooltip = "Live code review is ON — click to stop";
  }
  item.show();
}

function broadcastState(): void {
  try {
    const { broadcast } = require("./webviewHost.js") as {
      broadcast: (msg: HostToWebview) => void;
    };
    broadcast({ type: "liveReview/state", active });
    if (isScanning) {
      broadcast({ type: "scan/started" });
    } else {
      broadcast({ type: "scan/done", found: currentSuggestions.length, summary: "" });
    }
  } catch {}
}

function notifyLiveReviewOn(): void {
  try {
    const mod = require("./inlineErrors.js") as {
      refreshInlineDecorations: () => void;
      refreshFixItCodeLens: () => void;
    };
    mod.refreshInlineDecorations();
    mod.refreshFixItCodeLens();
  } catch {}
  try {
    const { refreshFindingCodeLens } = require("./codeLens.js") as {
      refreshFindingCodeLens: () => void;
    };
    refreshFindingCodeLens();
  } catch {}
}

function notifyLiveReviewOff(): void {
  try {
    const mod = require("./inlineErrors.js") as {
      clearInlineDecorations: () => void;
      refreshFixItCodeLens: () => void;
    };
    mod.clearInlineDecorations();
    mod.refreshFixItCodeLens();
  } catch {}
  try {
    const { clearProtegeDiagnostics } = require("./analyzer.js") as {
      clearProtegeDiagnostics: () => void;
    };
    clearProtegeDiagnostics();
  } catch {}
  try {
    const { refreshFindingCodeLens } = require("./codeLens.js") as {
      refreshFindingCodeLens: () => void;
    };
    refreshFindingCodeLens();
  } catch {}
}

function startLiveReview(): void {
  if (active) return;
  active = true;
  lastScannedText = null;
  pendingChangeSize = 0;

  changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || e.document !== editor.document) return;

    for (const c of e.contentChanges) {
      pendingChangeSize += Math.max(c.text.length, c.rangeLength);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runReview(editor);
    }, DEBOUNCE_MS);
  });

  editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    lastScannedText = null;
    pendingChangeSize = Infinity;
    void runReview(editor);
  });

  if (vscode.window.activeTextEditor) {
    pendingChangeSize = Infinity;
    void runReview(vscode.window.activeTextEditor);
  }

  healthTimer = setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor && active && !isScanning) {
      pendingChangeSize = Infinity;
      void runReview(editor);
    }
  }, HEALTH_CHECK_MS);

  updateStatusBar();
  broadcastState();
  notifyLiveReviewOn();
}

function stopLiveReview(): void {
  if (!active) return;
  active = false;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  changeListener?.dispose();
  changeListener = null;
  editorListener?.dispose();
  editorListener = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }

  scanSeq++; // invalidate any in-flight scan
  isScanning = false;

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.setDecorations(warnDecoration, []);
    editor.setDecorations(infoDecoration, []);
  }
  currentSuggestions = [];

  updateStatusBar();
  broadcastState();
  notifyLiveReviewOff();
}

async function runReview(editor: vscode.TextEditor): Promise<void> {
  if (!active) return;

  const text = editor.document.getText();
  if (pendingChangeSize < MIN_CHANGE_CHARS && text === lastScannedText) {
    return;
  }
  if (isScanning) return;

  pendingChangeSize = 0;
  lastScannedText = text;

  const mySeq = ++scanSeq;
  const cancelSignal = { cancelled: false };

  isScanning = true;
  updateStatusBar();
  broadcastState();

  let suggestions: Suggestion[] = [];
  try {
    suggestions = await reviewDocument(editor.document, cancelSignal);
  } catch (err) {
    console.error("[protege] live review failed:", err);
  }

  if (mySeq !== scanSeq || !active) {
    cancelSignal.cancelled = true;
    return;
  }

  isScanning = false;
  currentSuggestions = suggestions;

  const warns: vscode.DecorationOptions[] = [];
  const infos: vscode.DecorationOptions[] = [];

  for (const s of suggestions) {
    const hoverMessage = new vscode.MarkdownString();
    hoverMessage.isTrusted = true;
    hoverMessage.supportThemeIcons = true;

    const icon = s.severity === "warn" ? "$(warning)" : s.severity === "perf" ? "$(zap)" : "$(lightbulb)";
    hoverMessage.appendMarkdown(`${icon} **Protege**: ${s.message}\n\n`);

    if (s.fix) {
      const args = encodeURIComponent(
        JSON.stringify({
          uri: editor.document.uri.toString(),
          line: s.range.start.line,
          fix: s.fix,
        })
      );
      hoverMessage.appendMarkdown(
        `[$(wrench) Apply fix](command:protege.applyReviewFix?${args})`
      );
    }

    hoverMessage.appendMarkdown(
      `\n\n---\n*Protege Live Review · ${s.ruleId}*`
    );

    const deco: vscode.DecorationOptions = { range: s.range, hoverMessage };
    if (s.severity === "warn" || s.severity === "perf") {
      warns.push(deco);
    } else {
      infos.push(deco);
    }
  }

  editor.setDecorations(warnDecoration, warns);
  editor.setDecorations(infoDecoration, infos);

  updateStatusBar();
  broadcastState();
}

export function registerLiveReview(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("protege.toggleLiveReview", () => {
      if (active) {
        stopLiveReview();
      } else {
        startLiveReview();
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.applyReviewFix",
      async (argsJson: string) => {
        try {
          const { uri, line, fix } = JSON.parse(argsJson);
          const docUri = vscode.Uri.parse(uri);
          const doc = await vscode.workspace.openTextDocument(docUri);
          const lineRange = doc.lineAt(line).range;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(docUri, lineRange, fix);
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage("Protege: fix applied!");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Fix failed: ${msg}`);
        }
      }
    )
  );

  disposables.push(getStatusItem());

  disposables.push(
    new vscode.Disposable(() => {
      stopLiveReview();
    })
  );

  startLiveReview();

  return disposables;
}

export function isLiveReviewActive(): boolean {
  return active;
}
