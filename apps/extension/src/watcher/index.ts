import * as vscode from "vscode";
import { WatcherState } from "./state.js";
import { createDispatcher, type Dispatcher, type DispatchedNudge } from "./dispatcher.js";
import type { WatcherEvent } from "./events.js";

/**
 * Public entry point for the ambient watcher. Call startWatcher(context)
 * from extension.ts activate() and it'll wire up all VS Code subscriptions,
 * pump triggers every 4 seconds, and call onNudge for every dispatched nudge.
 */

const POLL_INTERVAL_MS = 4_000;

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
    })
  );

  subs.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      const path = e.document.fileName;
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
      ingest({
        type: "active_editor_change",
        ts: Date.now(),
        path:
          editor && editor.document.uri.scheme === "file"
            ? editor.document.fileName
            : null,
      });
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
            ingest({
              type: "error_appeared",
              path: uri.fsPath,
              ts: Date.now(),
              line: Number(lineStr) + 1,
              message: rest.join("::"),
              source: "vscode",
            });
          }
        }
        for (const key of prev) {
          if (!curr.has(key)) {
            const [lineStr, ...rest] = key.split("::");
            ingest({
              type: "error_cleared",
              path: uri.fsPath,
              ts: Date.now(),
              line: Number(lineStr) + 1,
              message: rest.join("::"),
              durationMs: 0,
            });
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

  const dispose = () => {
    clearInterval(timer);
    for (const s of subs) s.dispose();
  };

  context.subscriptions.push({ dispose });

  log.appendLine(`[watcher] started — polling every ${POLL_INTERVAL_MS}ms`);

  return { dispatch, ingest, dispose };
}

export type { DispatchedNudge } from "./dispatcher.js";
