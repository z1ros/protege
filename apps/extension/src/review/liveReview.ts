import * as vscode from "vscode";
import type { HostToWebview } from "@protege/types";
import { reviewDocument, type Suggestion } from "./reviewEngine.js";
import { renderProtegeHover, type HoverKind } from "../hints/hoverTemplate.js";
import { log } from "../log.js";
import {
  hasNativeDiagnosticInRange,
  hasNativeDiagnosticOnLine,
} from "./nativeDiagnostics.js";
import {
  shouldSuppress as gateShouldSuppress,
  noteFindingShown as gateNoteFindingShown,
  onGateChanged,
} from "./findingGate.js";

/**
 * Live Code Review — JARVIS Layer 4.
 *
 * Runs the AI review engine on the active file and renders two isolated
 * surfaces so we never stack with TS/cSpell/Cursor hovers:
 *
 *   1. Gutter icon (Orbit ring) — visual brand marker next to the line
 *   2. Inlay hint "💡 Protege" at end of line — hover this for our rich
 *      popup. Inlay hint tooltips are a separate hover target from code
 *      diagnostic hovers, so they NEVER merge.
 *
 * A dedup filter skips suggestions where TS/cSpell/ESLint already flagged
 * the range, so we stay quiet when someone else has already spoken.
 */

// ---- Gutter decorations (paused) ----
// Editor-surface UI for live review is off while we redesign. Scan results
// still flow to the sidebar webview via broadcastState(); only the in-editor
// drawing is suppressed. Leave the null decoration slots so the render call
// sites below become safe no-ops.

const gutterWarn: vscode.TextEditorDecorationType | null = null;
const gutterPerf: vscode.TextEditorDecorationType | null = null;
const gutterInfo: vscode.TextEditorDecorationType | null = null;

function initGutterDecorations(_context: vscode.ExtensionContext) {
  /* no-op while editor UI is paused */
}

// ---- State ----

let active = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let changeListener: vscode.Disposable | null = null;
let editorListener: vscode.Disposable | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let gateSubscription: vscode.Disposable | null = null;
let currentSuggestions: Suggestion[] = [];
let scanSeq = 0;
let pendingChangeSize = 0;
let lastScannedText: string | null = null;
let isScanning = false;

// Per-URI cache so the InlayHintsProvider can respond to VS Code's pulls
const suggestionsByUri = new Map<string, Suggestion[]>();
// Per-URI text snapshot of the last LLM scan, keyed by uri.toString().
// Used by the tab-switch path to avoid re-scanning a file whose content
// hasn't changed since we last saw it. Without this, switching to a
// file you visited 30s ago always fires a fresh LLM call even though
// the cached suggestions are still correct.
const lastScannedTextByUri = new Map<string, string>();

// Session-scoped dismiss log. Keyed by `${uri}` → Set<`${ruleId}@${line}`>.
// When the user clicks "✕ Dismiss" on a finding, we remember its key so
// the NEXT scan (which will almost certainly re-detect the same rule at
// the same line) doesn't re-surface it. Clears on window reload.
const dismissedByUri = new Map<string, Set<string>>();

// Short-lived "fix in progress" set. On Apply-fix click, we remove the
// finding from the store immediately (so the CodeLens clears, feels
// responsive) and add its key here for ~60s. During that window,
// re-ingestion (LIVE rescan, SAVE/FLOW merge) also skips the key so the
// finding doesn't flicker back while Claude is still mid-edit_file.
// After the window expires, normal behavior resumes — if the fix didn't
// actually resolve the issue, the next scan will legitimately re-add it.
const pendingFixByUri = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();
const PENDING_FIX_TTL_MS = 60_000;

// Tuned 2026-04-23 from 3s → 2s. With SAVE/IDLE retired, LIVE is the
// only source of findings — a shorter debounce makes the extension
// feel present instead of silent. 2s is still long enough to avoid
// firing mid-word.
const DEBOUNCE_MS = 2_000;
const MIN_CHANGE_CHARS = 4;
// Tuned 2026-04-23 from 20s → 12s. Paired with the gate's 8s
// LINE_EDIT_WINDOW_MS, post-paste recovery lands under ~15s total.
const HEALTH_CHECK_MS = 12_000;

// ---- Inlay hints provider (the isolated hover surface) ----

class ProtegeInlayProvider implements vscode.InlayHintsProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeInlayHints = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  provideInlayHints(doc: vscode.TextDocument): vscode.InlayHint[] {
    if (!active) return [];
    const list = suggestionsByUri.get(doc.uri.toString());
    if (!list || list.length === 0) return [];

    // Skip findings covered by a native diagnostic OR blocked by the
    // finding gate (line recently edited, cursor near, ruleId on
    // cooldown). Same two-stage filter the CodeLens + whisper use.
    const uriKey = doc.uri.toString();
    const filtered = list.filter((s) => {
      const rangeHasNative =
        s.scope === "block" || s.scope === "flow"
          ? hasNativeDiagnosticInRange(doc.uri, s.range)
          : hasNativeDiagnosticOnLine(doc.uri, s.range.start.line);
      if (rangeHasNative) return false;
      if (gateShouldSuppress(uriKey, s)) return false;
      return true;
    });

    return filtered.map((s) => {
      const line = Math.min(doc.lineCount - 1, s.range.start.line);
      const lineText = doc.lineAt(line).text;
      const position = new vscode.Position(line, lineText.length);

      const label = `  Protege`;
      const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
      hint.paddingLeft = true;
      // Minimal teaser only — the full card renders via `Open →` CodeLens
      // as a native Comment Thread (see tipComment.ts). Keeping the old
      // rich hover here would duplicate the thread's content.
      const tip = new vscode.MarkdownString(
        `**Protege** · ${titleForRule(s.ruleId, s.severity)}  \nClick **Open →** above to view details`
      );
      tip.isTrusted = false;
      hint.tooltip = tip;
      return hint;
    });
  }
}

let inlayProvider: ProtegeInlayProvider | null = null;

// ---- CodeLens (click to open full styled card in Protege panel) ----

class ProtegeLiveCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!active) return [];
    const list = suggestionsByUri.get(doc.uri.toString());
    if (!list || list.length === 0) return [];

    return list.map((s) => {
      const line = Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line));
      const range = new vscode.Range(line, 0, line, 0);
      const icon =
        s.severity === "warn" ? "$(circle-filled)" :
        s.severity === "perf" ? "$(zap)" : "$(lightbulb)";
      const title = titleForRule(s.ruleId, s.severity);
      return new vscode.CodeLens(range, {
        title: `${icon} Protege · ${title} · Open →`,
        command: "protege.openTipDetail",
        arguments: [
          {
            suggestion: s,
            docUri: doc.uri.toString(),
            currentLine: doc.lineAt(line).text.trim(),
            lang: doc.languageId,
          },
        ],
      });
    });
  }
}

let liveCodeLensProvider: ProtegeLiveCodeLensProvider | null = null;

function buildHover(s: Suggestion, doc: vscode.TextDocument): vscode.MarkdownString {
  const kind: HoverKind =
    s.severity === "warn" ? "warn" : s.severity === "perf" ? "perf" : "tip";
  const line = Math.min(doc.lineCount - 1, s.range.start.line);
  const currentLine = doc.lineAt(line).text.trim();
  const actions = s.fix
    ? [
        {
          icon: "wrench",
          label: "Apply fix",
          command: "protege.applyReviewFix",
          args: {
            uri: doc.uri.toString(),
            line: s.range.start.line,
            fix: s.fix,
          },
          primary: true,
        },
        {
          icon: "mortar-board",
          label: "Teach me",
          command: "protege.teachConcept",
          args: [s.ruleId],
        },
      ]
    : [
        {
          icon: "mortar-board",
          label: "Teach me",
          command: "protege.teachConcept",
          args: [s.ruleId],
        },
      ];
  return renderProtegeHover({
    kind,
    title: titleForRule(s.ruleId, s.severity),
    body: s.message,
    code: s.fix ? { before: currentLine, after: s.fix.trim(), lang: doc.languageId } : undefined,
    actions,
  });
}

// ---- Dedup: skip if TS/cSpell/ESLint already flagged this range ----

function hasOverlappingDiagnostic(uri: vscode.Uri, range: vscode.Range): boolean {
  const diags = vscode.languages.getDiagnostics(uri);
  for (const d of diags) {
    if (d.source === "Protege") continue;
    // Strict range intersection only. "Same line" is too aggressive — a file
    // with TS errors on most lines would silence Protege entirely even when
    // we have a unique insight at a different column.
    if (d.range.intersection(range)) return true;
  }
  return false;
}

// ---- Status bar ----

let statusItem: vscode.StatusBarItem | null = null;

function getStatusItem(): vscode.StatusBarItem {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90
    );
    statusItem.command = "protege.toggleLiveReview";
  }
  return statusItem;
}

function updateStatusBar(): void {
  const item = getStatusItem();
  if (!active) {
    item.hide();
    return;
  }
  if (isScanning) {
    // Shortened chip: icon-only while scanning so the status bar row
    // doesn't balloon. Full context lives in the tooltip.
    item.text = "$(sync~spin) Live";
    item.tooltip = "Protege Live — scanning this file";
  } else {
    const count = currentSuggestions.length;
    // Short form: "Live · N" when there are issues, just "Live" otherwise.
    // Full "Protege Live · N issues" was eating real estate next to four
    // other Protege status items (IQ, streak, Go Live, Wake state).
    item.text = count > 0 ? `$(eye) Live · ${count}` : "$(eye) Live";
    item.tooltip =
      count > 0
        ? `Protege Live — ${count} issue${count === 1 ? "" : "s"} found. Click to stop.`
        : "Protege Live — ON. Click to stop.";
  }
  item.show();
}

function broadcastState(): void {
  try {
    const { broadcast } = require("../chat/webviewHost.js") as {
      broadcast: (msg: HostToWebview) => void;
    };
    broadcast({ type: "liveReview/state", active });
    if (isScanning) {
      broadcast({ type: "scan/started" });
    } else {
      broadcast({ type: "scan/done", found: currentSuggestions.length, summary: "" });
    }
  } catch {}
}

// Re-paints every Live Review surface from the in-memory suggestion cache.
// No LLM call. The gate (findingGate.ts) is a render-time filter, so once
// its LINE_EDIT_WINDOW_MS expires for a touched line, calling this surfaces
// any findings the gate had been hiding. Used by:
//   - notifyLiveReviewOn (toggle-on handler, since the toggle wants the
//     same render fan-out)
//   - the V2 health timer body (replaces the old LLM-firing scan)
//   - the onGateChanged subscriber (gate-clear event re-render)
function refreshAllSurfaces(): void {
  try {
    const mod = require("./inlineErrors.js") as {
      refreshInlineDecorations: () => void;
      refreshFixItCodeLens: () => void;
    };
    mod.refreshInlineDecorations();
    mod.refreshFixItCodeLens();
  } catch {}
  try {
    const { refreshFindingCodeLens } = require("./codeLens.js") as {
      refreshFindingCodeLens: () => void;
    };
    refreshFindingCodeLens();
  } catch {}
  inlayProvider?.refresh();
}

function notifyLiveReviewOn(): void {
  refreshAllSurfaces();
}


function notifyLiveReviewOff(): void {
  try {
    const mod = require("./inlineErrors.js") as {
      clearInlineDecorations: () => void;
      refreshFixItCodeLens: () => void;
    };
    mod.clearInlineDecorations();
    mod.refreshFixItCodeLens();
  } catch {}
  try {
    const { clearProtegeDiagnostics } = require("./analyzer.js") as {
      clearProtegeDiagnostics: () => void;
    };
    clearProtegeDiagnostics();
  } catch {}
  try {
    const { refreshFindingCodeLens } = require("./codeLens.js") as {
      refreshFindingCodeLens: () => void;
    };
    refreshFindingCodeLens();
  } catch {}
  inlayProvider?.refresh();
}

// ---- Start / stop ----

function startLiveReview(): void {
  if (active) return;
  active = true;
  lastScannedText = null;
  pendingChangeSize = 0;

  changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || e.document !== editor.document) return;

    for (const c of e.contentChanges) {
      pendingChangeSize += Math.max(c.text.length, c.rangeLength);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runReview(editor);
    }, DEBOUNCE_MS);
  });

  editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    // Per-URI dedup: if we've scanned this exact text before, the cache
    // already has the right suggestions. Skip the LLM call and just
    // refresh surfaces. Without this, every tab switch re-scans even
    // unchanged files — common pattern (jump to a file, jump back) used
    // to fire two LLM calls for zero new info.
    const uriKey = editor.document.uri.toString();
    const text = editor.document.getText();
    const cached = lastScannedTextByUri.get(uriKey);
    if (cached !== undefined && cached === text && suggestionsByUri.has(uriKey)) {
      // Sync the global lastScannedText so a follow-up keystroke-debounced
      // scan still sees the dedup guard at runReview entry.
      lastScannedText = text;
      pendingChangeSize = 0;
      currentSuggestions = suggestionsByUri.get(uriKey) ?? [];
      log(
        "liveReview",
        `tab-switch dedup HIT · ${editor.document.fileName.split(/[\\/]/).pop()} · ${currentSuggestions.length} cached findings`
      );
      refreshAllSurfaces();
      updateStatusBar();
      broadcastState();
      return;
    }
    lastScannedText = null;
    pendingChangeSize = Infinity;
    void runReview(editor);
  });

  if (vscode.window.activeTextEditor) {
    const editor = vscode.window.activeTextEditor;
    const uriKey = editor.document.uri.toString();
    const text = editor.document.getText();
    const cached = lastScannedTextByUri.get(uriKey);
    if (cached !== undefined && cached === text && suggestionsByUri.has(uriKey)) {
      lastScannedText = text;
      pendingChangeSize = 0;
      currentSuggestions = suggestionsByUri.get(uriKey) ?? [];
      refreshAllSurfaces();
    } else {
      pendingChangeSize = Infinity;
      void runReview(editor);
    }
  }

  // The legacy "force a full LLM rescan every 12s" timer was deleted —
  // it bypassed runReview's same-content dedup with pendingChangeSize =
  // Infinity, burning ~$4/day per idle user re-scanning unchanged code.
  //
  // The timer's only legitimate job is to re-render surfaces after
  // findingGate's LINE_EDIT_WINDOW_MS expires. The gate is a render-time
  // filter — once its window clears, the existing suggestion cache is
  // already correct. We just need a paint pass. Zero LLM tokens.
  //
  // We subscribe to onGateChanged so most re-renders happen immediately
  // on cursor moves and on the time-based gate-clear emission from
  // findingGate.ts (scheduled per touched line, fires LINE_EDIT_WINDOW_MS
  // + 500ms after the edit). The interval below is a belt-and-suspenders
  // safety net for any recovery case the event channel misses.
  healthTimer = setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor && active) refreshAllSurfaces();
  }, HEALTH_CHECK_MS);
  gateSubscription = onGateChanged(() => {
    if (active) refreshAllSurfaces();
  });

  updateStatusBar();
  broadcastState();
  notifyLiveReviewOn();
}

function stopLiveReview(): void {
  if (!active) return;
  active = false;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  changeListener?.dispose();
  changeListener = null;
  editorListener?.dispose();
  editorListener = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  gateSubscription?.dispose();
  gateSubscription = null;

  scanSeq++;
  isScanning = false;

  // Clear decorations everywhere
  for (const editor of vscode.window.visibleTextEditors) {
    if (gutterWarn) editor.setDecorations(gutterWarn, []);
    if (gutterPerf) editor.setDecorations(gutterPerf, []);
    if (gutterInfo) editor.setDecorations(gutterInfo, []);
  }
  suggestionsByUri.clear();
  lastScannedTextByUri.clear();
  inlayProvider?.refresh();

  currentSuggestions = [];

  updateStatusBar();
  broadcastState();
  notifyLiveReviewOff();
}

// Syntax-error rule ids that mean "user is mid-edit, file is broken
// right now." When TS reports these we refuse to scan — typing in the
// middle of JSX / a function body / an async block always trips them
// transiently, and no amount of AI cleverness can usefully review code
// that doesn't parse. The set is deliberately small; anything not listed
// is a real issue that Protege CAN talk about (type mismatches,
// unused imports, etc.). See fightMidEditNoise() below.
const IN_PROGRESS_TS_CODES = new Set<number>([
  1005,  // ';' expected / expected token (opening tag, closing paren, etc.)
  1109,  // Expression expected
  1128,  // Declaration or statement expected
  1131,  // Property or signature expected
  1136,  // Property assignment expected
  1161,  // Unterminated regular expression literal
  1381,  // Unexpected token
  17002, // Expected corresponding JSX closing tag
  17008, // JSX element has no corresponding closing tag
  17014, // JSX fragment has no corresponding closing tag
  17015, // JSX attribute must have an initializer
]);

/**
 * True when the file has TypeScript diagnostics that scream "the user is
 * mid-edit, everything is broken right now" NEAR THE CURSOR. Tuned
 * 2026-04-23: previously bailed on any IN_PROGRESS_TS_CODE anywhere in
 * the file, which meant a single stray JSX typo 200 lines away silenced
 * the whole scan. Now we only gate when the mid-edit diagnostic is
 * within ±5 lines of the cursor — the user is demonstrably typing
 * there. Errors elsewhere are legitimate teaching surface.
 */
function isFileMidEdit(editor: vscode.TextEditor): boolean {
  const diags = vscode.languages.getDiagnostics(editor.document.uri);
  const cursorLine = editor.selection.active.line;
  for (const d of diags) {
    if (d.source !== "ts") continue;
    if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
    const code = typeof d.code === "number"
      ? d.code
      : typeof d.code === "object" && d.code && typeof (d.code as { value: unknown }).value === "number"
        ? ((d.code as { value: number }).value)
        : -1;
    if (!IN_PROGRESS_TS_CODES.has(code)) continue;
    // Only bail when the user is editing near the broken range.
    const within =
      d.range.start.line - 5 <= cursorLine &&
      cursorLine <= d.range.end.line + 5;
    if (within) return true;
  }
  return false;
}

async function runReview(editor: vscode.TextEditor): Promise<void> {
  if (!active) return;

  const text = editor.document.getText();
  if (pendingChangeSize < MIN_CHANGE_CHARS && text === lastScannedText) {
    return;
  }
  if (isScanning) return;

  // Mid-edit guard: if TS is currently reporting unresolved syntax (user
  // is halfway through typing a JSX tag, function body, etc.), skip this
  // scan. Running an LLM review on broken syntax produces phantom findings
  // AND costs tokens/time for zero useful output. We'll catch up on the
  // next debounce after TS stops complaining.
  if (isFileMidEdit(editor)) {
    const name = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
    log("liveReview", `LIVE skip ${name} — cursor near unresolved TS syntax (mid-edit)`);
    return;
  }

  pendingChangeSize = 0;
  lastScannedText = text;
  // Stamp the per-URI snapshot too so a future tab-switch back to this
  // URI can short-circuit the LLM call when content is unchanged.
  lastScannedTextByUri.set(editor.document.uri.toString(), text);

  const mySeq = ++scanSeq;
  const cancelSignal = { cancelled: false };

  isScanning = true;
  updateStatusBar();
  broadcastState();

  const scanFile = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
  log("liveReview", `LIVE tier → reviewDocument ${scanFile} (seq ${mySeq})`);

  let raw: Suggestion[] = [];
  try {
    // Pass the cursor line so the on-device prompt can focus its attention
    // on the window the user is actively editing. Cloud models (Haiku /
    // Sonnet) ignore this and review the whole file — they have the scale
    // for it and catch cross-function issues a focus window would miss.
    const activeLine = editor.selection.active.line;
    raw = await reviewDocument(editor.document, cancelSignal, activeLine);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("liveReview", `reviewDocument THREW for ${scanFile} — ${msg}`);
    console.error("[protege] live review failed:", err);
  }

  if (mySeq !== scanSeq || !active) {
    cancelSignal.cancelled = true;
    isScanning = false;
    updateStatusBar();
    broadcastState();
    return;
  }

  // Line-level dedup: drop Protege findings that land on lines TS has
  // already flagged with an error. If TS says "this line is broken", the
  // user sees a red squiggle and is already on notice — adding a Protege
  // whisper on the same line is noise and usually wrong (Protege's
  // finding was about the broken version of the code). Different rules
  // from our earlier "never stack with TS" worry — that one cared about
  // hover popups, this one cares about inline decorations that Protege
  // now owns (whisper highlight + tag). See the hello.tsx mid-edit
  // screenshot that prompted this pass.
  const tsErrorLines = new Set<number>();
  const tsDiags = vscode.languages.getDiagnostics(editor.document.uri);
  for (const d of tsDiags) {
    if (d.source !== "ts") continue;
    if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
    for (let i = d.range.start.line; i <= d.range.end.line; i++) {
      tsErrorLines.add(i);
    }
  }
  const suggestions = tsErrorLines.size
    ? raw.filter((s) => !tsErrorLines.has(s.range.start.line))
    : raw;
  if (raw.length > suggestions.length) {
    log(
      "liveReview",
      `LIVE dropped ${raw.length - suggestions.length} finding(s) on TS-error lines`
    );
  }

  isScanning = false;

  // Preserve higher-scope findings from SAVE / IDLE tiers — only replace
  // the atom-scope slice here. Without this, every LIVE pass wiped the
  // block/flow suggestions that SAVE had just emitted, so the user never
  // got to see cross-file findings after typing.
  const key = editor.document.uri.toString();
  const prior = suggestionsByUri.get(key) ?? [];
  const keepers = prior.filter(
    (s) => s.scope === "block" || s.scope === "flow"
  );
  const merged = [...keepers];
  const reserved = new Set(keepers.map((s) => `${s.ruleId}@${s.range.start.line}`));
  const dismissed = dismissedByUri.get(key) ?? new Set<string>();
  const pending = pendingFixByUri.get(key);
  // Re-read the doc NOW for the cooldown snapshot — `text` was captured
  // at scan start (line ~447), and the AI call between then and here
  // may have taken seconds during which the user kept typing. Using
  // the stale length would inflate the B1 reset delta and expire
  // cooldowns earlier than the 10% threshold actually warrants.
  const currentFileSize = editor.document.getText().length;
  const liveAdded: Suggestion[] = [];
  let gateDropped = 0;
  // Two-pass: filter FIRST (reading cooldown state from the pre-batch
  // store), then arm cooldowns SECOND. If we armed inside the loop,
  // the first finding with ruleId X would cooldown-block the second
  // finding with the same ruleId on a different line IN THE SAME
  // BATCH — collapsing a real "3 missing-keys found" report to
  // "1 finding shown." B1 is meant to be cross-scan, not within-batch.
  for (const s of suggestions) {
    const k = `${s.ruleId}@${s.range.start.line}`;
    if (reserved.has(k)) continue;
    // Skip anything the user has already dismissed this session.
    if (dismissed.has(k)) continue;
    // Skip findings whose fix is currently being applied (CodeLens
    // should stay clear until the fix settles or the TTL expires).
    if (pending?.has(k)) continue;
    // Skip findings the finding gate is actively suppressing — line
    // is mid-edit, cursor is parked on it, or ruleId is on cooldown.
    // Dropping at ingest (not just render) stops unconfident findings
    // from polluting the store and leaking into sidebar counts.
    if (gateShouldSuppress(key, s)) { gateDropped++; continue; }
    merged.push(s);
    liveAdded.push(s);
    reserved.add(k);
  }
  // Second pass: arm cooldowns for findings that actually landed. All
  // same-ruleId findings in this batch survived (the first pass read
  // pre-batch cooldown state uniformly). noteFindingShown is
  // idempotent within the 5min window, so repeat ruleIds no-op here.
  for (const s of liveAdded) {
    gateNoteFindingShown(key, s, currentFileSize);
  }
  // Track only what actually made it through all filters. Sidebar badge
  // and status bar both read `currentSuggestions.length` — using the
  // raw pre-filter count here would say "3 issues" while the store has
  // zero, which is exactly the kind of lying-UI the gate is meant to
  // prevent.
  currentSuggestions = liveAdded;
  suggestionsByUri.set(key, merged);
  log(
    "liveReview",
    `LIVE merged ${scanFile} · raw=${suggestions.length} keepers=${keepers.length} stored=${merged.length}${gateDropped > 0 ? ` · gate-dropped ${gateDropped}` : ""}`
  );
  // Editor UI paused — no inlay/codelens/gutter rendering. Sidebar still
  // receives suggestion state via broadcastState(). The Ambient Coach Strip
  // subscribes via onSuggestionsChanged() below.
  scanChangeEmitter.fire(key);

  updateStatusBar();
  broadcastState();
}

// ---- Registration ----

export function registerLiveReview(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  initGutterDecorations(context);
  // Editor-surface providers are paused; the scan pipeline (startLiveReview)
  // still runs and feeds the sidebar via broadcastState().
  inlayProvider = null;
  liveCodeLensProvider = null;

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("protege.toggleLiveReview", () => {
      if (active) {
        stopLiveReview();
      } else {
        startLiveReview();
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.applyReviewFix",
      async (argsJson: string) => {
        try {
          const { uri, line, fix } = JSON.parse(argsJson);
          const docUri = vscode.Uri.parse(uri);
          const doc = await vscode.workspace.openTextDocument(docUri);
          const lineRange = doc.lineAt(line).range;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(docUri, lineRange, fix);
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage("Protege: fix applied!");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Fix failed: ${msg}`);
        }
      }
    )
  );

  // Inlay + CodeLens providers for editor surfaces are paused.
  // `protege.openTipDetail` is still registered below so any stale CodeLens
  // or command-palette invocation resolves cleanly instead of erroring.

  // Editor-surface renderers (inset + comment thread) are paused. Keep the
  // command names registered as no-ops so existing CodeLens references
  // resolve and the command palette doesn't show them as missing.
  disposables.push(
    vscode.commands.registerCommand("protege.openTipDetail", async () => {
      /* paused */
    })
  );
  disposables.push(
    vscode.commands.registerCommand("protege.dismissTipThread", async () => {
      /* paused */
    })
  );

  disposables.push(getStatusItem());

  disposables.push(
    new vscode.Disposable(() => {
      stopLiveReview();
    })
  );

  startLiveReview();

  return disposables;
}

export function isLiveReviewActive(): boolean {
  return active;
}

// ---- Public accessors for the Ambient Coach Strip ----
// The Strip is an observer: it never drives scans, it only reads results.
// `onSuggestionsChanged` fires every time a scan finishes for a document
// (even when zero suggestions were found), so the Strip can refresh idle
// state too.

const scanChangeEmitter = new vscode.EventEmitter<string>();

export const onSuggestionsChanged: vscode.Event<string> = scanChangeEmitter.event;

export function getSuggestionsForUri(uri: string): Suggestion[] {
  return suggestionsByUri.get(uri) ?? [];
}

export function findSuggestionAtLine(
  uri: string,
  line: number
): Suggestion | undefined {
  const list = suggestionsByUri.get(uri);
  if (!list) return undefined;
  // Atom-scope suggestions match exact line. Block/flow suggestions match
  // if the cursor is inside the range.
  return list.find((s) => {
    if (s.scope === "block" || s.scope === "flow") {
      return s.range.start.line <= line && line <= s.range.end.line;
    }
    return s.range.start.line === line;
  });
}

/**
 * Dismiss a suggestion by URI + line. Removes the matching finding from
 * the shared store and fires the change event so every subscribed
 * surface (Ghost CodeLens, Underline Whisper, Inlay hint) rerenders
 * without it. Called from the CodeLens "Dismiss" button.
 *
 * Returns true if anything was actually removed. A future tier can
 * persist the dismissal as a session-level snooze so the next scan
 * doesn't immediately re-surface the same (ruleId, line).
 */
/**
 * Mark a finding as "fix in progress" — removes it from the store
 * immediately and blocks re-ingestion for PENDING_FIX_TTL_MS. Called
 * when the user clicks Apply fix so the CodeLens disappears instantly
 * and doesn't flicker back while Claude is still running its tool loop.
 *
 * Unlike `dismissSuggestionAtLine`, this is TIME-BOUNDED: after the
 * TTL, the block lifts. If the fix actually worked, the scan won't
 * re-add the finding (nothing to add). If the fix didn't work, the
 * finding comes back — which is the honest signal that the fix failed.
 */
export function markFixPending(uri: string, line: number): boolean {
  const list = suggestionsByUri.get(uri);
  if (!list || list.length === 0) return false;

  const removed: Suggestion[] = [];
  const next = list.filter((s) => {
    const match =
      s.scope === "block" || s.scope === "flow"
        ? s.range.start.line <= line && line <= s.range.end.line
        : s.range.start.line === line;
    if (match) {
      removed.push(s);
      return false;
    }
    return true;
  });
  if (removed.length === 0) return false;

  const pending = pendingFixByUri.get(uri) ?? new Map();
  for (const s of removed) {
    const key = keyOf(s);
    // If a timer is already running for this key, reset it.
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const cur = pendingFixByUri.get(uri);
      if (cur) {
        cur.delete(key);
        if (cur.size === 0) pendingFixByUri.delete(uri);
      }
      // Nothing else to do — next scan will legitimately re-add the
      // finding if the issue still exists. No forced refresh here to
      // avoid a surprise re-appearance when the user isn't looking.
    }, PENDING_FIX_TTL_MS);
    pending.set(key, timer);
  }
  pendingFixByUri.set(uri, pending);

  if (next.length === 0) suggestionsByUri.delete(uri);
  else suggestionsByUri.set(uri, next);
  scanChangeEmitter.fire(uri);
  return true;
}

export function dismissSuggestionAtLine(uri: string, line: number): boolean {
  const list = suggestionsByUri.get(uri);
  if (!list || list.length === 0) return false;

  const removed: Suggestion[] = [];
  const next = list.filter((s) => {
    const match =
      s.scope === "block" || s.scope === "flow"
        ? s.range.start.line <= line && line <= s.range.end.line
        : s.range.start.line === line;
    if (match) {
      removed.push(s);
      return false;
    }
    return true;
  });
  if (removed.length === 0) return false;

  // Record the dismissed keys so the next re-ingestion (LIVE rescan or
  // SAVE/IDLE merge) filters them back out instead of re-surfacing.
  const dismissed = dismissedByUri.get(uri) ?? new Set<string>();
  for (const s of removed) dismissed.add(keyOf(s));
  dismissedByUri.set(uri, dismissed);

  if (next.length === 0) suggestionsByUri.delete(uri);
  else suggestionsByUri.set(uri, next);
  scanChangeEmitter.fire(uri);
  return true;
}

/**
 * Merge findings from a higher-tier scanner (SAVE / IDLE) into the same
 * store the Ghost + Whisper read from. Higher-tier findings dedup by
 * `(uri, ruleId, line)` so a SAVE block-scope finding doesn't collide with
 * an atom finding the LIVE scanner already produced.
 *
 * Rule precedence (higher wins): flow > block > atom.
 */
export function ingestFindings(uri: string, findings: Suggestion[]): void {
  if (findings.length === 0) {
    // Even empty updates fire the change event so observers (Ghost / flows
    // counter / etc.) can refresh their state.
    scanChangeEmitter.fire(uri);
    return;
  }

  const SCOPE_WEIGHT: Record<NonNullable<Suggestion["scope"]>, number> = {
    atom: 0,
    block: 1,
    flow: 2,
  };
  const weight = (s: Suggestion) => SCOPE_WEIGHT[s.scope ?? "atom"];

  const existing = suggestionsByUri.get(uri) ?? [];
  const byKey = new Map<string, Suggestion>();
  for (const s of existing) {
    byKey.set(keyOf(s), s);
  }
  const dismissed = dismissedByUri.get(uri) ?? new Set<string>();
  const pending = pendingFixByUri.get(uri);
  // Snapshot file size ONCE for the whole batch — calling getText() per
  // finding is wasteful, and all findings in one ingestion correspond
  // to the same point-in-time document state anyway.
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri
  );
  const fileSize = doc?.getText().length ?? 0;
  let gateDropped = 0;
  // Two-pass (same reasoning as runReview's merge): filter first, arm
  // cooldowns second. Prevents the first finding of a repeated ruleId
  // in a batch from silencing the rest.
  const acceptedForCooldown: Suggestion[] = [];
  for (const s of findings) {
    const key = keyOf(s);
    // Respect dismissals across tiers — if the user hid it from LIVE,
    // SAVE/IDLE shouldn't smuggle it back in under a block/flow scope.
    if (dismissed.has(key)) continue;
    // Same for in-flight fixes — block block/flow re-surfacing until TTL.
    if (pending?.has(key)) continue;
    // Finding gate (A1+B1): if the user is mid-edit on this line, the
    // cursor is parked near it, or the ruleId is on cooldown, drop it.
    // Same reasoning as the LIVE merge loop — don't pollute the store.
    if (gateShouldSuppress(uri, s)) { gateDropped++; continue; }
    const prior = byKey.get(key);
    if (!prior || weight(s) >= weight(prior)) {
      byKey.set(key, s);
      acceptedForCooldown.push(s);
    }
  }
  for (const s of acceptedForCooldown) {
    gateNoteFindingShown(uri, s, fileSize);
  }
  if (gateDropped > 0) {
    log(
      "liveReview",
      `ingest gate-dropped ${gateDropped} finding(s) for ${uri.split(/[\\/]/).pop() ?? uri}`
    );
  }
  suggestionsByUri.set(uri, [...byKey.values()]);
  scanChangeEmitter.fire(uri);
}

function keyOf(s: Suggestion): string {
  return `${s.ruleId}@${s.range.start.line}`;
}

export function titleForRule(
  ruleId: string,
  severity: "warn" | "perf" | "info"
): string {
  const clean = ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const prefix = severity === "warn" ? "Potential bug" : severity === "perf" ? "Perf hit" : "Heads up";
  return `${prefix} — ${clean}`;
}
