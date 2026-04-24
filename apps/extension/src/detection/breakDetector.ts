import * as vscode from "vscode";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { log } from "../log.js";

/**
 * Natural-break detection.
 *
 * The vibecoding partnership only works if we interrupt at moments the
 * user isn't in flow. This module watches for those moments and emits a
 * typed `BreakEvent` on each. Consumers (the ownership inviter) decide
 * whether the moment is worth surfacing.
 *
 * Events:
 *   post-commit          — `git rev-parse HEAD` changed (10s poll)
 *   post-save-clean      — file saved + `languages.getDiagnostics(uri)`
 *                          reports zero errors/warnings
 *   idle-10min           — 10 min with no `onDidChangeTextDocument`
 *   end-of-day           — first time after local 5pm with 3 min idle
 *   unfamiliar-file-open — active editor changed to a file whose
 *                          ownership is `unknown`
 *
 * Deliberately cheap: one 10s git poll, two VS Code event subscriptions,
 * a single timer. No backend work. This is the highest-leverage surface
 * in the ownership system — so keep the plumbing simple and obvious.
 */

const exec = promisify(execCb);

export type BreakType =
  | "post-commit"
  | "post-save-clean"
  | "idle-10min"
  | "end-of-day"
  | "unfamiliar-file-open";

export interface BreakEvent {
  type: BreakType;
  /** Relevant URI when applicable — e.g. the saved file, the opened file. */
  uri?: vscode.Uri;
  ts: number;
}

const GIT_POLL_INTERVAL_MS = 10_000;
const IDLE_LIMIT_MS = 10 * 60_000;
const EOD_IDLE_MS = 3 * 60_000;
const EOD_HOUR_LOCAL = 17;

const emitter = new vscode.EventEmitter<BreakEvent>();
export const onBreak: vscode.Event<BreakEvent> = emitter.event;

let installed: vscode.Disposable | null = null;

/** Callback the inviter provides so break-detector can consult ownership
 *  without importing it directly (avoids a cycle with ownership.ts). */
export interface BreakDetectorDeps {
  /** Map of (uriString → is-unfamiliar). True when state === "unknown". */
  isUnfamiliar(uri: vscode.Uri): boolean;
}

let deps: BreakDetectorDeps = { isUnfamiliar: () => false };

export function installBreakDetector(
  d: BreakDetectorDeps
): vscode.Disposable {
  if (installed) return installed;
  deps = d;

  const subs: vscode.Disposable[] = [];
  let lastActivity = Date.now();
  let idleFired = false;
  let eodFiredForDate: string | null = null;

  // --- idle watcher (text changes reset the clock) ---
  subs.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      lastActivity = Date.now();
      idleFired = false;
    })
  );
  subs.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      lastActivity = Date.now();
      idleFired = false;
    })
  );

  // --- post-save-clean ---
  subs.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Diagnostics can update on a tick AFTER the save finishes; wait
      // ~500ms so we see the post-save diagnostic state, not the stale
      // pre-save one.
      setTimeout(() => {
        try {
          const diags = vscode.languages.getDiagnostics(doc.uri);
          const hasProblem = diags.some(
            (d) =>
              d.severity === vscode.DiagnosticSeverity.Error ||
              d.severity === vscode.DiagnosticSeverity.Warning
          );
          if (!hasProblem) {
            emitter.fire({
              type: "post-save-clean",
              uri: doc.uri,
              ts: Date.now(),
            });
          }
        } catch {
          /* ignore diag read failures */
        }
      }, 500);
    })
  );

  // --- unfamiliar-file-open ---
  subs.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      if (ed.document.uri.scheme !== "file") return;
      try {
        if (deps.isUnfamiliar(ed.document.uri)) {
          emitter.fire({
            type: "unfamiliar-file-open",
            uri: ed.document.uri,
            ts: Date.now(),
          });
        }
      } catch {
        /* ignore */
      }
    })
  );

  // --- idle timer + end-of-day ---
  const tick = setInterval(() => {
    const now = Date.now();
    const idleFor = now - lastActivity;

    if (!idleFired && idleFor >= IDLE_LIMIT_MS) {
      idleFired = true;
      emitter.fire({ type: "idle-10min", ts: now });
    }

    const local = new Date(now);
    if (
      local.getHours() >= EOD_HOUR_LOCAL &&
      idleFor >= EOD_IDLE_MS &&
      eodFiredForDate !== local.toDateString()
    ) {
      eodFiredForDate = local.toDateString();
      emitter.fire({ type: "end-of-day", ts: now });
    }
  }, 30_000);
  subs.push({ dispose: () => clearInterval(tick) });

  // --- post-commit via HEAD poll ---
  // On a no-git workspace the first call fails and we stop polling
  // entirely. Previously the interval kept firing every 10s forever,
  // silently swallowing errors and wasting a child-process spawn on
  // each tick.
  let lastHead: string | null = null;
  let headTick: ReturnType<typeof setInterval> | null = null;
  const stopHeadPoll = () => {
    if (headTick) {
      clearInterval(headTick);
      headTick = null;
    }
  };
  const pollHead = async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      stopHeadPoll();
      return;
    }
    try {
      const { stdout } = await exec(
        `git -C '${root.replace(/'/g, "'\\''")}' rev-parse HEAD`,
        { timeout: 3000 }
      );
      const head = stdout.trim();
      if (lastHead !== null && head !== lastHead) {
        emitter.fire({ type: "post-commit", ts: Date.now() });
      }
      lastHead = head;
    } catch {
      // Not a git repo, or git missing — stop polling for real, not
      // every 10s. A folder change would restart the extension anyway.
      stopHeadPoll();
      log("breakDetector", "post-commit poll disabled (no git repo)");
    }
  };
  void pollHead();
  headTick = setInterval(() => void pollHead(), GIT_POLL_INTERVAL_MS);
  subs.push({ dispose: () => stopHeadPoll() });

  log("breakDetector", "installed");

  installed = {
    dispose() {
      for (const s of subs) {
        try {
          s.dispose();
        } catch {
          /* ignore */
        }
      }
      installed = null;
    },
  };
  return installed;
}
