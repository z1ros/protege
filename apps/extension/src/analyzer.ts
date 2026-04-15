import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { Finding, GainEvent, MeResponse } from "@protege/types";
import {
  analyzeFile,
  recordConcepts,
  fetchMe,
  getUserId,
} from "./protegeClient.js";
import { detectConcepts } from "./concepts/detector.js";

const SUPPORTED_LANGS = new Set([
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
  "python",
]);

/** Active findings per file URI, so CodeLens can render tips above lines. */
const findingsByUri = new Map<string, Finding[]>();

export function getFindingsForUri(uri: vscode.Uri): Finding[] {
  return findingsByUri.get(uri.toString()) ?? [];
}

export type IqUpdatePayload = MeResponse;
export type OnIqChange = (data: IqUpdatePayload) => void;
export type OnGain = (gains: GainEvent[], codeIq: number) => void;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function registerAnalyzer(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
  onIqChange: OnIqChange,
  onGain: OnGain,
  log: vscode.OutputChannel
): vscode.Disposable {
  const userId = getUserId(context);
  const debouncers = new Map<string, NodeJS.Timeout>();

  const run = async (doc: vscode.TextDocument) => {
    if (!SUPPORTED_LANGS.has(doc.languageId)) return;
    if (doc.uri.scheme !== "file") return;

    const content = doc.getText();
    const fileHash = sha256(content);
    const file = {
      path: doc.fileName,
      language: doc.languageId,
      content,
    };

    // 1. Local concept detection — instant, no network.
    const concepts = detectConcepts(doc.languageId, content);
    log.appendLine(
      `[protege] save ${doc.fileName} — concepts: ${concepts.join(", ") || "(none)"}`
    );

    // 2. Kick off analyzer first so we know hasErrors before recording concepts.
    let findings: Finding[] = [];
    try {
      findings = await analyzeFile(userId, file);
      findingsByUri.set(doc.uri.toString(), findings);
      renderDiagnostics(doc, findings, diagnostics);
    } catch (e) {
      log.appendLine(`[protege] analyze err: ${e}`);
    }

    const errorCount = findings.filter(
      (f) => f.type === "bug" || f.type === "security"
    ).length;
    const hasErrors = errorCount > 0;

    // 3. Record concepts with content hash (dedup) + quality gate.
    try {
      const result = await recordConcepts(userId, {
        filePath: doc.fileName,
        fileHash,
        concepts,
        hasErrors,
        errorCount,
      });
      if (result.gains.length > 0) {
        onGain(result.gains, result.codeIq);
      }
      // Pull the full snapshot for the UI (topConcepts, clusters, recentGains).
      const me = await fetchMe(userId);
      onIqChange(me);
    } catch (e) {
      log.appendLine(`[protege] concepts err: ${e}`);
    }
  };

  const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
    const key = doc.uri.toString();
    const existing = debouncers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debouncers.delete(key);
      run(doc);
    }, 1500);
    debouncers.set(key, timer);
  });

  const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnostics.delete(doc.uri);
    findingsByUri.delete(doc.uri.toString());
  });

  return vscode.Disposable.from(saveSub, closeSub);
}

function renderDiagnostics(
  doc: vscode.TextDocument,
  findings: Finding[],
  collection: vscode.DiagnosticCollection
) {
  const diags: vscode.Diagnostic[] = findings.map((f) => {
    const lineIdx = Math.max(0, Math.min(doc.lineCount - 1, (f.line ?? 1) - 1));
    const line = doc.lineAt(lineIdx);
    const range = new vscode.Range(
      lineIdx,
      line.firstNonWhitespaceCharacterIndex,
      lineIdx,
      line.text.length
    );
    const severity =
      f.type === "bug" || f.type === "security"
        ? vscode.DiagnosticSeverity.Error
        : f.type === "performance"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
    const diag = new vscode.Diagnostic(
      range,
      `${f.title} — ${f.explanation}`,
      severity
    );
    diag.source = "Protege";
    diag.code = f.type;
    return diag;
  });
  collection.set(doc.uri, diags);
}
