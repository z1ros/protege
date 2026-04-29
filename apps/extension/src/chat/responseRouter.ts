import * as vscode from "vscode";
import { showTeachPopups } from "../teaching/teachPopup.js";

/**
 * Smart Response Router — JARVIS Plan 2, Prompt 1.
 *
 * After Claude replies, this module classifies the reply and dispatches
 * IDE-side actions so the teaching happens IN the editor, not just in
 * the chat panel. The chat still shows the reply, but the editor also
 * lights up with highlights, CodeLens, and annotations.
 *
 * Classification categories:
 *   - "explanation" → highlight relevant code in the file
 *   - "code_fix"   → show a diff / "Apply fix" CodeLens
 *   - "teaching"   → highlight + peek link
 *   - "general"    → chat only, no IDE action
 *
 * Cost: ZERO API calls. Classification is regex-based on the reply text.
 * The IDE actions use existing infrastructure (highlight_code tool,
 * decorations, CodeLens).
 */

export type ResponseKind = "explanation" | "code_fix" | "teaching" | "general";

export interface RouterResult {
  kind: ResponseKind;
  /** Symbols/patterns from the reply that exist in the active file */
  matchedSymbols: string[];
  /** Code blocks extracted from the reply */
  codeBlocks: { lang: string; code: string }[];
  /** Whether the reply suggests replacing code */
  hasSuggestion: boolean;
}

// ---- Regex patterns for classification ----

const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const SUGGESTION_KEYWORDS =
  /\b(instead of|replace|change .+ to|should be|try using|switch to|use .+ not|better to use|refactor)\b/i;
const TEACHING_KEYWORDS =
  /\b(means|is used for|stands for|refers to|the difference|here'?s how|for example|common mistake|gotcha|tip:|note:)\b/i;
const INLINE_CODE_RE = /`([^`]{2,40})`/g;

/**
 * Classify a Claude reply and extract actionable data.
 * Runs synchronously in <1ms — safe to call on every reply.
 */
export function classifyResponse(
  reply: string,
  activeFileContent?: string
): RouterResult {
  const codeBlocks = extractCodeBlocks(reply);
  const inlineSymbols = extractInlineCodeSymbols(reply);
  const hasSuggestion = SUGGESTION_KEYWORDS.test(reply);
  const hasTeaching = TEACHING_KEYWORDS.test(reply);

  // Find which symbols from the reply exist in the active file
  const matchedSymbols: string[] = [];
  if (activeFileContent) {
    for (const sym of inlineSymbols) {
      if (activeFileContent.includes(sym)) {
        matchedSymbols.push(sym);
      }
    }
  }

  // Classify
  let kind: ResponseKind = "general";

  if (codeBlocks.length > 0 && hasSuggestion) {
    kind = "code_fix";
  } else if (codeBlocks.length > 0 && hasTeaching) {
    kind = "teaching";
  } else if (matchedSymbols.length > 0 || hasTeaching) {
    kind = "explanation";
  } else if (codeBlocks.length > 0) {
    kind = "code_fix";
  }

  return { kind, matchedSymbols, codeBlocks, hasSuggestion };
}

function extractCodeBlocks(text: string): { lang: string; code: string }[] {
  const blocks: { lang: string; code: string }[] = [];
  let match: RegExpExecArray | null;
  CODE_BLOCK_RE.lastIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    blocks.push({ lang: match[1] || "", code: match[2].trim() });
  }
  return blocks;
}

function extractInlineCodeSymbols(text: string): string[] {
  const symbols: string[] = [];
  let match: RegExpExecArray | null;
  INLINE_CODE_RE.lastIndex = 0;
  while ((match = INLINE_CODE_RE.exec(text)) !== null) {
    const sym = match[1].trim();
    // Filter out things that look like sentences, not symbols
    if (sym.includes(" ") && sym.split(" ").length > 3) continue;
    symbols.push(sym);
  }
  return [...new Set(symbols)];
}

// ---- IDE action dispatcher ----

/**
 * Execute IDE-side actions based on the classification.
 * Called from webviewHost.ts after getting Claude's reply.
 */
export async function dispatchRouterActions(
  result: RouterResult,
  editor: vscode.TextEditor | undefined,
  reply: string = ""
): Promise<void> {
  if (!editor || result.kind === "general") return;

  const doc = editor.document;

  // 1. Highlight matched symbols in the file
  if (result.matchedSymbols.length > 0) {
    const decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(122, 162, 247, 0.12)",
      border: "1px solid rgba(122, 162, 247, 0.3)",
      borderRadius: "3px",
      overviewRulerColor: "rgba(122, 162, 247, 0.5)",
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    const decorations: vscode.DecorationOptions[] = [];
    const text = doc.getText();

    for (const sym of result.matchedSymbols.slice(0, 10)) {
      let idx = 0;
      while ((idx = text.indexOf(sym, idx)) !== -1) {
        const start = doc.positionAt(idx);
        const end = doc.positionAt(idx + sym.length);
        decorations.push({
          range: new vscode.Range(start, end),
          hoverMessage: new vscode.MarkdownString(
            `$(book) **Protege**: This is what we're discussing`
          ),
        });
        idx += sym.length;
        if (decorations.length >= 20) break;
      }
      if (decorations.length >= 20) break;
    }

    if (decorations.length > 0) {
      editor.setDecorations(decorationType, decorations);

      // Auto-clear after 30 seconds
      setTimeout(() => {
        editor.setDecorations(decorationType, []);
        decorationType.dispose();
      }, 30_000);
    }
  }

  // 2. Code-fix replies — the chat reply itself shows the fenced code
  // block, and if the same finding is in the live-review store the user
  // already has an "✔ Apply fix" CodeLens row above the line. The
  // showInformationMessage banner here ("Protege has a code suggestion
  // for line N — Show in editor / Dismiss") was redundant noise on top
  // of both surfaces, so it's gone (2026-04-29). No replacement —
  // editor-side affordances cover this path.

  // 3. For teaching/explanation — show rich hover popups anchored to symbols
  if (
    (result.kind === "teaching" || result.kind === "explanation") &&
    result.matchedSymbols.length > 0
  ) {
    // Extract a short explanation from the reply (first 2 sentences)
    const shortExplanation = extractShortExplanation(reply);
    showTeachPopups(result.matchedSymbols, shortExplanation, editor);

    vscode.window.setStatusBarMessage(
      `$(mortar-board) Protege: hover the highlighted symbols in your code to learn more`,
      6000
    );
  }
}

/** Extract the first 2 meaningful sentences from a reply for the hover popup. */
function extractShortExplanation(reply: string): string {
  // Strip markdown code blocks
  const stripped = reply.replace(/```[\s\S]*?```/g, "").trim();
  // Split on sentence boundaries
  const sentences = stripped.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
  return sentences.slice(0, 2).join(" ");
}
