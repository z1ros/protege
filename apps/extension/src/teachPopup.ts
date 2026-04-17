import * as vscode from "vscode";
import { findTeachCard } from "./teachKnowledge.js";

/**
 * Teaching Popups — JARVIS Plan 2, Prompt 5.
 *
 * When the response router detects a teaching/explanation reply, this
 * module anchors a rich hover card to the relevant symbols in the editor.
 * The hover shows:
 *   - Explanation extracted from Claude's reply (or local knowledge base)
 *   - Mini code example
 *   - "Teach me more" link → opens Peek Teaching View
 *   - "Got it" link → dismisses + shows a brief "learned" underline
 *
 * The hover is registered as a temporary HoverProvider that auto-unregisters
 * after 60 seconds or when the user moves to a different file.
 */

let activePopup: {
  disposable: vscode.Disposable;
  decoration: vscode.TextEditorDecorationType;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/**
 * Show teaching popups for the given symbols in the active editor.
 * Called from responseRouter.ts when a teaching/explanation reply arrives.
 *
 * @param symbols — symbol names to anchor popups to (e.g. ["useState", "useEffect"])
 * @param explanation — the explanation from Claude's reply
 * @param editor — the text editor to decorate
 */
export function showTeachPopups(
  symbols: string[],
  explanation: string,
  editor: vscode.TextEditor
): void {
  // Clean up any previous popup
  clearTeachPopups();

  if (symbols.length === 0) return;

  const doc = editor.document;
  const text = doc.getText();

  // Find all occurrences of the symbols
  const ranges: { symbol: string; range: vscode.Range }[] = [];
  for (const sym of symbols.slice(0, 5)) {
    let idx = 0;
    while ((idx = text.indexOf(sym, idx)) !== -1) {
      const start = doc.positionAt(idx);
      const end = doc.positionAt(idx + sym.length);
      ranges.push({ symbol: sym, range: new vscode.Range(start, end) });
      idx += sym.length;
      if (ranges.length >= 15) break;
    }
    if (ranges.length >= 15) break;
  }

  if (ranges.length === 0) return;

  // Create a subtle highlight decoration for the symbols
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(122, 162, 247, 0.1)",
    borderBottom: "2px solid rgba(122, 162, 247, 0.5)",
    overviewRulerColor: "rgba(122, 162, 247, 0.4)",
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  const decoOptions: vscode.DecorationOptions[] = ranges.map((r) => ({
    range: r.range,
  }));

  editor.setDecorations(decoration, decoOptions);

  // Register a temporary HoverProvider for these symbols
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file" },
    {
      provideHover(document, position) {
        // Check if the cursor is on one of our decorated ranges
        const hoveredRange = ranges.find((r) =>
          r.range.contains(position) &&
          document.uri.toString() === editor.document.uri.toString()
        );
        if (!hoveredRange) return null;

        const sym = hoveredRange.symbol;
        const card = findTeachCard(sym);

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;
        md.supportHtml = true;

        // Header
        md.appendMarkdown(`### $(mortar-board) Protege: ${sym}\n\n`);

        // Explanation — use Claude's reply first, local card as supplement
        const shortExplanation = explanation.length > 300
          ? explanation.slice(0, 297) + "..."
          : explanation;
        md.appendMarkdown(`${shortExplanation}\n\n`);

        // Mini example from local knowledge base
        if (card && card.examples.length > 0) {
          const ex = card.examples[0];
          md.appendMarkdown(`**Example** — ${ex.label}:\n\n`);
          md.appendCodeblock(ex.code, ex.lang);
          md.appendMarkdown("\n");
        }

        // Common mistake
        if (card && card.mistakes.length > 0) {
          md.appendMarkdown(`$(warning) **Gotcha**: ${card.mistakes[0]}\n\n`);
        }

        // Actions
        const teachArgs = encodeURIComponent(JSON.stringify(sym));
        md.appendMarkdown(
          `[$(book) Teach me more](command:protege.teachConcept?${teachArgs}) · ` +
          `[$(check) Got it](command:protege.dismissTeachPopup)\n\n`
        );

        md.appendMarkdown(`---\n*Protege · teaching in context*`);

        return new vscode.Hover(md, hoveredRange.range);
      },
    }
  );

  // Auto-clear after 60 seconds
  const timer = setTimeout(() => clearTeachPopups(), 60_000);

  activePopup = { disposable: hoverProvider, decoration, timer };
}

/**
 * Dismiss the current teaching popup and show a brief "learned" underline.
 */
export function dismissTeachPopup(): void {
  if (!activePopup) return;

  const editor = vscode.window.activeTextEditor;

  // Clean up the hover + highlight
  clearTeachPopups();

  // Show a brief "learned" underline on the current line
  if (editor) {
    const learnedDecoration = vscode.window.createTextEditorDecorationType({
      borderBottom: "2px dotted rgba(158, 206, 106, 0.6)",
      after: {
        contentText: " ✓ learned",
        color: "rgba(158, 206, 106, 0.7)",
        fontStyle: "italic",
        fontSize: "0.85em",
        margin: "0 0 0 1em",
      },
    });

    const line = editor.selection.active.line;
    const lineRange = editor.document.lineAt(line).range;
    editor.setDecorations(learnedDecoration, [{ range: lineRange }]);

    // Clear after 8 seconds
    setTimeout(() => {
      editor.setDecorations(learnedDecoration, []);
      learnedDecoration.dispose();
    }, 8000);
  }
}

function clearTeachPopups(): void {
  if (!activePopup) return;
  activePopup.disposable.dispose();
  activePopup.decoration.dispose();
  clearTimeout(activePopup.timer);
  activePopup = null;
}

/**
 * Register the dismiss command. Call once at activation.
 */
export function registerTeachPopup(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("protege.dismissTeachPopup", () => {
      dismissTeachPopup();
      vscode.window.setStatusBarMessage("$(check) Got it!", 3000);
    }),
    new vscode.Disposable(() => clearTeachPopups()),
  ];
}
