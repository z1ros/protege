import * as vscode from "vscode";

/**
 * Tracks the "last known real editor" — i.e. the last text editor the user
 * was looking at BEFORE focus moved to the Protege panel.
 *
 * Without this, every click in the webview makes `vscode.window.activeTextEditor`
 * undefined and we lose the file context. This module keeps it sticky.
 */

let lastEditor: vscode.TextEditor | undefined;

export function initActiveFileTracker(
  context: vscode.ExtensionContext,
  onChange: (editor: vscode.TextEditor | undefined) => void
) {
  // Seed with whatever's open now
  if (isRealEditor(vscode.window.activeTextEditor)) {
    lastEditor = vscode.window.activeTextEditor;
  }

  const sub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (isRealEditor(editor)) {
      lastEditor = editor;
      onChange(editor);
    }
    // If editor is undefined (webview focused) or non-file, KEEP lastEditor.
  });

  context.subscriptions.push(sub);
}

/**
 * Returns the last real editor the user was looking at, OR the current
 * activeTextEditor if it's a real file. Never returns the webview's pseudo-editor.
 */
export function getActiveFileEditor(): vscode.TextEditor | undefined {
  const current = vscode.window.activeTextEditor;
  if (isRealEditor(current)) return current;
  if (lastEditor && !lastEditor.document.isClosed) return lastEditor;
  return undefined;
}

function isRealEditor(
  editor: vscode.TextEditor | undefined
): editor is vscode.TextEditor {
  if (!editor) return false;
  if (editor.document.uri.scheme !== "file") return false;
  return true;
}
