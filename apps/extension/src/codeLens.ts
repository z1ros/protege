import * as vscode from "vscode";
import type { Finding } from "@protege/types";
import { getFindingsForUri } from "./analyzer.js";

/**
 * CodeLens above each finding line — clickable tip that opens the Protege
 * panel and asks the mentor to explain the issue in context.
 */
export class FindingCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChange.event;

  refresh() {
    this._onDidChange.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const findings = getFindingsForUri(doc.uri);
    return findings.map((f) => {
      const lineIdx = Math.max(
        0,
        Math.min(doc.lineCount - 1, (f.line ?? 1) - 1)
      );
      const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
      // VS Code codicons render inline as SVG in CodeLens titles.
      const icon = codiconFor(f.type);
      return new vscode.CodeLens(range, {
        title: `${icon} ${f.title}  ·  Ask Protege`,
        command: "protege.teachFinding",
        arguments: [f],
      });
    });
  }
}

function codiconFor(type: Finding["type"]): string {
  switch (type) {
    case "bug":
      return "$(bug)";
    case "security":
      return "$(shield)";
    case "performance":
      return "$(zap)";
    case "tip":
      return "$(lightbulb)";
  }
}
