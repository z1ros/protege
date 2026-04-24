import * as vscode from "vscode";
import { log } from "../log.js";

/**
 * Selection Hover — when the user highlights code, Protege auto-opens a
 * small hover popup with three actions:
 *
 *     ◎ Explain  ·  ✿ Teach me  ·  ✿ Explain back
 *
 * Cursor's own "Add to Chat · Quick Edit" floating bar is proprietary
 * and can't be extended, so this reproduces the same vibe via the
 * stable VS Code hover API: attach a decoration with a `hoverMessage`
 * to the selection range and programmatically fire
 * `editor.action.showHover`.
 *
 * Triggers:
 *   • Selection changes from empty → non-empty (mouse or keyboard drag),
 *     debounced 400ms so rapid multi-cursor jitters don't flash the UI.
 *   • Manual: `Cmd+K S` fires `protege.showSelectionActions` on the
 *     current selection.
 *
 * Skips:
 *   • Selections under 3 chars (cursor blips, single-word word-highlight).
 *   • Selections over 2000 chars (full-file selection is not a teach
 *     moment, it's a copy moment).
 *   • Non-file URIs (output panels, diff views, settings editor).
 *   • Setting `protege.selectionHover.enabled === false`.
 *
 * The hover dismisses itself on cursor movement or keystroke — that's
 * standard VS Code hover behaviour, nothing custom. We dispose the
 * backing decoration when the selection collapses so it can't leak.
 */

const SELECTION_DEBOUNCE_MS = 400;
const MIN_SELECTION_CHARS = 3;
const MAX_SELECTION_CHARS = 2000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeDecoration: vscode.TextEditorDecorationType | null = null;
/** Key of the last selection we showed a hover for — prevents re-showing
 *  when arrow keys move the cursor within the same selection range. */
let lastShownKey: string | null = null;

export function registerSelectionHover(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((evt) => {
      if (!isEnabled()) {
        clearHover();
        return;
      }

      const sel = evt.selections[0];
      if (!sel || sel.isEmpty) {
        clearHover();
        lastShownKey = null;
        return;
      }

      if (evt.textEditor.document.uri.scheme !== "file") return;

      const text = evt.textEditor.document.getText(sel);
      if (
        text.length < MIN_SELECTION_CHARS ||
        text.length > MAX_SELECTION_CHARS
      ) {
        return;
      }

      // Skip if the selection is pure whitespace.
      if (text.trim().length === 0) return;

      const key = keyFor(evt.textEditor.document.uri, sel);
      if (key === lastShownKey) return;

      scheduleHover(evt.textEditor, sel, key);
    })
  );

  // Clear on editor churn so stale decorations don't linger on the
  // wrong document after a tab switch.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearHover();
      lastShownKey = null;
    })
  );

  // Manual shortcut (Cmd+K S). Works even if the auto-hover is disabled
  // via setting — gives keyboard-first users a way to summon the
  // actions explicitly without relying on selection timing.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.showSelectionActions",
      () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (editor.selection.isEmpty) {
          vscode.window.showInformationMessage(
            "Protege: select some code first."
          );
          return;
        }
        const key = keyFor(editor.document.uri, editor.selection);
        showHoverNow(editor, editor.selection, key);
      }
    )
  );

  disposables.push({
    dispose() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      clearHover();
      lastShownKey = null;
    },
  });

  log("selectionHover", "installed");
  return disposables;
}

// ---- internals ----

function scheduleHover(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  key: string
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Re-check: user may have cleared or moved the selection during
    // the debounce. If anything changed, do nothing.
    const curr = vscode.window.activeTextEditor;
    if (!curr || curr !== editor) return;
    if (curr.selection.isEmpty) return;
    if (!curr.selection.isEqual(selection)) return;
    showHoverNow(curr, selection, key);
  }, SELECTION_DEBOUNCE_MS);
}

function showHoverNow(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  key: string
): void {
  clearHover();

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(
    `**[◎ Explain](command:protege.explainSelection "Quick explanation in chat")**` +
      ` · ` +
      `**[? Predict](command:protege.predict.fromSelection "Test your mental model — predict what this does before the reveal")**` +
      ` · ` +
      `**[✿ Teach me](command:protege.teachThis "Deep-dive lesson in the sidebar")**` +
      ` · ` +
      `**[✿ Explain back](command:protege.explainBack.start "Reverse teach — you explain it, Protege grades")**`
  );

  // Invisible decoration — we're not drawing anything on the code, just
  // attaching a hoverMessage to the selection range so VS Code has
  // something to render when `showHover` fires.
  const decoration = vscode.window.createTextEditorDecorationType({});
  try {
    editor.setDecorations(decoration, [
      {
        range: new vscode.Range(selection.start, selection.end),
        hoverMessage: md,
      },
    ]);
  } catch (err) {
    // Editor was disposed between debounce schedule and fire — rare but
    // possible when a tab closes mid-drag. Clean up and bail.
    try {
      decoration.dispose();
    } catch {
      /* ignore */
    }
    log(
      "selectionHover",
      `setDecorations failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  activeDecoration = decoration;
  lastShownKey = key;

  // Programmatically pop the hover at the current cursor position.
  // Guarded only by the earlier `curr !== editor` check in scheduleHover,
  // which ensures the active editor is still the one we captured. If
  // the user tab-switched during the 400ms debounce, that check bailed
  // and we never got here.
  void vscode.commands.executeCommand("editor.action.showHover");

  const lineCount = selection.end.line - selection.start.line + 1;
  log(
    "selectionHover",
    `shown · ${editor.document.fileName.split("/").pop()} · ${lineCount}L`
  );
}

function clearHover(): void {
  if (activeDecoration) {
    try {
      activeDecoration.dispose();
    } catch {
      /* ignore */
    }
    activeDecoration = null;
  }
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("selectionHover.enabled", true);
}

function keyFor(uri: vscode.Uri, sel: vscode.Selection): string {
  return `${uri.toString()}:${sel.start.line}:${sel.start.character}:${sel.end.line}:${sel.end.character}`;
}
