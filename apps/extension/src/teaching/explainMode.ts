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
