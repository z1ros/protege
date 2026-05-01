/**
 * Teaching intent trigger — detects whether a user's first chat message is
 * teach-shaped (e.g. "teach me Swiper", "I don't understand why this loops")
 * so the chat runner can upgrade `ChatMode` from "text" to "teaching" and
 * route through the structured TEACHING_TEXT prompt block.
 *
 * Only the FIRST message in a thread is classified. Once a thread is in
 * teaching mode the runner stays there until the user clears the chat —
 * we don't want re-classification mid-lesson to flip modes when the user
 * types short follow-ups like "ok" or "got it" (which would otherwise fall
 * out of teaching mode and break the beat structure).
 *
 * The 3-word minimum filters bare verbs ("explain", "teach me?") which are
 * almost always inside-thread follow-ups, not lesson starts. "teach me X"
 * (the canonical case) is exactly 3 words, so the threshold is inclusive.
 */

// LESSON intent — user wants a multi-turn structured teaching session.
// "t[a-z]{1,3}ch" matches "teach" + common typos. Aligned with backend
// TEACH_VERB_RE so chat + voice + concept extraction all agree.
//
// Only imperative / desire phrasings that imply being taught. NOT bare
// "what is X" / "how does X work" — those are quick-answer questions.
const LESSON_INTENT = new RegExp(
  `\\b(?:` +
    [
      `t[a-z]{1,3}(?:ch|hc)\\s+me`,
      `walk\\s+me\\s+through`,
      `guide\\s+me\\s+through`,
      `tutor\\s+me\\s+(?:on|about|in)`,
      `go\\s+over\\s+\\S`, // "go over X" — require an X to avoid bare "let's go"
      `break\\s+down\\s+\\S`,
      `deep\\s+dive`,
      `give\\s+me\\s+(?:a\\s+)?(?:rundown|overview|primer|crash\\s+course)`,
      `i\\s+(?:want|wanna|need|should|gotta|ought\\s+to)\\s+(?:to\\s+)?(?:learn|understand|figure\\s+out|get\\s+(?:good\\s+at|the\\s+hang\\s+of)|practice|master)`,
      `i\\s+(?:would|'?d)\\s+love\\s+to\\s+(?:learn|understand)`,
      `i'?m\\s+trying\\s+to\\s+(?:learn|understand|figure\\s+out|get)`,
      `i\\s+wish\\s+i\\s+(?:knew|could|would\\s+know|understood)`,
      `(?:can|could|would)\\s+you\\s+(?:expl[a-z]+n|teach\\s+me|show\\s+me|walk\\s+me\\s+through|go\\s+over|break\\s+down|help\\s+me\\s+(?:learn|understand|with))`,
      `help\\s+me\\s+(?:learn|practice|master|build|understand|with)`,
      `show\\s+me\\s+how\\s+to`,
      `how\\s+(?:do|can)\\s+i\\s+(?:use|build|set\\s*up|wire|implement|make|create|write)`,
      `let'?s?\\s+(?:go\\s+through|understand)`,
      // Imperative coding requests in Protege default to teaching, not
      // silent code-write. "add me a while loop" / "write me a debouncer"
      // / "give me an example of useEffect" — the user is here to learn,
      // so route through the lesson prompt instead of dumping a snippet.
      // Bare imperatives ("add a comment", "write tests") are excluded by
      // requiring "me" to keep the trigger surface narrow.
      `(?:add|write|give|make|build|create|show|generate)\\s+me\\s+\\S`,
      `can\\s+you\\s+(?:add|write|give|make|build|create|show|generate)\\s+me\\s+\\S`,
    ].join("|") +
    `)\\b`,
  "i"
);

// "expl[a-z]+n" catches "explain" + common typos. Only lesson-shaped when
// followed by "how to" / "to me how to" — bare "explain X" is a quick
// answer, not a lesson.
const EXPLAIN_LESSON =
  /\bexpl[a-z]+n\s+(?:to\s+me\s+)?how\s+to\b/i;

// CONFUSION — frustrated "I don't get this" lands in lesson because the
// user wants someone to walk them through it, not a one-liner definition.
const CONFUSION =
  /\b(don'?t\s+(?:get|understand)|i'?m\s+confused|not\s+sure\s+why|wait\s*what|i'?m\s+lost|no\s+idea\s+(?:how|why|what))\b/i;

// Long open question shape ("why does this happen when X and Y") —
// long enough that a multi-turn explanation makes sense. Short questions
// ("why this", "how does map work") are quick-answer. Question mark is
// optional — users often skip it.
const QUESTION_SHAPE = /^(why|how|when)\b.{25,}/i;

export function isTeachingMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length < 3) return false;
  return (
    LESSON_INTENT.test(trimmed) ||
    EXPLAIN_LESSON.test(trimmed) ||
    CONFUSION.test(trimmed) ||
    QUESTION_SHAPE.test(trimmed)
  );
}

// EXAMPLES:
//   isTeachingMessage("teach me Swiper")                        → true
//   isTeachingMessage("I don't understand why this loop runs forever") → true
//   isTeachingMessage("add me a while loop")                    → true (imperative coding ask)
//   isTeachingMessage("write me a debouncer")                   → true
//   isTeachingMessage("explain")                                → false (under 3 words)
//   isTeachingMessage("yes go ahead")                           → false (no trigger phrase)
//   isTeachingMessage("add a comment to this fn")               → false (no "me", silent action)
