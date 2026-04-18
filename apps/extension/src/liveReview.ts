import * as vscode from "vscode";
import type { HostToWebview } from "@protege/types";
import { reviewDocument, type Suggestion } from "./reviewEngine.js";
import { renderProtegeHover, type HoverKind } from "./hoverTemplate.js";
import { log } from "./log.js";

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
let currentSuggestions: Suggestion[] = [];
let scanSeq = 0;
let pendingChangeSize = 0;
let lastScannedText: string | null = null;
let isScanning = false;

// Per-URI cache so the InlayHintsProvider can respond to VS Code's pulls
const suggestionsByUri = new Map<string, Suggestion[]>();

const DEBOUNCE_MS = 3_000;
const MIN_CHANGE_CHARS = 4;
const HEALTH_CHECK_MS = 60_000;

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

    return list.map((s) => {
      const line = Math.min(doc.lineCount - 1, s.range.start.line);
      const lineText = doc.lineAt(line).text;
      const position = new vscode.Position(line, lineText.length);

      const label = `  💡 Protege`;
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
    item.text = "$(sync~spin) Protege · scanning…";
    item.tooltip = "Protege is reviewing this file with AI";
  } else {
    const count = currentSuggestions.length;
    item.text = count > 0
      ? `$(eye) Protege Live · ${count} issue${count === 1 ? "" : "s"}`
      : "$(eye) Protege Live";
    item.tooltip = "Live code review is ON — click to stop";
  }
  item.show();
}

function broadcastState(): void {
  try {
    const { broadcast } = require("./webviewHost.js") as {
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

function notifyLiveReviewOn(): void {
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
    lastScannedText = null;
    pendingChangeSize = Infinity;
    void runReview(editor);
  });

  if (vscode.window.activeTextEditor) {
    pendingChangeSize = Infinity;
    void runReview(vscode.window.activeTextEditor);
  }

  healthTimer = setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor && active && !isScanning) {
      pendingChangeSize = Infinity;
      void runReview(editor);
    }
  }, HEALTH_CHECK_MS);

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

  scanSeq++;
  isScanning = false;

  // Clear decorations everywhere
  for (const editor of vscode.window.visibleTextEditors) {
    if (gutterWarn) editor.setDecorations(gutterWarn, []);
    if (gutterPerf) editor.setDecorations(gutterPerf, []);
    if (gutterInfo) editor.setDecorations(gutterInfo, []);
  }
  suggestionsByUri.clear();
  inlayProvider?.refresh();

  currentSuggestions = [];

  updateStatusBar();
  broadcastState();
  notifyLiveReviewOff();
}

async function runReview(editor: vscode.TextEditor): Promise<void> {
  if (!active) return;

  const text = editor.document.getText();
  if (pendingChangeSize < MIN_CHANGE_CHARS && text === lastScannedText) {
    return;
  }
  if (isScanning) return;

  pendingChangeSize = 0;
  lastScannedText = text;

  const mySeq = ++scanSeq;
  const cancelSignal = { cancelled: false };

  isScanning = true;
  updateStatusBar();
  broadcastState();

  const scanFile = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
  log("liveReview", `LIVE tier → reviewDocument ${scanFile} (seq ${mySeq})`);

  let raw: Suggestion[] = [];
  try {
    raw = await reviewDocument(editor.document, cancelSignal);
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

  // NOTE: we intentionally do NOT dedup live review against TS/cSpell.
  // The inlay hint hover is an isolated surface (separate hover target from
  // the code), so our popup never stacks with theirs. Users get:
  //   hover code  → TS/cSpell/Cursor
  //   hover `💡 Protege` inlay → ONLY Protege, clean.
  const suggestions = raw;

  isScanning = false;
  currentSuggestions = suggestions;

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
  for (const s of suggestions) {
    const k = `${s.ruleId}@${s.range.start.line}`;
    if (!reserved.has(k)) {
      merged.push(s);
      reserved.add(k);
    }
  }
  suggestionsByUri.set(key, merged);
  log(
    "liveReview",
    `LIVE merged ${scanFile} · raw=${suggestions.length} keepers=${keepers.length} stored=${merged.length}`
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
  for (const s of findings) {
    const key = keyOf(s);
    const prior = byKey.get(key);
    if (!prior || weight(s) >= weight(prior)) {
      byKey.set(key, s);
    }
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
