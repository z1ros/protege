import * as vscode from "vscode";

/**
 * Native-diagnostic dedup helper.
 *
 * Protege creates its own diagnostics (labeled `source: "Protege"`),
 * but the editor also carries diagnostics from many OTHER sources —
 * TypeScript, ESLint, cSpell, and Cursor's agent integrations to name
 * a few. When one of those tools has already squiggled a token, we
 * should stay quiet on that line instead of piling more decorations on
 * top. This was the #1 cause of the "visual chaos" screenshot: every
 * line that Cursor already flagged ALSO got a Protege underline +
 * CodeLens row, doubling the noise for zero new signal.
 *
 * Policy: if any non-Protege diagnostic overlaps the same line (or the
 * same range), we skip our rendering on that line. Protege's job is to
 * surface things the native tooling DIDN'T catch — patterns, concepts,
 * subtle bugs — not to echo what the user already sees.
 *
 * Called from every decoration/lens/hint surface before it renders.
 * Cheap: `getDiagnostics(uri)` is a synchronous cached lookup.
 */

const PROTEGE_SOURCE = "Protege";

function getNonProtegeDiagnostics(
  uri: vscode.Uri | string
): vscode.Diagnostic[] {
  const u = typeof uri === "string" ? vscode.Uri.parse(uri) : uri;
  const all = vscode.languages.getDiagnostics(u);
  return all.filter((d) => d.source !== PROTEGE_SOURCE);
}

/**
 * True when any non-Protege diagnostic covers the given 0-based line.
 */
export function hasNativeDiagnosticOnLine(
  uri: vscode.Uri | string,
  line: number
): boolean {
  return getNonProtegeDiagnostics(uri).some(
    (d) => d.range.start.line <= line && line <= d.range.end.line
  );
}

/**
 * True when any non-Protege diagnostic intersects the given range.
 * Use this when you want to dedup against a multi-line range (block or
 * flow scope findings whose start/end spans several lines).
 */
export function hasNativeDiagnosticInRange(
  uri: vscode.Uri | string,
  range: vscode.Range
): boolean {
  return getNonProtegeDiagnostics(uri).some((d) => !!range.intersection(d.range));
}
