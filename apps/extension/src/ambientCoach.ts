import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  getSuggestionsForUri,
  onSuggestionsChanged,
  titleForRule,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";

/**
 * Ambient Coach — the Strip.
 *
 * A single, glanceable status-bar item that surfaces Protege's awareness
 * of the current cursor context. One line, one glance, one keystroke. No
 * popups, no gutter noise — the mentor's passive presence.
 *
 * Content slots (priority order, only one visible at a time):
 *   1. Insight on the current cursor line
 *   2. Insight on the cursor's enclosing function/block  (later stage)
 *   3. Recent teach moment not yet acknowledged           (later stage)
 *   4. Concept resurface from SM-2 queue                  (later stage)
 *   5. Idle fallback:  "Protege — watching"
 *
 * Stage 1 (this file) implements slots #1 and #5. Cursor-anchored only.
 * Event-driven: updates on selection change, active-editor change, and
 * scan completion. Never timer-driven.
 *
 * Positioning:
 *   `StatusBarAlignment.Left` at priority 10_000 so it appears as the
 *   first left-side item. Native chrome — zero flicker, works in both
 *   Cursor and VS Code without proposed APIs.
 */

// ---- Severity styling (status-bar-safe themeable colors) ----

const SEVERITY_ICON: Record<Suggestion["severity"], string> = {
  warn: "$(circle-filled)",
  perf: "$(zap)",
  info: "$(lightbulb)",
};

// VS Code has no themeable colour API for status-bar *foreground* — only
// `backgroundColor` accepts a ThemeColor. Keep the Strip visually calm: no
// background tint for info/perf, a warning tint only for `warn`.
const WARN_BG = new vscode.ThemeColor("statusBarItem.warningBackground");

// ---- State ----

let stripItem: vscode.StatusBarItem | null = null;
let currentTargetUri: string | null = null;
let currentTargetLine: number | null = null;

// ---- Public API ----

export function registerAmbientCoach(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  stripItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    10_000
  );
  stripItem.name = "Protege — Ambient Coach";
  stripItem.command = "protege.stripClick";
  stripItem.show();
  disposables.push(stripItem);

  // Click handler — opens the sidebar and anchors to the active target.
  disposables.push(
    vscode.commands.registerCommand("protege.stripClick", async () => {
      if (currentTargetUri != null && currentTargetLine != null) {
        await revealTarget(currentTargetUri, currentTargetLine);
      } else {
        await vscode.commands.executeCommand("protege.toggle");
      }
    })
  );

  // Re-render on cursor move
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      render(e.textEditor);
    })
  );

  // Re-render when the active editor changes
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) render(editor);
      else renderIdle();
    })
  );

  // Re-render when a new scan completes for the visible document
  disposables.push(
    onSuggestionsChanged((uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.uri.toString() !== uri) return;
      render(editor);
    })
  );

  // First paint
  if (vscode.window.activeTextEditor) {
    render(vscode.window.activeTextEditor);
  } else {
    renderIdle();
  }

  return disposables;
}

// ---- Render ----

function render(editor: vscode.TextEditor): void {
  if (!stripItem) return;

  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;

  // Slot #1 — insight on the current line
  const atCursor = findSuggestionAtLine(uri, line);
  if (atCursor) {
    paintInsight(atCursor, uri, line);
    return;
  }

  // Nothing at cursor — fall back to idle. Suggestion count is intentionally
  // NOT surfaced here (that's status-bar counter territory, not Strip).
  renderIdle();
}

function paintInsight(s: Suggestion, uri: string, line: number): void {
  if (!stripItem) return;

  const title = titleForRule(s.ruleId, s.severity);
  const icon = SEVERITY_ICON[s.severity];

  // Keep the Strip under ~80 chars so it never wraps or eats the status bar.
  const fullMessage = `${icon}  Protege · ${title}`;
  stripItem.text = clip(fullMessage, 80);

  const tt = new vscode.MarkdownString();
  tt.isTrusted = false;
  tt.appendMarkdown(`**Protege** · ${title}\n\n`);
  tt.appendMarkdown(`${s.message}\n\n`);
  tt.appendMarkdown(`_Click to open in sidebar._`);
  stripItem.tooltip = tt;

  stripItem.backgroundColor = s.severity === "warn" ? WARN_BG : undefined;

  currentTargetUri = uri;
  currentTargetLine = line;
}

function renderIdle(): void {
  if (!stripItem) return;
  stripItem.text = `$(eye)  Protege — watching`;
  stripItem.tooltip = "Protege is reading your code quietly. Click to open the sidebar.";
  stripItem.backgroundColor = undefined;
  currentTargetUri = null;
  currentTargetLine = null;
}

// ---- Helpers ----

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

async function revealTarget(uri: string, line: number): Promise<void> {
  // Make sure the suggestion still exists (user may have edited past it).
  const still = findSuggestionAtLine(uri, line);
  if (!still) {
    await vscode.commands.executeCommand("protege.toggle");
    return;
  }

  // Jump the editor caret to the target line so context is obvious.
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === uri) {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }

  // Open sidebar. A later stage will also broadcast a `strip/focus` message
  // so the sidebar scrolls to the insight; for Stage 1 we just open the
  // panel and let the user see it in the Live tab.
  await vscode.commands.executeCommand("protege.toggle");
}

/** Exposed for tests + future stages. */
export function __debug_getActiveTarget(): { uri: string | null; line: number | null } {
  return { uri: currentTargetUri, line: currentTargetLine };
}

/** Swallow unused-import warnings for helpers reserved for later stages. */
void getSuggestionsForUri;
