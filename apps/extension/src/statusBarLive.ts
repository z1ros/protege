import * as vscode from "vscode";
import { detectConcepts } from "./concepts/detector.js";
import { isLiveReviewActive } from "./liveReview.js";

/**
 * Context-Aware Status Bar — JARVIS Layer 4.
 *
 * Replaces the basic "Protege IQ 38" status bar with a live dashboard:
 *
 *   $(book) useEffect (72%) · IQ 540 · 🔥 14d
 *
 * Updates in real-time as you move the cursor between lines. Shows:
 *   - The concept on the current line + your mastery %
 *   - Your total Code IQ
 *   - Current streak (if > 0)
 *   - Suggestion count when live review is active
 *
 * Click → opens a quick pick with stats about the current file:
 *   - Concepts detected in this file
 *   - IQ earned today
 *   - Actions: "Open Protege", "Teach this concept", "Toggle Live Review"
 */

// ---- State ----

let mainItem: vscode.StatusBarItem | null = null;
let conceptItem: vscode.StatusBarItem | null = null;
let cursorListener: vscode.Disposable | null = null;

let codeIq = 0;
let streakDays = 0;
let totalConcepts = 0;
let lastConceptAtCursor = "";

// ---- Public API ----

export function registerStatusBarLive(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Main status bar item (right-aligned, high priority so it's visible)
  mainItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  mainItem.command = "protege.statusBarClick";
  mainItem.show();
  disposables.push(mainItem);

  // Concept-at-cursor item (to the left of main)
  conceptItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  conceptItem.command = "protege.teachThis";
  disposables.push(conceptItem);

  // Listen for cursor movement to detect concept at current line
  cursorListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    updateConceptAtCursor(e.textEditor);
  });
  disposables.push(cursorListener);

  // Also update when active editor changes
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateConceptAtCursor(editor);
      else hideConceptItem();
    })
  );

  // Command: click main status bar → quick pick
  disposables.push(
    vscode.commands.registerCommand("protege.statusBarClick", showQuickPick)
  );

  // Initial render
  updateMainItem();
  if (vscode.window.activeTextEditor) {
    updateConceptAtCursor(vscode.window.activeTextEditor);
  }

  return disposables;
}

/** Called by extension.ts whenever IQ/streak/concepts update */
export function updateStatusBarData(data: {
  codeIq: number;
  streakDays: number;
  totalConcepts: number;
}): void {
  codeIq = data.codeIq;
  streakDays = data.streakDays;
  totalConcepts = data.totalConcepts;
  updateMainItem();
}

// ---- Internals ----

function updateMainItem(): void {
  if (!mainItem) return;

  const parts: string[] = [];
  parts.push(`$(shield) Protege`);
  parts.push(`IQ ${codeIq}`);
  if (streakDays > 0) parts.push(`$(flame) ${streakDays}d`);

  mainItem.text = parts.join("  ");
  mainItem.tooltip = [
    `Code IQ: ${codeIq}`,
    `Concepts tracked: ${totalConcepts}`,
    streakDays > 0 ? `Streak: ${streakDays} days` : null,
    isLiveReviewActive() ? "Live Review: ON" : "Live Review: OFF",
    "",
    "Click for quick actions",
  ]
    .filter(Boolean)
    .join("\n");
}

function updateConceptAtCursor(editor: vscode.TextEditor): void {
  if (!conceptItem) return;

  const doc = editor.document;
  const lang = doc.languageId;

  // Only for supported languages
  if (
    !["javascript", "typescript", "javascriptreact", "typescriptreact", "python"].includes(lang)
  ) {
    hideConceptItem();
    return;
  }

  const line = doc.lineAt(editor.selection.active.line).text;

  // Detect concepts on the current line
  const concepts = detectConcepts(lang, line);

  if (concepts.length > 0) {
    const concept = concepts[0]; // most prominent concept on this line
    lastConceptAtCursor = concept;
    conceptItem.text = `$(book) ${concept}`;
    conceptItem.tooltip = `${concept} — click to learn more (Cmd+K T)`;
    conceptItem.show();
  } else {
    hideConceptItem();
  }
}

function hideConceptItem(): void {
  if (conceptItem) {
    conceptItem.hide();
    lastConceptAtCursor = "";
  }
}

async function showQuickPick(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  const items: vscode.QuickPickItem[] = [
    {
      label: "$(window) Open Protege Panel",
      description: "Open the full Protege sidebar",
    },
  ];

  if (lastConceptAtCursor) {
    items.unshift({
      label: `$(book) Teach: ${lastConceptAtCursor}`,
      description: "Open the teaching panel for this concept",
    });
  }

  if (editor) {
    const lang = editor.document.languageId;
    const fullText = editor.document.getText();
    const fileConcepts = detectConcepts(lang, fullText);
    items.push({
      label: `$(list-tree) ${fileConcepts.length} concepts in this file`,
      description: fileConcepts.slice(0, 5).join(", ") + (fileConcepts.length > 5 ? "..." : ""),
    });
  }

  items.push({
    label: isLiveReviewActive()
      ? "$(eye) Live Review: ON — click to stop"
      : "$(eye) Live Review: OFF — click to start",
    description: "Real-time code analysis as you type",
  });

  items.push({
    label: `$(graph) Code IQ: ${codeIq}`,
    description: `${totalConcepts} concepts · ${streakDays > 0 ? `${streakDays}d streak` : "no streak"}`,
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Protege — quick actions",
  });

  if (!picked) return;

  if (picked.label.includes("Open Protege Panel")) {
    vscode.commands.executeCommand("protege.toggle");
  } else if (picked.label.includes("Teach:")) {
    vscode.commands.executeCommand("protege.teachThis");
  } else if (picked.label.includes("Live Review")) {
    vscode.commands.executeCommand("protege.toggleLiveReview");
  } else if (picked.label.includes("Code IQ")) {
    vscode.commands.executeCommand("protege.toggle");
  }
}
