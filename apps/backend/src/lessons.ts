/**
 * Lesson sessions — micro-step adaptive teaching algorithm.
 *
 * Replaces the prior 6-phase static arc (PROBE → EXPLAIN → SHOW → TRY →
 * REVIEW → CLOSE) with a variable-length, plan-then-step model:
 *
 *   1. User says "teach me X". Server creates a session in PROBE phase,
 *      asks ONE level-probing question, waits for the answer.
 *   2. After the probe answer, server classifies level and CALLS THE LLM
 *      ONCE to plan the lesson — returns N atomic steps with TYPE
 *      (EXPLAIN-ATOM / SHOW-CODE / DO-IT-NOW / TASK-SOLO / REVIEW /
 *      CLOSE). Step count is variable (4-20 typical) based on concept
 *      complexity × user level.
 *   3. Server walks the plan one step per assistant message. Each
 *      message follows the strict per-type format (≤30 word cap, no
 *      mixing types, etc.).
 *   4. Adaptive insertions:
 *      - User asks "why?" → server inserts a WHY-ANSWER step that
 *        addresses ONLY their question, then resumes the plan.
 *      - User confused → server repeats the current step with a
 *        rephrased prompt (v1; richer expansion is a v2 idea).
 *      - User pastes code at TASK-SOLO → captured into pendingReviewCode,
 *        next step is forced to be REVIEW.
 *   5. When stepIndex passes the last plan step → DONE, session ends.
 *
 * Storage: in-memory (sessions Map). Sessions expire after 30 min. v2
 * concern is persistence across server restarts.
 */

import { callOneShot } from "./llm.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findCuratedPlan } from "./lessons-fallback-plans.js";

export type StepType =
  | "PROBE"
  | "EXPLAIN-ATOM"
  | "SHOW-CODE"
  | "DO-IT-NOW"
  | "TASK-SOLO"
  | "REVIEW"
  | "WHY-ANSWER"
  | "CLOSE";

export type LessonLevel = "zero" | "comfortable" | "expert" | "unknown";

export interface PlannedStep {
  type: StepType;
  /** Short human-readable summary the prompt generator uses to brief
   *  the model on what THIS step is about. */
  summary: string;
  /** For SHOW-CODE / DO-IT-NOW: the actual code snippet. Optional —
   *  the model can fill this in if missing, but pre-baking keeps the
   *  delivery deterministic. */
  code?: string;
  /** WHY-ANSWER only — the user question that triggered this insertion. */
  triggerQuestion?: string;
}

export interface LessonSession {
  id: string;
  userId: string;
  concept: string;
  level: LessonLevel;
  /** Macro state. PROBE = before probe answered, FLOW = adaptive teaching
   *  (was: TEACHING, walking a fixed plan — now generates beats per turn),
   *  DONE = stopped or wrapped. */
  phase: "PROBE" | "TEACHING" | "DONE";
  /** Vestigial — kept so persisted sessions still load. New sessions
   *  don't populate this; the bot decides each turn what to teach. */
  plan: PlannedStep[];
  /** Vestigial — same. */
  stepIndex: number;
  startedAt: number;
  lastTurnAt: number;
  attempts: number;
  failCount: number;
  /** Captured when user pastes code. Triggers a REVIEW beat next turn. */
  pendingReviewCode?: string;
  /** Last 6 user replies. The flow-prompt reads these to gauge pace. */
  recentTurns?: string[];
  /** Last 6 bot beats (compressed: type + first 80 chars). Read by the
   *  flow-prompt so it doesn't redeliver the same beat. */
  recentBeats?: string[];
  /** Running list of sub-topics the bot has covered. Bot updates this
   *  itself (one short string per turn). Used so the next turn doesn't
   *  re-explain something already covered. */
  coverage?: string[];
  /** Total turns the FLOW phase has executed. */
  turn?: number;
  /** Consecutive confused/idk replies. After 2+, the flow-prompt forces
   *  a hard pivot (ask user what's confusing, drop a bare example, etc.). */
  stuckCount?: number;
  /** Did the bot just deliver a task that we're waiting on? Drives review-
   *  shaped beats. */
  awaitingTaskPaste?: boolean;
  /** Vestigial — old plan-walking momentum bucket. Kept so persisted
   *  sessions still load and stale references compile. */
  momentum?: "fast" | "slow" | "stuck";
  /** User just signaled "you're repeating, I got it already" — set when
   *  the reply matches phrases like "i told you already" / "we discussed
   *  this" / "yes already". Next turn's prompt forces a wrap-or-choice
   *  beat instead of pushing another variation. */
  redundancyFrustration?: boolean;
  /** Hash of the active file content as of the last bot turn. Used by
   *  the next turn's prompt to detect "did the user actually edit
   *  their file?" — without this, the bot has to take the user's word
   *  ("yes I typed it") and can't react to actual code changes. */
  lastFileHash?: string;
  /** Path of the active file when lastFileHash was captured. If the
   *  user switched files mid-lesson the diff comparison resets. */
  lastFilePath?: string;
  /** Did the bot call edit_file in its previous turn? Used by the next
   *  turn's diff-signal logic to differentiate "user edited their file"
   *  vs "user accepted my edit_file diff" — both produce a hash change,
   *  but mean different things to the AI. Without this, the bot can
   *  end up saying "you added X" when really the bot wrote it itself. */
  lastBotEditedFile?: boolean;
}

const sessions = new Map<string, LessonSession>();
const SESSION_TIMEOUT_MS = 30 * 60_000;

/**
 * Cheap content fingerprint for file-diff awareness. We don't need
 * cryptographic strength — just "did this change since last turn".
 * Length + a 32-bit FNV-1a fold over the content is enough; collisions
 * within a single lesson session are statistically near-impossible.
 */
export function quickHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/* ─── Persistence (Tier 1.2) ──────────────────────────────────────── */
//
// Sessions are stored in-memory but mirrored to a JSON file so a
// `tsx watch` reload (or any backend restart) doesn't kill in-flight
// lessons. On boot, the file is read and non-expired sessions are
// rehydrated. Every session mutation triggers a write-back.

const SESSIONS_FILE = join(process.cwd(), ".lesson-sessions.json");
let writePending: NodeJS.Timeout | null = null;

function schedulePersist(): void {
  // Debounce: bunch up rapid mutations into one write within a 200ms
  // window. Avoids disk thrash if a turn updates the session multiple
  // times before the next request arrives.
  if (writePending) clearTimeout(writePending);
  writePending = setTimeout(() => {
    writePending = null;
    void persistSessions();
  }, 200);
}

async function persistSessions(): Promise<void> {
  try {
    const obj: Record<string, LessonSession> = {};
    for (const [k, v] of sessions) obj[k] = v;
    await writeFile(SESSIONS_FILE, JSON.stringify(obj), "utf8");
  } catch (err) {
    console.warn(
      `[protege] lesson session persist failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function restoreSessions(): Promise<void> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, LessonSession>;
    const now = Date.now();
    let restored = 0;
    for (const [userId, s] of Object.entries(obj)) {
      // Skip expired or already-DONE sessions on restore — they're not
      // useful and would just be cleared on the next chat call anyway.
      if (!s || typeof s !== "object") continue;
      if (s.phase === "DONE") continue;
      if (now - s.lastTurnAt > SESSION_TIMEOUT_MS) continue;
      sessions.set(userId, s);
      restored++;
    }
    if (restored > 0) {
      console.log(
        `[protege] restored ${restored} lesson session${restored === 1 ? "" : "s"} from ${SESSIONS_FILE}`
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[protege] lesson session restore failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

// Auto-restore on module load. Fire-and-forget — if it fails, the only
// cost is the user has to retype "teach me X" on whatever lesson was
// in flight before the restart.
void restoreSessions();

/** Set a session and schedule persistence. Use this everywhere instead
 *  of `sessions.set()` directly. */
function setSession(s: LessonSession): void {
  sessions.set(s.userId, s);
  schedulePersist();
}

/** Delete a session and schedule persistence. */
function deleteSession(userId: string): void {
  if (sessions.delete(userId)) schedulePersist();
}

export function getActiveSession(userId: string): LessonSession | null {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.lastTurnAt > SESSION_TIMEOUT_MS) {
    deleteSession(userId);
    return null;
  }
  if (s.phase === "DONE") {
    deleteSession(userId);
    return null;
  }
  return s;
}

export function startSession(userId: string, concept: string): LessonSession {
  const s: LessonSession = {
    id: crypto.randomUUID(),
    userId,
    concept,
    level: "unknown",
    phase: "PROBE",
    plan: [],
    stepIndex: -1,
    startedAt: Date.now(),
    lastTurnAt: Date.now(),
    attempts: 0,
    failCount: 0,
  };
  setSession(s);
  return s;
}

export function endSession(userId: string): void {
  deleteSession(userId);
}

/* ─── Concept extraction ──────────────────────────────────────────── */

// Typo-tolerant verb match: "teach" → t + any letters + ch (catches
// "taech", "tach", "teahc"). "explain" → expl + any letters + n (catches
// "expalin", "explaain", "exlpain"). Without this, a single transposed
// key prevents a NEW lesson from starting and the user gets stuck in
// the old session.
//
// Also tolerates leading pleasantries / softeners like "hey", "hi",
// "ok", "btw", "can you", "could you", "pls", "please" — users rarely
// write "teach me X" as their entire message; they say "hey can you
// teach me X". Without this tolerance, extractConcept returns null →
// no lesson session → big prompt leaks → wall-of-text response.
const TRAILING_FRAGMENT_RE = /\s+(?:i\s+(?:never|don'?t|haven'?t)\s.+|please|pls|thanks?|thx|i\s+(?:want|wanna)\s.+)$/i;
// Pleasantry prefixes — stripped from the front so the verb regex has
// a clean string to anchor on. Note: "can you / could you / would you"
// are NOT in this list — they're part of teach-shaped phrases ("can you
// explain X", "could you teach me X") and removing them would lose the
// signal. The verb regex handles those forms directly.
const PLEASANTRY_PREFIX_RE =
  /^(?:hey+|hi+|hello+|yo+|ok(?:ay)?|btw|so|alright|pl(?:s|ease)|please)[\s,!]*/i;
// Lesson-only verbs: explicit intent to be TAUGHT (multi-turn lesson).
// Quick "what is X" / "how does X" questions should NOT create a lesson
// session — they get answered conversationally. Aligned with the
// frontend LESSON_INTENT regex so chat + voice + extractConcept all
// agree on what counts as a lesson trigger.
//
// The list below covers casual phrasings — the regex is a fast-path; the
// LLM classifier (classifyFirstMessageLLM) catches whatever still slips
// through. Each new pattern saves one ~200ms LLM call when it hits.
const TEACH_VERB_RE = new RegExp(
  `^(?:` +
    [
      // Direct imperatives
      `t[a-z]{1,3}(?:ch|hc)\\s+me`,
      `expl[a-z]+n\\s+(?:to\\s+me\\s+)?how\\s+to`,
      `show\\s+me\\s+how\\s+to`,
      `walk\\s+me\\s+through`,
      `guide\\s+me\\s+through`,
      `tutor\\s+me\\s+(?:on|about|in)`,
      `go\\s+over`,
      `break\\s+down`,
      // "I want / need / should" forms
      `i\\s+(?:want|wanna|need|should|gotta|ought\\s+to)\\s+(?:to\\s+)?(?:learn|understand|figure\\s+out|get\\s+(?:good\\s+at|the\\s+hang\\s+of)|practice|master)`,
      `i\\s+(?:would|'?d)\\s+love\\s+to\\s+(?:learn|understand)`,
      `i'?m\\s+trying\\s+to\\s+(?:learn|understand|figure\\s+out|get)`,
      `i\\s+wish\\s+i\\s+(?:knew|could|would\\s+know|understood)`,
      // "Can/could/would you" + teach verb
      `(?:can|could|would)\\s+you\\s+(?:expl[a-z]+n|teach\\s+me|show\\s+me|walk\\s+me\\s+through|go\\s+over|break\\s+down|help\\s+me\\s+(?:learn|understand|with))`,
      // "Help me" + learning verb
      `help\\s+me\\s+(?:understand|learn|practice|master|build|with)`,
      // Concept-first action verbs
      `deep\\s+dive`,
      `give\\s+me\\s+(?:a\\s+)?(?:rundown|overview|primer|crash\\s+course)\\s+(?:on|of|about)?`,
      `let'?s?\\s+(?:me\\s+)?(?:go\\s+through|understand)`,
      // "How do I + action verb"
      `how\\s+(?:do|can)\\s+i\\s+(?:use|build|set\\s*up|wire|implement|make|create|write)`,
      // "I want to understand X"
      `i\\s+(?:want|wanna)\\s+to?\\s+understand`,
    ].join("|") +
    `)\\s+(.{3,120}?)\\s*[?.!]?\\s*$`,
  "i"
);

/**
 * Filler/stopword phrases that are NOT real concept names. When the
 * extractor lands on one of these (e.g. "teach me pls" → "pls"), return
 * null so the caller treats this as a continuation of the current lesson
 * rather than a request to start a new one on "pls".
 */
const CONCEPT_STOPWORDS = new Set([
  "pls",
  "please",
  "more",
  "this",
  "that",
  "it",
  "stuff",
  "thing",
  "things",
  "again",
  "again pls",
  "again please",
  "me",
  "us",
  "everything",
  "all",
  "the rest",
  "next",
  "now",
  "here",
  "this code",
  "in this file",
  "in my code",
  "in my file",
  "the code",
  "this stuff",
  "man",
  "bro",
  "dude",
]);

export function extractConcept(message: string): string | null {
  let trimmed = message.trim();
  // Strip leading pleasantries iteratively — "hey can you" is two
  // separate pleasantries stacked, and a single regex pass leaves the
  // second behind. Loop until the string stops shrinking.
  let prevLen = -1;
  while (trimmed.length !== prevLen) {
    prevLen = trimmed.length;
    trimmed = trimmed.replace(PLEASANTRY_PREFIX_RE, "").trim();
  }
  // Strip trailing pleasantries / soft framings ("i never used them
  // before", "please", "thanks") so the captured concept isn't
  // polluted by them.
  trimmed = trimmed.replace(TRAILING_FRAGMENT_RE, "").trim();
  const match = trimmed.match(TEACH_VERB_RE);
  if (!match || !match[1]) return null;
  let name = match[1].trim();
  name = name.replace(/^(?:how\s+)?(?:does\s+|do\s+)?(?:to\s+(?:use\s+)?)?/i, "");
  name = name.replace(/\s+(?:works?|behaves?|operates?)$/i, "");
  name = name.replace(/^(?:the\s+)?(?:basics\s+of\s+)?/i, "");
  // Strip trailing locator/filler words. Users naturally say "teach me X
  // here" / "teach me X in this file" / "teach me X now" — those tail
  // words leak into the concept and confuse the planner ("loop in react
  // here" is taken literally as "loop in react here" instead of "loops
  // in react"). Run repeatedly so chained tails ("here now") all drop.
  let prev = "";
  while (prev !== name) {
    prev = name;
    name = name.replace(
      /\s+(?:here|now|this|this\s+code|in\s+this\s+(?:file|code)|in\s+my\s+(?:file|code)|pls|please|man|bro|dude|too|also|for\s+me|with\s+me)$/i,
      ""
    );
    name = name.trim();
  }
  if (!name) return null;
  if (CONCEPT_STOPWORDS.has(name.toLowerCase())) return null;
  return name.slice(0, 60);
}

/* ─── Smart-fallback first-message classifier ─────────────────────── */
//
// When extractConcept (regex) returns null but the message is long
// enough to plausibly carry teach intent, we ask a cheap LLM whether
// the user wants a lesson. Catches casual phrasings the regex misses:
//   - "i wish i would know how to use loops"
//   - "loops are confusing me"
//   - "i should probably learn map"
//   - "could really use a hand with useEffect"
//
// Hits ~10-20% of fresh messages — only the ambiguous ones. Quick acks
// ("yes", "ok") and one-word replies are filtered by the caller's
// length check before reaching this function.

const FIRST_MSG_CLASSIFIER_PROMPT = `Classify a fresh user chat message into ONE of four intents:

- teach: User wants a multi-turn LESSON on a programming concept. Keywords are NOT required — natural phrasings count. Examples: "teach me X" / "i wish i knew how X works" / "loops are confusing me" / "could use a hand with X" / "i want to get better at X" / "X is hard for me" / "should probably learn X".
- answer: User wants a SHORT factual answer, not a lesson. Examples: "what is X" / "how does X work" / "is X better than Y" / "what's the difference".
- build: User wants something built / implemented / changed. Examples: "add a button" / "fix this" / "wire up X".
- other: Greeting, acknowledgement, off-topic, unclear.

If "teach", also extract the concept (1-4 words: programming concept name like "loops" / "useEffect" / "async/await").

Output ONLY a JSON object: {"intent": "teach|answer|build|other", "concept": "..."}
("concept" is "" unless intent is "teach".)`;

export async function classifyFirstMessageLLM(
  text: string
): Promise<{ intent: "teach" | "answer" | "build" | "other"; concept: string }> {
  try {
    const result = await callOneShot({
      systemText: FIRST_MSG_CLASSIFIER_PROMPT,
      userText: text.slice(0, 500),
      maxTokens: 60,
      cheap: true,
    });
    const raw = result.text.trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { intent: "other", concept: "" };
    }
    // Tolerate JS-literal syntax (no quotes around keys) — same trick
    // we use in parseBeatMeta.
    let json = raw.slice(start, end + 1);
    json = json.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    const obj = JSON.parse(json) as Record<string, unknown>;
    const intent = String(obj.intent ?? "other").toLowerCase();
    const concept = typeof obj.concept === "string" ? obj.concept.slice(0, 60).trim() : "";
    if (
      intent !== "teach" &&
      intent !== "answer" &&
      intent !== "build" &&
      intent !== "other"
    ) {
      return { intent: "other", concept: "" };
    }
    return { intent: intent as "teach" | "answer" | "build" | "other", concept };
  } catch (err) {
    console.warn(
      `[protege] classifyFirstMessageLLM failed: ${err instanceof Error ? err.message : String(err)} — defaulting to other`
    );
    return { intent: "other", concept: "" };
  }
}

/* ─── User-reply classification ───────────────────────────────────── */

type ReplySignal =
  | "ack"
  | "confused"
  | "code-paste"
  | "why-question"
  | "refusal"
  | "stop"
  | "other";

const ACK_RE =
  /^(ok|okay|yeah|yes|sure|yep|got\s+it|right|cool|fine|alright|continue|next|go\s+on|please|done|added|✓|👍)[\s!.?]*$/i;
const CONFUSED_RE =
  /\b(huh|wait\s*what|don'?t\s+(?:get|understand)|confused|not\s+sure\s+why|i'?m\s+lost|fuzzy|what\s+do\s+you\s+mean)\b/i;
const CODE_PASTE_RE = /```[\s\S]+```/;
const WHY_QUESTION_RE =
  /^\s*(?:why|what\s+about|what\s+does|what'?s|how\s+come|because|but\s+why)\b/i;
const REFUSAL_RE =
  /\b(i'?ll\s+figure\s+it\s+out|skip\s+(?:the\s+)?task|just\s+keep\s+(?:explaining|going)|i'?m\s+good)\b/i;
const STOP_RE =
  /\b(stop\s+(?:the\s+)?lesson|cancel\s+lesson|nevermind|forget\s+it|never\s+mind|wait\s+stop|cancel|abort)\b/i;
const LEVEL_ZERO_RE =
  /\b(not\s+sure|i\s+don'?t\s+know|idk|never\s+used|new\s+to\s+(?:this|it)|fresh|first\s+time|just\s+teach|no\s+idea)\b/i;
const LEVEL_COMFORTABLE_RE =
  /\b(i'?ve\s+used|i\s+know|comfortable|familiar|fuzzy|i'?m\s+ok\s+with|i\s+understand\s+x?\s*but)\b/i;
const LEVEL_EXPERT_RE =
  /\b(senior|years\s+of|experienced|skip\s+basics|skip\s+(?:the\s+)?intro|veteran)\b/i;

/* ─── Hybrid reply classifier (Tier 3.7) ──────────────────────────── */
//
// Fast-path regex for unambiguous cases (zero latency), then fall back
// to a cheap LLM call for ambiguous text. Most replies in practice
// ("ok", "done", "stop", code pastes) hit the regex path. Only edge
// phrasings like "alright cool but real quick what about..." go to
// the LLM (~200ms, ~$0.0001).

const replyClassifierCache = new Map<string, ReplySignal>();
const REPLY_CACHE_MAX = 500;

const CLASSIFIER_SYSTEM_PROMPT = `Classify the user's chat reply during a coding tutorial into ONE label.

Labels:
- ack: confirms / agrees / "got it" / "done" / "yeah" / "sure"
- confused: doesn't understand. "huh", "wait what", "I don't get it", "lost"
- why-question: asking why or how something is. "why does X work like this", "what is Y"
- code-paste: contains code (\`\`\` fences or significant code-shape text)
- refusal: refuses to do the practical task. "I'll figure it out", "skip it"
- stop: wants to end the lesson. "stop", "cancel", "nevermind"
- other: anything else (off-topic, vague, neutral)

Output ONLY the label, lowercase. No explanation.`;

async function classifyReplyLLM(text: string): Promise<ReplySignal> {
  const key = text.trim().slice(0, 200).toLowerCase();
  const cached = replyClassifierCache.get(key);
  if (cached) return cached;

  let signal: ReplySignal;
  try {
    const result = await callOneShot({
      systemText: CLASSIFIER_SYSTEM_PROMPT,
      userText: text.slice(0, 500),
      maxTokens: 12,
      cheap: true,
    });
    const label = result.text.trim().toLowerCase();
    const valid: ReplySignal[] = [
      "ack",
      "confused",
      "why-question",
      "code-paste",
      "refusal",
      "stop",
      "other",
    ];
    signal = (valid as readonly string[]).includes(label)
      ? (label as ReplySignal)
      : "other";
  } catch (err) {
    console.warn(
      `[protege] reply classifier LLM failed: ${
        err instanceof Error ? err.message : String(err)
      } — defaulting to "other"`
    );
    signal = "other";
  }

  // LRU-ish: drop oldest entry if at cap.
  if (replyClassifierCache.size >= REPLY_CACHE_MAX) {
    const firstKey = replyClassifierCache.keys().next().value;
    if (firstKey !== undefined) replyClassifierCache.delete(firstKey);
  }
  replyClassifierCache.set(key, signal);
  return signal;
}

/**
 * Classify the user's reply during a lesson. Hybrid:
 *
 *   1. Strong regex fast-paths for unambiguous cases (zero latency).
 *      Covers ~70-80% of replies in practice.
 *   2. For text that doesn't match a fast-path strongly, fall back to
 *      one LLM call (cached, cheap-tier model, ~200ms).
 *
 * The cutoff between "strong" and "ambiguous" is short replies. A
 * 4-word "ok got it now" matches ACK strongly. A 25-word reply with
 * "ok" buried inside might be doing something else — let the LLM decide.
 */
async function classifyReply(text: string): Promise<ReplySignal> {
  const t = text.trim();
  if (t.length === 0) return "other";

  // Fast paths for clearly unambiguous shapes
  if (STOP_RE.test(t)) return "stop";
  if (CODE_PASTE_RE.test(t)) return "code-paste";

  const wordCount = t.split(/\s+/).filter((w) => w.length > 0).length;

  // Strong, short matches go through regex — full obvious cases
  if (wordCount <= 4 && ACK_RE.test(t)) return "ack";
  if (wordCount <= 6 && CONFUSED_RE.test(t)) return "confused";
  if (wordCount <= 4 && REFUSAL_RE.test(t)) return "refusal";
  if (
    wordCount >= 3 &&
    wordCount <= 18 &&
    WHY_QUESTION_RE.test(t)
  )
    return "why-question";

  // Anything longer or weirder → ask the LLM
  const llmSignal = await classifyReplyLLM(t);

  // Defensive: if the LLM classifies a longish reply as "stop", treat
  // as "other" instead. Real stop intents are short ("stop", "cancel",
  // "nevermind"). Long replies that get tagged "stop" are usually the
  // model misreading something else — and the cost of a false-positive
  // stop is high (the lesson session terminates, banner disappears,
  // user has to start over).
  if (llmSignal === "stop" && t.split(/\s+/).length > 4) {
    console.log(
      `[protege] lesson classifier ignored long-reply "stop" signal: ${t.slice(0, 60)}`
    );
    return "other";
  }
  return llmSignal;
}

function classifyLevel(text: string): LessonLevel {
  const t = text.trim();
  if (LEVEL_EXPERT_RE.test(t)) return "expert";
  if (LEVEL_COMFORTABLE_RE.test(t)) return "comfortable";
  if (LEVEL_ZERO_RE.test(t)) return "zero";
  if (t.split(/\s+/).filter((w) => w.length > 0).length < 4) return "zero";
  return "unknown";
}

/* ─── Plan generator (one upfront LLM call) ───────────────────────── */

const PLAN_SYSTEM_PROMPT = `You are a curriculum planner for a 1:1 coding tutor. Output a step-by-step JSON plan to teach a programming concept.

# CORE RULE — ONE ATOMIC ACTION PER STEP
Every step is ONE single action with exactly ONE code block max. If a concept has 3 useEffect patterns to show, that's 3 separate SHOW-CODE steps, NOT one step labeled "show three patterns". If the user must add 3 imports, that's 3 separate DO-IT-NOW steps. Granularity wins — better to plan 12 atomic steps than 4 packed ones. The bot will deliver each step as its own short message, with the user replying between every step.

# Step types
- EXPLAIN-ATOM: ONE fact / definition / why-something-works (NO code, NO multiple ideas)
- SHOW-CODE: ONE 3-7 line code example with a one-sentence caption
- DO-IT-NOW: tells the user to add ONE specific code snippet somewhere; ONE fenced block
- TASK-SOLO: user writes their own version from scratch (no code given)
- REVIEW: bot reviews the user's pasted code (always after TASK-SOLO)
- CLOSE: brief wrap, offer next concept or end

# Step count — YOU decide, no defaults
There is NO target count. Pick the SMALLEST number of steps that actually teaches THIS specific concept at THIS user's level. The plan length is a function of the concept's surface area, not a quota.

Calibration examples (do not anchor to these — the right number for a given concept varies wildly with user level and scope):
- "what does || do" for an expert → 2 steps (one EXPLAIN-ATOM, one CLOSE). Don't pad.
- "ternary operator" for a zero → 4-6 steps.
- "useState basics" → 6-9 steps.
- "useEffect with cleanup" → 9-14 steps.
- "set up Redux Toolkit with async thunks and middleware" → 18-30 steps.
- "wire OAuth login end-to-end" → 25+ steps.

Hard rule: if the concept can be honestly taught in 2 steps for this user, output 2 steps. Padding a tiny concept to 8 steps wastes the user's time and breaks trust. Conversely, if a setup truly needs 24 atomic actions, output 24 — DON'T compress to fit some imagined ceiling. NEVER default to 10.

Before you write the array, mentally answer: "What's the absolute minimum the user must learn here, given their level?" Then plan ONLY those steps.

# Composition rules
- Lead with EXPLAIN-ATOM (mental model) before any code
- Pattern: EXPLAIN-ATOM → SHOW-CODE → DO-IT-NOW alternates well; user gets concept → sees → does
- DO-IT-NOW steps build progressively — one tiny addition each. NEVER pack multiple imports/effects into one DO-IT-NOW.
- Always end with: TASK-SOLO → REVIEW → CLOSE
- Adjust depth to user level: zero=more EXPLAIN-ATOM beats and gentler progression; expert=skip basics

# Concept fidelity (DON'T silently substitute)
Teach the concept the user actually asked about, not your best guess at what they "should" want. If they typed "loops" at zero level, teach plain JS loops (for / while / forEach) FIRST — even if the active file has arrays you could map over. The framework-y version (e.g. .map() for React lists) belongs LATER in the same lesson, after the basics, OR as a follow-up CLOSE suggestion. Same logic for "conditionals" (cover if/else before ternary), "functions" (declaration before arrow), etc. The active file informs grounding, but it doesn't change WHICH concept you're teaching.

# GROUNDED PLANNING — when an active file is provided
If the user has an active file (a # ACTIVE FILE block follows the concept), the plan MUST be grounded in that file. This is what makes teaching feel 1:1 instead of generic.

Hard rules when grounded:
- The first EXPLAIN-ATOM must reference something concrete already in the file. Open with the user's actual variable / function / pattern, not an unrelated analogy. Example for "loop in react" with a file containing \`const views = [...]\`: step 1 summary = "We're going to render \`views\` as a list — that array on line 9.", NOT "JSX expressions with curly braces let you embed JS."
- DO-IT-NOW step summaries must name the EXACT line / anchor where the change goes ("Add a \`{views.map(...)}\` block right after the opening \`<div>\` on line 19"), not vague ("Add a map block to your component").
- Use the user's actual variable names in step summaries ("map over \`views\`", not "map over an array"). The runtime sees those names and understands the concept lives in their code, not abstract JS.
- Pick examples that fit THIS file's stack and shape. If the file is a Next.js client component with useState, don't show class components. If there's already a partial implementation (e.g. \`const views = [...]\` but no \`.map\`), the lesson should walk to completing it, not start from scratch.
- If the concept truly doesn't appear in the file (user typed "teach me Redux" in a vanilla React file), say so by leading with a SHOW-CODE step that introduces a fresh tiny example, then a DO-IT-NOW that adds it to their file. Don't pretend grounding when there's nothing to ground on.

# Output format
A JSON array. Each element = {"type": "...", "summary": "...", "code": "..."?}.
- summary: ONE concrete sub-action (e.g. "Add useEffect to React import line", NOT "Set up useEffect with three patterns"). When grounded in an active file, summary should name a real variable or line from that file.
- code: REQUIRED for SHOW-CODE and DO-IT-NOW. Must be 3-7 lines, ONE example only. When grounded, prefer code that fits the user's existing variables (e.g. \`views.map(...)\` not \`items.map(...)\` if the file uses \`views\`).

NO PROSE around the array. Start with [, end with ].`;

export interface PlannerActiveFile {
  path: string;
  content: string;
  language?: string;
}

export async function planLesson(
  concept: string,
  level: LessonLevel,
  activeFile?: PlannerActiveFile
): Promise<PlannedStep[]> {
  // Truncate file content so a 4000-line file doesn't blow our token
  // budget. The first ~3000 chars are usually enough for the planner to
  // see imports, state, structure, and any existing relevant pattern.
  const fileBlock = activeFile
    ? `\n\n# ACTIVE FILE\nPath: ${activeFile.path}${activeFile.language ? ` (${activeFile.language})` : ""}\n\`\`\`${activeFile.language ?? ""}\n${activeFile.content.slice(0, 3000)}\n\`\`\`\n\nGround the plan in this file. Reference real variables, line ranges, and the existing structure. See "GROUNDED PLANNING" rules in the system prompt.`
    : "";

  const userPrompt = `Concept: ${concept}
User level: ${level === "unknown" ? "zero (default when uncertain)" : level}${fileBlock}

Output the JSON plan now.`;

  let raw: string;
  try {
    const result = await callOneShot({
      systemText: PLAN_SYSTEM_PROMPT,
      userText: userPrompt,
      maxTokens: 1500,
      cheap: true,
    });
    raw = result.text;
  } catch (err) {
    console.warn(
      `[protege] planLesson failed for "${concept}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to default plan`
    );
    return defaultPlan(concept, level);
  }

  // Extract JSON array — model may wrap in prose despite instructions.
  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");
  if (arrayStart < 0 || arrayEnd <= arrayStart) {
    console.warn(
      `[protege] planLesson returned no JSON array — falling back. Raw: ${raw.slice(0, 200)}`
    );
    return defaultPlan(concept, level);
  }
  const jsonText = raw.slice(arrayStart, arrayEnd + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.warn(
      `[protege] planLesson JSON parse failed: ${err} — falling back`
    );
    return defaultPlan(concept, level);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return defaultPlan(concept, level);
  }

  const validTypes: StepType[] = [
    "EXPLAIN-ATOM",
    "SHOW-CODE",
    "DO-IT-NOW",
    "TASK-SOLO",
    "REVIEW",
    "CLOSE",
  ];
  const cleaned: PlannedStep[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = String(r.type ?? "").toUpperCase().replace(/_/g, "-");
    if (!validTypes.includes(type as StepType)) continue;
    const summary = typeof r.summary === "string" ? r.summary.slice(0, 200) : "";
    const code = typeof r.code === "string" ? r.code.slice(0, 800) : undefined;
    cleaned.push({ type: type as StepType, summary, code });
  }

  if (cleaned.length === 0) return defaultPlan(concept, level);

  // Defensive: if the model didn't end with TASK-SOLO → REVIEW → CLOSE,
  // append the missing tail so every lesson has a practice + review
  // moment.
  const tailHasReview = cleaned.some((s) => s.type === "REVIEW");
  const tailHasTask = cleaned.some((s) => s.type === "TASK-SOLO");
  if (!tailHasTask)
    cleaned.push({
      type: "TASK-SOLO",
      summary: `User writes their own minimal use of ${concept}`,
    });
  if (!tailHasReview)
    cleaned.push({
      type: "REVIEW",
      summary: "Review user's pasted code from previous step",
    });
  const lastIsClose = cleaned[cleaned.length - 1]?.type === "CLOSE";
  if (!lastIsClose)
    cleaned.push({
      type: "CLOSE",
      summary: `Wrap up ${concept} and offer one adjacent concept`,
    });

  return cleaned;
}

/** Fallback plan when the LLM planner fails. Tries a curated plan
 *  first (handcrafted for common concepts like useEffect, Promises,
 *  closures, etc.); falls back to a generic 6-step template only when
 *  no curated plan matches. */
function defaultPlan(concept: string, _level: LessonLevel): PlannedStep[] {
  const curated = findCuratedPlan(concept);
  if (curated) {
    console.log(
      `[protege] using curated fallback plan for "${concept}" (${curated.length} steps)`
    );
    return curated;
  }
  return [
    {
      type: "EXPLAIN-ATOM",
      summary: `Define what ${concept} is and what problem it solves`,
    },
    {
      type: "SHOW-CODE",
      summary: `Minimal example of ${concept}`,
    },
    {
      type: "DO-IT-NOW",
      summary: `User adds the example to their project`,
    },
    {
      type: "TASK-SOLO",
      summary: `User writes their own use of ${concept}`,
    },
    {
      type: "REVIEW",
      summary: `Review user's code`,
    },
    {
      type: "CLOSE",
      summary: `Wrap up ${concept}`,
    },
  ];
}

/* ─── Step advancement (the runtime adaptation) ───────────────────── */

/**
 * Compute the next step the bot should deliver, given the current
 * session and the user's most recent message. Mutates the session in
 * place (and persists in the in-memory map).
 *
 * Return shape: the same updated session. Caller reads `session.phase`,
 * `session.plan`, `session.stepIndex` to know what comes next.
 */
export async function advanceStep(
  session: LessonSession,
  userReply: string,
  _activeFile?: PlannerActiveFile
): Promise<LessonSession> {
  const next: LessonSession = { ...session, lastTurnAt: Date.now() };
  const signal = await classifyReply(userReply);

  // Hard kill from any phase.
  if (signal === "stop") {
    next.phase = "DONE";
    deleteSession(session.userId);
    return next;
  }

  // Track recent turns regardless of phase — used by flow prompt.
  next.recentTurns = [...(next.recentTurns ?? []), userReply].slice(-8);

  if (next.phase === "PROBE") {
    // User just answered the probe — classify level, drop into FLOW.
    // No upfront plan generation. The bot decides each turn what to
    // teach next based on full context (concept, level, history,
    // coverage so far). Plan stays empty; lesson is purely adaptive.
    next.level = classifyLevel(userReply);
    next.phase = "TEACHING";
    next.stepIndex = 0;
    next.turn = 0;
    next.coverage = [];
    next.stuckCount = 0;
    next.recentBeats = [];
    next.plan = []; // no preset plan — bot improvises per turn
    setSession(next);
    console.log(
      `[protege] lesson FLOW started · concept="${next.concept}" · level=${next.level}`
    );
    return next;
  }

  if (next.phase !== "TEACHING") return next;

  // ── FLOW phase — adaptive per-turn ─────────────────────────────
  // No plan walking. Just update state; the next bot turn reads this
  // and the flow prompt decides what to deliver.
  next.turn = (next.turn ?? 0) + 1;

  if (signal === "confused") {
    next.stuckCount = (next.stuckCount ?? 0) + 1;
  } else if (signal === "ack" || signal === "code-paste") {
    next.stuckCount = 0;
  }

  // Code paste → next turn reviews it.
  if (signal === "code-paste") {
    next.pendingReviewCode = userReply;
    next.awaitingTaskPaste = false;
  }

  // Redundancy frustration — user's reply signals "you're making me
  // repeat myself, I already said this". Sets a flag the next turn's
  // prompt reads to force a wrap-or-choice beat (instead of pushing
  // yet another variation the user already understands). Without this,
  // a confident user who's nailed the concept gets dragged through 3
  // more variations before the bot decides to wrap.
  // Typo-tolerant: "already" → also matches "arleady" / "alredy" /
  // "alreday"; "discussed" → "dicussed" / "dicuss" / "disccused" /
  // "discus". Real users type fast and we want this signal to fire.
  const ALREADY = "(?:already|arleady|alredy|alreday|alraedy)";
  const DISCUSS = "(?:discus(?:s|sed)?|dicus(?:s|sed)?|disccus(?:s|sed)?|dicccussed)";
  const REDUNDANCY_RE = new RegExp(
    `\\b(told\\s+you|${ALREADY}\\s+(?:said|told|${DISCUSS}|covered|knew|did|got)|we\\s+(?:${DISCUSS}|covered|did)\\s+(?:this|that|it)|i\\s+said|you\\s+(?:asked|said)\\s+(?:${ALREADY}|that)|same\\s+(?:thing|answer)|yes\\s+${ALREADY})\\b`,
    "i"
  );
  next.redundancyFrustration = REDUNDANCY_RE.test(userReply);

  // Refusal during a task → push back once, then back off (don't trap user).
  if (signal === "refusal" && next.awaitingTaskPaste) {
    next.failCount = (next.failCount ?? 0) + 1;
    if (next.failCount >= 2) {
      next.awaitingTaskPaste = false;
    }
  }

  setSession(next);
  return next;
}

/* ─── (Removed: plan-walking momentum/reviser — now handled per-turn
       in the FLOW prompt directly.) ─────────────────────────────── */

/* ─── Per-step prompt generator ──────────────────────────────────── */

/**
 * Build the per-turn system prompt addendum for the upcoming bot
 * message. The prompt is TIGHT and TYPE-SPECIFIC — the model has no
 * room to drift into wall-of-text mode.
 *
 * For PROBE phase: returns the probe instruction.
 * For TEACHING phase: returns the prompt for the step at session.stepIndex.
 */
export function generateStepPrompt(
  session: LessonSession,
  _userReply: string,
  opts: {
    voice?: boolean;
    /** Current active file content (so we can diff against
     *  session.lastFileHash and signal "user acted / did not act"). */
    activeFile?: { path: string; content: string };
    /** Seconds since the user's last reply landed. Bot reads this to
     *  match pace — fast replies = tight beats, long pauses = they
     *  might be working through code. */
    secondsSinceLastTurn?: number;
    /** Compressed user-memory hint — comma-separated concept names the
     *  user has mastered + their general profile if known. Used by the
     *  PROBE prompt so the bot can SKIP the "are you beginner" question
     *  when memory already shows they have React/JS experience. */
    learnerHint?: string;
  } = {}
): string {
  const voice = opts.voice === true;
  if (session.phase === "PROBE") {
    const learnerHint = opts.learnerHint?.trim();
    const memoryAware = learnerHint && learnerHint.length > 0
      ? `\n# WHAT YOU ALREADY KNOW ABOUT THIS USER\n${learnerHint}\n\nIMPORTANT: Use this knowledge to SKIP redundant questions. If memory shows they already use React/JS comfortably, DON'T ask "are you beginner or comfortable" — that's insulting. Instead, ask a TIGHTER question that just disambiguates the SCOPE/FLAVOR (e.g. for/while/forEach? client-side or with hooks?). If the concept is unambiguous AND memory already implies their level, skip the question entirely and output a one-line nod ("Got it — let's tie this to your \`todos\` array.") that ends with a tiny check-in like "ready?".`
      : `\n# NO MEMORY YET ABOUT THIS USER\nGauge BOTH (a) their level (zero/comfortable/expert) and (b) flavor disambiguation in ONE question. Ambiguous concepts ("loops", "conditionals", "functions") need 2-3 flavor options listed.`;

    return [
      `# ACTIVE LESSON: ${session.concept}`,
      `# CURRENT PHASE: PROBE`,
      memoryAware,
      ``,
      `STRICT: ≤25 words, end with "?", conversational. Don't lead toward an answer. NO teaching content yet.`,
      `Output ONLY the question (or the one-line nod if you're skipping the level question per the memory rule above).`,
    ].join("\n");
  }

  if (session.phase === "DONE") {
    return ""; // shouldn't be called
  }

  // ── FLOW prompt — open-ended adaptive prompt, no plan walking ────
  // Philosophy: hand the model the full state of this lesson and a
  // teaching mandate. Don't enumerate "step types" or fire turn-based
  // hints — both make the bot mechanical. The only hardcoded guard is
  // the stuck-loop pivot, because that's a specific failure mode the
  // model otherwise misses (it'll happily rephrase the same beat).
  const lvlDesc =
    session.level === "zero"
      ? "ZERO (assume nothing — start from absolute basics)"
      : session.level === "comfortable"
        ? "COMFORTABLE (skip definitions; they know the basics)"
        : session.level === "expert"
          ? "EXPERT (skip the why; just the sharp edges and gotchas)"
          : "UNKNOWN (default to zero)";

  const turn = session.turn ?? 0;
  const coverage = session.coverage ?? [];
  const recentBeats = session.recentBeats ?? [];
  const stuckCount = session.stuckCount ?? 0;
  const recentTurns = session.recentTurns ?? [];

  // ── File-diff awareness ─────────────────────────────────────────
  // Two signals combine to tell the AI what just happened to the file:
  //   1. fileChanged = current hash !== lastFileHash
  //   2. botEditedLast = bot called edit_file in its previous turn
  //
  // Cross-product:
  //   changed + botEdited     → user accepted bot's diff
  //   changed + !botEdited    → user manually edited
  //   !changed + botEdited    → user hasn't accepted bot's diff yet
  //   !changed + !botEdited   → no changes either way
  //
  // Without this 4-state signal the bot can attribute its OWN edits
  // to the user ("you added the loop on line 12!") which is confusing
  // when the bot itself wrote that line via edit_file last turn.
  let fileDiffSignal = "";
  if (opts.activeFile && session.lastFileHash !== undefined && turn >= 1) {
    const samePath = opts.activeFile.path === session.lastFilePath;
    const sameContent = quickHash(opts.activeFile.content) === session.lastFileHash;
    const botEditedLast = session.lastBotEditedFile === true;

    if (!samePath) {
      fileDiffSignal = `\n\n## FILE STATE: USER SWITCHED FILES\nActive file is now ${opts.activeFile.path} (was ${session.lastFilePath ?? "unknown"}). They may have moved on, or be looking at related code. Acknowledge briefly if relevant.`;
    } else if (sameContent && botEditedLast) {
      fileDiffSignal = `\n\n## FILE STATE: USER HASN'T ACCEPTED YOUR PREVIOUS EDIT YET\nYou called edit_file last turn, but the file content is BYTE-IDENTICAL to before. The diff is probably still sitting in their editor waiting for them to accept. Don't assume your edit landed. Nudge them to accept, OR offer a chat-block alternative they can paste manually.`;
    } else if (sameContent && !botEditedLast) {
      fileDiffSignal = `\n\n## FILE STATE: USER DID NOT EDIT THE FILE SINCE YOUR LAST BEAT\nThe active file (${opts.activeFile.path}) is BYTE-IDENTICAL to what it was after your last reply. If your last beat asked them to type or change something, they didn't do it yet (or didn't save). React to that — gently nudge ("did you save?", "want me to add it for you with edit_file?") rather than assuming they followed through.`;
    } else if (!sameContent && botEditedLast) {
      fileDiffSignal = `\n\n## FILE STATE: USER ACCEPTED YOUR EDIT\nThe file changed since your last beat AND you called edit_file last turn. They accepted your diff. Acknowledge briefly ("nice, that landed") and move forward — don't say "you added X" because YOU added X. Reference the change as something the bot just placed; ask them to predict / observe / extend.`;
    } else {
      fileDiffSignal = `\n\n## FILE STATE: USER MANUALLY EDITED THE FILE\nThe file changed since your last beat AND you did NOT call edit_file last turn. The user typed something themselves. React to the actual change — name it specifically. If they added what you asked for, acknowledge it ("nice, you got the for-loop in"). If they did something different, gently reflect ("I see you put it inside the return — that'll work, but try moving it above for clarity").`;
    }
  }

  // ── Pace awareness ──────────────────────────────────────────────
  // Long pauses suggest the user is actually working through code;
  // instant replies suggest a quick ack or skim. Bot reads this so it
  // can match the user's tempo (don't push fast on someone clearly
  // working; don't pad out a beat for someone moving quickly).
  const secs = opts.secondsSinceLastTurn;
  const paceSignal = typeof secs === "number" && secs >= 0
    ? secs >= 45
      ? `\n\n## PACE: SLOW (${Math.round(secs)}s since last reply)\nThe user took their time. They might be reading, typing, or working through code in their editor. Don't rush them — let your beat give them room.`
      : secs <= 6
        ? `\n\n## PACE: FAST (${Math.round(secs)}s since last reply)\nThe user is moving quickly. Tight beat. No padding.`
        : ""
    : "";

  // The ONE hardcoded guard. Models otherwise rephrase the same beat
  // when the user signals confusion repeatedly. We force a shape change.
  const stuckGuard = stuckCount >= 2
    ? `\n\n## STUCK-LOOP DETECTED (priority signal)\nThe user has signaled confusion ${stuckCount} consecutive turns. Rephrasing the same atom again will fail — the model that wrote those last beats is the one the user just rejected. You MUST change shape this turn. Do not output another paragraph that explains the same thing differently. Pick something the previous beats did NOT do: ask THEM what's fuzzy with concrete options, drop pure code with no words, hand them a tiny do-it task, OR back up to a more fundamental atom they might be missing.`
    : "";

  // Redundancy frustration — user just said "told you already" / "we
  // discussed this" / etc. This is THE strongest signal that the lesson
  // has reached its useful end for this user. Force a wrap-or-choice
  // beat — DO NOT push another variation.
  const redundancyGuard = session.redundancyFrustration
    ? `\n\n## USER SIGNALED REDUNDANCY (priority signal)\nThe user's last reply indicates they feel you're repeating yourself ("told you already", "we discussed this", "i said", etc.). Pushing another variation now will frustrate them further. THIS TURN you MUST do ONE of:\n  (a) WRAP the lesson — set wrap=true, give a one-sentence recap of what they covered, offer ONE adjacent concept as a follow-up.\n  (b) Offer a clear three-way choice — "want to go deeper into [edge case], try this on YOUR \`todos\`, or wrap?" — and let them pick.\nDo NOT continue with another while/for variant. They're done with the basics; you either wrap or they tell you what's next.`
    : "";

  // Wrap-offer threshold — once the user has cleanly absorbed a few
  // atoms with no recent confusion or redundancy, the bot should pause
  // and offer a CHOICE rather than auto-pushing more variations. Keeps
  // the lesson from becoming an endless drill.
  const shouldOfferChoice =
    coverage.length >= 3 &&
    stuckCount === 0 &&
    !session.redundancyFrustration &&
    !session.pendingReviewCode &&
    !session.awaitingTaskPaste &&
    turn >= 4;
  const offerChoiceHint = shouldOfferChoice
    ? `\n\n## OFFER CHOICE NOW (the user has absorbed the basics)\nThey've cleanly covered ${coverage.length} atoms over ${turn} turns. Don't auto-push another variation — pause and let them steer. End this beat with a brief three-way choice: deeper edge case, try on their actual code, or wrap. Pick the wording yourself — concrete and short. If they answer with a clear "wrap" / "done" / "i'm good", the NEXT turn must set wrap=true.`
    : "";

  // Pasted code → review state.
  const reviewState = session.pendingReviewCode
    ? `\n\n## CODE THE USER JUST PASTED (review it now)\n\`\`\`\n${session.pendingReviewCode.slice(0, 600)}\n\`\`\``
    : "";

  const coverageBlock = coverage.length > 0
    ? `\n\n## What you've taught so far this lesson\n${coverage.map((c) => `  - ${c}`).join("\n")}`
    : "";

  const recentBeatsBlock = recentBeats.length > 0
    ? `\n\n## Your recent beats (oldest → newest) — do not redeliver any of these\n${recentBeats.map((b, i) => `  ${i + 1}. ${b}`).join("\n")}`
    : "";

  const recentTurnsBlock = recentTurns.length > 0
    ? `\n\n## Recent user replies (oldest → newest) — read these to gauge state\n${recentTurns.map((r) => `  · ${JSON.stringify(r.slice(0, 120))}`).join("\n")}`
    : "";

  // Voice channel: ZERO chat UI. The user keeps the sidebar closed,
  // listens, and watches their editor. Anything code-shaped MUST go
  // through edit_file (lands in file) or highlight_code (silent
  // pointer). Chat code blocks are dead weight — they can't be heard
  // and won't be read. The validator backs this up by stripping any
  // fenced blocks the model emits anyway.
  const voiceContract = voice
    ? `\n\n## VOICE CHANNEL — ZERO-UI MODE (CRITICAL)\nThe user is LISTENING + watching their editor. Their chat sidebar may be CLOSED. Your reply gets spoken aloud; the chat-panel display ALSO strips code (fenced blocks, inline code, anything with braces/semicolons/assignments). The whole point of voice mode is the user doesn't need the chat panel at all — they hear you and watch their file.\n\n## NON-NEGOTIABLE RULES\n- NEVER emit a fenced code block (\\\`\\\`\\\`) — stripped before render.\n- NEVER write code inline as prose (\`let i = 0 while (i < 3) { ... }\`) — also stripped, leaving a broken-looking sentence.\n- ANY code that needs to exist in the user's file → CALL edit_file. The diff appears in their editor; THAT is your code surface, not chat.\n- Want the user to ADD code? You MUST call edit_file with the new code. Don't ask them to "type this" or "add this above" without actually writing it via edit_file. Pointing with highlight_code at code that doesn't exist yet is broken UX — the highlight lands on irrelevant code (the line under it) and the user has nothing to type because the code never made it to chat or file.\n- ANY existing code reference → call highlight_code on the line that ALREADY EXISTS. Highlights are for code that's REAL and visible right now in the file.\n- ≤18 words of prose per turn. Short. Listeners tune out fast.\n- Contractions, fragments, conversational rhythm. Not written prose.\n- NO inline backtick code — \`for(let i=0;i<3;i++)\` is unintelligible spoken AND stripped from chat. Rephrase as words ("a for-loop counting up to three").\n- ONE BEAT PER TURN. Don't write "do X" then "now do Y" — that's two beats. Wait for them to do X first.\n\n## DECISION RULE — edit_file vs highlight_code\nBefore you mention code in your reply, decide:\n  • Does this code EXIST in the file right now? → highlight_code on the existing line, speak about it.\n  • Does this code need to be ADDED? → edit_file to write it, THEN optionally highlight the new line.\nNever reference code that exists only in your imagination. If you can't reach for highlight or edit_file to make it visible, don't mention it.\n\n## SYNCHRONIZE HIGHLIGHT + SPEECH\nTool calls fire BEFORE the spoken text plays. So when you call highlight_code, the highlight appears on screen exactly as TTS starts. Use this:\n- Call highlight_code on the SPECIFIC line you're about to talk about.\n- Phrase your speech to REFERENCE the highlight: "see this line — i++ is what eventually stops the loop", NOT "i++ is the increment" (abstract; they don't know what you're pointing at).\n- One highlight per beat. Multiple highlights compete for attention.\n- Pure conceptual beat (no specific line)? Skip highlight_code, just speak.\n\nGood: edit_file inserts a while-loop on line 5 + highlight_code on the new \`while (i < 3)\` line + speak "I dropped a counter loop above your return — see the gate I highlighted. When i hits 3, it stops. Refresh and tell me what printed."\nBad: highlight_code on \`return (\` + speak "Add this above the return: ... what printed?" — broken, no code was added, the highlight points at irrelevant code, and the user has nothing to refresh.`
    : "";

  return [
    `# YOU ARE A 1:1 HANDS-ON CODING TUTOR`,
    `Concept: ${session.concept}`,
    `User level: ${lvlDesc}`,
    `Turn: ${turn} of this lesson (no preset count — you decide pacing)`,
    voiceContract,
    coverageBlock,
    recentBeatsBlock,
    recentTurnsBlock,
    fileDiffSignal,
    paceSignal,
    stuckGuard,
    redundancyGuard,
    offerChoiceHint,
    reviewState,
    ``,
    `## THE TEACHING STYLE — NON-NEGOTIABLE`,
    `This is HANDS-ON 1:1 teaching. The user learns by DOING + briefly UNDERSTANDING. Every turn weaves a tiny piece of insight with a tiny action.`,
    ``,
    `Each turn is roughly: ONE sentence of insight (the WHY), then ONE concrete thing for them to do, then ONE quick check. Or after they've done something: a ONE-sentence explanation of what they just saw, then the next move.`,
    ``,
    `RIGHT shape examples:`,
    `  "A for loop has three parts: start, condition, step. Type this in your file: \`for (let i = 0; i < 3; i++) console.log(i)\`. What did the console show?"`,
    `  "0 1 2 because \`i < 3\` stops BEFORE i hits 3. Now change \`<\` to \`<=\` and run again. What changed?"`,
    `  "Right — \`i++\` is what makes it actually advance. Remove that line and tell me what happens (don't worry, you can stop the page)."`,
    ``,
    `WRONG shapes (do not do these):`,
    `  - All-action, zero-explanation: "Type X. Run it. What did you see?" repeated turn after turn — feels like a quiz, not teaching. The user can't connect WHAT they typed to WHY it works.`,
    `  - Theory paragraph: "What a loop is: a way to repeat code... The three basics we'll cover are for, while, forEach..." — that's a textbook intro, not 1:1.`,
    `  - Repeating yourself: if your last beat said "type this for loop" and they reported the result, your NEXT beat must move forward (next concept, next tiny change, next reflection) — never re-issue the same instruction.`,
    ``,
    `## WHAT EVERY TURN MUST DO (STRICTLY)`,
    `1. **REACT** to what they just said (1 sentence: name what they saw, why it happened — only when they reported a result).`,
    `2. **TEACH ONE BIT — REQUIRED unless this is a pure react beat.** ONE concrete sentence about WHAT a piece of the syntax means. Examples: "\`i++\` adds 1 each loop, otherwise it'd run forever", "the second part \`i < 3\` is the stop condition — when false, loop exits", "\`<\` stops BEFORE the value, \`<=\` includes it". WITHOUT this teaching beat the lesson becomes a quiz: code → result → code → result, and the student doesn't actually learn what the parts do.`,
    `3. **GIVE ONE CONCRETE THING TO DO** — type / change / delete something specific. Required on every non-wrap turn. A bare "ready?" / "with me?" cue is NOT an action — it must be something they can type or change.`,
    ``,
    `Skip step 1 only on the very first beat after probe. Skip step 2 only when the user is clearly speeding ahead and asking for the next thing. NEVER skip step 3 unless wrapping. All three = 2-3 sentences total. Longer = lecturing.`,
    ``,
    `Failure modes to avoid:`,
    `  - All-action drill ("type X. type Y. type Z.") with NO insight beats. The user pastes results but doesn't understand WHAT the parts mean.`,
    `  - All-explanation paragraph with no action. Lecture, not 1:1.`,
    `  - Pure check-in cue ("Onward?") without a concrete next change. Stall.`,
    ``,
    `## CODE FORMATTING (chat mode, when active file might not be edited)`,
    `When you ask the user to type a snippet, ALWAYS show it in a fenced code block:`,
    "```",
    "for (let i = 0; i < 3; i++) console.log(i)",
    "```",
    `NOT inline. Inline code longer than ~5 chars renders as plain text and the user can't copy it cleanly. Backtick-fenced is non-negotiable for any code longer than a single identifier.`,
    ``,
    `## HARD RULES`,
    `- NO META-TALK. Never say "what we'll cover", "let's move on", "here's what you'll change". Just teach.`,
    `- ZERO REPETITION. If a beat is in your recent-beats list, you CANNOT redeliver it. Same instruction with slightly different words = still repeating. Move forward.`,
    `- TEACH WHAT THEY ASKED. For "${session.concept}": teach the literal concept. If "loops": for/while/forEach FIRST. Active file informs grounding; it doesn't substitute the concept.`,
    `- USE TOOLS. When you tell the user to type code, ALSO call highlight_code on a nearby line in their file so they see WHERE the new code goes. For larger additions, edit_file is even better — it writes the code directly so they see the diff. Don't make them guess where things go.`,
    ``,
    `## LENGTH BUDGET`,
    `2-3 short sentences max (≤45 prose words; code in fenced blocks doesn't count). One beat is one chat message — not a paragraph.`,
    ``,
    `## NATURAL ARC (loose guide, not a script — adapt freely)`,
    `Lessons usually feel like:`,
    `  Turns 1-2: foundation — one tangible sentence about what the thing IS, paired with the first concrete action they can do.`,
    `  Turns 3-5: build on it — add a wrinkle (change a parameter, swap a comparison, observe a new behavior). One small layer per turn.`,
    `  Turns 6-9: practice — hand them a tiny task they write SOLO, review what they paste, name what's right or wrong by quoting their actual code.`,
    `  Wrap when: they've owned a working pattern AND can predict outcomes (or they signal "done"/"got it" after a clean review).`,
    `Don't follow this rigidly — read the user. A confident user can skip ahead; a stuck user might need an extra turn at any stage.`,
    ``,
    `## START FROM THE ABSOLUTE BARE BASICS — CRITICAL FOR ZERO LEVEL`,
    `For level=ZERO or UNKNOWN: turns 1-3 MUST teach the plain-language, plain-language-of-JS version of the concept. NOT a framework-integrated pattern. NOT a complete React component. NOT a real-world handler with state. Just the syntax in isolation — usually 3-5 lines that print to console.log.`,
    ``,
    `Example for "while loops" at zero level — first beat looks like:`,
    "```js",
    "let i = 0",
    "while (i < 3) {",
    "  console.log('i is', i)",
    "  i++",
    "}",
    "```",
    `Caption: "While runs the body again and again as long as the condition is true. \`i++\` is what eventually makes it false. Run it — what printed?"`,
    ``,
    `WRONG first beat at zero level (do not do this):`,
    `  - A 15-line React component with a button, useState, event handler, AND a loop inside. The user can't see the loop because it's buried in framework code.`,
    `  - Anything that requires understanding state mutation, refs, or other React-specific concepts.`,
    `  - A pattern that combines 3+ ideas (loop + state + render + event).`,
    ``,
    `Only AFTER turns 1-3 of bare-syntax basics — once they've SEEN the loop work in console — can you start integrating with their React file. The active file is for grounding the LATER turns ("now let's loop your \`views\` array"), not the first beat.`,
    ``,
    `## CODE BLOCK SIZE BUDGET`,
    `- Turns 1-3: ≤6 lines per code block. ONE concept per block. No "complete component" examples.`,
    `- Turns 4+: ≤10 lines per block.`,
    `- A 15-line block with a button + handler + state + render + loop is ALWAYS wrong in a teaching beat. If you'd write that, you're teaching too many things at once — split into multiple turns.`,
    ``,
    `## OFFER CHOICE WHEN A SUB-PATTERN IS OWNED`,
    `When the user has clearly owned a sub-pattern (predicted output correctly twice in a row, or written code that worked on first try), don't just push them into the next variation. Pause and OFFER a choice — give them agency. Pattern:`,
    `  "Solid — you've got [X]. Next: dig deeper into edge cases (off-by-one, infinite loops), try this on YOUR \`todos\` array, or see how a for-loop expresses the same thing — pick one?"`,
    `Three concrete options, terse. Don't lecture about the options; let them pick. This is what separates a quiz from a real lesson — the user has steering.`,
    ``,
    `## ANALOGIES — USE SPARINGLY BUT INTENTIONALLY`,
    `Once or twice per lesson, drop a tight analogy that anchors the mental model. Examples: "the condition is the gate — when it flips false, the loop exits", "i++ is the engine — without it, you're stuck idling forever". One sentence. Not every turn — that becomes folksy. Pick the moment when the user just saw something concrete (e.g. removed i++ and got an infinite loop) and tie it to a mental hook.`,
    ``,
    `## WHEN TO WRAP`,
    `You decide. Wrap when the user has DONE the concept (typed code, observed output, can explain) — usually after 4-8 turns of real action. Don't pad once they've got it. Wrap with a one-sentence recap + one adjacent-concept offer.`,
    ``,
    `## CONTINUATION CUE`,
    `Non-wrap turns end with a brief check-in (e.g. "what'd you see?", "ran it?", "with me?") — in your own words, varied each turn.`,
    ``,
    `## REQUIRED META TAG (server uses, user never sees)`,
    `After your beat, on a new line, append a JSON tag describing what THIS specific beat just taught. The "covers" string must describe THIS beat's actual content, not be an example or placeholder.`,
    `Format (JSON, double-quoted keys):`,
    `  <beat>{"covers": "<description of THIS beat — concrete and specific, max 8 words>", "wrap": false}</beat>`,
    `Examples of GOOD covers values: "for-loop counter increments by one", "while loop with sentinel", "user typed first map call". BAD values: "label", "what you taught", "covers value", "≤8-word label" — those are meta-references, not descriptions.`,
    `Set "wrap": true ONLY for the closing beat.`,
    ``,
    `Output the user-facing beat first, then the meta tag on its own line. Nothing else.`,
  ].filter((l) => l.length > 0).join("\n");
}

/* ─── Post-reply validation (Tier 1: stop trusting the model) ────── */

/**
 * Strip every fenced code block from a reply. Used for step types that
 * disallow code (EXPLAIN-ATOM / WHY-ANSWER / TASK-SOLO).
 *
 * Also strips INLINE code that the model dodged by writing JSX/arrow
 * fragments without fences — e.g. "Example: {views.map(v => <div .../>)}".
 * The model uses this loophole to cram three examples into one EXPLAIN
 * step; the deterministic floor here drops any sentence that's clearly
 * code-shaped.
 */
// (Removed: stripCodeBlocks / stripInlineCodeSentences — FLOW mode
// always allows up to one fenced code block, no per-step type to strip
// against.)

/**
 * Keep at most ONE fenced code block. If the reply contains ≥2 blocks,
 * truncate at the start of the second block, then trim any trailing
 * incomplete sentence so the cut feels natural rather than abrupt.
 *
 * The model is told via the prompt to output exactly one block, but it
 * frequently ignores that under RLHF "be thorough" pressure. This is
 * the deterministic floor.
 */
/**
 * Hard cap on lines inside a single fenced code block. The model
 * sometimes emits a "complete component" example with 15+ lines for a
 * concept that should fit in 4 lines. This trims the block to the first
 * N content lines (excluding the fence delimiters) so the user gets a
 * focused snippet instead of a full file.
 */
function trimCodeBlockLines(text: string, maxLines: number): string {
  return text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g, (_full, lang, body) => {
    const lines = body.split("\n");
    if (lines.length <= maxLines) return `\`\`\`${lang}\n${body}\n\`\`\``;
    const trimmed = lines.slice(0, maxLines).join("\n");
    // Add a comment marker so the user knows the block was truncated
    // — they can ask for the rest if they want.
    return `\`\`\`${lang}\n${trimmed}\n// …(trimmed for focus — ask for full version if needed)\n\`\`\``;
  });
}

function keepFirstCodeBlock(text: string): string {
  const re = /```[\s\S]*?```/g;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push(m);
    if (matches.length >= 2) break;
  }
  if (matches.length < 2) return text;

  // Cut at the start of the second block, drop everything after.
  const cutPoint = matches[1].index;
  let truncated = text.slice(0, cutPoint).trimEnd();

  // If the cut left us mid-sentence, scan back to the last sentence
  // boundary so the user sees a clean ending. Only do this if the
  // boundary is in the second half of the truncated text — otherwise
  // we'd lose too much.
  if (!/[.!?]$/.test(truncated)) {
    const lastDot = Math.max(
      truncated.lastIndexOf("."),
      truncated.lastIndexOf("!"),
      truncated.lastIndexOf("?")
    );
    if (lastDot > truncated.length * 0.6) {
      truncated = truncated.slice(0, lastDot + 1);
    }
  }
  return truncated;
}

// (Removed: PROSE_WORD_CAPS per-step table — FLOW mode uses a single
// flat cap (80 words) since beats are decided per-turn, not by type.)

/** Count prose words, treating fenced code blocks as zero words. */
function countProseWords(text: string): number {
  const noCode = text.replace(/```[\s\S]*?```/g, " ");
  return noCode.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Trim a chunk of prose to at most maxWords, snapping to the last
 * sentence boundary at or below the budget. Falls back to a hard
 * word-boundary cut if no sentence boundary is found.
 */
function truncateProseAtSentence(prose: string, maxWords: number): string {
  const words = prose.split(/(\s+)/);
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    if (/\S/.test(words[i])) count++;
    if (count > maxWords) {
      const sliced = words.slice(0, i + 1).join("");
      const lastSent = Math.max(
        sliced.lastIndexOf("."),
        sliced.lastIndexOf("!"),
        sliced.lastIndexOf("?")
      );
      if (lastSent > sliced.length * 0.4) {
        return sliced.slice(0, lastSent + 1);
      }
      return sliced.trimEnd();
    }
  }
  return prose;
}

/**
 * Enforce a prose word cap on the reply, KEEPING fenced code blocks
 * intact. If the text past the last code block is what's blowing
 * budget, trim only that trailing prose. If the prose BEFORE the last
 * code block is already over cap (rare), drop the trailing prose
 * entirely — we don't chop code or its lead-in.
 */
function enforceWordCap(text: string, maxWords: number): string {
  if (countProseWords(text) <= maxWords) return text;

  // Locate the LAST fenced code block (if any).
  let lastIdx = -1;
  let lastEnd = -1;
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastIdx = m.index;
    lastEnd = m.index + m[0].length;
  }

  if (lastIdx < 0) {
    // Pure prose — straight sentence-boundary truncate.
    return truncateProseAtSentence(text, maxWords);
  }

  const pre = text.slice(0, lastEnd);
  const post = text.slice(lastEnd);
  const preWords = countProseWords(pre);
  const remaining = maxWords - preWords;
  if (remaining <= 0) {
    // Already at/over cap before the last code block — drop trailing.
    return pre.trimEnd();
  }
  const trimmedPost = truncateProseAtSentence(post, remaining);
  return (pre + trimmedPost).trimEnd();
}

/**
 * Enforce per-step output constraints AFTER the model replies. Two
 * orthogonal checks:
 *   1. Code-block count: stripCodeBlocks for prose-only phases,
 *      keepFirstCodeBlock for code phases.
 *   2. Prose word cap: per-step ceiling (~50% above prompt target),
 *      truncates at last sentence boundary if exceeded. Code blocks
 *      are preserved.
 *
 * The model often obeys EITHER constraint but not both — e.g., it
 * keeps code count low but rambles 200 prose words on EXPLAIN-ATOM.
 * Both checks run; either one fires independently.
 *
 * Returns the (possibly truncated) reply and a flag indicating
 * whether anything was modified (for logging).
 */
export function validateStepReply(
  reply: string,
  stepType: StepType,
  opts: { voice?: boolean } = {}
): { text: string; truncated: boolean } {
  if (!reply || reply.trim().length === 0) {
    return { text: reply, truncated: false };
  }

  // FLOW mode validator. ORDER MATTERS:
  //   1. Strip <beat> meta tag FIRST — if word-cap runs before this, it
  //      can chop off the </beat> close, leaving a malformed half-tag in
  //      the user-visible text (this was a real bug).
  //   2. THEN handle code blocks: strip ALL in voice mode (zero-UI), or
  //      keep ≤1 in chat mode.
  //   3. THEN apply prose word cap.
  let validated = reply.replace(/<beat>[\s\S]*?<\/beat>/gi, "").trimEnd();
  // Defensive: strip any orphaned <beat> opener if the closer was already
  // missing (model truncation, etc.) — we don't want raw "<beat>" leaking.
  validated = validated.replace(/<beat>[\s\S]*$/gi, "").trimEnd();

  if (opts.voice) {
    // Voice mode: ZERO fenced blocks reach the user. The model is told
    // not to emit them, but cheap-tier models slip. Strip every block
    // and replace with a brief inline note pointing the user at their
    // editor — TTS reads the note, code is wherever the bot put it
    // (edit_file diff or just a missing answer they need to ask about).
    validated = validated.replace(
      /```[a-zA-Z0-9_+-]*\n[\s\S]*?\n```/g,
      "(code — check your editor)"
    );
  } else {
    validated = keepFirstCodeBlock(validated);
    validated = trimCodeBlockLines(validated, 12);
  }
  validated = enforceWordCap(validated, opts.voice ? 30 : 70);

  // Empty-body guard: if the model output ONLY the meta tag (or some
  // other accident), the user sees a blank reply and the chat just
  // freezes. Fall back to a generic re-prompt so the user knows the
  // bot is still alive and it's their turn to nudge it.
  if (validated.trim().length < 5) {
    validated = "Quick check — what's the part that's fuzzy? The syntax, the why, or where the loop goes?";
  }

  // Suppress unused-warning for stepType — kept for backwards-compat
  // with the old typed validator interface.
  void stepType;

  return {
    text: validated,
    truncated: validated.length !== reply.length,
  };
}

/**
 * Parse the <beat>...</beat> meta tag from the bot's reply. Returns
 * { covers, wrap } or null if no tag is present. The chat route uses
 * this to update session.coverage and detect when the bot is wrapping
 * the lesson.
 */
export function parseBeatMeta(
  reply: string
): { covers: string; wrap: boolean } | null {
  const match = reply.match(/<beat>([\s\S]*?)<\/beat>/i);
  if (!match) return null;
  // Tolerate JS object literal syntax — gpt-5 frequently emits
  // {covers:"x",wrap:false} (no quotes around keys) instead of valid
  // JSON. Pre-process to add quotes around bare identifier keys.
  let raw = match[1].trim();
  raw = raw.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    let covers = typeof obj.covers === "string" ? obj.covers.slice(0, 200) : "";
    // Drop placeholder echoes — when the model copies the prompt's
    // example string instead of generating a real label.
    const placeholderRe =
      /^(≤?\d*\s*-?\s*word\s+label|<?description\s+of\s+this\s+beat>?|covers\s+value|label|placeholder|tiny\s+label)$/i;
    if (placeholderRe.test(covers.trim())) {
      covers = "";
    }
    const wrap = obj.wrap === true;
    return { covers, wrap };
  } catch {
    return null;
  }
}

/* ─── Mastery detection (used by P6 server-side enforcer) ─────────── */

/**
 * Returns true iff the just-completed step is a clean REVIEW pass —
 * user wrote correct code on first try, no fail+retry.
 */
export function isCleanMasteryPass(session: LessonSession): boolean {
  const step = session.plan[session.stepIndex];
  return (
    session.phase === "TEACHING" &&
    step?.type === "REVIEW" &&
    session.attempts === 1 &&
    session.failCount === 0
  );
}
