import * as vscode from "vscode";
import type { Finding } from "@protege/types";
import { getFindingsForUri } from "./analyzer.js";
import { isLiveReviewActive } from "./liveReview.js";
import { renderProtegeHover, type HoverKind } from "./hoverTemplate.js";

/**
 * HoverProvider that overlays Protege's rich hover template on top of any
 * Protege diagnostic. VS Code's built-in diagnostic hover still shows the
 * plain message above, but our MarkdownString stacks in the same popup and
 * looks designed.
 */

const LANGS: vscode.DocumentSelector = [
  { language: "javascript" },
  { language: "typescript" },
  { language: "javascriptreact" },
  { language: "typescriptreact" },
  { language: "python" },
  { language: "css" },
  { language: "scss" },
  { language: "html" },
];

function kindForFinding(type: Finding["type"]): HoverKind {
  switch (type) {
    case "bug": return "bug";
    case "security": return "security";
    case "performance": return "perf";
    case "tip": return "tip";
  }
}

export function registerFindingHover(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const provider: vscode.HoverProvider = {
    provideHover(doc, position) {
      if (!isLiveReviewActive()) return;
      const findings = getFindingsForUri(doc.uri);
      if (findings.length === 0) return;

      // Find a finding on the line the user is hovering
      const line = position.line;
      const match = findings.find((f) => (f.line ?? 1) - 1 === line);
      if (!match) return;

      // Dedup: stay silent only when a non-Protege diagnostic overlaps the
      // hovered position exactly. Same-line-different-column is fine.
      const otherDiags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source !== "Protege");
      if (otherDiags.some((d) => d.range.contains(position))) return;

      const lineIdx = Math.max(0, Math.min(doc.lineCount - 1, (match.line ?? 1) - 1));
      const lineText = doc.lineAt(lineIdx).text.trim();

      const md = renderProtegeHover({
        kind: kindForFinding(match.type),
        title: match.title,
        body: match.explanation,
        code: lineText
          ? { before: lineText, lang: doc.languageId }
          : undefined,
        actions: [
          {
            icon: "mortar-board",
            label: "Teach me",
            command: "protege.teachFinding",
            args: [match],
            primary: true,
          },
        ],
      });

      const range = new vscode.Range(lineIdx, 0, lineIdx, doc.lineAt(lineIdx).text.length);
      return new vscode.Hover(md, range);
    },
  };

  return [vscode.languages.registerHoverProvider(LANGS, provider)];
}
