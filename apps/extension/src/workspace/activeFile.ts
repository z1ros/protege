import * as vscode from "vscode";
import {
  describeSelection as pureDescribeSelection,
  selectionsEqual,
  type SelectionInfo,
} from "@protege/types";

/**
 * Tracks the "last known real editor" - i.e. the last text editor the user
 * was looking at BEFORE focus moved to the Protege panel.
 *
 * Without this, every click in the webview makes `vscode.window.activeTextEditor`
 * undefined and we lose the file context. This module keeps it sticky.
 */

let lastEditor: vscode.TextEditor | undefined;
let lastSelection: SelectionInfo | null = null;
// User-toggled suppression. The webview's chip × sets this true so the
// next chat turn's workspace context drops the selection. Reset to
// false on every fresh selection change in the editor — a new highlight
// is a new intent and should re-arm the channel.
let selectionDismissed = false;

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

/**
 * Tracks the user's text selection in real editors and forwards a
 * `SelectionInfo | null` snapshot to the webview. Debounced so a fast drag
 * doesn't flood the channel. Switching to a non-file editor (the Protege
 * webview itself, an output panel, etc.) leaves the last selection in
 * place - same stickiness logic as the active-file tracker - so the chip
 * doesn't flicker off the moment the user clicks into the chat.
 */
export function initSelectionTracker(
  context: vscode.ExtensionContext,
  onChange: (selection: SelectionInfo | null) => void,
  debounceMs = 120
) {
  let timer: NodeJS.Timeout | null = null;

  const emit = (next: SelectionInfo | null) => {
    if (selectionsEqual(lastSelection, next)) return;
    lastSelection = next;
    // A genuinely new selection re-arms the dismissal gate — the user
    // is signalling fresh intent. (A null emit means the highlight was
    // collapsed/file closed; either way the chip is gone, so the gate
    // state is irrelevant until next selection.)
    if (next !== null) selectionDismissed = false;
    onChange(next);
  };

  const schedule = (next: SelectionInfo | null) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      emit(next);
    }, debounceMs);
  };

  // Seed from whatever's open now so a webview reload finds an existing
  // multi-line selection without waiting for the next mouse-up.
  if (vscode.window.activeTextEditor && isRealEditor(vscode.window.activeTextEditor)) {
    lastSelection = describeSelectionFromEditor(vscode.window.activeTextEditor);
  }

  const selSub = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!isRealEditor(event.textEditor)) return;
    schedule(describeSelectionFromEditor(event.textEditor));
  });

  // If the user closes the file holding the pinned selection, clear the
  // chip immediately - the line numbers no longer point to anything.
  const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (lastSelection && lastSelection.filePath === doc.fileName) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emit(null);
    }
  });

  context.subscriptions.push(selSub, closeSub, {
    dispose() {
      if (timer) clearTimeout(timer);
    },
  });
}

/** Current selection snapshot - used by sendInitialState on webview ready. */
export function getActiveSelection(): SelectionInfo | null {
  return lastSelection;
}

/** Selection that should be passed to the chat backend on the next
 *  /chat call. Returns `null` when the user has dismissed the chip via
 *  the webview × — `getActiveSelection()` keeps the raw state for chip
 *  display, this gate adds the dismissal filter for buildWorkspaceContext.
 *  Distinct accessor so a future caller can opt into either view. */
export function getChatSelection(): SelectionInfo | null {
  if (selectionDismissed) return null;
  return lastSelection;
}

/** Webview → host hook: user clicked the chip × . Suppresses the
 *  pinned selection from the next chat turn's workspace context until
 *  a genuinely new selection arrives. */
export function dismissChatSelection(): void {
  selectionDismissed = true;
}

/**
 * Pulls plain primitives out of a vscode.TextEditor and delegates the
 * actual SelectionInfo math to the pure helper in @protege/types so the
 * math stays unit-testable without a vscode environment.
 */
function describeSelectionFromEditor(
  editor: vscode.TextEditor
): SelectionInfo | null {
  const sel = editor.selection;
  const doc = editor.document;
  return pureDescribeSelection({
    filePath: doc.fileName,
    language: doc.languageId,
    text: sel && !sel.isEmpty ? doc.getText(sel) : "",
    startLine: sel ? sel.start.line : 0,
    endLine: sel ? sel.end.line : 0,
    isEmpty: !sel || sel.isEmpty,
  });
}

function isRealEditor(
  editor: vscode.TextEditor | undefined
): editor is vscode.TextEditor {
  if (!editor) return false;
  if (editor.document.uri.scheme !== "file") return false;
  return true;
}
