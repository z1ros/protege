import * as vscode from "vscode";
import { WatcherState } from "./state.js";
import { createDispatcher, type Dispatcher, type DispatchedNudge } from "./dispatcher.js";
import type { WatcherEvent } from "./events.js";
import { getBatcher } from "../echo/batcher.js";
import { notifyFocusBreak, notifySessionActivity } from "../echo/sessionTracker.js";

/**
 * Public entry point for the ambient watcher. Call startWatcher(context)
 * from extension.ts activate() and it'll wire up all VS Code subscriptions,
 * pump triggers every 4 seconds, and call onNudge for every dispatched nudge.
 */

const POLL_INTERVAL_MS = 4_000;
/** Cadence for keystroke_batch emission. Added in R1 for authorship
 *  tracking — one flush every 10s keeps the event log sane while giving
 *  near-real-time bucket updates on the Concepts Covered widget. */
const KEYSTROKE_BATCH_FLUSH_MS = 10_000;

export interface WatcherHandle {
  dispatch: Dispatcher;
  ingest: (e: WatcherEvent) => void;
  dispose: () => void;
}

export function startWatcher(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  onNudge: (n: DispatchedNudge) => void
): WatcherHandle {
  const state = new WatcherState();
  const dispatch = createDispatcher(state, log);
  dispatch.onNudge(onNudge);

  // Snapshot of previous diagnostics per file so we can compute deltas
  const lastDiags = new Map<string, Set<string>>();

  // Track previous document content length for rough "isUndo" detection
  const lastLen = new Map<string, number>();

  const ingest = (e: WatcherEvent) => {
    state.ingest(e);
  };

  // Keystroke accumulator — tracks chars typed per file over a 10s window
  // so we can emit one keystroke_batch EchoEvent per window instead of
  // one per text change. Paste bursts and AI accepts are subtracted at
  // the emission sites so they don't double-count into humanChars.
  interface KeystrokeAccum {
    chars: number;
    keystrokes: number;
    language: string;
    firstTs: number;
  }
  const keystrokeAccum = new Map<string, KeystrokeAccum>();

  const flushKeystrokeBatches = () => {
    if (keystrokeAccum.size === 0) return;
    const now = Date.now();
    const b = getBatcher();
    if (!b) {
      keystrokeAccum.clear();
      return;
    }
    for (const [file, acc] of keystrokeAccum) {
      if (acc.chars <= 0) continue;
      b.push({
        type: "keystroke_batch",
        ts: now,
        file,
        language: acc.language,
        keystrokes: acc.keystrokes,
        durationMs: Math.max(0, now - acc.firstTs),
        charsTyped: acc.chars,
      });
    }
    keystrokeAccum.clear();
  };

  const addKeystrokeChars = (
    file: string,
    language: string,
    chars: number
  ) => {
    if (chars <= 0) return;
    let acc = keystrokeAccum.get(file);
    if (!acc) {
      acc = { chars: 0, keystrokes: 0, language, firstTs: Date.now() };
      keystrokeAccum.set(file, acc);
    }
    acc.chars += chars;
    acc.keystrokes += 1;
    acc.language = language;
  };

  // ========== VS Code subscriptions ==========

  const subs: vscode.Disposable[] = [];

  subs.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      ingest({ type: "file_opened", path: doc.fileName, ts: Date.now() });
      lastLen.set(doc.fileName, doc.getText().length);
    })
  );

  subs.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      ingest({ type: "file_closed", path: doc.fileName, ts: Date.now() });
      lastLen.delete(doc.fileName);
      lastDiags.delete(doc.fileName);
    })
  );

  subs.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      const diags = vscode.languages.getDiagnostics(doc.uri);
      const errorCount = diags.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Error
      ).length;
      ingest({
        type: "file_saved",
        path: doc.fileName,
        ts: Date.now(),
        errorCount,
      });
      notifySessionActivity();
    })
  );

  subs.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      const path = e.document.fileName;
      const language = e.document.languageId;
      const newLen = e.document.getText().length;
      const prevLen = lastLen.get(path) ?? newLen;
      const changeSize = Math.abs(newLen - prevLen);
      lastLen.set(path, newLen);
      // Heuristic undo detection: reason field (vs code 1.66+) OR
      // any change with multiple ranges typically indicates undo/redo
      const reason = (e as unknown as { reason?: number }).reason;
      const isUndo = reason === 1; // TextDocumentChangeReason.Undo = 1
      const isRedo = reason === 2; // TextDocumentChangeReason.Redo = 2
      ingest({
        type: "text_change",
        path,
        ts: Date.now(),
        changeSize,
        isUndo,
        isRedo,
      });
      notifySessionActivity();
      if (isUndo) {
        const b = getBatcher();
        if (b) {
          b.push({ type: "undo_triggered", ts: Date.now(), file: path });
        }
      }

      // R1 authorship: bucket this change into one of
      //   - keystroke (small single-char typing → humanChars++)
      //   - AI accept (medium insert that pasteClassifier won't catch →
      //                aiChars++ via ai_suggestion_accepted)
      //   - paste (handled by pasteClassifier → no keystroke bump here)
      // Skip undo/redo entirely (net-zero authorship).
      //
      // AI-accept detection rationale: VS Code exposes no
      // onInlineSuggestionAccepted event. pasteClassifier already captures
      // anything with a newline or long whitespace run. What's left — pure
      // inserts of several chars without paste markers — is dominated by
      // inline-completion commits (Copilot, native inline suggest, etc.).
      // We emit ai_suggestion_accepted for inserts in the [AI_MIN, PASTE]
      // window and let paste_classified own everything above.
      if (!isUndo && !isRedo) {
        for (const change of e.contentChanges) {
          const text = change.text ?? "";
          if (text.length === 0) continue;
          if (change.rangeLength > 0) continue; // replacement, skip
          const looksLikePaste =
            text.length >= 40 && /\n|\t{2,}|\s{4,}/.test(text);
          if (looksLikePaste) continue; // pasteClassifier owns this
          // Short inserts with a newline ("\n  ", "};\n") are the editor
          // auto-closing brackets / newline handling, not authored chars.
          // Skip these entirely — they'd skew aiChars in the wrong
          // direction.
          if (text.length < 6 && /\n/.test(text)) continue;
          if (text.length >= 6) {
            // Likely AI inline-suggest commit. Emit the event so the
            // backend bumps aiChars on this file.
            const b = getBatcher();
            if (b) {
              b.push({
                type: "ai_suggestion_accepted",
                ts: Date.now(),
                file: path,
                chars: text.length,
                charsAccepted: text.length,
              });
            }
            continue;
          }
          addKeystrokeChars(path, language, text.length);
        }
      }
    })
  );

  subs.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.scheme !== "file") return;
      ingest({
        type: "selection_change",
        path: e.textEditor.document.fileName,
        ts: Date.now(),
        line: e.selections[0]?.active.line ?? 0,
      });
    })
  );

  subs.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const path =
        editor && editor.document.uri.scheme === "file"
          ? editor.document.fileName
          : null;
      const language =
        editor && editor.document.uri.scheme === "file"
          ? editor.document.languageId
          : null;
      ingest({
        type: "active_editor_change",
        ts: Date.now(),
        path,
      });
      const b = getBatcher();
      if (b) {
        b.push({ type: "file_focus_change", ts: Date.now(), file: path, language });
      }
    })
  );

  subs.push(
    vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        if (uri.scheme !== "file") continue;
        const diags = vscode.languages.getDiagnostics(uri);
        const errors = diags.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error
        );
        const warnings = diags.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Warning
        );

        ingest({
          type: "diagnostic_change",
          path: uri.fsPath,
          ts: Date.now(),
          errors: errors.length,
          warnings: warnings.length,
        });

        // Compute error deltas → appeared / cleared events
        const prev = lastDiags.get(uri.fsPath) ?? new Set<string>();
        const curr = new Set(
          errors.map((d) => `${d.range.start.line}::${d.message}`)
        );

        for (const key of curr) {
          if (!prev.has(key)) {
            const [lineStr, ...rest] = key.split("::");
            const lineNum = Number(lineStr) + 1;
            const msg = rest.join("::");
            ingest({
              type: "error_appeared",
              path: uri.fsPath,
              ts: Date.now(),
              line: lineNum,
              message: msg,
              source: "vscode",
            });
            const b = getBatcher();
            if (b) {
              b.push({
                type: "diagnostic_appeared",
                ts: Date.now(),
                file: uri.fsPath,
                line: lineNum,
                severity: "error",
                message: msg,
              });
            }
            notifyFocusBreak();
          }
        }
        for (const key of prev) {
          if (!curr.has(key)) {
            const [lineStr, ...rest] = key.split("::");
            const lineNum = Number(lineStr) + 1;
            ingest({
              type: "error_cleared",
              path: uri.fsPath,
              ts: Date.now(),
              line: lineNum,
              message: rest.join("::"),
              durationMs: 0,
            });
            const b = getBatcher();
            if (b) {
              b.push({
                type: "diagnostic_resolved",
                ts: Date.now(),
                file: uri.fsPath,
                line: lineNum,
                durationMs: 0,
              });
            }
          }
        }
        lastDiags.set(uri.fsPath, curr);
      }
    })
  );

  // ========== Polling pump ==========
  const timer = setInterval(() => {
    try {
      dispatch.pumpPolling();
    } catch (err) {
      log.appendLine(`[watcher] pump error: ${err}`);
    }
  }, POLL_INTERVAL_MS);

  const keystrokeTimer = setInterval(() => {
    try {
      flushKeystrokeBatches();
    } catch (err) {
      log.appendLine(`[watcher] keystroke flush error: ${err}`);
    }
  }, KEYSTROKE_BATCH_FLUSH_MS);

  const dispose = () => {
    clearInterval(timer);
    clearInterval(keystrokeTimer);
    try {
      flushKeystrokeBatches();
    } catch {
      // best-effort; the buffer is cleared anyway
    }
    for (const s of subs) s.dispose();
  };

  context.subscriptions.push({ dispose });

  log.appendLine(`[watcher] started — polling every ${POLL_INTERVAL_MS}ms`);

  return { dispatch, ingest, dispose };
}

export type { DispatchedNudge } from "./dispatcher.js";
