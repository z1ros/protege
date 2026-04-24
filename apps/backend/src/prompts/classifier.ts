/**
 * Task-shaping classifier prompt — used by `/classify` when the regex
 * tier is ambiguous. See plans/task-shaping.md §2.4.
 *
 * The prompt asks Haiku to return ONLY a JSON object with fields matching
 * the TaskShape type. Response is strict-parsed on the server; any non-JSON
 * or schema-violating reply falls back to the regex classification.
 */

export const CLASSIFIER_SYSTEM_PROMPT = `You classify a user message into a task shape so Protege (a senior-engineer mentor extension) can route it correctly.

Reply with ONLY a JSON object. No prose, no markdown fences, no explanation:

{
  "shape": "qna" | "build" | "teach" | "debug" | "refactor" | "chat",
  "complexity": "trivial" | "single-step" | "multi-step",
  "mode": "text" | "voice-dialogue" | "learning",
  "roadmapSeeds": ["phase 1 label", "phase 2 label"],
  "confidence": 0.0,
  "why": "one short sentence"
}

Rules:
- "qna"      = question about a concept, not a request to change code
- "chat"     = casual / social / clarifying / no buildable content
- "build"    = user wants code added or created
- "refactor" = user wants existing code restructured, not extended
- "debug"    = user is stuck on a specific broken thing
- "teach"    = user wants to LEARN, not have it done for them
- "multi-step" = would take a competent dev > 5 minutes OR requires >= 3 distinct subtasks
- "single-step" = one localized edit
- "trivial" = no code change at all (question/chat)
- "mode": "learning" ONLY when complexity is multi-step AND shape in {build, teach, refactor, debug}.
         "voice-dialogue" when currentMode is voice/voice-dialogue/teaching OR wakeActive is true.
         Otherwise "text".
- roadmapSeeds: ONLY when complexity is multi-step. 3-5 items. Action-shaped labels, <= 8 words each, verbs first.
  Good: "Add the filter state slot", "Render a 3-option dropdown"
  Bad:  "Filter state", "Dropdown"
- confidence: your own honest estimate, 0.0 to 1.0. Low if the intent is ambiguous.

Output exactly one JSON object. No trailing text.`;

/**
 * Render the context block sent as the user turn. Kept tight — the
 * classifier doesn't need every line of the active file, just enough
 * context to distinguish "add a filter to THIS todo app" from "add a
 * filter, hypothetically".
 */
export function buildClassifierUserPrompt(
  message: string,
  ctx: {
    activeFilePath: string | null;
    activeFileLanguage: string | null;
    currentMode: string;
    wakeActive: boolean;
    diagnosticsCount: { errors: number; warnings: number };
    recentTurns: { role: "user" | "assistant"; content: string }[];
  }
): string {
  const diagSummary =
    ctx.diagnosticsCount.errors + ctx.diagnosticsCount.warnings === 0
      ? "clean"
      : `${ctx.diagnosticsCount.errors} errors, ${ctx.diagnosticsCount.warnings} warnings`;
  const recentBlock =
    ctx.recentTurns.length === 0
      ? "(none)"
      : ctx.recentTurns
          .slice(-3)
          .map(
            (t) =>
              `${t.role}: ${t.content.length > 200 ? t.content.slice(0, 200) + "…" : t.content}`
          )
          .join("\n");

  return `Context:
- Active file: ${ctx.activeFilePath ?? "none"}${ctx.activeFileLanguage ? ` (${ctx.activeFileLanguage})` : ""}
- Diagnostics on active file: ${diagSummary}
- Current mode: ${ctx.currentMode}${ctx.wakeActive ? " (wake-word on)" : ""}
- Recent turns:
${recentBlock}

User message:
"${message.replace(/"/g, '\\"')}"`;
}
