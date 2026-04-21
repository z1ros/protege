import * as vscode from "vscode";
import type { Suggestion } from "./reviewEngine.js";
import { log } from "./log.js";

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
const LINE_EDIT_WINDOW_MS = 45_000;
const CURSOR_PROXIMITY_LINES = 2;
const LINE_PRUNE_MS = LINE_EDIT_WINDOW_MS * 3; // ~135s
const lineTouchedAt = new Map<string, Map<number, number>>();

// ---- B1 state ----
const RULE_COOLDOWN_MS = 5 * 60_000; // 5 min
const FILE_SIZE_DELTA_THRESHOLD = 0.10; // 10% char churn resets cooldown
// Alternative to the char-delta check: if the file's line count has
// grown/shrunk by more than this many lines since the cooldown snapshot,
// reset anyway. Catches big blank-line inserts or boilerplate deletions
// that don't cross 10% char churn but still represent "the user did
// significant work here, this ruleId deserves a fresh look."
const LINE_DELTA_THRESHOLD = 20;
const RULE_PRUNE_MS = RULE_COOLDOWN_MS * 2; // 10 min
interface RuleCooldownEntry {
  firstShownAt: number;
  fileSizeAtShow: number;
  linesAtShow: number;
}
const ruleCooldownByUri = new Map<string, Map<string, RuleCooldownEntry>>();

// Fired whenever the cursor moves or gate state otherwise changes in a
// way that could affect suppression. Surfaces subscribe to re-render.
const gateEmitter = new vscode.EventEmitter<void>();
export const onGateChanged: vscode.Event<void> = gateEmitter.event;

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
        const startLine = change.range.start.line;
        const endLine = change.range.end.line;
        const addedNewlines = (change.text.match(/\n/g) ?? []).length;
        // Span covers replaced lines + any new lines the edit inserted.
        const span = Math.max(endLine, startLine + addedNewlines);
        for (let i = startLine; i <= span; i++) {
          map.set(i, now);
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

  // --- B1 — cheap first: is this (ruleId, uri) on cooldown? ---
  const ruleMap = ruleCooldownByUri.get(uri);
  const existing = ruleMap?.get(finding.ruleId);
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

  const existing = ruleMap.get(finding.ruleId);
  if (existing && now - existing.firstShownAt < RULE_COOLDOWN_MS) {
    // Still within the cooldown window — keep the original timestamp
    // so the 5-min clock doesn't get bumped on every re-render.
    return;
  }

  // Look up the doc to snapshot line count for the >20-line reset
  // threshold. Kept out of the public signature (spec: `(uri, finding,
  // fileSize)`) so we don't break callers that already pass fileSize.
  // If the doc isn't currently open (edge case — shouldn't happen for
  // an ingested finding), fall back to 0 and the char-delta check
  // becomes the sole reset trigger.
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri
  );
  const linesAtShow = doc?.lineCount ?? 0;

  ruleMap.set(finding.ruleId, {
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
