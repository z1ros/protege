import * as vscode from "vscode";
import {
  getSuggestionsForUri,
  onSuggestionsChanged,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";

/**
 * Mirror block- and flow-scope Protege findings into VS Code diagnostics
 * so users get a bunch of native UX for free:
 *
 *   • Problems panel entry ("Protege — stale auth state")
 *   • Overview ruler tick (right-edge strip — always-visible awareness)
 *   • Minimap marker
 *   • `Go to → Next Problem` keybinding works
 *   • `DiagnosticRelatedInformation` renders a clickable list of anchors
 *     in the hover and in the Problems panel → one-click cross-file nav
 *
 * We only mirror block/flow findings. Atom findings would spam the
 * Problems panel and reduce it to noise. Whisper + Ghost are enough for
 * atoms.
 */

let collection: vscode.DiagnosticCollection | null = null;

export function registerFindingDiagnostics(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  collection = vscode.languages.createDiagnosticCollection("Protege");
  disposables.push(collection);

  disposables.push(
    onSuggestionsChanged((uri) => refresh(uri))
  );

  return disposables;
}

function refresh(uriStr: string): void {
  if (!collection) return;
  const uri = vscode.Uri.parse(uriStr);
  const suggestions = getSuggestionsForUri(uriStr);

  const diags: vscode.Diagnostic[] = [];

  for (const s of suggestions) {
    // Only mirror block + flow. Atom stays inline-only.
    if (s.scope !== "block" && s.scope !== "flow") continue;

    const diag = new vscode.Diagnostic(
      s.range,
      `${s.message}`,
      severityToDiagnosticSeverity(s.severity)
    );
    diag.source = "Protege";
    diag.code = s.ruleId;

    const anchors = s.anchors ?? [];
    if (anchors.length > 0) {
      diag.relatedInformation = anchors.map((a) => {
        const anchorUri = vscode.Uri.parse(a.uri);
        const line = Math.max(0, a.line);
        const pos = new vscode.Position(line, 0);
        const range = new vscode.Range(pos, pos);
        return new vscode.DiagnosticRelatedInformation(
          new vscode.Location(anchorUri, range),
          a.label
        );
      });
    }

    diags.push(diag);
  }

  collection.set(uri, diags);
}

function severityToDiagnosticSeverity(
  sev: Suggestion["severity"]
): vscode.DiagnosticSeverity {
  // Map Protege's tri-state onto VS Code's severities. We deliberately use
  // `Information` for warn too — red is reserved for compiler errors so
  // Protege never looks like it's breaking your build.
  switch (sev) {
    case "warn":
      return vscode.DiagnosticSeverity.Warning;
    case "perf":
      return vscode.DiagnosticSeverity.Information;
    case "info":
      return vscode.DiagnosticSeverity.Hint;
  }
}
