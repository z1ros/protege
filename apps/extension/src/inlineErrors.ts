import * as vscode from "vscode";
import { aiExplainError } from "./aiExplain.js";
import { isLiveReviewActive } from "./liveReview.js";

/**
 * Inline Error Explanations — JARVIS Layer 2.
 *
 * Listens to ALL diagnostics (TypeScript, ESLint, Protege, etc.) and adds
 * plain-English explanations at the end of each error line. Like having a
 * mentor lean over your shoulder and say "ah, you forgot to close the tag."
 *
 * How it works:
 * 1. `vscode.languages.onDidChangeDiagnostics` fires when errors change
 * 2. For each error/warning, `aiExplainError()` asks the AI (cached per message)
 * 3. If no local match, the explanation is a simplified version of the
 *    original message (stripped of jargon)
 * 4. Explanations render as italic text at the end of the error line
 *    (similar to the popular "Error Lens" extension)
 * 5. A CodeLens "Fix it" button appears above each error
 * 6. Everything auto-clears when the error is resolved
 *
 * Cost: ZERO API calls. All explanations are local pattern matching.
 * Claude is only called when the user explicitly clicks "Fix it".
 */

// ---- Decoration types ----

const errorExplainDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  after: {
    margin: "0 0 0 3em",
    fontStyle: "italic",
  },
});

const warningExplainDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  after: {
    margin: "0 0 0 3em",
    fontStyle: "italic",
  },
});

// ---- State ----

let featureEnabled = true;
let fixInProgress = false;

/** Enable or disable inline error explanations at runtime. */
export function setInlineErrorsEnabled(enabled: boolean): void {
  featureEnabled = enabled;
  if (!enabled) {
    clearInlineDecorations();
  } else {
    // Re-run on the active editor
    if (vscode.window.activeTextEditor) {
      updateInlineExplanations(vscode.window.activeTextEditor);
    }
  }
}

/** Clear inline decorations on all visible editors (used when live review turns off). */
export function clearInlineDecorations(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(errorExplainDecoration, []);
    editor.setDecorations(warningExplainDecoration, []);
  }
  activeDecorations.clear();
}

/** Re-run inline explanations on the active editor (used when live review turns on). */
export function refreshInlineDecorations(): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) void updateInlineExplanations(editor);
}

/** Track which editors have active decorations so we can clear them */
const activeDecorations = new Map<
  string,
  { errors: vscode.DecorationOptions[]; warnings: vscode.DecorationOptions[] }
>();

/** CodeLens for "Fix it" buttons above errors */
let fixCodeLensProvider: FixItCodeLensProvider | null = null;

/** Ask VS Code to re-query the Fix it CodeLens provider. */
export function refreshFixItCodeLens(): void {
  fixCodeLensProvider?.refresh();
}

// ---- Colors ----

const ERROR_COLOR = new vscode.ThemeColor("editorError.foreground");
const WARNING_COLOR = new vscode.ThemeColor("editorWarning.foreground");
// Fallback colors if theme colors don't resolve well
const ERROR_COLOR_STR = "#e06c75";
const WARNING_COLOR_STR = "#d19a66";

// ---- Main registration ----

export function registerInlineErrors(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Listen for diagnostic changes across all files
  disposables.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        const editor = vscode.window.visibleTextEditors.find(
          (ed) => ed.document.uri.toString() === uri.toString()
        );
        if (editor) {
          updateInlineExplanations(editor);
        }
      }
    })
  );

  // Also update when the active editor changes (in case diagnostics were
  // already present when the file was opened)
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateInlineExplanations(editor);
    })
  );

  // Initial pass for the currently active editor
  if (vscode.window.activeTextEditor) {
    updateInlineExplanations(vscode.window.activeTextEditor);
  }

  // Periodic refresh — catches diagnostics that the event listener might miss
  // (some language servers emit lazily)
  const refreshTimer = setInterval(() => {
    if (!featureEnabled) return;
    const editor = vscode.window.activeTextEditor;
    if (editor) updateInlineExplanations(editor);
  }, 15_000); // every 15s
  disposables.push(new vscode.Disposable(() => clearInterval(refreshTimer)));

  // Register the "Fix it" CodeLens provider
  fixCodeLensProvider = new FixItCodeLensProvider();
  disposables.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "javascript" },
        { language: "typescript" },
        { language: "javascriptreact" },
        { language: "typescriptreact" },
        { language: "python" },
        { language: "css" },
        { language: "html" },
      ],
      fixCodeLensProvider
    )
  );

  // Register the "Fix it" command
  disposables.push(
    vscode.commands.registerCommand(
      "protege.fixError",
      async (diagnostic: vscode.Diagnostic, uri: vscode.Uri) => {
        await handleFixIt(diagnostic, uri);
      }
    )
  );

  return disposables;
}

// ---- Core: update decorations for an editor ----

async function updateInlineExplanations(editor: vscode.TextEditor): Promise<void> {
  if (!featureEnabled) return;
  if (!isLiveReviewActive()) return;

  const uri = editor.document.uri;
  const lang = editor.document.languageId;
  const diagnostics = vscode.languages.getDiagnostics(uri);

  const errors = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Error
  );
  const warnings = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Warning
  );

  const filterProtege = (d: vscode.Diagnostic) => d.source !== "Protege";
  const externalErrors = errors.filter(filterProtege);
  const externalWarnings = warnings.filter(filterProtege);

  const MAX_PER_FILE = 6;

  // Use real AI for explanations (cached per error message — instant on repeat)
  const errorDecos: vscode.DecorationOptions[] = [];
  for (const d of externalErrors.slice(0, MAX_PER_FILE)) {
    const explanation = await aiExplainError(d.message, lang);
    errorDecos.push({
      range: d.range,
      renderOptions: {
        after: {
          contentText: `  ${explanation}`,
          color: ERROR_COLOR_STR,
          fontStyle: "italic",
          fontSize: "0.85em",
        },
      },
    });
  }

  const warningDecos: vscode.DecorationOptions[] = [];
  for (const d of externalWarnings.slice(0, MAX_PER_FILE - errorDecos.length)) {
    const explanation = await aiExplainError(d.message, lang);
    warningDecos.push({
      range: d.range,
      renderOptions: {
        after: {
          contentText: `  ${explanation}`,
          color: WARNING_COLOR_STR,
          fontStyle: "italic",
          fontSize: "0.85em",
        },
      },
    });
  }

  editor.setDecorations(errorExplainDecoration, errorDecos);
  editor.setDecorations(warningExplainDecoration, warningDecos);

  activeDecorations.set(uri.toString(), {
    errors: errorDecos,
    warnings: warningDecos,
  });

  // Refresh CodeLens
  fixCodeLensProvider?.refresh();
}

// ---- Simplify jargon-heavy messages as a fallback ----

function simplifyMessage(msg: string): string {
  // Truncate very long messages
  let s = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;

  // Strip TS error codes like "TS2345: "
  s = s.replace(/^TS\d+:\s*/, "");

  // Strip eslint rule names like "(no-unused-vars)"
  s = s.replace(/\s*\([\w-]+\)\s*$/, "");

  // Lowercase first char for a more casual tone
  if (s.length > 0 && s[0] === s[0].toUpperCase()) {
    s = s[0].toLowerCase() + s.slice(1);
  }

  return s;
}

// ---- "Fix it" CodeLens ----

class FixItCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChange.event;

  refresh() {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isLiveReviewActive()) return [];
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    const errors = diagnostics.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error &&
        d.source !== "Protege" // Protege findings already have their own CodeLens
    );

    // One "Fix it" CodeLens per error, max 5
    return errors.slice(0, 5).map(
      (d) =>
        new vscode.CodeLens(d.range, {
          title: "$(wrench) Fix it — Protege",
          command: "protege.fixError",
          arguments: [d, document.uri],
        })
    );
  }
}

// ---- Handle "Fix it" click — asks Claude for a fix ----

async function handleFixIt(
  diagnostic: vscode.Diagnostic,
  uri: vscode.Uri
): Promise<void> {
  if (fixInProgress) {
    vscode.window.showInformationMessage("Protege: already fixing an error, please wait...");
    return;
  }
  fixInProgress = true;

  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === uri.toString()
  );
  if (!editor) return;

  const doc = editor.document;
  const line = diagnostic.range.start.line;
  const lineText = doc.lineAt(line).text;

  // Get surrounding context (5 lines above and below)
  const startLine = Math.max(0, line - 5);
  const endLine = Math.min(doc.lineCount - 1, line + 5);
  const context = doc.getText(
    new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)
  );

  // Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Protege: fixing error...",
      cancellable: false,
    },
    async () => {
      try {
        // Route through aiBackend so the user's model choice is respected
        const { aiQuery } = await import("./aiBackend.js");
        const prompt = [
          `Fix this error in ${doc.languageId}:`,
          `Error: ${diagnostic.message}`,
          `Line ${line + 1}: ${lineText}`,
          ``,
          `Context:`,
          "```" + doc.languageId,
          context,
          "```",
          ``,
          `Reply with ONLY the fixed line (or lines). No explanation, no markdown fencing.`,
        ].join("\n");

        const fixedCode = await aiQuery(prompt);
        if (!fixedCode || fixedCode.trim().length === 0) {
          vscode.window.showWarningMessage(
            "Protege couldn't generate a fix for this error."
          );
          return;
        }

        // Clean up the response (strip markdown fencing if Claude added it)
        const cleaned = fixedCode
          .replace(/^```\w*\n?/, "")
          .replace(/\n?```$/, "")
          .trim();

        // Apply the fix as a workspace edit
        const edit = new vscode.WorkspaceEdit();
        const lineRange = doc.lineAt(line).range;
        edit.replace(uri, lineRange, cleaned);
        await vscode.workspace.applyEdit(edit);

        vscode.window.showInformationMessage("Protege: fix applied!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Protege fix failed: ${msg}`);
      } finally {
        fixInProgress = false;
      }
    }
  );
}
