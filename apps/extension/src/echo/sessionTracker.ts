import * as vscode from "vscode";
import { getBatcher } from "./batcher.js";

/**
 * Session heartbeat. Emits session_tick every ~60s while the editor has
 * focus, and session_boundary when crossing the idle threshold. A
 * "session" is a contiguous stretch of activity bounded by >15min idle.
 */

const TICK_INTERVAL_MS = 60_000;
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

interface SessionState {
  activeStartedAt: number | null;
  lastActivityAt: number;
  focusStretchStart: number;
  inSession: boolean;
}

let state: SessionState = {
  activeStartedAt: null,
  lastActivityAt: Date.now(),
  focusStretchStart: Date.now(),
  inSession: false,
};

let timer: ReturnType<typeof setInterval> | null = null;

function hasEditorFocus(): boolean {
  return !!vscode.window.activeTextEditor;
}

function markActivity(): void {
  const now = Date.now();
  const sinceLast = now - state.lastActivityAt;
  if (sinceLast > IDLE_THRESHOLD_MS && state.inSession) {
    // Close the previous session before starting a new one.
    const b = getBatcher();
    if (b && state.activeStartedAt != null) {
      b.push({
        type: "session_boundary",
        ts: state.lastActivityAt,
        kind: "end",
        reason: "idle",
        activeMs: state.lastActivityAt - state.activeStartedAt,
      });
    }
    state.inSession = false;
    state.activeStartedAt = null;
    state.focusStretchStart = now;
  }
  if (!state.inSession) {
    state.activeStartedAt = now;
    state.inSession = true;
    state.focusStretchStart = now;
    const b = getBatcher();
    if (b) {
      b.push({
        type: "session_boundary",
        ts: now,
        kind: "start",
        reason: "fresh-start",
      });
    }
  }
  state.lastActivityAt = now;
}

export function notifySessionActivity(): void {
  markActivity();
}

export function notifyFocusBreak(): void {
  // Reset the focus stretch (e.g. diagnostic appeared). Session stays open.
  state.focusStretchStart = Date.now();
}

export function startSessionTracker(
  context: vscode.ExtensionContext
): vscode.Disposable {
  // Reset state for a fresh activation.
  state = {
    activeStartedAt: null,
    lastActivityAt: Date.now(),
    focusStretchStart: Date.now(),
    inSession: false,
  };

  const subscriptions: vscode.Disposable[] = [];
  subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      markActivity();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      markActivity();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      markActivity();
    })
  );

  timer = setInterval(() => {
    const b = getBatcher();
    if (!b) return;
    const now = Date.now();
    const focused = hasEditorFocus();
    if (!focused) {
      // No editor — skip the tick. Idle detection still ticks over via
      // the boundary check when activity resumes.
      if (state.inSession && now - state.lastActivityAt > IDLE_THRESHOLD_MS) {
        b.push({
          type: "session_boundary",
          ts: state.lastActivityAt,
          kind: "end",
          reason: "idle",
          activeMs:
            state.activeStartedAt != null
              ? state.lastActivityAt - state.activeStartedAt
              : undefined,
        });
        state.inSession = false;
        state.activeStartedAt = null;
      }
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const file = editor?.document.fileName ?? null;
    const language = editor?.document.languageId ?? null;
    const stretchMs = Math.max(0, now - state.focusStretchStart);
    b.push({
      type: "session_tick",
      ts: now,
      file,
      language,
      focusStretchMs: stretchMs,
    });
  }, TICK_INTERVAL_MS);

  const disposable = new vscode.Disposable(() => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const s of subscriptions) s.dispose();
    subscriptions.length = 0;
    const b = getBatcher();
    if (b && state.inSession && state.activeStartedAt != null) {
      b.push({
        type: "session_boundary",
        ts: Date.now(),
        kind: "end",
        reason: "vscode-close",
        activeMs: Date.now() - state.activeStartedAt,
      });
    }
  });
  context.subscriptions.push(disposable);
  return disposable;
}
