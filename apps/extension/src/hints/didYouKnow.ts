import * as vscode from "vscode";
import { detectConcepts } from "../concepts/detector.js";
import { aiGenerateTip } from "../ai/aiExplain.js";
import { renderProtegeHover } from "./hoverTemplate.js";
import { fetchKnownConcepts } from "../user/protegeClient.js";
import { log } from "../log.js";

/**
 * "Did You Know?" — Protege's proactive teaching layer.
 *
 * At natural pause points (8s idle, file switch, save), Protege drops a
 * small lightbulb decoration next to the line where the relevant concept
 * lives. Hovering reveals a rich MarkdownString popover with the tip text
 * and "Learn more" / "Dismiss" actions — styled by us, non-modal, closes
 * when the user clicks away. Zero VS Code native notifications.
 *
 * Gated behind the Live Review toggle so one switch controls all visuals.
 */

// Background-only decoration — the `💡 tip` badge was a right-side
// italic after-tag, which looked interactive but wasn't clickable. The
// clickable "Learn more / Dismiss" row now lives ABOVE the line as a
// CodeLens (see DidYouKnowCodeLensProvider below), which is the standard
// VS Code affordance for "there are actions available on this line".
// The hoverMessage on the decoration still carries the full tip body.
const tipDecoration = vscode.window.createTextEditorDecorationType({
  overviewRulerColor: "rgba(122, 162, 247, 0.4)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

class DidYouKnowCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChange.event;
  refresh(): void {
    this._onDidChange.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!activeTip || activeTip.docUri !== doc.uri.toString()) return [];
    const lensRange = new vscode.Range(activeTip.line, 0, activeTip.line, 0);
    // Single lens with the tip preview baked into the title — the user reads
    // a glance-sized version inline and only clicks for the full body.
    // Dismiss stays available via the hover popover (and any keystroke).
    return [
      new vscode.CodeLens(lensRange, {
        title: `◎ ${previewTip(activeTip.tipText)}`,
        command: "protege.tipLearnMore",
        arguments: [activeTip.concept],
      }),
    ];
  }
}

/** Truncate the tip body to a single line that fits comfortably as a lens
 *  title. Whitespace is collapsed so the AI-generated newlines do not
 *  break the preview. ~80 chars matches what reads cleanly above a code
 *  line at typical editor widths. */
const PREVIEW_MAX = 80;
function previewTip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= PREVIEW_MAX) return oneLine;
  return oneLine.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
}

let tipLensProvider: DidYouKnowCodeLensProvider | null = null;

export function registerDidYouKnowCodeLens(): vscode.Disposable {
  tipLensProvider = new DidYouKnowCodeLensProvider();
  return vscode.languages.registerCodeLensProvider({ scheme: "file" }, tipLensProvider);
}

const shownTips = new Set<string>();
/** Last-shown timestamp keyed by document URI. Per-file rather than global
 *  so opening a fresh file gets a fresh budget — the previous design
 *  silently swallowed every tip in a 5-minute window across all files. */
const lastTipPerDoc = new Map<string, number>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;

interface ActiveTip {
  editor: vscode.TextEditor;
  docUri: string;
  line: number;
  concept: string;
  tipText: string;
}
let activeTip: ActiveTip | null = null;

/** Engagement-aware cooldown. The default 5-minute floor scales to 10
 *  after a dismiss (user actively rejected the last tip — back off) and
 *  shrinks to 1 after a Learn-more click (user wants more — feed them).
 *  The signal lives until the next engagement event overwrites it. */
type EngagementKind = "dismiss" | "learn";
let lastEngagement: { ts: number; kind: EngagementKind } | null = null;

const COOLDOWN_BASE_MS = 5 * 60 * 1000;
const COOLDOWN_AFTER_DISMISS_MS = 10 * 60 * 1000;
const COOLDOWN_AFTER_LEARN_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 8_000;

function currentCooldownMs(): number {
  if (!lastEngagement) return COOLDOWN_BASE_MS;
  return lastEngagement.kind === "dismiss"
    ? COOLDOWN_AFTER_DISMISS_MS
    : COOLDOWN_AFTER_LEARN_MS;
}

/** Cached "likely-known" concept set from the backend mastery heuristic.
 *  Refreshed lazily — one fetch per KNOWN_TTL_MS, regardless of how many
 *  files trigger the tip pipeline. We accept stale-by-a-few-minutes data:
 *  worst case, a tip slips through for a freshly-mastered concept and gets
 *  suppressed on the next refresh. Network failure → empty set, which
 *  preserves the legacy behaviour of relying on `shownTips` alone. */
const KNOWN_TTL_MS = 10 * 60 * 1000;
let knownCache: { set: Set<string>; fetchedAt: number } | null = null;
let knownInflight: Promise<Set<string>> | null = null;

async function getKnownConcepts(): Promise<Set<string>> {
  const now = Date.now();
  if (knownCache && now - knownCache.fetchedAt < KNOWN_TTL_MS) {
    return knownCache.set;
  }
  if (knownInflight) return knownInflight;
  knownInflight = (async () => {
    try {
      const list = await fetchKnownConcepts();
      const set = new Set(list);
      knownCache = { set, fetchedAt: Date.now() };
      return set;
    } catch (err) {
      log("didYouKnow", `mastery fetch failed: ${String(err)}`);
      // Cache the empty set briefly so we don't hammer a failing endpoint.
      const set = new Set<string>();
      knownCache = { set, fetchedAt: Date.now() };
      return set;
    } finally {
      knownInflight = null;
    }
  })();
  return knownInflight;
}

export function setDidYouKnowEnabled(enabled: boolean): void {
  active = enabled;
  if (!enabled) clearActiveTip();
}

export function registerDidYouKnow(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  active = true;

  const stored = context.globalState.get<string[]>("protege.shownTips") ?? [];
  for (const t of stored) shownTips.add(t);

  disposables.push(
    vscode.workspace.onDidChangeTextDocument(() => {
      if (!active) return;
      // Any keystroke dismisses the current tip — user has moved on.
      if (activeTip) clearActiveTip();
      resetIdleTimer();
    })
  );

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!active) return;
      clearActiveTip();
      if (!editor) return;
      setTimeout(() => maybeShowTip(editor), 3000);
    })
  );

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!active) return;
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document === doc
      );
      if (editor) maybeShowTip(editor);
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.dismissTip", () => {
      lastEngagement = { ts: Date.now(), kind: "dismiss" };
      clearActiveTip();
    })
  );

  // Bridge command for the lens click — records "learn more" engagement
  // (shrinks the next-tip cooldown) and forwards to the existing
  // teachConcept handler. Lens title click hits this command, not
  // teachConcept directly, so the engagement signal isn't lost.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.tipLearnMore",
      async (concept: string) => {
        lastEngagement = { ts: Date.now(), kind: "learn" };
        await vscode.commands.executeCommand("protege.teachConcept", concept);
      }
    )
  );

  disposables.push(
    new vscode.Disposable(() => {
      active = false;
      if (idleTimer) clearTimeout(idleTimer);
      clearActiveTip();
      context.globalState.update("protege.shownTips", Array.from(shownTips));
    })
  );

  return disposables;
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const editor = vscode.window.activeTextEditor;
    if (editor) maybeShowTip(editor);
  }, IDLE_THRESHOLD_MS);
}

async function maybeShowTip(editor: vscode.TextEditor): Promise<void> {
  const { isLiveReviewActive } = await import("../review/liveReview.js");
  if (!isLiveReviewActive()) return;

  if (activeTip) return;

  const doc = editor.document;
  const docUri = doc.uri.toString();
  const lastForDoc = lastTipPerDoc.get(docUri) ?? 0;
  if (Date.now() - lastForDoc < currentCooldownMs()) return;

  const lang = doc.languageId;
  const content = doc.getText();

  const concepts = detectConcepts(lang, content);
  const knownByMastery = await getKnownConcepts();
  // Two suppression layers: `shownTips` blocks repeats within a session,
  // `knownByMastery` blocks concepts the user has already demonstrated they
  // can ship (heuristic from backend usage / authorship signal). The
  // mastery filter is what fixes the "stop teaching me useState" complaint.
  const candidates = concepts.filter(
    (c) => !shownTips.has(c) && !knownByMastery.has(c)
  );

  if (candidates.length === 0) {
    if (shownTips.size > 20) shownTips.clear();
    return;
  }

  const concept = candidates[Math.floor(Math.random() * candidates.length)];
  const snippet = content.slice(0, 500);

  const raw = await aiGenerateTip(concept, snippet, lang);
  if (!raw) return;

  const tipText = cleanTipText(raw);
  if (!tipText) return;

  shownTips.add(concept);
  lastTipPerDoc.set(doc.uri.toString(), Date.now());

  showRichTip(editor, concept, tipText);
}

function cleanTipText(raw: string): string {
  let t = raw.trim();
  // Strip leading "💡", "Did you know?", "Did you know,", "DYK:" etc — the AI
  // tends to repeat the prefix even though we already brand the popup.
  t = t.replace(/^(?:💡|🤔|📝|💭)\s*/u, "");
  t = t.replace(/^(did\s*you\s*know[?:,.\s-]*){1,3}/i, "");
  t = t.trim();
  // Capitalise first letter so it reads cleanly after our heading.
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

function showRichTip(
  editor: vscode.TextEditor,
  concept: string,
  tipText: string
): void {
  clearActiveTip();

  const doc = editor.document;
  const targetLine = findConceptLine(doc, concept, editor.selection.active.line);

  // Dedup: only skip if a non-Protege diagnostic actually overlaps the
  // concept line — not just any diagnostic in the file.
  const lineRange = new vscode.Range(targetLine, 0, targetLine, doc.lineAt(targetLine).text.length);
  const otherDiags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source !== "Protege");
  if (otherDiags.some((d) => d.range.intersection(lineRange))) {
    return;
  }

  const lineText = doc.lineAt(targetLine).text;
  const range = new vscode.Range(targetLine, lineText.length, targetLine, lineText.length);

  const md = renderProtegeHover({
    kind: "tip",
    title: `Did you know? · ${concept}`,
    body: tipText,
    actions: [
      {
        icon: "book",
        label: "Learn more",
        command: "protege.teachConcept",
        args: [concept],
        primary: true,
      },
      {
        icon: "close",
        label: "Dismiss",
        command: "protege.dismissTip",
      },
    ],
  });

  editor.setDecorations(tipDecoration, [{ range, hoverMessage: md }]);
  activeTip = {
    editor,
    docUri: doc.uri.toString(),
    line: targetLine,
    concept,
    tipText,
  };
  tipLensProvider?.refresh();

  // If the cursor is already on the tip line, auto-pop the hover so the user
  // doesn't have to find it. Otherwise we leave the 💡 badge for them to notice.
  if (editor.selection.active.line === targetLine) {
    setTimeout(() => {
      if (activeTip && vscode.window.activeTextEditor === editor) {
        vscode.commands.executeCommand("editor.action.showHover");
      }
    }, 150);
  }
}

function findConceptLine(
  doc: vscode.TextDocument,
  concept: string,
  fallback: number
): number {
  const pattern = new RegExp(`\\b${escapeRegex(concept)}\\b`, "i");
  for (let i = 0; i < doc.lineCount; i++) {
    if (pattern.test(doc.lineAt(i).text)) return i;
  }
  return Math.min(fallback, Math.max(0, doc.lineCount - 1));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clearActiveTip(): void {
  if (!activeTip) return;
  try {
    activeTip.editor.setDecorations(tipDecoration, []);
  } catch {}
  activeTip = null;
  tipLensProvider?.refresh();
}
