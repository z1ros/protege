import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRunRequest,
  ChatRunResponse,
  ChatTier,
  OAITurn,
  ToolCall,
} from "@protege/types";
import { MENTOR_SYSTEM_PROMPT } from "../anthropic.js";
import { callChat, getProvider } from "../llm.js";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { enforceQuotaInline, enforceCostCapOnly } from "../middleware/quota.js";
import {
  addCostUsd,
  addChatMinutes,
  addToolCalls,
  estimateCallCostUsd,
  checkToolCallLimit,
} from "../quotas.js";
import { buildSystemPrompt, buildLearnerBlock } from "../prompts/persona.js";
import {
  removeMemory,
  getMemorySnapshot,
  getRelevantMemories,
  openSession,
  touchSessionFile,
  type MemoryType,
} from "../store.js";
import { reconcileAndStore } from "../memoryReconciler.js";
import {
  getActiveSession,
  startSession,
  endSession,
  advanceStep,
  generateStepPrompt,
  extractConcept,
  classifyFirstMessageLLM,
  validateStepReply,
  parseBeatMeta,
  quickHash,
  type LessonSession,
} from "../lessons.js";

/**
 * Loose concept-equality check. Lesson concepts are user-typed strings
 * ("useEffect" vs "use effect" vs "useEffect cleanup"), so we normalize
 * to lowercase + alphanumerics and treat one as a substring of the
 * other as "same lesson". Strict equality would over-trigger concept
 * switches on cosmetic phrasing changes.
 */
function sameConcept(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}
import type { LessonStateSnapshot } from "@protege/types";

export const chatRoute = new Hono();

chatRoute.use("*", githubAuth());

/**
 * Tool-enabled chat using Claude Sonnet 4.5 with prompt caching.
 *
 * The wire format stays OAITurn[] (OpenAI-shaped) so the extension's
 * chatRunner.ts doesn't need to change. Internally we translate to
 * Anthropic's messages / content-block format per call.
 *
 * Prompt caching: the system prompt + tool definitions are marked with
 * cache_control: "ephemeral", so on repeat calls Anthropic reuses them
 * at ~10% of input token cost. Huge win for a mentor that makes many
 * multi-turn tool rounds per user question.
 */
/**
 * Map the client-side backend preference + tier to a concrete Anthropic
 * model id.
 *
 * TEMP (2026-04-18): Sonnet is disabled server-side for cost reasons.
 * Every cloud Anthropic call — regardless of the client's stated
 * preference — routes to Haiku, so cheap and premium currently collapse
 * to the same id on the Anthropic side. When Sonnet is re-enabled,
 * branch on `tier === "premium"` here.
 */
function resolveAnthropicModel(
  _backend: ChatRunRequest["backend"],
  _tier: ChatTier
): string {
  return process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5";
}

/**
 * Map the tier to a concrete OpenAI model id.
 *   Cheap   → gpt-4o-mini ($0.15/$0.60 per MTok)
 *             — chosen for Live Review scans + AI-block summaries.
 *             ~5× cheaper than Haiku for short lint-shaped prompts.
 *   Premium → gpt-4.1 ($2/$8 per MTok)
 * Both can be overridden via env: OPENAI_CHEAP_MODEL / OPENAI_MODEL.
 */
function resolveOpenAIModel(tier: ChatTier): string {
  if (tier === "cheap") {
    return process.env.OPENAI_CHEAP_MODEL ?? "gpt-4o-mini";
  }
  return process.env.OPENAI_MODEL ?? "gpt-4.1";
}

/**
 * Cap reply length by channel:
 *  - voice / voice-dialogue → 300 tokens (~150–200 words, 45–60s of speech
 *    max). Hard ceiling that prevents the LLM from unrolling a 3-paragraph
 *    explanation that the user will then sit through being read aloud.
 *    Soft pressure from the VOICE_MODE prompt + this hard cap together.
 *  - teaching → 1200 tokens. Tool-loop turns are shorter than full text
 *    but the terminal reply still needs room for context.
 *  - text → 4096 (no practical cap). Chat is scannable, long is fine.
 */
/**
 * Extract the concept name from a "concept" memory row. The teaching loop
 * writes these as `user owns: [name] — verified [date] via correct [thing]`
 * (see TEACHING_TEXT > "Marking mastery"). We just want the name.
 *
 * Returns null if the content doesn't match the expected prefix, so a
 * stray non-conforming row doesn't pollute the prompt with junk like
 * "verified" as a concept name.
 *
 * We split on the documented separator (space + em/en/hyphen + space) so
 * a hyphenated concept name like "non-blocking I/O" survives intact —
 * the prior version stopped at the first hyphen and produced "non".
 */
function parseOwnedConceptName(content: string): string | null {
  if (!/^user owns:/i.test(content)) return null;
  const body = content.replace(/^user owns:\s*/i, "");
  const sepIdx = body.search(/\s[—–-]\s/);
  const name = (sepIdx >= 0 ? body.slice(0, sepIdx) : body).trim();
  return name.length > 0 ? name : null;
}

/* ──────────────────────────────────────────────────────────────────────
 * Server-side P6 mastery enforcer
 *
 * The TEACHING_TEXT persona block instructs the model to call `remember`
 * after every clean YOUR-TURN pass. Haiku follows this maybe 30-50% of
 * the time — its RLHF training pushes it toward conservative tool-use
 * even when the prompt explicitly demands it. So we detect the mastery
 * moment ourselves on the server and write the memory row when the model
 * doesn't.
 *
 * Heuristic, not perfect — but deterministic and topic-agnostic. Three
 * signals must all match in the same turn:
 *
 *   1. Quiz-shape in the PRIOR assistant message (the question with a
 *      right answer)
 *   2. Substantive answer in the most recent USER message
 *   3. Acknowledgement words in the CURRENT assistant reply (the one
 *      we're about to send back)
 *
 * Concept name comes from the first teach-shaped user message in the
 * thread ("teach me X" → X). Concept-agnostic — works for any topic.
 *
 * Skipped automatically if the model already wrote a `concept` memory
 * itself this turn (no double-write).
 * ──────────────────────────────────────────────────────────────────── */

const QUIZ_PATTERNS: RegExp[] = [
  /\bin one sentence\b/i,
  /\bwhat'?s? the difference\b/i,
  /\bwhat (?:does|will) .{2,40}? (?:do|print|return|output|happen)\b/i,
  /\bwhat'?s? the (?:rule|gotcha|catch|trick|trap|trade.?off|key)\b/i,
  /\bexplain (?:that|it|this|why)\b.{0,40}?\b(?:in your own words|to me|back)\b/i,
  /\bsummari[zs]e\b.{0,40}?\b(?:in one|in a)\b/i,
  /\bspot the bug\b/i,
  /\bguess\s+what\s+(?:this|it|that)\s+(?:does|prints|returns)\b/i,
  /\bpaste\b.{0,20}\b(?:lines?|code|attempt)\b/i,
];

function detectQuizShape(text: string): boolean {
  return QUIZ_PATTERNS.some((p) => p.test(text));
}

const TRIVIAL_REPLIES =
  /^(ok|okay|yeah|yes|sure|yep|nope|hmm|huh|wait|wait what|got it|right|cool|fine|alright|continue)[!.?\s]*$/i;

function isSubstantiveAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length < 25) return false;
  const words = t.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 6) return false;
  if (TRIVIAL_REPLIES.test(t)) return false;
  return true;
}

const ACK_PATTERNS: RegExp[] = [
  /\b(?:locked in|exactly|nailed it|spot on|bang on|precisely)\b/i,
  /\bthat'?s (?:right|it|the (?:rule|distinction|whole thing|key|point)|exactly)\b/i,
  /\byou(?:'?ve)? got it\b/i,
  /\byou nailed (?:it|the)\b/i,
  // "Correct" alone, but not when followed by hedging ("correct, but…")
  /^correct(?:[!.]|\s+(?:and|—|–|-)|\s*$)/i,
];

function detectAcknowledgement(text: string): boolean {
  // Acknowledgement is almost always at the very start. Looking past the
  // first line invites false positives ("you'll see this is exactly the
  // pattern …" mid-explanation isn't an ack).
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return false;
  return ACK_PATTERNS.some((p) => p.test(firstLine));
}

const TEACH_TRIGGER_RE =
  /^(?:teach me|explain|show me|how does|what is|walk me through|i want to learn|help me understand|deep dive)\s+(.{4,80}?)\s*[?.!]?\s*$/i;

function extractConceptName(messages: OAITurn[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (!c) continue;
    const match = c.trim().match(TEACH_TRIGGER_RE);
    if (match && match[1]) {
      // Lop off "how X works" / "the basics of X" wrappers to keep the
      // concept name clean. Best-effort — fall through to raw if no
      // wrapper matches.
      let name = match[1].trim();
      name = name.replace(/^(?:how\s+)?(?:does\s+|do\s+)?/i, "");
      name = name.replace(/\s+(?:works?|behaves?|operates?)$/i, "");
      name = name.replace(/^(?:the\s+)?(?:basics\s+of\s+)?/i, "");
      return name.slice(0, 60);
    }
  }
  return null;
}

/** Find the assistant text from the turn BEFORE the current reply.
 *  Skips the most recent assistant turn (= the reply we're about to
 *  return) and returns the one before, ignoring empty/null contents
 *  (assistant turns whose entire content was a tool_use block). */
function findPriorAssistantText(messages: OAITurn[]): string | null {
  let assistantSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    if (assistantSeen === 0) {
      assistantSeen++;
      continue;
    }
    const c = messages[i].content;
    const text = typeof c === "string" ? c : "";
    if (text.trim().length > 0) return text;
  }
  return null;
}

function findLastUserText(messages: OAITurn[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const c = messages[i].content;
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return "";
}

interface ToolUseLike {
  name: string;
  input?: unknown;
}

async function maybeAutoMarkMastery(opts: {
  userId: string;
  mode: string | undefined;
  messages: OAITurn[];
  finalReply: string;
  toolUsesThisTurn: ToolUseLike[];
}): Promise<void> {
  // Only fires for typed teaching mode. Voice teaching has its own pacing.
  if (opts.mode !== "teaching-text") return;
  if (!opts.finalReply || opts.finalReply.trim().length === 0) return;

  // No double-write — if the model already called `remember` with type
  // concept this turn, we trust it and stay out of the way.
  const modelAlreadyWrote = opts.toolUsesThisTurn.some((tu) => {
    if (tu.name !== "remember") return false;
    const input = tu.input as Record<string, unknown> | undefined;
    return input?.type === "concept";
  });
  if (modelAlreadyWrote) return;

  const priorAssistant = findPriorAssistantText(opts.messages);
  if (!priorAssistant || !detectQuizShape(priorAssistant)) return;

  const lastUser = findLastUserText(opts.messages);
  if (!isSubstantiveAnswer(lastUser)) return;

  if (!detectAcknowledgement(opts.finalReply)) return;

  const concept = extractConceptName(opts.messages);
  if (!concept) return;

  const today = new Date().toISOString().slice(0, 10);
  const content = `user owns: ${concept} — verified ${today} via server-detected one-sentence answer`;
  try {
    await reconcileAndStore(opts.userId, "concept" as MemoryType, content);
    console.log(
      `[protege] auto-marked mastery (server-detected): ${concept}`
    );
  } catch (err) {
    console.warn(
      `[protege] auto-mark mastery failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Apply per-step output validation to the model's terminal reply. If
 * the active lesson is in TEACHING phase, the reply is constrained by
 * the current step type (e.g. SHOW-CODE → ≤1 code block, EXPLAIN-ATOM
 * → no code blocks). When truncation fires, log it so failures are
 * diagnosable. Returns the possibly-truncated reply.
 */
function applyLessonValidation(
  reply: string,
  lesson: LessonSession | null,
  opts: { voice?: boolean } = {}
): string {
  if (!reply || !lesson || lesson.phase !== "TEACHING") return reply;

  // FLOW mode: parse the <beat> meta tag the bot appended (covers + wrap
  // flag), update session state, then strip the tag from the user-visible
  // text via the validator.
  const meta = parseBeatMeta(reply);
  if (meta) {
    if (meta.covers && meta.covers.length > 0) {
      lesson.coverage = [...(lesson.coverage ?? []), meta.covers].slice(-12);
    }
    // Track this beat in recentBeats so the next turn's prompt sees what
    // was just delivered and avoids redelivering. Compress to a short
    // snippet — no need to keep the full reply.
    const beatSnippet = reply
      .replace(/<beat>[\s\S]*?<\/beat>/gi, "")
      .replace(/```[\s\S]*?```/g, "[code]")
      .trim()
      .slice(0, 100);
    lesson.recentBeats = [...(lesson.recentBeats ?? []), beatSnippet].slice(-6);
    if (meta.wrap) {
      console.log(`[protege] lesson WRAP signaled by bot — concept="${lesson.concept}"`);
      lesson.phase = "DONE";
    }
  }

  const { text, truncated } = validateStepReply(reply, "EXPLAIN-ATOM", { voice: opts.voice });
  if (truncated) {
    console.log(
      `[protege] lesson reply truncated · ${reply.length}ch → ${text.length}ch`
    );
  }

  // Deterministic continuation-cue fallback. The prompt asks the model
  // to end non-wrap turns with a brief "ready?" cue, but cheap-tier
  // models routinely drop it. Without the cue the user sees a paragraph
  // ending in a period and assumes the lesson is done.
  if (!meta?.wrap) {
    const trimmed = text.trimEnd();
    const endsWithCue = /[?!]\s*$/.test(trimmed);
    if (!endsWithCue) {
      const cues = ["Ready?", "With me?", "Got that?", "Onward?", "Follow?"];
      const cue = cues[(lesson.turn ?? 0) % cues.length];
      console.log(
        `[protege] lesson reply missing continuation cue — appending "${cue}"`
      );
      return `${trimmed} ${cue}`;
    }
  }
  return text;
}

/**
 * Project a LessonSession down to the slim shape the webview reads to
 * render its lesson-progress banner. Returns null if no lesson is
 * active or the lesson just terminated this turn (so the webview
 * clears its banner cleanly).
 */
function projectLessonState(
  lesson: LessonSession | null
): LessonStateSnapshot | null {
  if (!lesson) return null;
  // FLOW mode: no preset plan. Banner shows turn number + last-covered
  // atom. Older sessions with a populated plan still project the legacy
  // step-count shape.
  const turn = lesson.turn ?? 0;
  const coverage = lesson.coverage ?? [];
  const lastCover = coverage[coverage.length - 1] ?? null;
  return {
    id: lesson.id,
    concept: lesson.concept,
    level: lesson.level,
    phase: lesson.phase,
    stepNumber: lesson.phase === "TEACHING" ? turn : 0,
    totalSteps: lesson.plan.length, // 0 in FLOW mode → UI hides "of N"
    currentStepType: null,
    currentStepSummary: lastCover,
    plan: lesson.plan.map((s) => ({
      type: s.type,
      summary: s.summary,
    })),
  };
}

function maxTokensForMode(mode: string): number {
  // Voice cap: 300→150→200 (2026-04-30). 150 was tight enough that the
  // model occasionally got cut mid-sentence by stop_reason=max_tokens
  // — even though trimForVoice clipped on the client, headroom for the
  // model to finish a thought matters for prompt-cache friendliness
  // and lets the next sentence start cleanly. 200 = ~150 words of
  // generation budget; combined with client-side trimForVoice(50)
  // (which clips at sentence boundary), the user hears ≤ 2 clean
  // sentences ending on a period — never a mid-sentence cut.
  // BREVITY APPLIES TO VOICE MODES ONLY. text mode is 4096 (unchanged).
  if (mode === "voice" || mode === "voice-dialogue") return 200;
  if (mode === "teaching") return 1200;
  // Each text-teaching beat is capped at ~150 words by the prompt — 600
  // tokens covers that with headroom for tool-call thinking. Lower than
  // plain text to make over-long replies actually rare instead of just
  // discouraged.
  if (mode === "teaching-text") return 600;
  return 4096;
}

// Per-user dedup window — track the last incoming user message + its
// timestamp. If a new message arrives within 2s and is >=80% similar to
// the prior one, drop it as a probable double-send (rapid Enter, voice
// hiccup, repeated typing). Prevents bot from generating two near-
// identical replies for what the user perceives as one turn.
const recentUserMessages = new Map<string, { text: string; at: number }>();
const DEDUP_WINDOW_MS = 2000;

/**
 * Last time each user sent a chat message. Used to compute chat
 * engagement minutes — the gap between consecutive user messages
 * approximates the time the user spent reading the assistant reply
 * and composing their next turn. Capped per-gap so a user who walks
 * away for an hour and comes back doesn't get an hour added.
 *
 * Module-level Map → resets on server restart, which is fine: the
 * worst case is one missed gap per user per restart (acceptable for
 * a "rough engagement signal", not a billing source).
 */
const lastChatTsByUser = new Map<string, number>();
/** Cap per-gap contribution. 60s = "still actively in the conversation."
 *  Anything longer than that, we cap at 60s (they were probably reading
 *  for a moment but not engaged the whole time). */
const CHAT_GAP_CAP_MS = 60_000;
/** Fresh-session threshold. If the gap is longer than this, the user
 *  wasn't engaged during the gap at all — they walked away. Counting
 *  even 60s for that turn over-credits engagement. So we contribute 0
 *  and treat their next message as the start of a new session.
 *  10 min strikes a balance: typical "sat thinking + ran a test" gaps
 *  stay under it, lunch-break / browser-tab gaps go over. */
const CHAT_FRESH_SESSION_MS = 10 * 60_000;

/**
 * Pure helper — given the raw gap in ms between two consecutive user
 * messages, returns how many ms of engagement to credit. Exported for
 * unit tests (`countableChatGapMs.test.ts`).
 *
 *   gap ≤ 0                        → 0  (defensive, shouldn't happen)
 *   gap > FRESH_SESSION_MS         → 0  (user walked away, fresh start)
 *   FRESH_SESSION_MS ≥ gap > GAP_CAP_MS → GAP_CAP_MS (cap)
 *   gap ≤ GAP_CAP_MS               → gap (count actual)
 */
export function countableChatGapMs(rawGapMs: number): number {
  if (rawGapMs <= 0) return 0;
  if (rawGapMs > CHAT_FRESH_SESSION_MS) return 0;
  return Math.min(CHAT_GAP_CAP_MS, rawGapMs);
}

function similarity(a: string, b: string): number {
  // Normalize: lowercase, collapse whitespace, strip filler punctuation.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,!?]+/g, "").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  // Substring containment: "0 1 2 3" inside "so basically 0 1 2 3" → 1.
  // The shorter form is the user's repeated/cleaned-up version of the
  // longer one (or vice versa).
  if (na.includes(nb) || nb.includes(na)) return 1;
  // Word-level Jaccard. Handles cases like "got it" vs "got it!" or
  // "yes please" vs "yes pls thanks".
  const wa = new Set(na.split(" "));
  const wb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

chatRoute.post("/", async (c) => {
  const body = (await c.req.json()) as ChatRunRequest;
  const userId = resolveUserId(c, body.userId);
  const requestedMode = body.mode ?? "text";

  // Hard message-size cap (defense-in-depth). The extension composer
  // already enforces this with a visible counter + disabled Send, but
  // a stale extension or a direct API caller could bypass that. 8000
  // chars ≈ 2000 tokens; bump if real beta usage shows legitimate
  // questions hitting it.
  const MAX_USER_MESSAGE_CHARS = 8000;
  if (
    body.newUserMessage &&
    body.newUserMessage.length > MAX_USER_MESSAGE_CHARS
  ) {
    return c.json(
      {
        error: "message too long",
        used: body.newUserMessage.length,
        limit: MAX_USER_MESSAGE_CHARS,
      },
      400
    );
  }

  // Rapid-duplicate guard. Only checks newUserMessage (not toolResults
  // or other paths). Returns 200 with empty reply so the frontend
  // doesn't error — the original in-flight turn will deliver the
  // response.
  if (body.newUserMessage) {
    const last = recentUserMessages.get(userId);
    const now = Date.now();
    if (
      last &&
      now - last.at < DEDUP_WINDOW_MS &&
      similarity(last.text, body.newUserMessage) >= 0.8
    ) {
      console.log(
        `[protege] dedup: dropped duplicate from ${userId} (${now - last.at}ms apart, "${body.newUserMessage.slice(0, 40)}")`
      );
      return c.json<ChatRunResponse>({
        reply: "",
        messages: body.messages ?? [],
        lessonState: projectLessonState(getActiveSession(userId)),
      });
    }
    recentUserMessages.set(userId, { text: body.newUserMessage, at: now });

    // Chat engagement minutes — rough but free signal. Approximates
    // "time the user was reading the assistant's prior reply +
    // composing this turn" via the gap between consecutive user
    // messages. Two cutoffs:
    //   - gap > FRESH_SESSION  → user walked away. Contribute 0.
    //                            Treat this message as a new session.
    //   - gap > GAP_CAP        → cap at GAP_CAP (engaged but slow turn).
    //   - gap ≤ GAP_CAP        → use the actual gap.
    // The first message of any session has no prior gap → 0.
    const lastTs = lastChatTsByUser.get(userId);
    if (lastTs !== undefined) {
      const countedGap = countableChatGapMs(now - lastTs);
      if (countedGap > 0) {
        void addChatMinutes(userId, countedGap / 60_000);
      }
    }
    lastChatTsByUser.set(userId, now);
  }

  // Mode stickiness for active lessons. The webview only upgrades to
  // "teaching-text" on the FIRST message of a thread (per the
  // first-message classifier in webviewHost.ts). On subsequent turns
  // it reverts to "text", which would bypass the entire lesson-session
  // flow — the bot would dump a wall-of-text using the global
  // TEACHING_TEXT prompt instead of the tight per-step prompt.
  //
  // Fix: if THIS user has an active lesson session, force the mode to
  // "teaching-text" server-side. Source of truth is the session, not
  // the client's per-message mode.
  const preexistingLesson = getActiveSession(userId);
  const mode =
    preexistingLesson && requestedMode === "text"
      ? "teaching-text"
      : requestedMode;

  // Tier choice for teaching-text. Originally we forced "cheap" here for
  // latency, but cheap-tier nano with reasoning_effort=minimal was
  // ignoring the FLOW prompt's structural rules — defaulting to its
  // training prior of "helpful assistant with explanations and code
  // blocks" instead of acting as a tight 1:1 tutor. The teaching beats
  // require enough judgment (when to drill, when to pivot, when to use
  // tools) that the cheap path produced unusable output. Bumping to
  // premium adds ~3-5s per turn but the model actually follows the
  // structural rules. The caller can still override via body.tier.
  const requestedTier: ChatTier = body.tier ?? "premium";
  const tier: ChatTier = requestedTier;
  const anthropicModel = resolveAnthropicModel(body.backend, tier);
  const openaiModel = resolveOpenAIModel(tier);
  const maxTokens = maxTokensForMode(mode);

  // Quota gate. Tier maps directly: "cheap" → "scan" (Live Review
  // auto-fired calls), "premium" → "teach" (chat / Compare / Fix it).
  // The 429 short-circuits the request before any model is called, so
  // a user past their daily limit never burns more tokens.
  //
  // Honest accounting: a single user turn can produce multiple `/chat`
  // round-trips when the LLM uses tools (read_file, search, …). Only
  // the FIRST round of each user turn (the one carrying
  // `body.newUserMessage` with no `body.toolResults`) bumps the
  // route counter — tool re-fires only re-check the $ cap. Without
  // this split, 3 user-typed messages with multi-tool reasoning could
  // land as "9 / 100" in the Profile panel, which is what users see
  // and (correctly) call out as wrong.
  const quotaKind = tier === "cheap" ? "scan" : "teach";
  const isFirstRoundOfUserTurn =
    typeof body.newUserMessage === "string" &&
    body.newUserMessage.length > 0 &&
    (!body.toolResults || body.toolResults.length === 0);
  const blocked = isFirstRoundOfUserTurn
    ? await enforceQuotaInline(c, quotaKind)
    : await enforceCostCapOnly(c);
  if (blocked) return blocked;

  // Tool-call ceiling — separate from the chat-message ceiling.
  // A user could have chat messages left but be out of tool calls;
  // we'd rather 429 here than have the model fire tools that won't
  // count cleanly. Only checks when the request might use tools
  // (premium tier with tools=on); cheap-tier scans never use tools.
  if (tier === "premium") {
    const toolGate = await checkToolCallLimit(userId, 1);
    if (!toolGate.allowed) {
      return c.json(
        {
          error: "daily quota exceeded",
          kind: "tool_calls",
          reason: "route-cap",
          used: toolGate.used,
          limit: toolGate.limit,
          resetAt: toolGate.resetAt,
        },
        429
      );
    }
  }

  let messages: OAITurn[] = body.messages ?? [];

  // Hoisted so the terminal returns can read the lesson state for the
  // ChatRunResponse projection. Set inside the isFreshTurn block when
  // teaching-text mode is active.
  let activeLesson: LessonSession | null = null;
  // Hoisted so reasoningEffort calc (post-fresh-turn) can read it.
  let voiceLessonGate = false;

  // "Fresh turn" detection: any request that carries a newUserMessage is
  // a new conversational turn. The frontend does carry forward the prior
  // system message in `messages`, so we strip it and rebuild — this keeps
  // memory/learner/lesson-session blocks fresh on every turn instead of
  // re-using the stale system prompt from turn 1 forever.
  const isFreshTurn = !!body.newUserMessage;
  if (isFreshTurn) {
    // Drop any prior system message — we'll rebuild and prepend below.
    messages = messages.filter((m) => m.role !== "system");
  }

  if (isFreshTurn) {
    // Build a query string for contextual retrieval: the new user message
    // plus a short slice of the active file. This lets cosine ranking pick
    // memories tied to *this* moment instead of just the most recent ones.
    // Fallback to the legacy non-semantic snapshot when there's no signal
    // to retrieve against (rare — fresh turns always carry newUserMessage).
    const retrievalQuery = [
      body.newUserMessage ?? "",
      body.workspace?.activeFile?.path ?? "",
      body.workspace?.activeFile?.language ?? "",
      body.workspace?.activeFile?.selection ??
        body.workspace?.activeFile?.content?.slice(0, 1500) ??
        "",
    ]
      .filter((s) => s)
      .join("\n");

    const memoriesPromise = retrievalQuery.trim()
      ? getRelevantMemories(userId, retrievalQuery, 12)
      : getMemorySnapshot(userId, 12);

    const [memories, sessionInfo] = await Promise.all([
      memoriesPromise,
      openSession(userId),
    ]);

    // Derive a learner block from the memory snapshot — profile memories
    // drive level inference, recent struggles flag concepts to tread
    // carefully on, concept memories list verified mastery so the model
    // doesn't re-teach what the user already produced correctly. Empty-
    // string when there's no signal yet; the prompt degrades gracefully.
    const profileNotes = memories
      .filter((m) => m.type === "profile")
      .map((m) => m.content);
    const recentStruggles = memories
      .filter((m) => m.type === "struggle")
      .map((m) => m.content);
    // Owned concepts come from `remember("concept", "user owns: [name] — ...")`
    // entries written by the teaching loop on a clean YOUR-TURN pass.
    // We extract just the concept name for the prompt — full provenance
    // lives in the memory block below.
    const ownedConcepts = memories
      .filter((m) => m.type === "concept")
      .map((m) => parseOwnedConceptName(m.content))
      .filter((c): c is string => c !== null);
    const learnerBlock = buildLearnerBlock({
      profileNotes,
      recentStruggles,
      ownedConcepts: ownedConcepts.length > 0 ? ownedConcepts : undefined,
      // Decay + new buckets need a mastery store with timestamps the
      // remember-tool surface doesn't carry yet. Owned-only is enough
      // to deliver the "feels personal" experience.
    });

    // ─── Lesson session: micro-step adaptive teaching ──────────────
    // When mode is teaching-text we drive the model with a TIGHT per-
    // step prompt that REPLACES the global TEACHING_TEXT block. The
    // model sees only the instruction for ONE step — no room to drift
    // into wall-of-text mode.
    //
    // Flow:
    //   1. First "teach me X" → create session at PROBE, deliver probe
    //   2. After probe answer → planner runs (one extra LLM call), plan
    //      stored on session, step 0 delivered
    //   3. Each subsequent user reply → advanceStep mutates plan based
    //      on signal (why? → insert WHY-ANSWER; code-paste → REVIEW;
    //      ack → next planned step)
    // Lesson FLOW gate. Originally only teaching-text mode triggered
    // lesson sessions. Now we also fire for voice channels when the
    // user has explicit teach intent — so voice gets the SAME adaptive
    // FLOW system as chat (memory-aware probe, redundancy detection,
    // file-diff awareness, etc.) instead of the older teach_step path.
    // The voice flag in generateStepPrompt enforces the voice contract
    // (≤20 words, no fenced code blocks — code goes to editor via
    // edit_file, visuals via highlight_code).
    const isVoiceChannel =
      requestedMode === "voice" ||
      requestedMode === "voice-dialogue" ||
      requestedMode === "teaching";
    voiceLessonGate = (() => {
      if (!isVoiceChannel) return false;
      if (getActiveSession(userId)) return true;
      const newConcept = extractConcept(body.newUserMessage ?? "");
      return newConcept !== null;
    })();
    let lessonStepPrompt: string | null = null;
    if (mode === "teaching-text" || voiceLessonGate) {
      const userText = body.newUserMessage ?? "";
      const existing = getActiveSession(userId);
      let newConcept = extractConcept(userText);

      // Smart-fallback: regex missed a casual teach intent like
      // "i wish i would know how to use loops" or "loops are confusing
      // me". Only fires when:
      //   - no existing session (this is a fresh teach attempt)
      //   - regex returned null
      //   - message is meaningful (≥4 words — filters acks/follow-ups)
      // Hits ~10-20% of fresh teach-shaped messages, costs one cheap
      // LLM call (~200ms with reasoning_effort=minimal).
      if (
        !existing &&
        !newConcept &&
        userText.trim().split(/\s+/).filter((w) => w.length > 0).length >= 4
      ) {
        const cls = await classifyFirstMessageLLM(userText);
        if (cls.intent === "teach" && cls.concept) {
          console.log(
            `[protege] smart-classifier rescued teach intent · concept="${cls.concept}" · text="${userText.slice(0, 60)}..."`
          );
          newConcept = cls.concept;
        }
      }

      // Active file → planner. The planner uses this to ground steps in
      // the user's real code (e.g. plan around `views.map` on line 9
      // instead of inventing a counter example). Without this the plan
      // is concept-only and the model riffs on generic examples.
      const plannerFile = body.workspace?.activeFile
        ? {
            path: body.workspace.activeFile.path,
            content: body.workspace.activeFile.content,
            language: body.workspace.activeFile.language,
          }
        : undefined;

      // Concept-switch detection: if the user typed "teach me X" mid-
      // lesson and X is clearly a DIFFERENT concept than the current
      // session, end the current lesson and start a new one. Without
      // this guard, "teach me map" gets glommed into a useEffect lesson
      // as a WHY-ANSWER and the user is trapped in the wrong plan.
      const isConceptSwitch =
        !!(existing && newConcept && !sameConcept(newConcept, existing.concept));

      // Capture the PREVIOUS turn's timestamp BEFORE advanceStep bumps
      // it. Otherwise `activeLesson.lastTurnAt` reads as "now" and the
      // pace signal always says FAST.
      const previousTurnAt = existing?.lastTurnAt;

      if (isConceptSwitch) {
        console.log(
          `[protege] lesson concept switch · "${existing!.concept}" → "${newConcept}" — ending old session, starting new`
        );
        endSession(userId);
        activeLesson = startSession(userId, newConcept!);
      } else if (existing) {
        activeLesson = await advanceStep(existing, userText, plannerFile);
      } else if (newConcept) {
        activeLesson = startSession(userId, newConcept);
      }
      if (activeLesson && activeLesson.phase !== "DONE") {
        // Voice channel? Mode here is forced to "teaching-text" when an
        // active lesson exists, so we read the ORIGINAL requestedMode
        // to detect TTS channels. Voice replies are spoken aloud, so
        // the prompt switches to short-spoken delivery and bans chat
        // code blocks (user is listening + watching the editor).
        const isVoiceChannel =
          requestedMode === "voice" ||
          requestedMode === "voice-dialogue" ||
          requestedMode === "teaching";
        // Pace signal: gap between PREVIOUS turn's timestamp and now.
        // We captured `previousTurnAt` before advanceStep bumped it.
        // No previous turn (fresh session) → undefined, prompt skips
        // the pace block.
        const secondsSinceLastTurn =
          typeof previousTurnAt === "number"
            ? Math.max(0, Math.floor((Date.now() - previousTurnAt) / 1000))
            : undefined;

        // Compress what we know about this user into a short hint so
        // the PROBE prompt can SKIP "are you beginner" if memory
        // already shows them comfortable. Without this the bot asks
        // "beginner/comfortable/expert?" every single lesson — even
        // when memory clearly says they're a senior React dev.
        const learnerHint = (() => {
          const parts: string[] = [];
          const profile = memories.find((m) => m.type === "profile");
          if (profile) {
            parts.push(`profile: ${profile.content.slice(0, 120)}`);
          }
          const mastered = memories
            .filter((m) => m.type === "concept")
            .map((m) => parseOwnedConceptName(m.content))
            .filter((n): n is string => Boolean(n))
            .slice(0, 8);
          if (mastered.length > 0) {
            parts.push(`mastered: ${mastered.join(", ")}`);
          }
          const struggles = memories
            .filter((m) => m.type === "struggle")
            .map((m) => m.content.slice(0, 60))
            .slice(0, 4);
          if (struggles.length > 0) {
            parts.push(`struggles: ${struggles.join("; ")}`);
          }
          return parts.join("\n");
        })();

        lessonStepPrompt = generateStepPrompt(activeLesson, userText, {
          voice: isVoiceChannel,
          activeFile: body.workspace?.activeFile
            ? {
                path: body.workspace.activeFile.path,
                content: body.workspace.activeFile.content,
              }
            : undefined,
          secondsSinceLastTurn,
          learnerHint,
        });
        // After generating the prompt, snapshot the current file so
        // the NEXT turn can diff against it. This is the "what did the
        // user do between beats" signal the next turn reads.
        if (body.workspace?.activeFile) {
          activeLesson.lastFilePath = body.workspace.activeFile.path;
          activeLesson.lastFileHash = quickHash(
            body.workspace.activeFile.content
          );
        }
        const stepInfo =
          activeLesson.phase === "TEACHING"
            ? `step ${activeLesson.stepIndex + 1}/${activeLesson.plan.length} (${activeLesson.plan[activeLesson.stepIndex]?.type ?? "?"})`
            : `phase=${activeLesson.phase}`;
        console.log(
          `[protege] lesson ${activeLesson.id} · concept="${activeLesson.concept}" · level=${activeLesson.level} · ${stepInfo}`
        );
      }
    }

    // Split the persona into a stable static portion + a dynamic per-turn
    // portion. The static side (CORE_PERSONA + learner) is identical
    // across turns of any given lesson; the dynamic side (lessonStepPrompt
    // — recent beats, coverage, file-diff signal) changes every turn.
    // Keeping them separate lets us put the workspace file content
    // BETWEEN them at the cache boundary: file-stable turns then hit cache
    // on persona+workspace, only paying full cost on the per-turn lesson
    // state at the tail.
    // ALWAYS strip the verbose TEACHING_TEXT block when in teaching-text
    // mode, even if no lesson session got created (e.g. extractConcept
    // failed). Otherwise the model sees a 6-phase scripted prompt and
    // dumps a wall-of-text. Without a lesson we still prefer thin
    // CORE_PERSONA to TEACHING_TEXT's heavy structure.
    const fullPrompt = buildSystemPrompt(mode, learnerBlock);
    // Strip the verbose "## Channel: TEACHING ..." block whenever
    // FLOW is driving — that includes teaching-text mode AND voice
    // channels with an active lesson (voiceLessonGate). The split
    // catches both TEACHING_TEXT (typed lesson) and TEACHING_MODE
    // (voice-agentic teach_step path); the latter conflicts with FLOW
    // so dropping it cleans up the voice prompt.
    const staticPersona =
      lessonStepPrompt || mode === "teaching-text" || voiceLessonGate
        ? fullPrompt.split(/^## Channel: TEACHING/m)[0].trim()
        : fullPrompt;
    const dynamicPersona = lessonStepPrompt ?? "";

    // === Memory block ===
    let memoryBlock = "";
    if (memories.length > 0) {
      const lines = memories.map(
        (m) => `- [${m.type}] (${m.id}) ${m.content}`
      );
      memoryBlock = `\n\n## What you know about this user\n${lines.join("\n")}\n\n(Reference these naturally when relevant. Use \`forget(id)\` if any entry turns out to be wrong.)`;
    }

    // === Session / continuity block ===
    let sessionBlock = "";
    if (sessionInfo.isFirstToday && sessionInfo.lastSession) {
      const last = sessionInfo.lastSession;
      const parts: string[] = [`Last session: ${last.date}`];
      if (last.endSummary) parts.push(`Summary: ${last.endSummary}`);
      if (last.filesTouched.length > 0)
        parts.push(`Files touched: ${last.filesTouched.slice(-6).join(", ")}`);
      sessionBlock = `\n\n## Session continuity\nThis is the user's FIRST message today. ${parts.join(" · ")}\n\nGo straight into addressing their current message. If — and only if — the summary above contains a SPECIFIC, concrete detail worth referencing, you may briefly mention it in passing (one short clause). Constraints:\n- Don't invent details that aren't in the summary. If the summary is empty or generic, skip any continuity reference entirely.\n- No greetings ("hey", "morning", "welcome back"). No "great to see you again" energy.\n- The user's CURRENT message is what matters; continuity is at most a half-sentence aside.`;
    } else if (!sessionInfo.isFirstToday) {
      sessionBlock = `\n\n## Session\nContinuing today's session. Don't re-greet.`;
    }

    // === Workspace block — split into stable + volatile halves ===
    //
    // Stable half (wsBlock): file path, language, content, file tree.
    // These change only when the user edits the file or switches files —
    // so they pay the cache-write cost ONCE per edit and reuse for every
    // subsequent stable turn.
    //
    // Volatile half (wsSelectionBlock): cursor selection. Users move the
    // cursor constantly, so keeping selection in the cached prefix
    // would invalidate the cache on every click. Split it into the
    // dynamic tail instead.
    const wsBlock = body.workspace
      ? `\n\n## Current workspace\nRoot: ${body.workspace.root ?? "(unknown)"}\n${
          body.workspace.activeFile
            ? `Active file: ${body.workspace.activeFile.path} (${body.workspace.activeFile.language})\n\`\`\`${body.workspace.activeFile.language}\n${body.workspace.activeFile.content.slice(0, 4000)}\n\`\`\``
            : "No active file."
        }\n${
          body.workspace.fileTree && body.workspace.fileTree.length > 0
            ? `\nFile tree (first ${body.workspace.fileTree.length} files):\n${body.workspace.fileTree.join("\n")}`
            : ""
        }`
      : "";
    const wsSelectionBlock = body.workspace?.activeFile?.selection
      ? `\n\n## User selection (current cursor highlight)\n\`\`\`\n${body.workspace.activeFile.selection}\n\`\`\``
      : "";

    // Track the active file in the session (for next-day continuity)
    if (body.workspace?.activeFile?.path) {
      touchSessionFile(userId, body.workspace.activeFile.path).catch(() => {});
    }

    // Cache layout — stable bytes first (cached), volatile bytes last:
    //   [staticPersona]      — same across every turn of this lesson
    //   [wsBlock]            — same when the file hasn't changed since
    //                          last turn (the common case during reading
    //                          + Q&A; cache miss only when user edits)
    //   ── CACHE_SPLIT_MARKER ──
    //   [dynamicPersona]     — per-turn lesson state (recent beats,
    //                          coverage, diff signal, etc.)
    //   [memoryBlock]        — slowly changes; tolerable to leave uncached
    //   [sessionBlock]       — same
    //
    // For Anthropic the marker becomes a cache_control breakpoint via
    // toAnthropic(); the prefix is sent with cache_control:ephemeral.
    // For OpenAI prefix caching is automatic — putting the volatile bits
    // last maximizes the identical-prefix length between consecutive
    // turns.
    const systemMessage: OAITurn = {
      role: "system",
      content:
        staticPersona +
        wsBlock +
        CACHE_SPLIT_MARKER +
        (dynamicPersona ? "\n\n" + dynamicPersona : "") +
        wsSelectionBlock +
        memoryBlock +
        sessionBlock,
    };
    // Prior user/assistant turns (history) stay between system + new user,
    // so Claude sees: [system, ...history, new user message].
    const priorHistory = messages;
    messages = [
      systemMessage,
      ...priorHistory,
      { role: "user", content: body.newUserMessage! },
    ];
  } else if (body.toolResults && body.toolResults.length > 0) {
    for (const tr of body.toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.id,
        name: tr.name,
        content: tr.error ? `ERROR: ${tr.error}` : tr.content,
      });
    }
  } else if (body.newUserMessage) {
    messages.push({ role: "user", content: body.newUserMessage });
  }

  // Translate OAITurn[] → Anthropic format
  const { systemStable, systemDynamic, anthropicMessages } = toAnthropic(messages);

  // One-shot callers (review engine, voice explain) pass `noTools: true`.
  // Without this flag, Claude can respond with a tool call instead of
  // text — which the one-shot path can't consume, so the caller sees an
  // empty reply and the scan produces zero suggestions. The scan prompt
  // asks for JSON-only, but Claude sometimes "prepares" by calling
  // read_file before answering. Disabling tools forces a direct reply.
  const useTools = body.noTools !== true;

  // Per-request provider routing: cheap-tier requests (Live Review
  // scans, AI-block summaries — everywhere the extension's aiQuery
  // sets `kind: "scan"`) get pinned to OpenAI / gpt-4o-mini regardless
  // of the env-wide AI_PROVIDER, since that's ~5× cheaper than Haiku
  // for short lint-shaped prompts. Premium-tier requests (chat,
  // teaching, Compare, Fix it) keep the env default. The override
  // gracefully falls back to Anthropic if OPENAI_API_KEY is missing
  // (handled in callChat). This is the implementation of step 1 of
  // the live-review-cost-cut plan.
  const envProvider = getProvider();
  const provider =
    tier === "cheap" && process.env.OPENAI_API_KEY ? "openai" : envProvider;
  const loggedModel = provider === "openai" ? openaiModel : anthropicModel;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent =
    typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg?.content ?? "").slice(0, 120);
  console.log(
    `[protege] /chat provider=${provider} model=${loggedModel} tier=${tier} mode=${mode ?? "?"} requestedBackend=${body.backend ?? "default"} tools=${useTools ? "on" : "off"} turns=${messages.length} lastRole=${messages.at(-1)?.role} lastUser=${JSON.stringify(lastUserContent.slice(0, 100))}`
  );

  // Teaching-text needs the model to actually follow structural prompt
  // rules. reasoning_effort=minimal makes the model skim past them.
  // "low" gives just enough thinking budget for compliance without
  // killing latency.
  // Lesson FLOW (chat or voice) needs the model to follow structural
  // rules — bump reasoning. Plain Q&A stays "minimal" for latency.
  const reasoningEffort: "minimal" | "low" | "medium" | "high" =
    mode === "teaching-text" || voiceLessonGate ? "low" : "minimal";

  // Tool ban is mode-specific:
  //   - teaching-text: the user TYPES the code themselves — that's the
  //     pedagogy. Strip edit_file so the model can't shortcut past the
  //     practice phase.
  //   - teaching (voice): the user is HEARING the lesson and watching
  //     their editor. Code must land in the file (not in chat) so they
  //     can close the sidebar and just listen + watch. edit_file STAYS
  //     in the toolbox here.
  // create_scratch_file is always banned (was producing junk lesson
  // files in workspace root).
  const excludeTools =
    mode === "teaching-text"
      ? ["edit_file", "create_scratch_file"]
      : mode === "teaching"
      ? ["create_scratch_file"]
      : undefined;

  const result = await callChat({
    anthropicModel,
    openaiModel,
    provider,
    maxTokens,
    systemStable,
    systemDynamic,
    anthropicMessages,
    useTools,
    reasoningEffort,
    excludeTools,
  });

  console.log(
    `[protege] /chat provider=${result.providerUsed} model=${result.modelUsed} stop=${result.stopReason} usage=`,
    result.usage
  );

  // Record this call's $ estimate against the user's daily quota.
  // Fire-and-forget — UI rendering doesn't block on the rollup write.
  // Token shape varies by provider but `prompt_tokens` / `input_tokens`
  // and `completion_tokens` / `output_tokens` are the canonical names.
  const usage = result.usage as Record<string, unknown> | undefined;
  const inTok = Number(
    usage?.prompt_tokens ?? usage?.input_tokens ?? 0
  );
  const outTok = Number(
    usage?.completion_tokens ?? usage?.output_tokens ?? 0
  );
  if (inTok > 0 || outTok > 0) {
    void addCostUsd(userId, estimateCallCostUsd(tier, inTok, outTok));
  }
  // Record tool-call usage. Fires whenever the model called any tools
  // in this turn — counts against the daily 25-tool-call ceiling.
  // Note: a single /chat turn can include multiple tool uses (e.g. the
  // model reads two files). Each one counts.
  if (result.toolUses && result.toolUses.length > 0) {
    void addToolCalls(userId, result.toolUses.length);
  }
  if (result.toolUses.length > 0) {
    console.log(
      `[protege] /chat tool_calls=${result.toolUses.length}: ${result.toolUses
        .map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 80)}${JSON.stringify(t.input).length > 80 ? "…" : ""})`)
        .join(" | ")}`
    );
  }
  if (result.text && result.text.length > 0) {
    console.log(
      `[protege] /chat reply chars=${result.text.length} preview=${JSON.stringify(result.text.slice(0, 160))}`
    );
  }

  const toolUses = result.toolUses;
  const assistantText = result.text;

  // Append assistant turn to the running conversation
  messages.push({
    role: "assistant",
    content: assistantText || null,
    tool_calls: toolUses.length
      ? toolUses.map((tu) => ({
          id: tu.id,
          type: "function" as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }))
      : undefined,
  });

  // Server-side tools (no bounce to extension): remember / forget.
  // If Claude only called these, execute locally and recurse with tool results.
  const extensionCalls = toolUses.filter(
    (tu) => tu.name !== "remember" && tu.name !== "forget"
  );
  const serverCalls = toolUses.filter(
    (tu) => tu.name === "remember" || tu.name === "forget"
  );

  if (serverCalls.length > 0) {
    // Execute each server tool inline and push tool_result turns
    for (const tu of serverCalls) {
      const args = (tu.input ?? {}) as Record<string, unknown>;
      let resultText = "";
      try {
        if (tu.name === "remember") {
          const result = await reconcileAndStore(
            userId,
            String(args.type ?? "context") as MemoryType,
            String(args.content ?? "")
          );
          if (result.row) {
            resultText = `${result.decision.action.toLowerCase()} (id=${result.row.id}, type=${result.row.type})`;
          } else if (result.decision.action === "DELETE") {
            resultText = `Removed superseded memory (id=${result.decision.targetId ?? "?"})`;
          } else {
            resultText = "Skipped (duplicate of existing memory)";
          }
        } else if (tu.name === "forget") {
          const ok = await removeMemory(userId, String(args.id ?? ""));
          resultText = ok ? "Forgotten" : "Nothing to forget (id not found)";
        }
      } catch (err) {
        resultText = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tu.id,
        name: tu.name,
        content: resultText,
      });
    }

    // If there are ALSO extension tool calls, return them now so the
    // extension can run them. Otherwise the server has fully handled this
    // round — but we still need to return something. Claude's next response
    // will come on the next POST from the extension which already has the
    // updated messages, so return those with no toolCalls.
    if (extensionCalls.length > 0) {
      const toolCalls: ToolCall[] = extensionCalls.map((tu) => ({
        id: tu.id,
        name: tu.name,
        arguments:
          typeof tu.input === "object" && tu.input !== null
            ? (tu.input as Record<string, unknown>)
            : {},
      }));
      return c.json<ChatRunResponse>({ toolCalls, messages });
    }

    // Pure server-tool round — synthesize a continuation by calling the LLM
    // again with the tool results appended. This keeps the UX instant
    // (no extra client roundtrip) when the model is just updating memory.
    const { systemStable: ss2, systemDynamic: sd2, anthropicMessages: am2 } =
      toAnthropic(messages);
    const result2 = await callChat({
      anthropicModel,
      openaiModel,
      provider,
      maxTokens,
      systemStable: ss2,
      systemDynamic: sd2,
      anthropicMessages: am2,
      useTools: true,
      reasoningEffort,
    });
    const text2 = result2.text;
    const toolUses2 = result2.toolUses;

    messages.push({
      role: "assistant",
      content: text2 || null,
      tool_calls: toolUses2.length
        ? toolUses2.map((tu) => ({
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          }))
        : undefined,
    });

    if (toolUses2.length > 0) {
      const toolCalls: ToolCall[] = toolUses2
        .filter((tu) => tu.name !== "remember" && tu.name !== "forget")
        .map((tu) => ({
          id: tu.id,
          name: tu.name,
          arguments:
            typeof tu.input === "object" && tu.input !== null
              ? (tu.input as Record<string, unknown>)
              : {},
        }));
      if (toolCalls.length > 0) {
        return c.json<ChatRunResponse>({ toolCalls, messages });
      }
    }

    // Auto-mastery hook — fires only in teaching-text when the model
    // didn't write a concept memory itself this turn but the conversation
    // shape (prior quiz Q + substantive user answer + acknowledgement)
    // says one mastery moment just happened.
    await maybeAutoMarkMastery({
      userId,
      mode,
      messages,
      finalReply: text2,
      toolUsesThisTurn: toolUses2,
    });
    // Validate per-step output before sending. This is the deterministic
    // floor that catches the "model packed multiple atoms into one reply"
    // failure mode. Updates the messages array's last assistant turn so
    // history matches what the user actually saw.
    const validatedText2 = applyLessonValidation(text2, activeLesson, {
      voice: voiceLessonGate,
    });
    if (validatedText2 !== text2) {
      const lastIdx = messages.length - 1;
      if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: validatedText2 || null,
        };
      }
    }
    return c.json<ChatRunResponse>({
      reply: validatedText2,
      messages,
      lessonState: projectLessonState(activeLesson),
    });
  }

  // If Claude wants tool calls → return them to the extension for execution
  if (toolUses.length > 0) {
    const toolCalls: ToolCall[] = toolUses.map((tu) => ({
      id: tu.id,
      name: tu.name,
      arguments:
        typeof tu.input === "object" && tu.input !== null
          ? (tu.input as Record<string, unknown>)
          : {},
    }));
    return c.json<ChatRunResponse>({ toolCalls, messages });
  }

  // Auto-mastery hook (see maybeAutoMarkMastery for the rules). Runs
  // only on terminal teaching-text replies. Cheap and idempotent —
  // safe to call on every reply; it short-circuits when the conditions
  // don't hold.
  await maybeAutoMarkMastery({
    userId,
    mode,
    messages,
    finalReply: assistantText,
    toolUsesThisTurn: toolUses,
  });

  // Validate per-step output before sending. See applyLessonValidation
  // for the rationale — deterministic floor against the "model packed
  // multiple atoms" failure mode.
  const validatedAssistant = applyLessonValidation(assistantText, activeLesson, {
    voice: voiceLessonGate,
  });
  if (validatedAssistant !== assistantText) {
    const lastIdx = messages.length - 1;
    if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
      messages[lastIdx] = {
        ...messages[lastIdx],
        content: validatedAssistant || null,
      };
    }
  }

  // Defensive final strip: NEVER let the <beat> meta tag reach the
  // user's chat. The validator above already strips it, but only when
  // a lesson is active in TEACHING phase. If the bot still emits the
  // tag (model habit) when the lesson is DONE / PROBE / not present,
  // we strip here regardless. Belt + suspenders.
  const cleanReply = (validatedAssistant ?? "")
    .replace(/<beat>[\s\S]*?<\/beat>/gi, "")
    .replace(/<beat>[\s\S]*$/gi, "") // orphaned opener (model truncation)
    .trimEnd();

  // Did the bot call edit_file anywhere in this turn? Walk the assembled
  // messages array and look for tool_calls. Next turn's file-diff signal
  // uses this to differentiate "user accepted my diff" vs "user manually
  // edited" when both produce a file-content change.
  if (activeLesson) {
    let botEditedThisTurn = false;
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray((m as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls)) {
        const tc = (m as { tool_calls: Array<{ function?: { name?: string } }> }).tool_calls;
        if (tc.some((t) => t.function?.name === "edit_file")) {
          botEditedThisTurn = true;
          break;
        }
      }
    }
    activeLesson.lastBotEditedFile = botEditedThisTurn;
  }

  // Terminal: final text reply. Always return the full reply (including
  // code blocks) — the chat UI renders it as markdown. The /tts route
  // sanitizes for speech on its side, so voice modes hear a clean spoken
  // summary while the chat still shows the code the user asked for.
  return c.json<ChatRunResponse>({
    reply: cleanReply,
    messages,
    lessonState: projectLessonState(activeLesson),
  });
});

/**
 * Translate OpenAI-shaped turns → Anthropic format.
 * Tool results must be embedded as `tool_result` content blocks on
 * a user message in Anthropic's model (not a separate role).
 */
/** Marker inserted between the stable persona and the per-user dynamic
 *  context so toAnthropic() can split them into two separate cache blocks.
 *  Never user-facing — stripped before the prompt reaches Claude. */
const CACHE_SPLIT_MARKER = "\n<<<PROTEGE_SYSTEM_SPLIT>>>\n";

function toAnthropic(turns: OAITurn[]): {
  systemStable: string;
  systemDynamic: string;
  anthropicMessages: Anthropic.Messages.MessageParam[];
} {
  let systemText = MENTOR_SYSTEM_PROMPT;
  const out: Anthropic.Messages.MessageParam[] = [];

  for (const t of turns) {
    if (t.role === "system") {
      // Use the last system message as the system prompt
      if (t.content) systemText = t.content;
      continue;
    }

    if (t.role === "user") {
      if (typeof t.content === "string") {
        out.push({ role: "user", content: t.content });
      }
      continue;
    }

    if (t.role === "assistant") {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (t.content) {
        blocks.push({ type: "text", text: t.content });
      }
      if (t.tool_calls && t.tool_calls.length > 0) {
        for (const tc of t.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: input as Record<string, unknown>,
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (t.role === "tool") {
      // Anthropic: tool_result goes inside a user message's content array.
      // If the previous out-message is a user with content blocks, push into it.
      // Otherwise start a new user message.
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: t.tool_call_id ?? "",
        content: t.content ?? "",
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content)
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
  }

  // Split into stable (cacheable globally) + dynamic (per-user) halves.
  // If no marker is present (legacy / fallback path) the whole prompt is
  // treated as stable.
  const splitIdx = systemText.indexOf(CACHE_SPLIT_MARKER);
  const systemStable =
    splitIdx === -1 ? systemText : systemText.slice(0, splitIdx);
  const systemDynamic =
    splitIdx === -1
      ? ""
      : systemText.slice(splitIdx + CACHE_SPLIT_MARKER.length);

  return { systemStable, systemDynamic, anthropicMessages: out };
}
