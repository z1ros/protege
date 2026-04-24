import type { TaskShape, ShapeContext } from "@protege/types";

/**
 * Regex-based task-shape classification. First tier — fast, free, covers
 * ~80% of cases per plans/task-shaping.md §2.3.
 *
 * Returns null when the patterns are ambiguous, signalling the caller
 * should fall back to the LLM tier. Never throws.
 *
 * Decision order matters: most-specific patterns first so a short debug
 * request doesn't get swallowed by the broader build/teach regexes.
 */

const PATTERNS = {
  // Single-step, localized edits that shouldn't spawn a roadmap.
  trivialTell:
    /\b(rename|console\.log|add a comment|delete this|remove this line|fix the typo|fix a typo)\b/i,
  // Straight concept questions — no code change needed.
  conceptOnly:
    /\b(what (is|are|does)|how does|why (is|are|does) .* work|what's (a|an) )\b/i,
  // User is stuck on a specific broken thing.
  debug:
    /\b(why is|why does|why won't|not working|broken|bug|error|fails?|crash|stuck|doesn't work|isn't working)\b/i,
  // Restructure existing code.
  refactor:
    /\b(refactor|rewrite|rename|extract|convert|migrate|clean up|simplify)\b/i,
  // Add new surface.
  build:
    /\b(add|build|implement|create|make|wire up|hook up|set up|integrate|install)\b/i,
  // Wants to LEARN, not be served.
  teach:
    /\b(teach me|walk me through|show me how|how do i|how would i|what's (a|an)|what is (a|an)|explain)\b/i,
};

function pickMode(
  shape: TaskShape["shape"],
  complexity: TaskShape["complexity"],
  ctx: ShapeContext
): TaskShape["mode"] {
  const voiceChannel =
    ctx.currentMode === "voice" ||
    ctx.currentMode === "voice-dialogue" ||
    ctx.currentMode === "teaching" ||
    ctx.wakeActive;
  if (voiceChannel) return "voice-dialogue";
  if (
    complexity === "multi-step" &&
    (shape === "build" || shape === "teach" || shape === "refactor" || shape === "debug")
  ) {
    return "learning";
  }
  return "text";
}

function build(
  shape: TaskShape["shape"],
  complexity: TaskShape["complexity"],
  confidence: number,
  why: string,
  ctx: ShapeContext
): TaskShape {
  const needsRoadmap = complexity === "multi-step";
  return {
    shape,
    complexity,
    mode: pickMode(shape, complexity, ctx),
    needsRoadmap,
    // Regex tier can't generate roadmap seeds — that's LLM-only.
    // Caller will re-route to llmTier if needsRoadmap is true AND the
    // caller cares about seeds (fork chip doesn't; Phase 2 does).
    roadmapSeeds: undefined,
    confidence,
    signals: { tier: "regex", why },
  };
}

/** Length-based heuristic: short asks are usually single-step, long asks
 *  usually aren't. Calibrated on plan §2.3 examples. */
function complexityFromLength(
  message: string,
  kind: "build" | "teach" | "debug" | "refactor"
): TaskShape["complexity"] {
  if (kind === "build") return message.length > 25 ? "multi-step" : "single-step";
  if (kind === "debug") return message.length > 40 ? "multi-step" : "single-step";
  // teach + refactor almost always imply multiple moving parts
  return "multi-step";
}

/**
 * Run tier-1 regex classification. Returns a TaskShape with the
 * `signals.tier = "regex"` stamp, or `null` if no pattern applied (in
 * which case the caller should invoke the LLM tier).
 */
export function classifyWithRegex(
  message: string,
  ctx: ShapeContext
): TaskShape | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return build("chat", "trivial", 0.95, "empty message", ctx);
  }
  // Very short asks are almost always chat / yes-no / acknowledgements.
  if (trimmed.length < 8) {
    return build("chat", "trivial", 0.95, "under 8 chars", ctx);
  }

  // Order: specific → general. Trivial and concept-only before the
  // broader build/teach regexes so they don't get miscategorized.
  if (PATTERNS.trivialTell.test(trimmed)) {
    return build("build", "single-step", 0.85, "trivial-tell pattern", ctx);
  }
  if (PATTERNS.conceptOnly.test(trimmed) && !PATTERNS.teach.test(trimmed)) {
    return build("qna", "trivial", 0.85, "concept-only question", ctx);
  }
  if (PATTERNS.debug.test(trimmed)) {
    return build(
      "debug",
      complexityFromLength(trimmed, "debug"),
      0.75,
      "debug pattern",
      ctx
    );
  }
  if (PATTERNS.refactor.test(trimmed)) {
    return build("refactor", "multi-step", 0.75, "refactor pattern", ctx);
  }
  // Teach checked BEFORE build because "teach me how to add X" matches
  // both and the teach interpretation is richer.
  if (PATTERNS.teach.test(trimmed)) {
    return build("teach", "multi-step", 0.75, "teach pattern", ctx);
  }
  if (PATTERNS.build.test(trimmed)) {
    return build(
      "build",
      complexityFromLength(trimmed, "build"),
      0.7,
      "build pattern",
      ctx
    );
  }
  return null; // ambiguous — kick to LLM tier
}
