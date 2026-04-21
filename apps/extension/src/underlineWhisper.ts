import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  getSuggestionsForUri,
  onSuggestionsChanged,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";
import { log } from "./log.js";
import { hasNativeDiagnosticInRange } from "./nativeDiagnostics.js";

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

// Separate end-of-line "tag" decoration — shows the suggestion's `label`
// (3–5 words) as ambient inline text, so the user knows WHAT the finding
// is about at a glance without hovering. Plan §3 originally made the
// whisper "zero text" for purity, but in practice a short tag is more
// useful than pure highlight: catches the eye AND communicates, all
// without a click. The hover still carries the teaser, the thread the
// lesson, voice the narrative — we're just adding an ambient label, not
// duplicating deeper content.
const WHISPER_TAG = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Track underlined ranges per URI so the hover provider can check whether a
// given hover position is over one of our whispers (vs random code).
const whisperRangesByUri = new Map<string, vscode.Range[]>();

/**
 * Look up the first whisper range on the given line, if any. Used by the
 * Ghost Mentor headline peek command to park the cursor INSIDE the token
 * our hover provider is registered on — otherwise `editor.action.showHover`
 * fires at an empty position and the popup never renders.
 */
export function getWhisperRangeAtLine(
  uri: string,
  line: number
): vscode.Range | null {
  const ranges = whisperRangesByUri.get(uri);
  if (!ranges || ranges.length === 0) return null;
  const hit = ranges.find((r) => r.start.line <= line && line <= r.end.line);
  return hit ?? null;
}

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

  // Interactive hover: shows the actual issue + clickable Apply fix /
  // Explain / Dismiss buttons RIGHT IN the hover. This is the primary
  // action surface because hovering is a natural, fast gesture — users
  // don't have to guess "click the line and wait" to interact.
  //
  // The Ghost Lens above the cursor line still exists for keyboard-driven
  // users (Tab / ⌘. / Esc parity), but the hover is the discoverable one.
  disposables.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        provideHover(doc, position) {
          const uri = doc.uri.toString();
          const ranges = whisperRangesByUri.get(uri);
          if (!ranges || ranges.length === 0) return undefined;
          const hit = ranges.find((r) => r.contains(position));
          if (!hit) return undefined;

          const s = findSuggestionAtLine(uri, hit.start.line);
          if (!s) return undefined;

          return new vscode.Hover(buildActionHover(s, uri, doc.languageId), hit);
        },
      }
    )
  );

  // ⌘. / click → opens the inline teaching thread on the current line.
  // When invoked from a keybinding the caller passes no args; fall back to
  // the active editor's cursor position so the command Just Works.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.openTeachPeek",
      async (args?: { uri?: string; line?: number }) => {
        const editor = vscode.window.activeTextEditor;
        const uri = args?.uri ?? editor?.document.uri.toString();
        const line =
          typeof args?.line === "number"
            ? args.line
            : editor?.selection.active.line;
        if (!uri || typeof line !== "number") return;
        await openInlinePeek(uri, line);
      }
    )
  );

  // ---- Hover action commands ----
  // The interactive hover exposes Apply fix / Explain / Dismiss as markdown
  // command links. These three commands back those links directly so hover
  // clicks work without requiring the Ghost Lens to be active.

  disposables.push(
    vscode.commands.registerCommand(
      "protege.applyWhisperFix",
      async (args: { uri: string; line: number }) => {
        if (!args || typeof args.line !== "number") return;
        const uri = args.uri ?? vscode.window.activeTextEditor?.document.uri.toString();
        if (!uri) return;
        const s = findSuggestionAtLine(uri, args.line);
        if (!s) return;
        // Always route Fix through smartFix, not through the scan's
        // pre-stored `fix` string. The scan's fix is often wrong (Qwen
        // compresses it, Haiku sometimes hallucinates keys, etc.).
        // smartFix fires a fresh cloud round-trip with full context.
        await vscode.commands.executeCommand("protege.smartFix", {
          uri,
          line: s.range.start.line,
        });
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.explainWhisper",
      async (args: { uri: string; line: number }) => {
        if (!args || typeof args.line !== "number") return;
        const uri = args.uri ?? vscode.window.activeTextEditor?.document.uri.toString();
        if (!uri) return;
        const s = findSuggestionAtLine(uri, args.line);
        if (!s) return;

        // The hover's button carries a 🎙 mic icon — that promises voice.
        // Always play the clip. If explainMode is "both", also open the
        // sidebar so the user has the full written reply to reference.
        const { resolveExplainMode } = await import("./explainMode.js");
        const mode = resolveExplainMode();

        const { runVoiceExplanation } = await import("./ghostMentor.js");
        void runVoiceExplanation(s);

        if (mode === "both") {
          await vscode.commands.executeCommand(
            "protege.teachConcept",
            s.ruleId
          );
        }
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.dismissWhisper",
      async (args: { uri: string; line: number }) => {
        if (!args || typeof args.line !== "number") return;
        const uri = args.uri ?? vscode.window.activeTextEditor?.document.uri.toString();
        if (!uri) return;
        // Actually remove the finding from the shared store. The change
        // event refreshes every subscribed surface (Ghost CodeLens,
        // Underline Whisper, Inlay hint) so the row, underline, and
        // hover all disappear in one frame.
        const { dismissSuggestionAtLine } = await import("./liveReview.js");
        dismissSuggestionAtLine(uri, args.line);
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
      WHISPER_TAG.dispose();
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

  // Just the highlight ranges — the inline `← <label>` end-of-line tag
  // was removed (2026-04-18, user feedback: "we don't show this inline
  // stuff anymore, we show this on top of the code"). The label, message,
  // and actions all live in the Ghost Lens CodeLens row above the line
  // now (see ghostMentor.ts), which renders for every finding on the
  // file, not just the cursor-parked one.
  const ranges: vscode.Range[] = [];
  for (const s of suggestions) {
    // Only atom-scope (single-token) findings get an inline underline.
    // Block and flow-scope findings span many lines — painting a wavy
    // underline across 20+ lines of a function body is the "everything
    // is highlighted" chaos the user flagged. Those findings still
    // appear as a CodeLens row above the code; nothing is lost.
    if (s.scope === "block" || s.scope === "flow") continue;

    const tokenRange = resolveTokenRange(doc, s);
    if (!tokenRange) continue;

    // Dedup against native diagnostics — if TS / ESLint / cSpell /
    // Cursor's agent already squiggled this token, we stay quiet
    // instead of layering more decorations on top. (Note: Cursor's
    // "Fix with Agent" inline UI is NOT a diagnostic, so that one
    // dedup can't detect it; the scope skip above is what prevents
    // Protege from also covering those lines with block/flow
    // underlines.)
    if (hasNativeDiagnosticInRange(doc.uri, tokenRange)) continue;

    // Praise / concept findings are positive-framing signals — they
    // don't need an "attention, something is wrong" wavy underline.
    // Keep them visible via the Ghost CodeLens + concept-trail dot;
    // skip the underline. Only risk-carrying findings (watch-out,
    // or any non-LEARN severity=warn/perf) get the underline.
    if (s.kind === "praise" || s.kind === "concept") continue;

    ranges.push(tokenRange);
  }

  editor.setDecorations(WHISPER_HIGHLIGHT, ranges);
  // Clear any stale inline tags from prior renders (the WHISPER_TAG type
  // still exists for back-compat / quick re-enable; we just never push
  // options to it now).
  editor.setDecorations(WHISPER_TAG, []);
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

// ---- Interactive hover builder (slim) ----
//
// Target: ≤ 4 visual rows. Users were reading 8+ rows including VS Code's
// own type-hover stacking below — it felt like a modal instead of a
// sticky-note.
//
// Layout:
//   💡 Rule Title
//   One-sentence why.
//   <fix code, one or two lines>
//   🪄 Fix · 🎙 Explain · ✕
//
// `isTrusted = true` is required for `command:` URIs to work from hover.

function buildActionHover(
  s: Suggestion,
  uri: string,
  lang: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  const title = s.label
    ? s.label.replace(/\b\w/g, (c) => c.toUpperCase())
    : s.ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Title only — no `· line N`, no lightbulb icon. The user said both
  // were noise (they already see which line they're hovering on).
  // Cleaner: rule name, then a one-line explanation, then actions.
  md.appendMarkdown(`**${title}**\n\n`);

  // Use the LESSON field when present — it's the model's 2-sentence
  // "what's wrong + why it matters here" explanation, exactly the
  // depth the user asked for ("explain more, like one or two
  // paragraphs why"). Falls back to teaser, then message, when the
  // lesson wasn't generated (older scans, on-device path).
  const explanation = (s.lesson && s.lesson.trim())
    ? s.lesson.trim()
    : compactMessage(s.teaser || s.message);
  md.appendMarkdown(`${explanation}\n\n`);

  // Compact fix block when we have one — max 2 lines, longer fixes are
  // truncated with an ellipsis so the hover never scrolls.
  if (s.fix && s.fix.trim()) {
    const compact = compactFix(s.fix.trim());
    md.appendCodeblock(compact, lang || "typescript");
  }

  // Action row — three compact links.
  //   🪄 Fix    — only shown when a fix exists (Haiku regenerates on click)
  //   📖 Teach  — opens the inline Comment Thread AND speaks the lesson.
  //               One button, both surfaces. Voice + text compose naturally:
  //               you hear the narrative while reading the paragraph.
  //   ✕ Dismiss
  // Dropped the standalone "🎙 Explain" button — it was confusing next to
  // 📖 Teach (both meant "tell me more"). Teach now delivers both.
  const argsObj = encodeURIComponent(
    JSON.stringify({ uri, line: s.range.start.line })
  );
  const applyCmd = `command:protege.applyWhisperFix?${argsObj}`;
  const teachCmd = `command:protege.openTeachingThread?${argsObj}`;
  const dismissCmd = `command:protege.dismissWhisper?${argsObj}`;

  // Action labels mirror the CodeLens row exactly — same glyphs, same
  // verbs — so users learn one vocabulary that works everywhere. No
  // codicons (rule: "no emoji and no `$(name)` codicons in label text").
  const parts: string[] = [];
  if (s.fix) parts.push(`[✔ Apply fix](${applyCmd})`);
  parts.push(`[✿ Teach me](${teachCmd})`);
  parts.push(`[✘ Dismiss](${dismissCmd})`);
  md.appendMarkdown(`${parts.join("  ·  ")}`);

  return md;
}

function compactMessage(msg: string): string {
  // Strict one-row budget. Plan §3 caps the hover at 4 visual rows
  // total (title + teaser + fix + actions), so the teaser only has ONE
  // row. Take the first sentence; hard-cap at MAX if it's still too long.
  //
  // This is also the key to plan anti-feature #3 ("no duplicating the
  // lesson text across surfaces"). When the model omits a dedicated
  // teaser and both hover + thread fall back to `message`, the hover
  // gets the first clause while the thread still renders the full
  // paragraph. Never identical content on both surfaces.
  const MAX = 80;
  const trimmed = msg.trim().replace(/\s+/g, " ");
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  if (firstSentence.length <= MAX) return firstSentence;
  return firstSentence.slice(0, MAX - 1) + "…";
}

function compactFix(fix: string): string {
  const lines = fix.split("\n");
  if (lines.length <= 2) return fix;
  return lines.slice(0, 2).join("\n") + "\n…";
}

// ---- Inline peek → inline teaching thread ----
//
// `⌘.` (or the Ghost Lens "Explain" button, or a command palette entry)
// routes here. Used to open the sidebar chat with a teaching prompt — now
// opens the in-editor Comment Thread where the full lesson lives. This
// keeps eyes on code: the user never leaves the editor to read the paragraph.

async function openInlinePeek(uriStr: string | undefined, line: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const uri = uriStr ?? editor.document.uri.toString();
  const s = findSuggestionAtLine(uri, line);
  if (!s) return;

  // Park the cursor on the finding line so VS Code scrolls the thread into
  // view even when the user invoked the command from a scrolled-off spot.
  const pos = new vscode.Position(s.range.start.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  await vscode.commands.executeCommand("protege.openTeachingThread", {
    uri,
    line: s.range.start.line,
  });
}
