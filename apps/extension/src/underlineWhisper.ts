import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  getSuggestionsForUri,
  onSuggestionsChanged,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";
import { log } from "./log.js";

/**
 * Underline Whisper — Grammarly for code.
 *
 * Draws a thin Protege-blue underline under specific tokens that have
 * teaching value. Zero text, zero icon — pure ambient visual signal. Your
 * eye catches the blue underline; your brain registers "worth a second
 * look" without you consciously reading anything.
 *
 * Progressive disclosure:
 *   passive  → underline only
 *   hover    → one-line tip (no buttons, no popup)
 *   ⌘. / click → inline peek with full teaching
 *
 * Conflict rules (non-negotiable):
 *   - Never underline a token that already has a non-Protege diagnostic
 *     (TS / ESLint / cSpell). Blue + red = mud.
 *   - Pure decoration — never pushed into the diagnostic stream.
 *   - Hover scoped to Protege-underlined ranges only.
 *
 * See Architecture/ambient-coach-plan.md → Surface 3.
 */

// ---- Decoration type ----
//
// One visual across every severity — soft white-opacity token background
// with a subtle left-edge stripe. We tried a warn/info split with blue
// underline earlier but it read as two different features; a single
// consistent highlight is both easier to spot and easier to trust ("this
// is Protege noticing something"). White-on-dark respects whatever theme
// the user has without fighting the syntax palette.

const WHISPER_HIGHLIGHT = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(255,255,255,0.08)",
  borderWidth: "0 0 0 2px",
  borderStyle: "solid",
  borderColor: "rgba(255,255,255,0.45)",
  borderRadius: "3px",
  // Don't include leading whitespace in the token range — looks silly as a
  // highlighted empty stripe. Callers pick the token range directly.
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Track underlined ranges per URI so the hover provider can check whether a
// given hover position is over one of our whispers (vs random code).
const whisperRangesByUri = new Map<string, vscode.Range[]>();

// ---- Public API ----

export function registerUnderlineWhisper(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Re-render whispers when a new scan completes.
  disposables.push(
    onSuggestionsChanged((uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.uri.toString() !== uri) return;
      renderWhispers(editor);
    })
  );

  // Re-render when the user switches editors.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      renderWhispers(editor);
    })
  );

  // Re-render when diagnostics change — a new TS error on a token we were
  // whispering should suppress our underline immediately.
  disposables.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      renderWhispers(editor);
    })
  );

  // Hover provider intentionally NOT registered.
  //
  // Earlier versions popped a small markdown tip on hover. With the Ghost
  // Lens now rendering above the cursor line with Apply / Explain / Dismiss
  // buttons, the hover was a redundant second surface showing the same
  // message — users found it confusing ("why is it explaining twice?").
  //
  // The Whisper is now pure visual signal. To interact: park the cursor
  // on the whispered line and the Ghost Lens appears after 800ms.

  // ⌘. / click → inline peek expansion.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.openTeachPeek",
      async (args: { uri: string; line: number }) => {
        await openInlinePeek(args.uri, args.line);
      }
    )
  );

  // First paint on activation.
  if (vscode.window.activeTextEditor) {
    renderWhispers(vscode.window.activeTextEditor);
  }

  // Cleanup on dispose.
  disposables.push(
    new vscode.Disposable(() => {
      WHISPER_HIGHLIGHT.dispose();
      whisperRangesByUri.clear();
    })
  );

  return disposables;
}

// ---- Render ----

function renderWhispers(editor: vscode.TextEditor): void {
  const doc = editor.document;
  const uri = doc.uri.toString();
  const suggestions = getSuggestionsForUri(uri);

  // Build token ranges. We used to skip any range overlapping a non-Protege
  // diagnostic (to avoid "blue + red squiggle mud"), but with the new
  // HIGHLIGHT visual (soft white token background + left stripe), there's
  // no squiggle to mud with — and the skip made Protege silent on every
  // file that had TS errors, which is the exact file a student needs help
  // with. TS/Protege now coexist: TS reports the error, Protege teaches
  // the "why".
  const ranges: vscode.Range[] = [];
  for (const s of suggestions) {
    const tokenRange = resolveTokenRange(doc, s);
    if (!tokenRange) continue;
    ranges.push(tokenRange);
  }

  editor.setDecorations(WHISPER_HIGHLIGHT, ranges);
  whisperRangesByUri.set(uri, ranges);

  const name = doc.fileName.split(/[\\/]/).pop() ?? "file";
  log(
    "whisper",
    `render ${name} · suggestions=${suggestions.length} ranges=${ranges.length}`
  );
}

/**
 * Pick the tightest meaningful range to underline. If the suggestion carries
 * a real token-level range (not whole-line), use it. Otherwise pick the first
 * non-whitespace word on the line so the underline doesn't span the entire
 * indentation.
 */
function resolveTokenRange(
  doc: vscode.TextDocument,
  s: Suggestion
): vscode.Range | undefined {
  const line = Math.min(doc.lineCount - 1, s.range.start.line);
  const lineText = doc.lineAt(line).text;

  const startCol = s.range.start.character;
  const endCol = s.range.end.character;
  const isLineWide = startCol === 0 && endCol >= lineText.length - 1;

  if (!isLineWide && endCol > startCol) {
    // Trust the suggestion's own range.
    return new vscode.Range(line, startCol, line, endCol);
  }

  // Fallback: first non-whitespace word on the line.
  const match = /\S+/.exec(lineText);
  if (!match) return undefined;
  const col = match.index;
  return new vscode.Range(line, col, line, col + match[0].length);
}

// ---- Inline peek (stub — wires to the chat panel for MVP) ----

async function openInlinePeek(uriStr: string | undefined, line: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const uri = uriStr ?? editor.document.uri.toString();
  const s = findSuggestionAtLine(uri, line);
  if (!s) return;

  // Jump caret to the line so context is obvious, then open the Protege
  // panel. The full inline-peek expansion is Stage-2 work; for MVP the sidebar
  // carries the full teaching.
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  await vscode.commands.executeCommand("protege.teachConcept", s.ruleId);
}
