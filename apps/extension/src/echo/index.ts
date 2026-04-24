import * as vscode from "vscode";
import type { EchoEvent } from "@protege/types";
import { startBatcher, getBatcher } from "./batcher.js";
import { startSessionTracker } from "./sessionTracker.js";
import { startLineDiffer } from "./lineDiffer.js";
import { startPasteClassifier } from "./pasteClassifier.js";
import { startGitCommitWatcher } from "./gitCommitWatcher.js";
import { startConceptAnalyzer } from "./conceptAnalyzer.js";
import { broadcastToEcho, openEchoPanel } from "./panel.js";
import { startEventStream } from "./eventStream.js";
import { startStoreDiff } from "./storeDiff.js";

export { openEchoPanel, broadcastToEcho } from "./panel.js";
export { getBatcher } from "./batcher.js";
export { getEventStreamChannel } from "./eventStream.js";

/**
 * Wires every extension-side Echo subsystem: batcher, session tracker,
 * line differ, paste classifier, git commit watcher. Returns a single
 * disposable so extension.ts keeps its registration list tidy.
 */
export function initEcho(
  context: vscode.ExtensionContext,
  userId: string,
  log: vscode.OutputChannel
): vscode.Disposable {
  startBatcher(context, userId, log);
  // Event stream tail — must start AFTER startBatcher so getBatcher() is
  // non-null when the subscription is attached. Pure diagnostic, no
  // network or store writes.
  const eventStreamSub = startEventStream(context);
  // Store diff command registration — independent of batcher ordering.
  const storeDiffSub = startStoreDiff(context, userId);
  const sessionSub = startSessionTracker(context);
  const differSub = startLineDiffer(context);
  const pasteSub = startPasteClassifier(context);
  const conceptAnalyzerSub = startConceptAnalyzer(context);
  const eventBuffer: EchoEvent[] = [];
  const snapshotEvents = (): EchoEvent[] => eventBuffer.slice();
  const commitSub = startGitCommitWatcher(
    context,
    userId,
    log,
    (story) => {
      broadcastToEcho({ type: "echo_commit_enriched", story });
    },
    snapshotEvents
  );

  // Mirror pushed events into a recent-window buffer so the commit
  // watcher's enrichment has live data. Capped at 4000 recent events.
  const b = getBatcher();
  let unsubscribe: (() => void) | null = null;
  if (b) {
    unsubscribe = b.onPush((e) => {
      eventBuffer.push(e);
      if (eventBuffer.length > 4000) {
        eventBuffer.splice(0, eventBuffer.length - 4000);
      }
    });
  }

  log.appendLine("[echo] subsystems started");

  const disposable = new vscode.Disposable(() => {
    sessionSub.dispose();
    differSub.dispose();
    pasteSub.dispose();
    conceptAnalyzerSub.dispose();
    commitSub.dispose();
    eventStreamSub.dispose();
    storeDiffSub.dispose();
    if (unsubscribe) unsubscribe();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

export function openEcho(context: vscode.ExtensionContext): void {
  openEchoPanel(context);
}
