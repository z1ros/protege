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

/** Whole-line wash for any line a Protege finding lands on. Subtle
 *  electric tint so the user gets a visible "something here" cue
 *  without the line looking like a syntax error. Created lazily once
 *  registerLiveReview gets called. */
let lineHighlight: vscode.TextEditorDecorationType | null = null;

function initGutterDecorations(_context: vscode.ExtensionContext) {
  if (!lineHighlight) {
    lineHighlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // White wash, not blue. Blue read as "selected" or "linked" — too
      // close to the editor's own selection/link colors, which made the
      // finding line ambiguous. Plain white at low alpha reads as a
      // neutral "something here" cue regardless of theme. Border kept
      // for the gutter cue but stripped of hue.
      backgroundColor: "rgba(255, 255, 255, 0.07)",
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      borderColor: "rgba(255, 255, 255, 0.6)",
      overviewRulerColor: "rgba(255, 255, 255, 0.6)",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }
}

/** Suggestions visible to the user — same filter the inlay + CodeLens
 *  providers apply. Findings already covered by a native (TS / ESLint /
 *  cSpell) squiggle and findings suppressed by the finding gate (line
 *  recently edited, cursor near, ruleId on cooldown) are dropped here so
 *  every renderable surface paints from the same set. Without this, the
 *  line-wash painted on suggestions that the CodeLens provider then
 *  filtered out — leaving a "naked" highlight with no lens row above it. */
function visibleSuggestionsForUri(
  uri: vscode.Uri,
  list: Suggestion[]
): Suggestion[] {
  const uriKey = uri.toString();
  return list.filter((s) => {
    const rangeHasNative =
      s.scope === "block" || s.scope === "flow"
        ? hasNativeDiagnosticInRange(uri, s.range)
        : hasNativeDiagnosticOnLine(uri, s.range.start.line);
    if (rangeHasNative) return false;
    if (gateShouldSuppress(uriKey, s)) return false;
    return true;
  });
}

/** Paint / clear the line-highlight decoration for an editor based on
 *  its current Protege findings. Cleared when there are no findings or
 *  Live Review is off. Called from refreshAllSurfaces and on tab switch. */
function paintLineHighlights(editor: vscode.TextEditor): void {
  if (!lineHighlight) return;
  if (!active) {
    editor.setDecorations(lineHighlight, []);
    return;
  }
  const list = suggestionsByUri.get(editor.document.uri.toString());
  if (!list || list.length === 0) {
    editor.setDecorations(lineHighlight, []);
    return;
  }
  // Match the inlay + CodeLens filter so the wash is never painted on a
  // line that won't get a lens row above it.
  //
  // Plus a severity floor: only `warn` and `perf` findings get the
  // full-line wash. `info` (teaching tips, "did-you-know" patterns) keep
  // a CodeLens row — clickable, dismissible — but no full-line attention
  // grab. This is the "be quieter for non-bugs" pass: the editor stays
  // calm, but the teaching content is still one click away.
  const filtered = visibleSuggestionsForUri(editor.document.uri, list).filter(
    (s) => s.severity === "warn" || s.severity === "perf"
  );
  if (filtered.length === 0) {
    editor.setDecorations(lineHighlight, []);
    return;
  }
  const ranges: vscode.Range[] = filtered.map((s) => {
    const line = Math.max(
      0,
      Math.min(editor.document.lineCount - 1, s.range.start.line)
    );
    return new vscode.Range(line, 0, line, 0);
  });
  try {
    editor.setDecorations(lineHighlight, ranges);
  } catch {
    /* editor disposed mid-paint */
  }
}

// ---- State ----

let active = false;
let changeListener: vscode.Disposable | null = null;
let editorListener: vscode.Disposable | null = null;
let windowStateListener: vscode.Disposable | null = null;
let gateSubscription: vscode.Disposable | null = null;
let idleScanTimer: ReturnType<typeof setTimeout> | null = null;
// Pending cloud-refinement timer for the hybrid Live Review pipeline.
// Set after phase-1 (cheap nano scan) finds something; clears when it
// fires or when a fresh phase-1 supersedes it. Single-flight per active
// editor — multiple files in rapid tab-switch reset, not stack.
let cloudRefineTimer: ReturnType<typeof setTimeout> | null = null;
// Signature of the most recent phase-2 cloud-refine input, keyed per
// URI. If a fresh phase-1 returns the SAME set of findings (same rule
// IDs at the same lines), skipping phase-2 saves a cloud call —
// re-refining identical signal would just produce identical output.
const lastRefinedSignatureByUri = new Map<string, string>();
// Polished findings from the most recent successful phase-2 cloud
// refine, keyed per URI. When sig dedup decides to skip phase-2,
// phase-1's rough findings have already been written to the store —
// but the polished version we already produced last time is strictly
// better. Restore it here so the user keeps seeing polished findings
// even after phase-1 re-runs on the same signal. Cleared on Live
// Review stop and any time text actually changes.
const lastRefinedFindingsByUri = new Map<string, Suggestion[]>();

// ---- Tier-learning blocklist ----
// Per-URI set of ruleIds that the cloud refinement step has rejected as
// false positives at least once this session. Phase-1 findings matching
// any blocklisted ruleId are filtered out BEFORE phase-2 fires — so we
// never pay to validate the same false positive twice.
//
// Phase-1 (cheap nano scan) is permissive by design ("is there anything
// weird here?"); phase-2 is the strict editor. This map is the feedback
// channel: phase-2's rejections train the orchestrator to ignore that
// ruleId on this file for the rest of the session. Resets on Live
// Review stop / window reload.
//
// Scope choice: ruleId+URI, not ruleId+line. If phase-2 says "prefer-const
// is a false positive on this file" (e.g. the binding really IS reassigned
// elsewhere), we don't want phase-1 flagging the same rule on a different
// line of the same file 30 seconds later.
const rejectedRuleIdsByUri = new Map<string, Set<string>>();

function findingsSignature(findings: Suggestion[]): string {
  return findings
    .map((s) => `${s.ruleId}@${s.range.start.line}`)
    .sort()
    .join("|");
}
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

// Idle-typing window. Phase-1 scan fires after IDLE_SCAN_MS of no
// keystrokes — long enough that you've genuinely paused (reading what
// you wrote, stuck, moved attention), short enough to feel real-time on
// a typist who pauses regularly. Phase-1 hits cloud nano (~$0.0002/scan)
// gated by autoBudgetPerHour.
const IDLE_SCAN_MS = 20_000;
// Phase-2 (cloud refinement) fires CLOUD_REFINE_DELAY_MS after a phase-1
// pass that returned >= 1 finding. The delay lets the user keep typing
// without immediately burning a cloud call on a transient state. Each
// new phase-1 pass that finds something resets this timer, so a steady
// stream of dirty edits collapses to one cloud call per ~minute, not
// one per pause.
const CLOUD_REFINE_DELAY_MS = 60_000;
// Per-keystroke micro-edits don't count — the runReview dedup at entry
// also skips if the doc text hasn't changed materially since the last
// scan. 30 chars ≈ a meaningful token, not a typo correction.
const MIN_CHANGE_CHARS = 30;

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

    // Same dedup the inlay used: skip findings already covered by TS /
    // ESLint native diagnostics, and findings the gate is suppressing
    // (line recently edited, ruleId on cooldown). Otherwise the user
    // sees double-rendered lints.
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

    // CodeLens row (left → right):
    //   1. Short explanation of the issue — clickable, opens a hover
    //      popup at that line with the full why + fix preview.
    //      No severity icon, no "Protege ·" prefix — just the
    //      explanation reads as the lens.
    //   2. `✿ Teach me`  — opens the full lesson in chat.
    //   3. `✔ Apply fix` — runs the smart-fix tool loop (only when
    //      the suggestion has a fix string).
    //   4. `✘ Dismiss`   — removes the finding from this session.
    // Unicode glyphs (NOT emoji): ✿ U+273F, ✔ U+2714, ✘ U+2718.
    return filtered.flatMap((s) => {
      const line = Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line));
      const range = new vscode.Range(line, 0, line, 0);
      const uri = doc.uri.toString();
      const explanation = lensExplanation(s);
      // Match the `Finding` shape the chat-side teachFinding handler in
      // App.tsx reads (`type`, `title`, `line`, `explanation`). Without
      // these, the prompt builder substituted `undefined` everywhere and
      // the resulting chat message read "I saw a undefined on line 10:
      // undefined" — the AI then probed for context instead of teaching
      // the actual concept. The extra fields (currentLine, lang) carry
      // the actual code so the prompt can quote it; the AI then has
      // enough to spot small adjacent issues (let vs const, etc.).
      const findingType: "bug" | "performance" | "tip" =
        s.severity === "warn"
          ? "bug"
          : s.severity === "perf"
            ? "performance"
            : "tip";
      const teachArgs = {
        type: findingType,
        title: titleForRule(s.ruleId, s.severity).trim(),
        line: line + 1,
        explanation: s.message,
        ruleId: s.ruleId,
        message: s.message,
        uri,
        currentLine: doc.lineAt(line).text.trim(),
        lang: doc.languageId,
      };

      const lenses: vscode.CodeLens[] = [
        new vscode.CodeLens(range, {
          title: explanation,
          tooltip: "Click for the full explanation and fix preview",
          command: "protege.showFindingPopup",
          arguments: [{ uri, line }],
        }),
        new vscode.CodeLens(range, {
          title: "✿ Teach me",
          tooltip: "Open the full lesson in chat",
          command: "protege.teachFinding",
          arguments: [teachArgs],
        }),
      ];
      if (s.fix) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "✔ Apply fix",
            tooltip: "Apply Protege's fix to this line",
            command: "protege.smartFix",
            arguments: [{ uri, line }],
          })
        );
      }
      lenses.push(
        new vscode.CodeLens(range, {
          title: "✘ Dismiss",
          tooltip: "Hide this finding",
          command: "protege.dismissFinding",
          arguments: [{ uri, ruleId: s.ruleId, line }],
        })
      );
      return lenses;
    });
  }
}

/** Build the short single-line explanation that becomes the CodeLens
 *  status. Prefer the rule's curated title when available (it's
 *  written human-friendly), then fall back to the model's `message`
 *  trimmed to one sentence. Capped so the row never wraps. */
function lensExplanation(s: Suggestion): string {
  const title = titleForRule(s.ruleId, s.severity).trim();
  const msg = (s.message ?? "").trim();
  let body = title;
  // If the title is a generic category ("Heads up", "Potential bug",
  // "Perf hit") and the message has more substance, use the message
  // instead so the lens actually communicates *what's wrong*, not
  // just *that* something is wrong.
  const genericTitles = new Set(["Heads up", "Potential bug", "Perf hit"]);
  if (msg && (genericTitles.has(title) || msg.length > title.length + 6)) {
    body = msg;
  }
  // First sentence only — keep the lens row tight.
  const firstSentence = body.split(/(?<=[.!?])\s+/)[0] ?? body;
  // Hard cap so very long messages don't push other lenses off-screen.
  // Tightened from 90 → 55 — the prior limit ate ~70% of the editor row
  // and crowded the action buttons. The full text is one click away via
  // the "showFindingPopup" hover, so the lens just needs to read as a
  // glance-sized headline.
  return firstSentence.length > 55
    ? firstSentence.slice(0, 52) + "…"
    : firstSentence;
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
  liveCodeLensProvider?.refresh();
  // Repaint the whole-line wash on every visible editor that's looking
  // at a tracked file. Cheap (just setDecorations with the cached
  // ranges) so safe to fire from every refresh callsite.
  for (const ed of vscode.window.visibleTextEditors) {
    paintLineHighlights(ed);
  }
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

  // Idle-typing review (2026-04-29 v2). We tried "every 12s of typing
  // pause" (too noisy, shoulder-leaning) and "save only" (too quiet for
  // users who don't ⌘S). Final shape: scan after IDLE_SCAN_MS of typing
  // inactivity. Hits the configured cloud provider and is gated by the
  // autoBudgetPerHour cap (default 30/h = ~$0.96/mo ceiling on cheap-tier).
  //
  // No save trigger — saves are an implementation detail of typists who
  // happen to ⌘S; not a UX signal.
  changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || e.document !== editor.document) return;
    for (const c of e.contentChanges) {
      pendingChangeSize += Math.max(c.text.length, c.rangeLength);
    }
    // Reset the idle timer on every keystroke. The scan only fires
    // after IDLE_SCAN_MS of no further edits — i.e. you stopped typing
    // for long enough that you're reading, thinking, or moved on. The
    // 60s health-recheck retired with continuous scans, so the runReview
    // dedup at entry handles "same content, skip" by itself.
    if (idleScanTimer) clearTimeout(idleScanTimer);
    idleScanTimer = setTimeout(() => {
      idleScanTimer = null;
      if (!active) return;
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document !== e.document) return;
      log(
        "liveReview",
        `LIVE idle ${IDLE_SCAN_MS / 1000}s · ${e.document.fileName.split(/[\\/]/).pop()}`
      );
      void runHybridScan(ed);
    }, IDLE_SCAN_MS);
  });

  editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    // Skip virtual documents (output channels, settings UI, etc.) —
    // they're not user code, scanning them is pointless and burns
    // tokens on guaranteed-bad findings. Only file:// schemes count.
    // runReview also defends against this, but bailing here saves the
    // tab-switch log line + cache check for noise that doesn't matter.
    if (editor.document.uri.scheme !== "file") return;
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
    log(
      "liveReview",
      `LIVE tab-switch · ${editor.document.fileName.split(/[\\/]/).pop()}`
    );
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
      log(
        "liveReview",
        `LIVE startup · ${editor.document.fileName.split(/[\\/]/).pop()}`
      );
      void runReview(editor);
    }
  }

  // When the IDE regains focus (user alt-tabbed back from a browser /
  // Slack / terminal), fire a single rescan of the active file. This
  // pairs with the focus gate at runReview entry: while the user was
  // away every debounce + health tick no-op'd, so anything that
  // changed externally (git pull, formatter on save, the file content
  // shifted) needs one fresh scan to catch up. Losing focus disposes
  // nothing — the existing listeners stay live and just keep skipping
  // until focus comes back. Pending edits during the unfocused window
  // count: we treat a refocus as if the user just paused typing, so
  // the freshest content gets reviewed without waiting another 7s.
  windowStateListener = vscode.window.onDidChangeWindowState((s) => {
    if (!active || !s.focused) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    log("liveReview", "LIVE refocus · firing catch-up scan");
    void runReview(editor);
  });

  // Gate-change re-renders cover the only repaint path that matters:
  // when a touched line's recency window expires, findingGate fires
  // and the cached suggestions repaint with their now-cleared gate
  // state. No interval timer — without continuous typing scans there's
  // nothing to safety-net.
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

  changeListener?.dispose();
  changeListener = null;
  editorListener?.dispose();
  editorListener = null;
  windowStateListener?.dispose();
  windowStateListener = null;
  gateSubscription?.dispose();
  gateSubscription = null;
  if (idleScanTimer) {
    clearTimeout(idleScanTimer);
    idleScanTimer = null;
  }
  if (cloudRefineTimer) {
    clearTimeout(cloudRefineTimer);
    cloudRefineTimer = null;
  }
  lastRefinedSignatureByUri.clear();
  lastRefinedFindingsByUri.clear();
  rejectedRuleIdsByUri.clear();

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

/**
 * Hybrid Live Review — the "wide-net then refine" path.
 *
 * Phase 1 (always): scan via cloud cheap-tier (gpt-5-nano). Wide-net
 *   prompt against the full file. Cheap (~$0.0002/scan) — used to
 *   identify whether there's anything teachable here at all.
 * Phase 2 (only if phase 1 returned ≥ 1 finding): schedule a cloud
 *   refinement CLOUD_REFINE_DELAY_MS later. Same nano model, but with
 *   a narrow refinement prompt over only the candidate ranges
 *   (~75% smaller context). Produces polished teaching-quality
 *   findings that overwrite the phase-1 rough ones.
 *
 * Cost shape: a "clean code" 20s-pause scan still stays cheap
 * (~$0.0002 for the phase-1 nano call). Phase-2 only fires when
 * phase 1 found candidates AND no signature dedup hit, so most
 * scans are phase-1 only.
 *
 * Falls back gracefully:
 *   - cloud unreachable → both phases fail silently; surfaces stay
 *     stable on whatever findings we last had.
 */
async function runHybridScan(editor: vscode.TextEditor): Promise<void> {
  const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
  const uriKey = editor.document.uri.toString();

  log("liveReview", `[HYBRID] ▸ phase-1 starting · ${fileName} · backend=NANO cloud (cheap-tier via kind:scan)`);
  const phase1 = await runReview(editor, { forceBackend: "cloud" });

  // Phase 1 didn't actually run an LLM call — distinguish the cases for
  // honest logging. "SCAN clean" should mean "phase-1 ran and saw nothing
  // teachable", not "we never even tried."
  if (phase1.skipReason) {
    log(
      "liveReview",
      `[HYBRID] ▸ phase-1 not run · reason=${phase1.skipReason} · CLOUD also skipped`
    );
    return;
  }

  if (phase1.findingsStored === 0) {
    log("liveReview", `[SCAN]   ✓ clean · ${fileName} · no findings · CLOUD skipped (saved ~$0.0008)`);
    if (cloudRefineTimer) {
      clearTimeout(cloudRefineTimer);
      cloudRefineTimer = null;
    }
    return;
  }

  // Apply the session blocklist — drop phase-1 findings whose ruleId
  // cloud has already rejected on this URI. This is the cost-saving
  // half of the tier-learning loop: false positives phase-1 detected
  // get filtered before they trigger a redundant cloud refinement.
  const blocklist = rejectedRuleIdsByUri.get(uriKey) ?? new Set<string>();
  const surviving = phase1.findings.filter((f) => !blocklist.has(f.ruleId));
  const blocked = phase1.findings.length - surviving.length;
  if (blocked > 0) {
    const blockedRules = phase1.findings
      .filter((f) => blocklist.has(f.ruleId))
      .map((f) => f.ruleId);
    log(
      "liveReview",
      `[SCAN]   ✗ filtered ${blocked} finding(s) · ruleIds=[${[...new Set(blockedRules)].join(", ")}] · previously rejected by CLOUD`
    );
  }

  log(
    "liveReview",
    `[SCAN]   ✓ found ${surviving.length} · ${fileName} · ${surviving
      .map((f) => `${f.ruleId}@L${f.range.start.line + 1}`)
      .join(", ")}`
  );

  if (surviving.length === 0) {
    log("liveReview", `[HYBRID] ▸ all phase-1 findings blocklisted — CLOUD skipped`);
    return;
  }

  // Dedup: if the surviving findings exactly match what we last
  // refined, re-refining would just produce identical output.
  const sig = findingsSignature(surviving);
  const lastSig = lastRefinedSignatureByUri.get(uriKey);
  if (sig === lastSig) {
    log(
      "liveReview",
      `[HYBRID] ▸ phase-1 same as last cloud refine — CLOUD skipped (saved ~$0.0008)`
    );
    if (cloudRefineTimer) {
      clearTimeout(cloudRefineTimer);
      cloudRefineTimer = null;
    }
    // Phase 1 just overwrote the store with rough findings. The
    // polished version we already produced last time is strictly
    // better — restore it so the user doesn't see findings degrade
    // after the second phase-1 pass on identical signal.
    const polished = lastRefinedFindingsByUri.get(uriKey);
    if (polished && polished.length > 0) {
      suggestionsByUri.set(uriKey, polished);
      currentSuggestions = polished;
      log(
        "liveReview",
        `[HYBRID] ▸ restored ${polished.length} polished finding${polished.length === 1 ? "" : "s"} from last refine`
      );
      refreshAllSurfaces();
      updateStatusBar();
      broadcastState();
    }
    return;
  }

  log(
    "liveReview",
    `[HYBRID] ▸ scheduling phase-2 CLOUD refine in ${CLOUD_REFINE_DELAY_MS / 1000}s`
  );
  if (cloudRefineTimer) clearTimeout(cloudRefineTimer);
  cloudRefineTimer = setTimeout(async () => {
    cloudRefineTimer = null;
    if (!active) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    if (ed.document.uri.toString() !== uriKey) {
      log("liveReview", `[HYBRID] ▸ user switched files · CLOUD skipped`);
      return;
    }
    log(
      "liveReview",
      `[CLOUD]  ▸ phase-2 firing · ${fileName} · refining ${surviving.length} candidate${surviving.length === 1 ? "" : "s"} (narrow context, ~75% smaller prompt)`
    );
    lastRefinedSignatureByUri.set(uriKey, sig);
    const phase2 = await runReview(ed, {
      forceBackend: "cloud",
      candidates: surviving,
    });

    // Tier-learning: any candidate whose ruleId did not survive cloud
    // refinement is a confirmed false positive. Add to the per-URI
    // blocklist so the next phase-1 pass on this file filters it out
    // before scheduling another cloud call.
    //
    // Safeguard: only update the blocklist when phase-2 returned ≥ 1
    // finding. A 0-finding response is ambiguous — it could mean "cloud
    // rejected everything" (legit, would warrant blocklisting) OR the
    // model returned malformed JSON / the network call failed (parse
    // returned null → reviewDocument returned []). We can't distinguish
    // those cases at this layer, so we conservatively skip blocklist
    // updates when the result is empty. The "all legitimately rejected"
    // case still self-heals via the phase-1 signature dedup above —
    // the next identical phase-1 output will short-circuit at "same as
    // last refine" without firing another cloud call.
    if (phase2.findings.length === 0) {
      log(
        "liveReview",
        `[CLOUD]  ▸ phase-2 returned 0 findings · blocklist NOT updated (ambiguous: all-rejected vs parse-fail)`
      );
      return;
    }
    // Save the polished findings so the dedup-skip path in a future
    // phase-1 pass can restore them (instead of leaving the store with
    // rough phase-1 output after phase-1 overwrites it).
    lastRefinedFindingsByUri.set(uriKey, phase2.findings);

    const survivedRuleIds = new Set(phase2.findings.map((f) => f.ruleId));
    const rejectedRuleIds = surviving
      .map((f) => f.ruleId)
      .filter((id) => !survivedRuleIds.has(id));
    if (rejectedRuleIds.length > 0) {
      const set = rejectedRuleIdsByUri.get(uriKey) ?? new Set<string>();
      for (const id of rejectedRuleIds) set.add(id);
      rejectedRuleIdsByUri.set(uriKey, set);
      log(
        "liveReview",
        `[CLOUD]  ▸ rejected ${rejectedRuleIds.length} false positive${rejectedRuleIds.length === 1 ? "" : "s"} · blocklisted for ${fileName}: [${[...new Set(rejectedRuleIds)].join(", ")}]`
      );
    } else {
      log("liveReview", `[CLOUD]  ▸ all ${surviving.length} candidates validated — none blocklisted`);
    }
  }, CLOUD_REFINE_DELAY_MS);
}

/** Why a scan attempt was short-circuited before reaching the LLM. The
 *  orchestrator uses this to log accurately — "phase-1 actually scanned
 *  and found nothing" vs "we never ran phase-1 at all because cache hit /
 *  focus was off / etc." are different things and the user wants to see
 *  which. */
type ScanSkipReason =
  | "inactive"
  | "unfocused"
  | "non-file"
  | "cache-identical"
  | "cache-threshold"
  | "is-scanning"
  | "mid-edit";

async function runReview(
  editor: vscode.TextEditor,
  opts: {
    forceBackend?: import("../ai/aiBackend.js").AiBackend;
    /** When provided, use the refinement prompt path: model validates +
     *  polishes these specific findings instead of scanning from scratch.
     *  Phase-2 of the hybrid pipeline passes phase-1's findings here so
     *  the cloud sees only the relevant lines, not the whole file. */
    candidates?: Suggestion[];
  } = {}
): Promise<{
  findingsStored: number;
  findings: Suggestion[];
  /** Set when the LLM call was never made (cache, focus, mid-edit, etc.).
   *  Absent means an LLM call actually ran. */
  skipReason?: ScanSkipReason;
}> {
  const NONE = { findingsStored: 0, findings: [] as Suggestion[] };
  if (!active) return { ...NONE, skipReason: "inactive" as const };

  // Window-focus gate: skip scans when the user isn't looking at the
  // IDE. Critical for keeping cloud-scan budget honest (we don't want
  // for ~5s — running it while the user is in a browser tab is a
  // gratuitous battery drain), but also right for cloud (no point
  // billing tokens for a user who isn't reading findings anyway).
  // The debounce + health timer keep firing in the background; this
  // gate just makes them no-op until the window regains focus, at
  // which point a fresh scan fires from the focus listener below.
  if (!vscode.window.state.focused) {
    const name = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
    log("liveReview", `LIVE skip · window unfocused · ${name}`);
    return { ...NONE, skipReason: "unfocused" };
  }

  // Non-file URIs are virtual documents — VS Code's own output channels
  // (scheme="output"), extension output (scheme="extension-output"),
  // settings UI, debug consoles, vscode-userdata, etc. They're not user
  // code; scanning them costs LLM tokens for guaranteed-bad findings
  // (model invents issues, anchor reconciler then drops them). Bail
  // before any LLM call. Only `file://` documents are user code.
  if (editor.document.uri.scheme !== "file") {
    log(
      "liveReview",
      `LIVE skip · non-file scheme="${editor.document.uri.scheme}" · ${editor.document.fileName.split(/[\\/]/).pop() ?? "file"}`
    );
    return { ...NONE, skipReason: "non-file" };
  }

  const text = editor.document.getText();
  const uriKey = editor.document.uri.toString();
  const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
  const isRefinement = !!(opts.candidates && opts.candidates.length > 0);
  const backendLabel = isRefinement ? "CLOUD-REFINE" : "SCAN";

  // Refinement mode skips both cache layers below. Phase 1 just stamped
  // lastScannedTextByUri[uri] = text before its own LLM call, so the
  // cache hit check would otherwise immediately short-circuit phase 2 —
  // it would NEVER fire unless the user kept typing during the 60s wait.
  // Refinement is always intentional ("validate these candidates"); it's
  // never a duplicate scan worth deduplicating.
  const lastTextForUri = lastScannedTextByUri.get(uriKey);
  if (!isRefinement) {
    // ---- Cache layer 1: per-URI text identity ----
    // If THIS file's content matches what we last scanned for it, skip
    // the LLM call entirely. Catches: undo-redo cycles back to a clean
    // state, formatter ran + reverted, file restored from disk,
    // identical re-scans triggered by multiple paths (idle + tab-switch
    // racing).
    if (text === lastTextForUri) {
      log(
        "liveReview",
        `[CACHE] hit · ${fileName} · content unchanged · skipping ${backendLabel} call`
      );
      pendingChangeSize = 0;
      return { ...NONE, skipReason: "cache-identical" };
    }

    // ---- Cache layer 2: min-change threshold ----
    // If we've already scanned this URI at least once and the
    // accumulated edits since then are below MIN_CHANGE_CHARS, skip —
    // typo corrections and micro-edits don't warrant a fresh LLM call.
    // The pendingChangeSize counter resets on every successful scan;
    // tab-switch and startup paths explicitly set it to Infinity to
    // bypass this gate (they always scan).
    //
    // Bug fix (2026-04-29): the prior version was gated by
    // `pendingChangeSize < N && text === lastScannedText`. That AND
    // clause is almost never true after a real edit, so the threshold
    // rarely actually skipped — which meant a 3-char typo correction
    // triggered a full LLM scan. Removing the AND restores the
    // intended behavior.
    if (lastTextForUri !== undefined && pendingChangeSize < MIN_CHANGE_CHARS) {
      log(
        "liveReview",
        `[CACHE] skip · ${fileName} · only ${pendingChangeSize}ch changed (< ${MIN_CHANGE_CHARS}ch threshold)`
      );
      return { ...NONE, skipReason: "cache-threshold" };
    }
  }

  if (isScanning) return { ...NONE, skipReason: "is-scanning" };

  // Mid-edit guard: if TS is currently reporting unresolved syntax (user
  // is halfway through typing a JSX tag, function body, etc.), skip this
  // scan. Running an LLM review on broken syntax produces phantom findings
  // AND costs tokens/time for zero useful output. We'll catch up on the
  // next debounce after TS stops complaining.
  if (isFileMidEdit(editor)) {
    const name = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
    log("liveReview", `LIVE skip ${name} — cursor near unresolved TS syntax (mid-edit)`);
    return { ...NONE, skipReason: "mid-edit" };
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
    // Pass the cursor line so the cloud prompt can focus its attention
    // on the window the user is actively editing.
    const activeLine = editor.selection.active.line;
    raw = await reviewDocument(
      editor.document,
      cancelSignal,
      activeLine,
      opts.candidates
    );
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
    return NONE;
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

  // Full replace per scan (2026-04-29). The prior version preserved
  // block/flow-scope keepers from older scans so SAVE/FLOW-tier findings
  // wouldn't get wiped by every LIVE pass. But that also kept findings
  // alive after the code they anchored to was deleted — "handleClick
  // loops 0..3" hanging above a return statement long after handleClick
  // was removed. Stale findings are a worse failure mode than briefly
  // missing a SAVE/FLOW finding (which the next FLOW/SAVE scan will
  // re-emit anyway). Each LIVE scan is now the source of truth for the
  // scopes it covers; dismiss + pending-fix are still respected.
  const key = editor.document.uri.toString();
  const merged: Suggestion[] = [];
  const reserved = new Set<string>();
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
    `LIVE merged ${scanFile} · raw=${suggestions.length} stored=${merged.length}${gateDropped > 0 ? ` · gate-dropped ${gateDropped}` : ""}`
  );
  // Editor UI paused — no inlay/codelens/gutter rendering. Sidebar still
  // receives suggestion state via broadcastState(). The Ambient Coach Strip
  // subscribes via onSuggestionsChanged() below.
  scanChangeEmitter.fire(key);

  updateStatusBar();
  broadcastState();
  return { findingsStored: liveAdded.length, findings: liveAdded };
}

// ---- Registration ----

export function registerLiveReview(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  initGutterDecorations(context);
  // 2026-04-28 swap: the right-side inlay hint had no actions, so
  // the user couldn't do anything with a flagged line. Replaced with
  // the original design — a multi-action CodeLens row ABOVE the line
  // (Protege · <title> · Explain · Fix it · Teach me) plus a subtle
  // whole-line wash so the eye lands on the right line. The inlay
  // class is kept in tree but no longer registered; flip the assignments
  // below if we ever want to A/B them again.
  inlayProvider = null;
  liveCodeLensProvider = new ProtegeLiveCodeLensProvider();

  const disposables: vscode.Disposable[] = [];

  // Register the CodeLens surface across all file-scheme docs so the
  // action row appears above any line that has a finding.
  disposables.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      liveCodeLensProvider
    )
  );

  // Hover provider — drives the popup that opens when the user
  // clicks the status CodeLens. We match findings by (line + rule)
  // and render the same MarkdownString `buildHover()` already
  // produces for the rest of the app.
  disposables.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        provideHover(doc, pos) {
          if (!active) return null;
          const list = suggestionsByUri.get(doc.uri.toString());
          if (!list || list.length === 0) return null;
          // Pick the finding whose primary line matches the hover
          // position. If multiple findings share a line (rare), the
          // first one wins — they all surface via the CodeLens row
          // anyway.
          const hit = list.find((s) => s.range.start.line === pos.line);
          if (!hit) return null;
          const md = buildHover(hit, doc);
          // Anchor the hover to the whole line so the popup stays
          // open while the user mouses across to its action buttons.
          const anchor = new vscode.Range(pos.line, 0, pos.line, doc.lineAt(pos.line).text.length);
          return new vscode.Hover(md, anchor);
        },
      }
    )
  );

  // Repaint line-highlight decoration when the active editor changes —
  // VS Code clears decorations when an editor unmounts, so without this
  // the wash disappears on tab switch even if findings are still cached.
  if (lineHighlight) {
    disposables.push(lineHighlight);
    disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) paintLineHighlights(editor);
      })
    );
  }

  disposables.push(
    vscode.commands.registerCommand("protege.toggleLiveReview", () => {
      if (active) {
        stopLiveReview();
      } else {
        startLiveReview();
      }
    })
  );

  // Status-lens click handler: jumps the cursor to the finding line
  // (so the hover popup anchors correctly) and triggers VS Code's
  // built-in showHover. Hover content comes from buildHover() above
  // — already includes the explanation, fix preview, and action row.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.showFindingPopup",
      async ({ uri, line }: { uri: string; line: number }) => {
        const docUri = vscode.Uri.parse(uri);
        const editor =
          vscode.window.activeTextEditor?.document.uri.toString() === uri
            ? vscode.window.activeTextEditor
            : await vscode.window.showTextDocument(docUri, { preserveFocus: false });
        if (!editor) return;
        const safeLine = Math.max(0, Math.min(editor.document.lineCount - 1, line));
        const pos = new vscode.Position(safeLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await vscode.commands.executeCommand("editor.action.showHover");
      }
    )
  );

  // Dismiss handler — drop one finding (matched by uri+ruleId+line)
  // from the in-memory store and refresh all surfaces. Lives only
  // for the session; on next scan the rule may resurface unless the
  // findingGate has separately suppressed it.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.dismissFinding",
      ({
        uri,
        ruleId,
        line,
      }: {
        uri: string;
        ruleId: string;
        line: number;
      }) => {
        const list = suggestionsByUri.get(uri);
        if (!list) return;
        const next = list.filter(
          (s) => !(s.ruleId === ruleId && s.range.start.line === line)
        );
        if (next.length === list.length) return;
        suggestionsByUri.set(uri, next);
        refreshAllSurfaces();
      }
    )
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
