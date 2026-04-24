import * as vscode from "vscode";
import type { ShapeContext, ChatMode, ChatMessage } from "@protege/types";

/**
 * Build a ShapeContext from the editor/host state. Pure reader — no
 * mutation. Called at the top of handleChat, right before shapeTask.
 *
 * Only the last ~6 history messages are included. Anything older rarely
 * changes the classifier's decision and eats prompt tokens in tier 2.
 *
 * Selection is capped at 400 chars — classifier only needs a taste, not
 * the whole file.
 */

const HISTORY_WINDOW = 6;
const SELECTION_MAX_CHARS = 400;

export function buildShapeContext(args: {
  history: ChatMessage[];
  currentMode: ChatMode;
  wakeActive: boolean;
}): ShapeContext {
  const editor = getEditorOrNull();
  const doc = editor?.document ?? null;
  const selection = editor?.selection;
  const sel =
    doc && selection && !selection.isEmpty
      ? doc.getText(selection).slice(0, SELECTION_MAX_CHARS)
      : null;

  const recentMessages = args.history
    .slice(-HISTORY_WINDOW)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  const diagnostics = doc
    ? vscode.languages
        .getDiagnostics(doc.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 10)
        .map((d) => ({
          severity:
            d.severity === vscode.DiagnosticSeverity.Error
              ? ("error" as const)
              : ("warning" as const),
          message: d.message.slice(0, 200),
        }))
    : [];

  return {
    activeFilePath: doc ? doc.uri.fsPath : null,
    activeFileLanguage: doc ? doc.languageId : null,
    activeFileSelection: sel,
    recentMessages,
    currentMode: args.currentMode,
    wakeActive: args.wakeActive,
    diagnosticsOnActiveFile: diagnostics,
  };
}

/** Editors backed by real files only — ignore Output, git diff views,
 *  scratch buffers. Classifier's "active file" signal needs a real file
 *  URI to be meaningful. */
function getEditorOrNull(): vscode.TextEditor | null {
  const e = vscode.window.activeTextEditor;
  if (!e) return null;
  if (e.document.uri.scheme !== "file") return null;
  return e;
}
