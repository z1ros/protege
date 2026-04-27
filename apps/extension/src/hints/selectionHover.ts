import * as vscode from "vscode";
import { log } from "../log.js";

/**
 * Selection Hover — when the user highlights code, Protege attaches a
 * hover popup to the selection with five actions:
 *
 *     ◎ Explain  ·  ⌘ Find similar  ·  → Trace  ·  ✿ Compare  ·  ? Why
 *
 * Cursor's own "Add to Chat · Quick Edit" floating bar is proprietary
 * and can't be extended, so this reproduces the same vibe via the
 * stable VS Code hover API: attach a decoration with a `hoverMessage`
 * to the selection range. The popup surfaces when the user hovers the
 * mouse over their selection — VS Code's native mouse-hover does NOT
 * steal keyboard focus, so backspace/typing on the selection still
 * works as expected.
 *
 * We deliberately do NOT call `editor.action.showHover` to auto-pop the
 * widget. That command focuses the hover, which traps the next
 * keystroke (e.g. backspace would dismiss the hover instead of
 * deleting the selected code).
 *
 * Triggers:
 *   • Mouse-hover over a non-empty selection — natural VS Code hover.
 *   • Manual: `Cmd+K S` fires `protege.showSelectionActions` on the
 *     current selection (this one DOES focus, by user intent).
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
        showHoverFocused(editor, editor.selection, key);
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
      `**[⌘ Find similar](command:protege.findSimilar "Find sister-patterns elsewhere in this workspace")**` +
      ` · ` +
      `**[→ Trace](command:protege.trace "Jump to where this is defined and every place it's called")**` +
      ` · ` +
      `**[✿ Compare](command:protege.compare "Side-by-side: how a senior engineer would write this")**` +
      ` · ` +
      `**[? Why](command:protege.why "Git blame + commit body + linked PR — the intent behind this code")**`
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

  const lineCount = selection.end.line - selection.start.line + 1;
  log(
    "selectionHover",
    `armed · ${editor.document.fileName.split("/").pop()} · ${lineCount}L`
  );
}

function showHoverFocused(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  key: string
): void {
  showHoverNow(editor, selection, key);
  // Manual Cmd+K S path: user explicitly asked for the popup, so
  // focusing the hover widget is the right thing here.
  void vscode.commands.executeCommand("editor.action.showHover");
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
