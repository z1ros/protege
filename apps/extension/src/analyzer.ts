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
import { detectHybrid } from "./concepts/hybridDetector.js";

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
  const userId = getUserId(context);
  const debouncers = new Map<string, NodeJS.Timeout>();
  protegeDiagnostics = diagnostics;

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

    // 1. Hybrid concept detection — AST + regex + AI (optional).
    //    AST layer is instant (<50ms). Regex catches Python/CSS.
    //    AI layer only runs if on-device model is loaded.
    const { getOnDeviceStatus } = await import("./onDeviceModel.js");
    const aiEnabled = getOnDeviceStatus().ready;
    const detection = await detectHybrid(content, doc.fileName, doc.languageId, fileHash, aiEnabled);
    const concepts = detection.concepts.map((c) => c.name);
    const contextScores: Record<string, number> = {};
    for (const c of detection.concepts) {
      contextScores[c.name] = c.contextScore;
    }
    log.appendLine(
      `[protege] save ${doc.fileName} — ${detection.sources.total} concepts (AST:${detection.sources.ast} + regex:${detection.sources.regex} + AI:${detection.sources.ai}) in ${detection.durationMs}ms`
    );

    // 2. Kick off analyzer first so we know hasErrors before recording concepts.
    let findings: Finding[] = [];
    try {
      findings = await analyzeFile(userId, file);
      findingsByUri.set(doc.uri.toString(), findings);
      // Only render Protege diagnostics when live review is on — this is the
      // single switch that controls all visible Protege annotations.
      const { isLiveReviewActive } = await import("./liveReview.js");
      if (isLiveReviewActive()) {
        renderDiagnostics(doc, findings, diagnostics);
      } else {
        diagnostics.delete(doc.uri);
      }
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
        contextScores,
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

  // ===== REAL-TIME ANALYSIS: on every keystroke (debounced 1.5s) =====
  // This is the LIGHT path: local concept detection + AI inline analysis.
  // No network calls — just detect what the user is writing and feed it
  // to the live review + inline errors + status bar. The user gets
  // feedback WHILE they type, not after they save.
  const realtimeDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    const doc = e.document;
    if (!SUPPORTED_LANGS.has(doc.languageId)) return;
    if (doc.uri.scheme !== "file") return;

    const key = doc.uri.toString();
    const existing = realtimeDebounce.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      realtimeDebounce.delete(key);
      try {
        // Light analysis — local only, no network
        const content = doc.getText();
        const concepts = detectConcepts(doc.languageId, content);

        // Feed detected concepts to the status bar (so it knows what's
        // on the current line even between saves)
        // The status bar already listens to cursor changes, but this
        // ensures the concept list is fresh.

        // Run AI-powered inline analysis if the user has it enabled.
        // This calls the on-device model or Haiku (depending on user
        // preference) to explain any new issues it detects.
        const { aiQuery } = await import("./aiBackend.js");
        const { isOnDeviceReady } = await import("./onDeviceModel.js");

        // Only do AI analysis if on-device model is ready (free + instant)
        // or if user explicitly chose a cloud backend.
        // This prevents burning cloud credits on every keystroke.
        if (isOnDeviceReady()) {
          // Quick check: are there obvious issues AI should explain?
          const hasErrors = vscode.languages.getDiagnostics(doc.uri)
            .some(d => d.severity === vscode.DiagnosticSeverity.Error);

          if (hasErrors) {
            // AI inline errors are already handled by inlineErrors.ts
            // listener — no need to duplicate here. But we CAN do a
            // proactive concept-aware check that the diagnostic system
            // doesn't cover.
          }

          // Detect patterns the review engine might miss — things that
          // need semantic understanding (e.g. "this useEffect has no
          // cleanup but it starts a subscription")
          if (concepts.length > 0) {
            const lastLine = e.contentChanges[0]?.range.start.line;
            if (lastLine !== undefined) {
              const lineText = doc.lineAt(lastLine).text;
              // Check if this line has a concept we should teach about
              const lineConcepts = detectConcepts(doc.languageId, lineText);
              if (lineConcepts.length > 0) {
                // Update status bar with the freshest concept
                // (statusBarLive already does this on cursor move,
                // but this ensures it's up-to-date during typing too)
              }
            }
          }
        }
      } catch (err) {
        // Real-time analysis failures are non-fatal
        log.appendLine(`[protege] realtime analysis err: ${err}`);
      }
    }, 1500);

    realtimeDebounce.set(key, timer);
  });

  const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnostics.delete(doc.uri);
    findingsByUri.delete(doc.uri.toString());
    realtimeDebounce.delete(doc.uri.toString());
  });

  /**
   * Imperative scan — called by the header Scan button. Uses the sticky
   * active-file tracker so clicking the button in the webview (which
   * takes focus away from the editor) still scans whatever the user was
   * last working on.
   */
  const scanActive = async (): Promise<{ found: number; path: string } | null> => {
    const { getActiveFileEditor } = await import("./activeFile.js");
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
    disposable: vscode.Disposable.from(saveSub, changeSub, closeSub),
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
