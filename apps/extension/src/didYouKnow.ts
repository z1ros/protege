import * as vscode from "vscode";
import { detectConcepts } from "./concepts/detector.js";
import { aiGenerateTip } from "./aiExplain.js";
import { renderProtegeHover } from "./hoverTemplate.js";

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

const tipDecoration = vscode.window.createTextEditorDecorationType({
  after: {
    contentText: "  💡 tip",
    color: "#7aa2f7",
    fontStyle: "italic",
    margin: "0 0 0 1em",
  },
  overviewRulerColor: "rgba(122, 162, 247, 0.4)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const shownTips = new Set<string>();
let lastTipTime = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;

interface ActiveTip {
  editor: vscode.TextEditor;
  docUri: string;
  line: number;
}
let activeTip: ActiveTip | null = null;

const COOLDOWN_MS = 5 * 60 * 1000;
const IDLE_THRESHOLD_MS = 8_000;

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
      clearActiveTip();
    })
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
  const { isLiveReviewActive } = await import("./liveReview.js");
  if (!isLiveReviewActive()) return;

  if (Date.now() - lastTipTime < COOLDOWN_MS) return;
  if (activeTip) return;

  const doc = editor.document;
  const lang = doc.languageId;
  const content = doc.getText();

  const concepts = detectConcepts(lang, content);
  const untipped = concepts.filter((c) => !shownTips.has(c));

  if (untipped.length === 0) {
    if (shownTips.size > 20) shownTips.clear();
    return;
  }

  const concept = untipped[Math.floor(Math.random() * untipped.length)];
  const snippet = content.slice(0, 500);

  const raw = await aiGenerateTip(concept, snippet, lang);
  if (!raw) return;

  const tipText = cleanTipText(raw);
  if (!tipText) return;

  shownTips.add(concept);
  lastTipTime = Date.now();

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
  activeTip = { editor, docUri: doc.uri.toString(), line: targetLine };

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
}
