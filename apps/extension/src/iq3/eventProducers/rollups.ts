import * as vscode from "vscode";
import type {
  Iq3ReadPatternEvent,
  Iq3PasteOutcomeEvent,
  Iq3AiAcceptOutcomeEvent,
  EchoEvent,
} from "@protege/types";
import { getBatcher } from "../../echo/batcher.js";
import { classifyReadPattern, shouldCountAsEdit } from "./rollupClassifier.js";

export { classifyReadPattern, shouldCountAsEdit };

/**
 * Extension-side rollup producers for Codex F3.
 *
 * Pre-F3 the backend tried to evaluate windowed matchers ("first edit
 * within 30s of file_opened", "no edit within 60s of paste") at ingest
 * time, which is impossible — the future events the matcher needs
 * haven't arrived yet, and `file_opened` / `text_change` are local
 * watcher signals that never reach the backend at all.
 *
 * The fix moves the windowed temporal logic to the extension. We
 * observe the multi-event pattern locally, wait the appropriate
 * window, then emit a single high-level rollup event with the verdict
 * pre-computed. Backend matchers become trivial — just key off the
 * verdict.
 *
 * Privacy: rollup events deliberately omit file paths. Only verdict +
 * cheap counters/sizes go on the wire.
 */

/** Cap pending observations to avoid unbounded growth. */
const MAX_PENDING_OPENS = 100;
const MAX_PENDING_PASTES = 50;
const MAX_PENDING_ACCEPTS = 50;

const PASTE_WINDOW_MS = 60_000;
const AI_ACCEPT_WINDOW_MS = 30_000;

interface OpenObservation {
  openTs: number;
  navCount: number;
}

interface PendingPaste {
  pasteTs: number;
  uri: string;
  source: string;
  chars: number;
  /**
   * `TextDocument.version` immediately after the paste. The paste
   * itself fires its own `onDidChangeTextDocument` with this version;
   * we only count subsequent changes (strictly greater) toward
   * `editedDuring`. See Codex follow-up: self-edit invalidation.
   */
  pastedAtVersion: number;
  editedDuring: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAccept {
  acceptTs: number;
  uri: string;
  acceptedChars: number;
  totalChangedChars: number;
  /** Same self-invalidation guard as PendingPaste; see comment there. */
  acceptedAtVersion: number;
  sawEdit: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Wire up the three rollup producers. Returns a disposable so the
 * caller can clean timers + subscriptions on extension deactivation.
 */
export function startRollupProducers(
  ctx: vscode.ExtensionContext,
): vscode.Disposable {
  // file URI string -> { openTs, navCount } observation kept until the
  // first text_change for that file fires (or the entry is evicted).
  const opens = new Map<string, OpenObservation>();
  const pendingPastes = new Set<PendingPaste>();
  const pendingAccepts = new Set<PendingAccept>();

  const dropOldestOpen = () => {
    // Map insertion order = LRU-ish; drop oldest on overflow.
    const firstKey = opens.keys().next().value;
    if (firstKey !== undefined) opens.delete(firstKey);
  };

  // ---- Read pattern producer ----------------------------------------
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      const key = doc.uri.toString();
      // Re-opening a file resets the observation window.
      opens.delete(key);
      if (opens.size >= MAX_PENDING_OPENS) dropOldestOpen();
      opens.set(key, { openTs: Date.now(), navCount: 0 });
    }),
  );

  // editor_navigation goes through the batcher; subscribe via onPush
  // so we increment nav counts for any open observation that targets
  // the navigation's destination file.
  const batcher = getBatcher();
  const batcherUnsubs: Array<() => void> = [];
  if (batcher) {
    const unsubNav = batcher.onPush((e: EchoEvent) => {
      if (e.type !== "editor_navigation") return;
      const toFile = (e as any).toFile as string | undefined;
      if (!toFile) return;
      // Match on suffix because the rollup tracks vscode.Uri strings
      // while editor_navigation carries the workspace-relative path.
      for (const [uri, obs] of opens) {
        if (uri.endsWith(toFile)) {
          obs.navCount += 1;
        }
      }
    });
    batcherUnsubs.push(unsubNav);
  }

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      const key = e.document.uri.toString();
      const obs = opens.get(key);
      if (obs) {
        const msToFirstEdit = Date.now() - obs.openTs;
        const pattern = classifyReadPattern(msToFirstEdit, obs.navCount);
        const event: Iq3ReadPatternEvent = {
          type: "read_pattern_observed",
          ts: Date.now(),
          pattern,
          msToFirstEdit,
          navCount: obs.navCount,
        };
        getBatcher()?.push(event);
        // Clear so subsequent edits don't re-fire; a reopen will
        // recreate the observation.
        opens.delete(key);
      }

      // Feed pending paste / accept observations.
      //
      // Codex follow-up: gate by `TextDocument.version` to prevent
      // self-invalidation. The paste/AI-accept event is itself a text
      // change; without version gating its own change handler flips
      // editedDuring=true on the same paste, so `kept-as-is` never
      // fires. shouldCountAsEdit() rejects same-version changes
      // (the paste itself) and adds a 100 ms time-grace as a
      // belt-and-suspenders defence.
      const uri = e.document.uri.toString();
      const changeVersion = e.document.version;
      const now = Date.now();
      let changedChars = 0;
      for (const change of e.contentChanges) {
        changedChars += change.text.length + change.rangeLength;
      }
      for (const p of pendingPastes) {
        if (p.uri !== uri) continue;
        if (!shouldCountAsEdit(p.pastedAtVersion, changeVersion, p.pasteTs, now)) {
          continue;
        }
        p.editedDuring = true;
      }
      for (const a of pendingAccepts) {
        if (a.uri !== uri) continue;
        if (
          !shouldCountAsEdit(a.acceptedAtVersion, changeVersion, a.acceptTs, now)
        ) {
          continue;
        }
        a.sawEdit = true;
        a.totalChangedChars += changedChars;
      }
    }),
  );

  // ---- Paste outcome + AI-accept outcome producers ------------------
  // Both ride the batcher's onPush bus so they see the same event
  // stream that flushes to the backend. This avoids double-subscribing
  // to VS Code APIs that the watcher / pasteClassifier already own.
  if (batcher) {
    const unsubBatcher = batcher.onPush((e: EchoEvent) => {
      if (e.type === "paste_classified") {
        if (pendingPastes.size >= MAX_PENDING_PASTES) {
          // Drop oldest by iteration order.
          const oldest = pendingPastes.values().next().value as
            | PendingPaste
            | undefined;
          if (oldest) {
            clearTimeout(oldest.timer);
            pendingPastes.delete(oldest);
          }
        }
        const file = (e as any).file as string;
        const source = (e as any).source as string;
        const chars = (e as any).chars as number;
        const uri = vscode.Uri.file(file).toString();
        // Capture the post-paste TextDocument.version. The paste's
        // own text_change carries this version; gating on strictly
        // greater versions excludes the paste itself from
        // editedDuring. Falls back to 0 if the doc isn't open
        // (defensive — the time-grace inside shouldCountAsEdit
        // covers that case).
        const doc = vscode.workspace.textDocuments.find(
          (d) =>
            d.uri.toString() === uri ||
            d.uri.fsPath === file ||
            d.fileName === file,
        );
        const pastedAtVersion = doc?.version ?? 0;
        const pending: PendingPaste = {
          pasteTs: (e as any).ts,
          uri,
          source,
          chars,
          pastedAtVersion,
          editedDuring: false,
          timer: setTimeout(() => {
            pendingPastes.delete(pending);
            // TODO(F3-rejection): undo-within-window detection. For
            // now we collapse rejected → iterated since both involve
            // post-paste activity; the `iterated` matchKey is no-op
            // on the backend (matcher only fires on "kept-as-is"),
            // so privacy + signal are preserved either way.
            const outcome: Iq3PasteOutcomeEvent["outcome"] = pending
              .editedDuring
              ? "iterated"
              : "kept-as-is";
            const evt: Iq3PasteOutcomeEvent = {
              type: "paste_outcome_observed",
              ts: Date.now(),
              outcome,
              source: pending.source,
              chars: pending.chars,
            };
            getBatcher()?.push(evt);
          }, PASTE_WINDOW_MS),
        };
        pendingPastes.add(pending);
      }

      if (e.type === "ai_suggestion_accepted") {
        if (pendingAccepts.size >= MAX_PENDING_ACCEPTS) {
          const oldest = pendingAccepts.values().next().value as
            | PendingAccept
            | undefined;
          if (oldest) {
            clearTimeout(oldest.timer);
            pendingAccepts.delete(oldest);
          }
        }
        const file = (e as any).file as string;
        const acceptedChars =
          ((e as any).charsAccepted as number | undefined) ??
          ((e as any).chars as number | undefined) ??
          0;
        const uri = vscode.Uri.file(file).toString();
        // Same self-invalidation guard as paste — the AI-accept
        // event is emitted from inside watcher's
        // onDidChangeTextDocument handler, so its own text_change
        // arrives at our editedDuring handler with the same doc
        // version. Gate on strictly greater versions only.
        const doc = vscode.workspace.textDocuments.find(
          (d) =>
            d.uri.toString() === uri ||
            d.uri.fsPath === file ||
            d.fileName === file,
        );
        const acceptedAtVersion = doc?.version ?? 0;
        const pending: PendingAccept = {
          acceptTs: (e as any).ts,
          uri,
          acceptedChars,
          totalChangedChars: 0,
          acceptedAtVersion,
          sawEdit: false,
          timer: setTimeout(() => {
            pendingAccepts.delete(pending);
            const outcome: Iq3AiAcceptOutcomeEvent["outcome"] = pending.sawEdit
              ? "iterated"
              : "no-edit";
            // Approximation: chars changed in the window divided by
            // accepted chars. Capped to [0,1]. If we didn't see any
            // edit, fraction is 0. If we did but acceptedChars is 0
            // (older event without size), fall back to 0.5 as a
            // best-effort signal that *some* iteration happened.
            let editFraction = 0;
            if (pending.sawEdit) {
              editFraction =
                pending.acceptedChars > 0
                  ? Math.min(
                      1,
                      pending.totalChangedChars /
                        Math.max(1, pending.acceptedChars),
                    )
                  : 0.5;
            }
            const evt: Iq3AiAcceptOutcomeEvent = {
              type: "ai_accept_outcome_observed",
              ts: Date.now(),
              outcome,
              editFraction,
            };
            getBatcher()?.push(evt);
          }, AI_ACCEPT_WINDOW_MS),
        };
        pendingAccepts.add(pending);
      }
    });
    batcherUnsubs.push(unsubBatcher);
  }

  const disposable = new vscode.Disposable(() => {
    for (const u of batcherUnsubs) u();
    for (const p of pendingPastes) clearTimeout(p.timer);
    pendingPastes.clear();
    for (const a of pendingAccepts) clearTimeout(a.timer);
    pendingAccepts.clear();
    opens.clear();
  });
  ctx.subscriptions.push(disposable);
  return disposable;
}
