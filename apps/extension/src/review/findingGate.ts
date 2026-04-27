import * as vscode from "vscode";
import type { Suggestion } from "./reviewEngine.js";
import { log } from "../log.js";

/**
 * Finding Gate — A1 (line-recency + cursor proximity) + B1 (rule cooldown).
 *
 * Session-scoped render-time filter. Gate functions are called by every
 * visible surface (Ghost CodeLens, Underline Whisper, Inlay Hint) as
 * they render their output, AFTER the existing `dismissedByUri` +
 * `pendingFixByUri` checks. The gate itself is stateful only in-memory
 * and clears on reload.
 *
 * === A1 — suppress findings where the user is still working ===
 *
 * A finding is suppressed if EITHER:
 *   (a) its line was edited within LINE_EDIT_WINDOW_MS (45s), OR
 *   (b) a visible editor's cursor is on its line OR within
 *       ±CURSOR_PROXIMITY_LINES (2) lines.
 *
 * Together these give "quiet where the user is working" — typing
 * suppresses via (a), thinking/reading-pauses suppress via (b).
 *
 * For block/flow-scope findings, we check the whole range: any line in
 * [range.start.line, range.end.line] being touched recently OR any
 * cursor within ±2 of that range suppresses.
 *
 * === B1 — same ruleId can't re-surface for 5min unless file churns ===
 *
 * After a finding with ruleId `X` renders on URI `Y`, we block `(X,Y)`
 * from re-appearing for RULE_COOLDOWN_MS (5min). After the TTL it can
 * surface again (honest signal the user hasn't addressed it). A
 * "significant edit" (file char count ±10%) clears all cooldowns for
 * the URI — heavy refactor = fresh attention warranted.
 *
 * === Architecture ===
 *
 * Gate runs at RENDER time (not ingest) so cursor movement changes
 * suppression state without needing a re-scan. Surfaces subscribe to
 * `onGateChanged` to re-render themselves when the cursor moves — one
 * event emitter, one subscriber per surface, no callbacks threaded
 * through the call chain.
 *
 * No AI, no backend, no UI, no prompts. Pure client filter.
 */

// ---- A1 state ----
// Tuned 2026-04-23 from 15s → 8s. With SAVE/IDLE retired, LIVE is the
// only scan tier; over-long suppression was the #1 reason findings
// "never appeared." 8s still silences while the user is actively
// typing into a line, short enough that post-paste surfaces in ~12s
// total (3s scan debounce + AI call + window lift).
const LINE_EDIT_WINDOW_MS = 8_000;
// Tuned 2026-04-23 from 1 → 0. ±1 line still smothered "I just fixed
// line N, cursor is there, Protege went silent on line N-1 and N+1
// where there are real issues." Exact-line match only — if the cursor
// is ON the finding's line we suppress (user is editing it right now);
// one line away is plenty of breathing room to let it surface.
const CURSOR_PROXIMITY_LINES = 0;
const LINE_PRUNE_MS = LINE_EDIT_WINDOW_MS * 3; // ~24s
const lineTouchedAt = new Map<string, Map<number, number>>();

// ---- B1 state ----
// Tuned 2026-04-23 from 5 min → 45s AND scope changed from URI-wide
// to per-(ruleId, line). The URI-wide cooldown was the #2 reason LIVE
// felt dead: one `prefer-const` on line 5 blocked ALL other prefer-
// const findings on DIFFERENT lines for 5 minutes. Scoping per-line
// means you see every distinct occurrence; 45s still prevents the
// same finding from flickering in/out between scans.
const RULE_COOLDOWN_MS = 45_000;
const FILE_SIZE_DELTA_THRESHOLD = 0.10;
const LINE_DELTA_THRESHOLD = 20;
const RULE_PRUNE_MS = RULE_COOLDOWN_MS * 2;
interface RuleCooldownEntry {
  firstShownAt: number;
  fileSizeAtShow: number;
  linesAtShow: number;
}
// Key is `${ruleId}@${line}` — per-line scoping.
const ruleCooldownByUri = new Map<string, Map<string, RuleCooldownEntry>>();

// Fired whenever the cursor moves or gate state otherwise changes in a
// way that could affect suppression. Surfaces subscribe to re-render.
const gateEmitter = new vscode.EventEmitter<void>();
export const onGateChanged: vscode.Event<void> = gateEmitter.event;

// Time-based gate-clear scheduling. Without this, a typed-then-idle line
// stayed suppressed until the user moved the cursor or another doc-change
// event fired — which is exactly the gap the Live Review health timer was
// papering over with full LLM rescans every 12s. With this, each touched
// line gets a one-shot setTimeout that fires gateEmitter when its
// LINE_EDIT_WINDOW_MS expires, so subscribers (Live Review surfaces,
// ghostMentor, underlineWhisper) can re-render exactly when the gate
// clears — zero LLM cost.
//
// Capped at GATE_CLEAR_TIMER_CAP entries with FIFO eviction so a
// pathological keystroke storm cannot grow the map unbounded.
const GATE_CLEAR_TIMER_CAP = 200;
const GATE_CLEAR_FIRE_BUFFER_MS = 500;
const pendingGateClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleGateClearFire(uriKey: string, line: number): void {
  const timerKey = `${uriKey}:${line}`;
  const existing = pendingGateClearTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  if (pendingGateClearTimers.size >= GATE_CLEAR_TIMER_CAP) {
    // FIFO eviction — drop the oldest pending timer. Map iteration order
    // is insertion order, so the first key is the oldest.
    const firstKey = pendingGateClearTimers.keys().next().value;
    if (firstKey !== undefined) {
      const t = pendingGateClearTimers.get(firstKey);
      if (t) clearTimeout(t);
      pendingGateClearTimers.delete(firstKey);
    }
  }
  const handle = setTimeout(() => {
    pendingGateClearTimers.delete(timerKey);
    gateEmitter.fire();
  }, LINE_EDIT_WINDOW_MS + GATE_CLEAR_FIRE_BUFFER_MS);
  pendingGateClearTimers.set(timerKey, handle);
}


export type SuppressReason =
  | "line-still-being-edited"
  | "cursor-near-line"
  | "rule-on-cooldown";

// ---- Public API ----

/**
 * Register once from extension.ts. Sets up the document-change +
 * document-close + selection-change listeners that maintain gate state
 * and fire `onGateChanged` so surfaces can refresh on cursor moves.
 */
export function registerFindingGate(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      if (e.document.uri.scheme !== "file") return;
      const key = e.document.uri.toString();
      const now = Date.now();
      const map = lineTouchedAt.get(key) ?? new Map<number, number>();

      for (const change of e.contentChanges) {
        // A1 intent: suppress findings on lines the user is ACTIVELY
        // TYPING. Pastes, AI-applied fixes, and other bulk edits fire
        // as a single multi-line change event — treating them as
        // "still mid-edit" is what caused the 60+ seconds of post-paste
        // silence (every pasted line got marked for the full window,
        // dropping every finding the scan returned).
        //
        // Heuristic: any change whose inserted text crosses a newline
        // is bulk — skip marking. Character-level typing never contains
        // a newline except when pressing Enter, which just demotes the
        // current line's "still typing" signal by one keystroke — the
        // keystrokes BEFORE the Enter already marked the line, so the
        // suppression window still covers the pause after Enter.
        if (change.text.includes("\n")) continue;

        const startLine = change.range.start.line;
        const endLine = change.range.end.line;
        // Keep the span logic for completeness even though addedNewlines
        // is 0 here (we continue'd above for multi-line changes). A
        // multi-line DELETE (range spans lines, text empty) still marks
        // the collapse line — harmless, the deleted lines no longer
        // exist so there's nothing for findings to land on.
        for (let i = startLine; i <= endLine; i++) {
          map.set(i, now);
          scheduleGateClearFire(key, i);
        }
      }

      // Prune stale entries on the same pass — cheap and keeps the map
      // from growing for long-lived documents.
      const cutoff = now - LINE_PRUNE_MS;
      for (const [line, ts] of map) {
        if (ts < cutoff) map.delete(line);
      }

      if (map.size === 0) lineTouchedAt.delete(key);
      else lineTouchedAt.set(key, map);

      // B1: significant edits clear rule cooldowns for this URI so a
      // heavy refactor gets fresh attention. Two thresholds, OR'd:
      //   - file char-count changed ≥10% from snapshot
      //   - file line-count changed by >20 lines from snapshot
      // Char-count catches most refactors; line-count catches the edge
      // case where many short/blank lines are added/removed without
      // crossing the char threshold.
      const ruleMap = ruleCooldownByUri.get(key);
      if (ruleMap && ruleMap.size > 0) {
        const currentSize = e.document.getText().length;
        const currentLines = e.document.lineCount;
        let clearedAny = false;
        for (const [ruleId, entry] of ruleMap) {
          if (entry.fileSizeAtShow === 0) continue;
          const sizeDelta =
            Math.abs(currentSize - entry.fileSizeAtShow) /
            entry.fileSizeAtShow;
          const lineDelta = Math.abs(currentLines - entry.linesAtShow);
          if (
            sizeDelta >= FILE_SIZE_DELTA_THRESHOLD ||
            lineDelta > LINE_DELTA_THRESHOLD
          ) {
            ruleMap.delete(ruleId);
            clearedAny = true;
          }
        }
        if (clearedAny) {
          log(
            "findingGate",
            `rule-cooldown-reset ${shortName(e.document.uri)} — significant edit (size ≥${Math.round(FILE_SIZE_DELTA_THRESHOLD * 100)}% or lines >${LINE_DELTA_THRESHOLD})`
          );
        }
        if (ruleMap.size === 0) ruleCooldownByUri.delete(key);
      }

      // An edit always changes what "line recency" means for this URI,
      // so surfaces should re-render their suppression state.
      gateEmitter.fire();
    })
  );

  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      lineTouchedAt.delete(key);
      ruleCooldownByUri.delete(key);
    })
  );

  // Cursor movement updates the (b) arm of A1. Fire the event so
  // surfaces (Ghost CodeLens, Underline Whisper, Inlay) can refresh.
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      gateEmitter.fire();
    })
  );

  disposables.push({
    dispose() {
      lineTouchedAt.clear();
      ruleCooldownByUri.clear();
      for (const handle of pendingGateClearTimers.values()) clearTimeout(handle);
      pendingGateClearTimers.clear();
      gateEmitter.dispose();
    },
  });

  return disposables;
}

/**
 * The core check — call before rendering a finding.
 * Returns null if the finding should render, otherwise a reason string
 * (useful for logs — callers can ignore the specific value).
 */
export function shouldSuppress(
  uri: string,
  finding: Suggestion
): SuppressReason | null {
  const now = Date.now();

  // --- B1 — cheap first: is this (ruleId@line, uri) on cooldown? ---
  // Scoped per-line so multiple instances of the same rule on different
  // lines each get their own window. A URI-wide cooldown silently hid
  // up to 4/5 legitimate findings per scan.
  const cooldownKey = `${finding.ruleId}@${finding.range.start.line}`;
  const ruleMap = ruleCooldownByUri.get(uri);
  const existing = ruleMap?.get(cooldownKey);
  if (existing && now - existing.firstShownAt < RULE_COOLDOWN_MS) {
    return "rule-on-cooldown";
  }

  // --- A1 — line-recency + cursor proximity ---
  const touchedMap = lineTouchedAt.get(uri);
  const startLine = finding.range.start.line;
  const endLine =
    finding.scope === "block" || finding.scope === "flow"
      ? finding.range.end.line
      : startLine;

  // Line-recency: any line in [startLine, endLine] touched recently?
  if (touchedMap && touchedMap.size > 0) {
    for (let ln = startLine; ln <= endLine; ln++) {
      const ts = touchedMap.get(ln);
      if (ts && now - ts < LINE_EDIT_WINDOW_MS) {
        return "line-still-being-edited";
      }
    }
  }

  // Cursor proximity: any visible editor for this URI with cursor
  // within ±CURSOR_PROXIMITY_LINES of the finding's range? Iterating
  // visibleTextEditors covers split-pane / multi-window cases where a
  // single URI can be open in more than one place.
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() !== uri) continue;
    const cur = editor.selection.active.line;
    if (
      cur >= startLine - CURSOR_PROXIMITY_LINES &&
      cur <= endLine + CURSOR_PROXIMITY_LINES
    ) {
      return "cursor-near-line";
    }
  }

  return null;
}

/**
 * Call AFTER a finding has actually been rendered on a surface. Starts
 * the B1 cooldown for `(uri, ruleId)`. Only sets the timestamp on the
 * FIRST render so rapid re-renders within the cooldown don't extend
 * the window. `fileSize` is the current char length of the document —
 * used for the "significant edit" cooldown-reset check on future edits.
 *
 * Safe to call multiple times from multiple surfaces; idempotent when
 * the entry already exists and is still fresh.
 */
export function noteFindingShown(
  uri: string,
  finding: Suggestion,
  fileSize: number
): void {
  const now = Date.now();
  const ruleMap = ruleCooldownByUri.get(uri) ?? new Map<string, RuleCooldownEntry>();
  const cooldownKey = `${finding.ruleId}@${finding.range.start.line}`;

  const existing = ruleMap.get(cooldownKey);
  if (existing && now - existing.firstShownAt < RULE_COOLDOWN_MS) {
    // Still within the cooldown window — keep the original timestamp
    // so the clock doesn't get bumped on every re-render.
    return;
  }

  // Look up the doc to snapshot line count for the >20-line reset
  // threshold. If the doc isn't currently open (edge case — shouldn't
  // happen for an ingested finding), fall back to 0 and the char-delta
  // check becomes the sole reset trigger.
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri
  );
  const linesAtShow = doc?.lineCount ?? 0;

  ruleMap.set(cooldownKey, {
    firstShownAt: now,
    fileSizeAtShow: fileSize,
    linesAtShow,
  });

  // Prune stale entries on write.
  const cutoff = now - RULE_PRUNE_MS;
  for (const [ruleId, entry] of ruleMap) {
    if (entry.firstShownAt < cutoff) ruleMap.delete(ruleId);
  }

  ruleCooldownByUri.set(uri, ruleMap);
}

function shortName(u: vscode.Uri): string {
  return u.path.split("/").pop() ?? u.path;
}
