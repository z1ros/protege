import * as vscode from "vscode";

/**
 * Resolve the effective delivery mode for a Ghost Lens "Explain" click.
 *
 * Layers, highest priority first:
 *   1. Caller-supplied override (from a modifier keybinding, e.g. ⌘ click)
 *   2. User setting `protege.explainMode`
 *   3. Hard default: `"text"` — voice is always opt-in
 *
 * The Stage 3 "auto-detect headphones" layer isn't implemented yet; this
 * module returns a well-defined value today so callers can plumb the
 * voice path now and let auto-detect slot in later without API churn.
 */

export type ExplainMode = "text" | "voice" | "both";

export function resolveExplainMode(override?: ExplainMode): ExplainMode {
  if (override === "text" || override === "voice" || override === "both") {
    return override;
  }
  const setting = vscode.workspace
    .getConfiguration("protege")
    .get<string>("explainMode", "text");
  if (setting === "voice" || setting === "both") return setting;
  return "text";
}

/**
 * Truncate a voice explanation to a safe ≈8-second budget. We clip on a
 * sentence boundary when possible, otherwise hard-cap. Too-long TTS was a
 * real risk of voice mode feeling like a lecture — anti-feature #3 in the
 * plan says "≤ 30s per clip, else fall back to text."
 *
 * Brevity is VOICE-ONLY by design. Text/chat mode does not call this —
 * see [routes/chat.ts] maxTokensForMode (text = 4096, no client trim).
 *
 * NEVER produces a mid-sentence cut. If the cap falls inside a sentence,
 * we look for the nearest boundary in either direction and pick the one
 * closer to maxWords; if the only boundary is too far past the cap, we
 * accept the slight overshoot rather than chop a half-thought.
 */
export function trimForVoice(text: string, maxWords = 90): string {
  const stripped = text
    // Drop markdown artifacts TTS can't read — fences, backticks, list bullets
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = stripped.split(" ");
  if (words.length <= maxWords) return stripped;

  // Cap landed somewhere mid-text. New rule (2026-05-03): never cut
  // BACKWARDS to a previous period — that drops a final sentence the
  // user reasonably expects to hear (e.g. "The effect is fine."). The
  // model's word-budget is enforced by the cap softly; the trim's job
  // is only to land on a clean sentence boundary, even if that means
  // overshooting by a handful of words.
  //
  // Algorithm: find the FIRST sentence boundary at-or-after the cap
  // and stop there. If the very last char of the original is already
  // a sentence terminator we just return as-is — we're past the cap
  // but the model already wrapped a sentence right at the end.
  const beyondStart = words.slice(0, maxWords).join(" ").length;
  // Search the rest of the stripped string for a `. ` / `! ` / `? `
  // (or terminator at end-of-string). `(?=\s|$)` is the spaces-or-EOS
  // lookahead so we stop at sentence boundaries, not embedded periods
  // (e.g. "v1.2.3").
  const rest = stripped.slice(beyondStart);
  const m = rest.match(/[.!?](?=\s|$)/);
  if (m && typeof m.index === "number") {
    return stripped.slice(0, beyondStart + m.index + 1).trim();
  }
  // No sentence boundary anywhere after the cap — model produced one
  // giant run-on. Speak the whole thing rather than chop mid-thought.
  return stripped;
}

/**
 * Trim text-mode replies at a sentence/paragraph boundary while
 * preserving markdown (code fences, bullets, headers). Used in text
 * mode where the user is reading and CAN benefit from formatting,
 * unlike trimForVoice which strips markdown for TTS.
 *
 * The model routinely violates the persona's TEXT_MODE 200-word HARD
 * CEILING on conceptual questions. Real test 2026-05-02: a "explain
 * how we use JavaScript in general" reply came back at 600+ words
 * with 6 headed sections and 20+ bullets. This trim is the safety net.
 *
 * Strategy: count words on a markdown-stripped view (so prose length
 * is what we measure, not formatting noise). If the original is under
 * the cap, return verbatim — most replies stay short and don't get
 * touched. If over, find the last paragraph break (\n\n) at-or-before
 * the cap and slice the ORIGINAL text there. Falls back to last
 * sentence boundary if no paragraph break is in reach.
 */
export function trimForText(text: string, maxWords = 200): string {
  // Count words on a stripped view, but NEVER mutate the original —
  // we want to preserve all markdown in the returned text.
  const proseView = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\*\*|\*|_|~/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = proseView.split(" ").filter(Boolean).length;
  if (wordCount <= maxWords) return text;

  // We're over the cap. Find a clean break in the ORIGINAL text. We
  // walk char-by-char, counting prose words (skipping fences and
  // backtick spans), and remember the last "good break" we passed
  // (\n\n is best, then a sentence end).
  let inFence = false;
  let inBacktick = false;
  let words = 0;
  let lastWasWordChar = false;
  let lastParagraphBreak = -1;
  let lastSentenceEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // Track fenced code blocks (don't count their words)
    if (text.slice(i, i + 3) === "```") {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (!inFence && c === "`") {
      inBacktick = !inBacktick;
      continue;
    }
    if (inFence || inBacktick) continue;

    // Count words on whitespace transitions
    const isWordChar = /[A-Za-z0-9'-]/.test(c);
    if (isWordChar && !lastWasWordChar) words++;
    lastWasWordChar = isWordChar;

    // Track potential break points
    if (c === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      if (words <= maxWords) lastParagraphBreak = i;
    }
    if ((c === "." || c === "!" || c === "?") && i + 1 < text.length && /[\s\n]/.test(text[i + 1])) {
      if (words <= maxWords) lastSentenceEnd = i + 1;
    }

    if (words > maxWords) break;
  }

  if (lastParagraphBreak > 0) {
    return text.slice(0, lastParagraphBreak).trimEnd();
  }
  if (lastSentenceEnd > 0) {
    return text.slice(0, lastSentenceEnd).trimEnd();
  }
  // No break found — hard slice to a roughly-proportional char count.
  return text.slice(0, Math.floor(text.length * (maxWords / wordCount))).trimEnd() + "…";
}
