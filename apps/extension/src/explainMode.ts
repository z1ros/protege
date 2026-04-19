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

  // Try to end on a sentence boundary near the cap.
  const rough = words.slice(0, maxWords).join(" ");
  const lastPeriod = Math.max(
    rough.lastIndexOf(". "),
    rough.lastIndexOf("! "),
    rough.lastIndexOf("? ")
  );
  if (lastPeriod > maxWords * 3) {
    return rough.slice(0, lastPeriod + 1).trim();
  }
  return rough.trim() + "…";
}
