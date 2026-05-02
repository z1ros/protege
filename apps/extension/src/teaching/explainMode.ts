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

  // Look for a sentence boundary at-or-before the cap.
  const rough = words.slice(0, maxWords).join(" ");
  const lastPeriodBefore = Math.max(
    rough.lastIndexOf(". "),
    rough.lastIndexOf("! "),
    rough.lastIndexOf("? ")
  );
  // Also look for the FIRST boundary after the cap — if there's no
  // boundary earlier (or the earlier one is suspiciously close to the
  // start), better to overshoot than chop.
  const beyond = words.slice(maxWords).join(" ");
  const overshootMatch = beyond.match(/[.!?](?=\s|$)/);
  const firstPeriodAfter = overshootMatch
    ? rough.length + 1 + overshootMatch.index!
    : -1;

  // Prefer earlier boundary if it lands past 1/3 of the cap (i.e. we
  // got at least one substantive sentence in). Otherwise, accept the
  // overshoot to avoid a mid-thought trail-off.
  const minEarlyChars = Math.floor(rough.length / 3);
  if (lastPeriodBefore >= minEarlyChars) {
    return rough.slice(0, lastPeriodBefore + 1).trim();
  }
  if (firstPeriodAfter >= 0) {
    return stripped.slice(0, firstPeriodAfter + 1).trim();
  }
  // No sentence boundary anywhere — model produced one giant run-on.
  // Return the full stripped text; trailing "…" is worse than letting
  // the user hear the whole thing once.
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
