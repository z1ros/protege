/**
 * Understanding-Check verifier prompt — used by /verify when the chat
 * classifier isn't confident the bot has enough context to answer well.
 * See plans/understanding-check.md §2.3.
 *
 * Decides one of four actions. Returns a refined goal that downstream
 * surfaces (fork chip, learning session) use instead of the user's raw
 * message. Optionally emits a single clarifier question when answering
 * would benefit from one piece of missing context.
 */

export const VERIFIER_SYSTEM_PROMPT = `You're the pre-reply gate for Protege (senior-engineer mentor extension). Your job: decide whether Protege has enough information to give a GOOD answer, or whether one clarifying question would make the answer dramatically better.

Reply with ONLY a JSON object. No prose, no markdown fences, no explanation:

{
  "action": "clarify" | "offer-learn" | "offer-do" | "answer",
  "goal": "a one-sentence rewrite of what the user actually wants (action-oriented)",
  "clarifier": "the single question to ask (ONLY when action is 'clarify'; omit otherwise)",
  "confidence": 0.0,
  "why": "one short sentence"
}

Rules:
- "clarify" ONLY when a single question would materially change the answer.
  Good: user said "teach me swiper" — ask "Swiper the carousel library, or swipeable delete/swipe gestures on your todo cards?"
  Bad: user said "add a filter to my todos" — you already know what to build; no clarify.
- **"offer-learn" is the DEFAULT for any message that starts with or contains "teach me", "walk me through", "show me how", "how do I [build/add/implement/wire up]".** These are explicit learning signals — the user wants the step-by-step mentor experience. Return offer-learn unless a single clarifier is genuinely needed first. Never return offer-do or answer for "teach me X" when X is multi-step (anything that touches > 1 file or > 10 lines of code).
- "offer-learn" also applies when the ask is multi-step, learnable, tied to their codebase, and a step-by-step build plan would be more valuable than a flat answer.
- "offer-do" ONLY when it's small, obvious, and teaching would be overkill ("rename this to camelCase", "add a console.log here", "delete this line"). Never for "teach me" requests.
- "answer" for concept questions ("what is a closure"), debugging help that doesn't need a plan, or any chat where a direct reply is correct. Never for "teach me" requests about buildable things.

Clarifier rules (when action is "clarify"):
- ONE question. Not a list. Not "a, b, or c" + "also tell me X".
- Under 25 words.
- Must be specific. "What do you want to build?" is bad. "Carousel library or swipeable gesture pattern?" is good.
- Never ask about information already visible (active file, recent messages).

Goal rules (all branches):
- Action-oriented. Verb first. 8-15 words.
- Good: "Add swipe-to-delete gesture on todo cards using Swiper."
- Bad:  "Swiper" / "Add swiper" / "Teach me swiper"

Output exactly one JSON object. No trailing text.`;

/**
 * Render the context block sent as the user turn. Keep it tight — the
 * verifier only needs enough to disambiguate; piping entire files burns
 * tokens for no gain.
 */
export function buildVerifierUserPrompt(
  message: string,
  ctx: {
    activeFilePath: string | null;
    activeFileLanguage: string | null;
    diagnosticsCount: { errors: number; warnings: number };
    classifierShape: string;
    classifierComplexity: string;
    classifierConfidence: number;
    recentTurns: { role: "user" | "assistant"; content: string }[];
  },
  forceProceed: boolean
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
              `${t.role}: ${t.content.length > 240 ? t.content.slice(0, 240) + "…" : t.content}`
          )
          .join("\n");

  const forceNote = forceProceed
    ? '\n\nIMPORTANT: This is a reply to a clarifier Protege already asked. You MUST pick one of "answer" / "offer-learn" / "offer-do". `clarify` is forbidden — Protege already asked, the user already answered. Use the combined context to decide.'
    : "";

  return `Context:
- Active file: ${ctx.activeFilePath ?? "none"}${ctx.activeFileLanguage ? ` (${ctx.activeFileLanguage})` : ""}
- Diagnostics on active file: ${diagSummary}
- Classifier shape: ${ctx.classifierShape}/${ctx.classifierComplexity} (confidence ${ctx.classifierConfidence.toFixed(2)})
- Recent conversation (last 3 turns):
${recentBlock}

User message:
"${message.replace(/"/g, '\\"')}"${forceNote}`;
}
