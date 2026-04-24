import * as vscode from "vscode";

/**
 * Error-line highlight — ambient white wash on every line that carries
 * an error diagnostic.
 *
 * Purely visual. Listens to `vscode.languages.onDidChangeDiagnostics`,
 * collects the set of error lines per visible editor, and paints a
 * whole-line background with low opacity so the error line stands out
 * against the editor background without fighting the squiggle or the
 * CodeLens row above it.
 *
 * Separate from inlineErrors.ts (which adds italic "after" text) so
 * this can ship independently while the editor-surface redesign is
 * still paused. No AI calls, no diagnostics of our own — we only REACT
 * to whatever language servers / linters / Protege's own diagnostic
 * collection produce.
 *
 * Warnings intentionally excluded. Adding a second color for warnings
 * doubles the visual noise and the signal-to-user from errors is
 * higher — we want the screen to calm down once errors clear, even if
 * warnings linger.
 */

const HIGHLIGHT_COLOR = "rgba(255, 255, 255, 0.06)";

let errorLineDecoration: vscode.TextEditorDecorationType | null = null;

export function registerErrorLineHighlight(): vscode.Disposable[] {
  errorLineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: HIGHLIGHT_COLOR,
    isWholeLine: true,
  });

  const disposables: vscode.Disposable[] = [];

  // Re-render on any diagnostic change. `onDidChangeDiagnostics` fires
  // with the list of URIs that changed — we only update decorations for
  // editors actually showing those URIs, so unrelated files don't pay
  // the cost.
  disposables.push(
    vscode.languages.onDidChangeDiagnostics((evt) => {
      const changed = new Set(evt.uris.map((u) => u.toString()));
      for (const editor of vscode.window.visibleTextEditors) {
        if (!changed.has(editor.document.uri.toString())) continue;
        applyTo(editor);
      }
    })
  );

  // Editor churn: new editors need their existing diagnostics painted
  // on first render, so listeners alone aren't enough.
  disposables.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const e of editors) applyTo(e);
    })
  );

  // Seed every currently-visible editor so the first paint after
  // activate() doesn't miss errors that were already present.
  for (const e of vscode.window.visibleTextEditors) applyTo(e);

  // Cleanup — dispose the decoration type itself, which also clears
  // every editor's applied ranges in one step.
  disposables.push({
    dispose() {
      errorLineDecoration?.dispose();
      errorLineDecoration = null;
    },
  });

  return disposables;
}

function applyTo(editor: vscode.TextEditor): void {
  if (!errorLineDecoration) return;
  if (editor.document.uri.scheme !== "file") {
    editor.setDecorations(errorLineDecoration, []);
    return;
  }

  const diags = vscode.languages.getDiagnostics(editor.document.uri);

  // One range per unique error line. Multiple errors on the same line
  // collapse to one wash — no cumulative darkening.
  const seenLines = new Set<number>();
  const ranges: vscode.Range[] = [];
  for (const d of diags) {
    if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
    const line = d.range.start.line;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const lineText = editor.document.lineAt(line).text;
    ranges.push(new vscode.Range(line, 0, line, Math.max(1, lineText.length)));
  }

  editor.setDecorations(errorLineDecoration, ranges);
}
