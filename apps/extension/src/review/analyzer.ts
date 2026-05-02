import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { Finding, GainEvent, MeResponse } from "@protege/types";
import {
  analyzeFile,
  recordConcepts,
  fetchMe,
  currentUserIdOrNull,
} from "../user/protegeClient.js";
import { detectHybrid } from "../concepts/hybridDetector.js";

const SUPPORTED_LANGS = new Set([
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
  "python",
]);

/** Active findings per file URI, so CodeLens can render tips above lines. */
const findingsByUri = new Map<string, Finding[]>();

/** Module-level ref to the diagnostic collection, so liveReview can clear it. */
let protegeDiagnostics: vscode.DiagnosticCollection | null = null;

export function getFindingsForUri(uri: vscode.Uri): Finding[] {
  return findingsByUri.get(uri.toString()) ?? [];
}

/** Clear all Protege-sourced diagnostics (used when live review turns off). */
export function clearProtegeDiagnostics(): void {
  protegeDiagnostics?.clear();
}

export type IqUpdatePayload = MeResponse;
export type OnIqChange = (data: IqUpdatePayload) => void;
export type OnGain = (gains: GainEvent[], codeIq: number) => void;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Imperative scan handle exposed by registerAnalyzer. Lets the Scan
 * button (webview) trigger an analyzer run on the active document
 * without going through the save event.
 */
export interface AnalyzerHandle {
  disposable: vscode.Disposable;
  scanActive: () => Promise<{ found: number; path: string } | null>;
}

export function registerAnalyzer(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
  onIqChange: OnIqChange,
  onGain: OnGain,
  log: vscode.OutputChannel
): AnalyzerHandle {
  const debouncers = new Map<string, NodeJS.Timeout>();
  protegeDiagnostics = diagnostics;

  const run = async (doc: vscode.TextDocument) => {
    if (!SUPPORTED_LANGS.has(doc.languageId)) return;
    if (doc.uri.scheme !== "file") return;
    // Login-first: skip silently when there's no GitHub session. The
    // analyzer is a save-time observer; users will get a fresh run on
    // the next save after they sign in.
    const userId = currentUserIdOrNull();
    if (!userId) return;

    const content = doc.getText();
    const fileHash = sha256(content);
    const file = {
      path: doc.fileName,
      language: doc.languageId,
      content,
    };

    // 1. Hybrid concept detection — AST + regex.
    //    AST layer is instant (<50ms). Regex catches Python/CSS.
    const detection = await detectHybrid(content, doc.fileName, doc.languageId, fileHash, false);
    const concepts = detection.concepts.map((c) => c.name);
    const contextScores: Record<string, number> = {};
    for (const c of detection.concepts) {
      contextScores[c.name] = c.contextScore;
    }
    log.appendLine(
      `[protege] save ${doc.fileName} — ${detection.sources.total} concepts (AST:${detection.sources.ast} + regex:${detection.sources.regex}) in ${detection.durationMs}ms`
    );

    // 2. Kick off analyzer first so we know hasErrors before recording concepts.
    let findings: Finding[] = [];
    try {
      findings = await analyzeFile(userId, file);
      findingsByUri.set(doc.uri.toString(), findings);
      // Protege diagnostics were causing our text to stack inside the core
      // editor hover (alongside TS + Cursor's "Fix with Agent"). We now
      // surface findings through dedicated Protege surfaces only (CodeLens,
      // inlay hint, inset card), so skip pushing them into the diagnostic
      // hover stream entirely.
      diagnostics.delete(doc.uri);
    } catch (e) {
      log.appendLine(`[protege] analyze err: ${e}`);
    }

    const errorCount = findings.filter(
      (f) => f.type === "bug" || f.type === "security"
    ).length;
    const hasErrors = errorCount > 0;

    // 3. Record concepts with content hash (dedup) + quality gate.
    try {
      const rawLang = doc.languageId;
      const language =
        rawLang && rawLang !== "plaintext" ? rawLang : null;
      const result = await recordConcepts(userId, {
        filePath: doc.fileName,
        fileHash,
        concepts,
        contextScores,
        hasErrors,
        errorCount,
        language,
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

  // ===== FULL SCAN: on save — concepts + backend analysis + IQ update =====
  // This is the heavy path: 2 network calls. Fires on explicit save.
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

  /**
   * Imperative scan — called by the header Scan button. Uses the sticky
   * active-file tracker so clicking the button in the webview (which
   * takes focus away from the editor) still scans whatever the user was
   * last working on.
   */
  const scanActive = async (): Promise<{ found: number; path: string } | null> => {
    const { getActiveFileEditor } = await import("../workspace/activeFile.js");
    const editor = getActiveFileEditor() ?? vscode.window.activeTextEditor;
    if (!editor) return null;
    const doc = editor.document;
    if (!SUPPORTED_LANGS.has(doc.languageId)) return null;
    if (doc.uri.scheme !== "file") return null;
    await run(doc);
    const findings = findingsByUri.get(doc.uri.toString()) ?? [];
    return { found: findings.length, path: doc.fileName };
  };

  return {
    disposable: vscode.Disposable.from(saveSub, closeSub),
    scanActive,
  };
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
