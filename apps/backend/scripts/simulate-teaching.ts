#!/usr/bin/env tsx
/**
 * Teaching simulator — exercises the typed-teaching pipeline end-to-end.
 *
 * Hits the running backend at $PROTEGE_BACKEND_URL/chat (default
 * http://localhost:8787), walks through scripted conversation scenarios,
 * and prints structured terminal output showing mode upgrades, tool
 * calls, beat counts, length compliance, etc.
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │  ┌─ scenario header                                            │
 *   │  ├─ per turn:  USER msg → mode → tool calls → PROTEGE reply    │
 *   │  └─ per turn:  word count, ends-with-question, expectation diff│
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Setup:
 *   1. Start the backend in dev mode:
 *        cd apps/backend && pnpm dev
 *   2. (Local-dev shortcut) export PROTEGE_AUTH_REQUIRED=false  before
 *      starting the backend so this simulator doesn't need a real
 *      GitHub Bearer. OR set PROTEGE_TEST_BEARER=<token> in this
 *      script's environment if auth is on.
 *
 * Usage:
 *   pnpm tsx scripts/simulate-teaching.ts            # all scenarios
 *   pnpm tsx scripts/simulate-teaching.ts --only=2   # one scenario
 *   pnpm tsx scripts/simulate-teaching.ts --interactive
 *
 * Tool calls are stubbed (read_file returns placeholder text, etc.) so
 * the model isn't blocked waiting for real workspace data — we're
 * testing the persona / mode / beat behavior, not the tool plumbing.
 */

import * as readline from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ESM doesn't expose __dirname — derive it from import.meta.url so the
// script can locate the sibling simulation-logs/ directory regardless
// of where it was invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKEND = process.env.PROTEGE_BACKEND_URL ?? "http://localhost:8787";
// Per-run fresh user-id by default — otherwise memory writes from earlier
// scenarios (esp. "concept" rows from P6) bleed forward and cause false
// negatives ("model said: you already own this — no need to remember
// again" reads as a P6 failure even though the system worked correctly
// LAST run). Set PROTEGE_TEST_USER_ID explicitly to opt in to memory
// persistence across runs (useful for testing the next-session flow).
const TEST_USER_ID =
  process.env.PROTEGE_TEST_USER_ID ??
  `sim-user-teaching-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_BEARER = process.env.PROTEGE_TEST_BEARER;

// ─── ANSI helpers ────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const colorize = (s: string, color: string) => `${color}${s}${C.reset}`;

// ─── Types (loose copy of @protege/types — keep simulator standalone) ─
interface OAITurn {
  role: "user" | "assistant";
  content: string;
}
interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface ToolResult {
  id: string;
  name: string;
  content: string;
  error?: string;
}
interface ChatRunRequest {
  userId?: string;
  workspace?: unknown;
  messages: OAITurn[];
  newUserMessage?: string;
  toolResults?: ToolResult[];
  mode?: string;
  backend?: string;
  tier?: string;
  noTools?: boolean;
}
interface ChatRunResponse {
  reply?: string;
  toolCalls?: ToolCall[];
  messages?: OAITurn[];
}

// ─── Scenarios ───────────────────────────────────────────────────────

interface Expectation {
  /** Mode the simulator predicts the call will use (mirrors extension classifier). */
  mode?: "teaching-text" | "text" | "teaching";
  /** Reply must end with a question mark (P2 PAUSE-at-checkpoint). */
  endsWithQuestion?: boolean;
  /** Word ceiling for this beat (P2 60-150 words). */
  maxWords?: number;
  /** Word floor (catch one-liner cop-outs). */
  minWords?: number;
  /**
   * Reply MUST contain at least one fenced code block (```…```).
   * Used for the SHOW phase of the teaching arc.
   */
  hasCodeBlock?: boolean;
  /**
   * Reply MUST NOT contain a fenced code block. Used for the EXPLAIN
   * phase — bot should give pure prose, no code yet.
   */
  noCodeBlock?: boolean;
  /**
   * Reply must contain at least one of these substrings (case-insensitive).
   * Used for the TRY phase — looks for task-shaped phrases like "paste",
   * "try writing", "show me", "in your", etc.
   */
  containsAny?: string[];
  /**
   * A specific extension-side tool name should appear in this turn's
   * client-facing tool calls. Note: server-side tools like `remember`
   * never appear here — use `expectConceptMemory` for those.
   */
  hasToolCall?: string;
  /**
   * After this turn, the user's memory store should contain a `concept`
   * row (written either by the model's own remember() call OR by the
   * server-side P6 enforcer in routes/chat.ts). Verified by hitting
   * GET /memory with the test user-id.
   */
  expectConceptMemory?: boolean;
  /** Free-form note shown next to the assertion in the report. */
  note?: string;
}

interface Turn {
  user: string;
  expect?: Expectation;
}

interface Scenario {
  name: string;
  why: string;
  turns: Turn[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "1. Happy path — first-message classifier upgrades to teaching-text",
    why: "P1 (intent gate) + P2 (beat structure). Reply 1 should be a probe or one beat that ends with a question, NOT a paragraph dump.",
    turns: [
      {
        user: "teach me how Swiper works",
        expect: {
          mode: "teaching-text",
          endsWithQuestion: true,
          maxWords: 160,
          // 18 not 25 — a focused 20-word probe ("Have you used X before, or
          // first time?") is correct teaching behavior, not a deficiency.
          // We only want to catch one-line cop-outs, not punish concision.
          minWords: 18,
          note: "first-message classifier should fire",
        },
      },
      {
        user: "I want the swipeable carousel kind on mobile",
        expect: { maxWords: 160, endsWithQuestion: true },
      },
      {
        user: "got it",
        expect: { maxWords: 160, endsWithQuestion: true, note: "should advance, not re-explain" },
      },
      {
        user: "ok",
        expect: { maxWords: 160 },
      },
    ],
  },
  {
    name: "2. Confusion path — P3 read-the-listener should re-explain with a different example",
    why: "After teach starts, typing 'huh?' should produce a SHORTER reply with a DIFFERENT concrete example, not more abstraction.",
    turns: [
      {
        user: "teach me React useState",
        expect: { mode: "teaching-text", endsWithQuestion: true },
      },
      { user: "I'm comfortable with React basics" },
      {
        user: "huh?",
        expect: {
          maxWords: 130,
          note: "P3: confusion → same idea, different example, no more abstraction",
        },
      },
      { user: "ok now I get it" },
    ],
  },
  {
    name: "3. Your-turn enforcement — P4 should produce a code/prediction ask by beat 3-4",
    why: "Every 2-3 explanation beats, force a YOUR-TURN beat. By the 4th turn we should see 'paste/predict/spot/in one sentence' phrasing.",
    turns: [
      {
        user: "teach me how setState updates work in React",
        expect: { mode: "teaching-text" },
      },
      { user: "I've used class components before" },
      { user: "ok" },
      {
        user: "yeah",
        expect: { note: "by here a YOUR-TURN beat is overdue" },
      },
    ],
  },
  {
    name: "4. Code review specificity — P5 should quote one line + name one issue",
    why: "Pasting broken code (key={i}) in response to a YOUR-TURN should produce: specific quote, ONE issue, tiny corrected snippet, retry ask. NOT 'looks great'.",
    turns: [
      {
        user: "teach me React keys in lists",
        expect: { mode: "teaching-text" },
      },
      { user: "I'm an experienced JS dev — skip the basics" },
      { user: "ok continue" },
      {
        user:
          "Here's my attempt:\n```jsx\n{items.map((item, i) => <li key={i}>{item.name}</li>)}\n```",
        expect: {
          note: "P5: should quote `key={i}`, name reorder bug, no vague praise",
        },
      },
    ],
  },
  {
    name: "5. Mastery memory — P6 should call remember after a clean YOUR-TURN pass",
    why: "Quiz-style YOUR-TURN with a clear right answer + correct user reply should trigger remember('concept', 'user owns: …').",
    turns: [
      {
        user: "teach me array.map vs array.forEach",
        expect: { mode: "teaching-text" },
      },
      {
        user: "I'm comfortable with JS basics, skip the intro",
      },
      {
        // Force the bot into an unambiguous YOUR-TURN beat with a right
        // answer. This sidesteps the prior failure where the bot asked
        // a preference question ('which feels more natural?') — those
        // don't satisfy the P6 trigger ('previous reply asked a question
        // with a right answer'), so remember was correctly NOT called.
        user: "Quiz me — ask me to summarize the difference in one sentence.",
      },
      {
        user:
          "map returns a new transformed array, forEach runs side effects and returns undefined.",
        expect: {
          expectConceptMemory: true,
          note: "P6: clean one-sentence answer to a quiz prompt → a concept memory row should exist after this turn (either via model's remember tool or via server-side P6 enforcer)",
        },
      },
    ],
  },
  {
    name: "6. Off-track answer — P3 should name the specific mistake, not restart the lesson",
    why: "When the user gives a SPECIFICALLY WRONG answer (not vague), the bot should name what's wrong + re-explain ONLY that piece. Not restart the whole lesson.",
    turns: [
      {
        user: "teach me JavaScript closures",
        expect: { mode: "teaching-text", endsWithQuestion: true },
      },
      { user: "I know functions but closures are fuzzy" },
      // The bot will likely teach with a counter() example. We then give a
      // wrong answer that misidentifies WHICH variable is captured.
      {
        user: "So the closure captures the value of count at the moment the function was created?",
        expect: {
          maxWords: 200,
          note: "P3 off-track: should correct the 'captures value' misconception specifically (it captures the variable, not the value at creation), not restart from 'a closure is a function...'",
        },
      },
    ],
  },
  {
    name: "7. Tangent question — P3 should bookmark and continue, not derail",
    why: "Asking 'does this also apply to X?' mid-lesson should get bookmarked and the original thread continued. Bot should not abandon the original concept.",
    turns: [
      {
        user: "teach me how Promise.all works",
        expect: { mode: "teaching-text", endsWithQuestion: true },
      },
      { user: "I've used promises but only single .then chains" },
      {
        user: "wait — does this apply to async/await too?",
        expect: {
          maxWords: 180,
          note: "P3 tangent: should bookmark async/await ('good question, let's finish Promise.all first'), then continue the Promise.all thread",
        },
      },
    ],
  },
  {
    name: "8. Refusal handling — P4 should push back ONCE, then drop on second refusal",
    why: "When bot asks YOUR-TURN and user refuses ('I'll figure it out'), bot should push back once. If refused again, it drops the ask but flags concept as unverified for the closing beat.",
    turns: [
      {
        user: "teach me how useEffect cleanup works",
        expect: { mode: "teaching-text" },
      },
      { user: "I've used useEffect but cleanup is murky" },
      { user: "ok" },
      // By turn 4 a YOUR-TURN beat should appear. We refuse it.
      { user: "I'll figure it out from here, just keep explaining" },
      // Refuse again — bot should drop and continue.
      {
        user: "no really, I'm good — just continue",
        expect: {
          maxWords: 180,
          note: "P4 refusal: should drop the YOUR-TURN ask after the second refusal and continue (with internal note to revisit at close)",
        },
      },
    ],
  },
  {
    name: "9. Code review on PASS — P5 should quote one line + advance, no rewrite",
    why: "Pasting WORKING code in response to a YOUR-TURN should produce: ONE-sentence acknowledgement quoting a specific token, advance to next beat. No rewrite, no padding.",
    turns: [
      {
        user: "teach me debouncing in JavaScript",
        expect: { mode: "teaching-text" },
      },
      { user: "I know throttling but debounce is the inverse, right?" },
      { user: "ok continue" },
      // Working debounce code — passes the test.
      {
        user:
          "Here's my attempt:\n```js\nfunction debounce(fn, delay) {\n  let timer;\n  return (...args) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), delay);\n  };\n}\n```",
        expect: {
          maxWords: 120,
          note: "P5 pass: should acknowledge briefly + advance, NOT rewrite the function or list 3 nitpicks",
        },
      },
    ],
  },
  {
    name: "10. Non-teach message — P1 should NOT trigger teaching mode",
    why: "Negative test: a regular code question or chat message should stay in 'text' mode. Only teach-shaped first messages upgrade.",
    turns: [
      {
        user: "yo what's the time complexity of Array.prototype.sort",
        expect: {
          mode: "text",
          note: "P1 negative: 'what's the time complexity' is technical Q&A, not a teaching ask — stays in text mode",
        },
      },
    ],
  },
  {
    name: "11. ARC VERIFICATION — strict phase-by-phase teaching flow",
    why: "Validates the new TEACHING_TEXT arc: PROBE → EXPLAIN (no code) → SHOW (code) → TRY (task) → REVIEW. Each phase = one message, never combined. This is the test that the new prompt actually produces a multi-message arc instead of one wall of text.",
    turns: [
      {
        user: "teach me how useEffect works",
        expect: {
          mode: "teaching-text",
          endsWithQuestion: true,
          maxWords: 80,
          note: "PHASE 1 (PROBE): one short question about the user's level, no teaching yet",
        },
      },
      {
        user: "yeah I know hooks but useEffect is fuzzy",
        expect: {
          maxWords: 110,
          noCodeBlock: true,
          note: "PHASE 2 (EXPLAIN): pure prose, no code block, ~30-60 words. Just the concept.",
        },
      },
      {
        user: "ok",
        expect: {
          hasCodeBlock: true,
          maxWords: 60,
          note: "PHASE 3 (SHOW): one code example + short caption. Caption is brief.",
        },
      },
      {
        user: "got it",
        expect: {
          containsAny: ["paste", "try writing", "your file", "now you", "in your", "show me", "write a"],
          maxWords: 90,
          note: "PHASE 4 (TRY): explicit coding task. Should ask the user to produce code.",
        },
      },
      {
        user:
          "Here's my attempt:\n```jsx\nuseEffect(() => {\n  console.log(todos)\n}, [todos])\n```",
        expect: {
          maxWords: 90,
          note: "PHASE 5 (REVIEW pass): brief acknowledgement quoting a specific token, then advance",
        },
      },
    ],
  },
  {
    name: "12. MICRO-STEP — adaptive plan-then-step with why-question insertion",
    why: "Tests the micro-step algorithm: PROBE → planner runs → walks through plan one atomic step per message. Mid-flight 'why?' should insert a WHY-ANSWER step; ack should advance. Every reply should be ≤30 prose words (code blocks don't count).",
    turns: [
      {
        user: "teach me how useEffect works",
        expect: {
          mode: "teaching-text",
          endsWithQuestion: true,
          maxWords: 35,
          note: "PROBE: short level question, end with ?",
        },
      },
      {
        user: "first time",
        expect: {
          maxWords: 60,
          note: "Step 1 of plan (probably EXPLAIN-ATOM or SHOW-CODE): tight, one atom",
        },
      },
      {
        user: "ok",
        expect: {
          maxWords: 60,
          note: "Step 2: another single atom",
        },
      },
      {
        user: "why does the dependency array matter?",
        expect: {
          maxWords: 50,
          noCodeBlock: true,
          note: "WHY-ANSWER inserted: short, focused, no code, no follow-up",
        },
      },
      {
        user: "ok got it",
        expect: {
          maxWords: 60,
          note: "Resumes plan at step that was current before why-question",
        },
      },
    ],
  },
];

// ─── Local mirror of the extension's teaching classifier ─────────────
// Lets us predict (and assert on) the mode the request *should* use.

const EXPLICIT =
  /\b(teach|explain|show me|how does|what is|walk me through|i want to learn|help me understand|deep dive)\b/i;
const QUESTION_SHAPE = /^(why|how|when)\b.{8,}\?$/i;
const CONFUSION_RE =
  /\b(don'?t (?:get|understand)|confused|not sure why|wait what|i'?m lost)\b/i;

function isTeachingShape(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length < 3) return false;
  return (
    EXPLICIT.test(trimmed) ||
    QUESTION_SHAPE.test(trimmed) ||
    CONFUSION_RE.test(trimmed)
  );
}

// ─── Run log (captured for the markdown transcript file) ────────────

interface RecordedToolCall {
  name: string;
  argsJson: string;
  toolResultStub: string;
}

interface TurnLog {
  turnNumber: number;
  userMessage: string;
  modeSent: string;
  preTurnHistorySize: number;
  toolCalls: RecordedToolCall[];
  finalReply: string;
  proseWords: number;
  endsWithQuestion: boolean;
  expectations?: Expectation;
  failures: string[];
  passed: boolean;
  /** Backend errors that aborted the turn (shown verbatim in log). */
  abortError?: string;
}

interface ScenarioLog {
  number: number;
  name: string;
  why: string;
  turns: TurnLog[];
  totalFailures: number;
}

// Single global accumulator — appended to inside runScenario, dumped to
// disk at the end of main().
const RUN_LOG: ScenarioLog[] = [];

// ─── Backend HTTP ────────────────────────────────────────────────────

async function callChat(body: ChatRunRequest): Promise<ChatRunResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-user-id": body.userId ?? TEST_USER_ID,
  };
  if (TEST_BEARER) headers["Authorization"] = `Bearer ${TEST_BEARER}`;

  const res = await fetch(`${BACKEND}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as ChatRunResponse;
}

/** Fetch the test user's current memories. Used to verify P6 mastery
 *  rows after a teaching scenario — works regardless of whether the
 *  write came from the model's `remember` call or the server-side
 *  enforcer. */
interface MemoryRowPreview {
  type: string;
  content: string;
}
async function fetchMemories(): Promise<MemoryRowPreview[]> {
  const headers: Record<string, string> = {
    "x-user-id": TEST_USER_ID,
  };
  if (TEST_BEARER) headers["Authorization"] = `Bearer ${TEST_BEARER}`;
  const res = await fetch(`${BACKEND}/memory`, { headers });
  if (!res.ok) {
    throw new Error(`/memory HTTP ${res.status}`);
  }
  const data = (await res.json()) as { memories: MemoryRowPreview[] };
  return data.memories ?? [];
}

// ─── Stub tool executor (so the loop terminates) ─────────────────────

function simulateToolResult(
  name: string,
  args: Record<string, unknown>
): string {
  switch (name) {
    case "read_file":
      return [
        "1  // simulated file content",
        "2  function add(a, b) { return a + b; }",
        "3  export default add;",
      ].join("\n");
    case "list_files":
      return "page.tsx\nlayout.tsx\nApp.tsx";
    case "grep":
      return "(no matches in simulator)";
    case "show_code":
      return "// shown in editor (simulated)";
    case "highlight_code": {
      const regions = (args.regions as unknown[] | undefined) ?? [];
      return `Highlighted ${regions.length} region${regions.length === 1 ? "" : "s"} (simulated)`;
    }
    case "clear_highlights":
      return "Cleared.";
    case "remember":
      return "Saved memory (simulated).";
    case "forget":
      return "Removed memory (simulated).";
    case "teach_step":
      return "Teach step rendered (simulated).";
    default:
      return "ok";
  }
}

// ─── Pretty printers ─────────────────────────────────────────────────

function hr(char = "─", color = C.cyan) {
  console.log(colorize(char.repeat(74), color));
}

function header(scenario: Scenario, idx: number) {
  console.log("");
  console.log(colorize("═".repeat(74), C.cyan));
  console.log(
    colorize(` SCENARIO ${idx + 1} · ${scenario.name}`, C.bold + C.cyan)
  );
  console.log(colorize(` Why:  ${scenario.why}`, C.dim));
  console.log(colorize("═".repeat(74), C.cyan));
}

function box(title: string, color: string, body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  out.push(colorize(`  ${title}`, color));
  for (const l of lines) out.push(`  ${colorize("│", color)} ${l}`);
  return out.join("\n");
}

function summarizeReply(reply: string): { words: number; endsQ: boolean; charCount: number } {
  const trimmed = reply.trim();
  // Count prose words only — strip fenced code blocks and inline code
  // before counting. The persona's 60-150 cap is about prose density,
  // not code volume; a 4-line snippet shouldn't eat 30 of a beat's
  // word budget. Inline `code` tokens stay (they're part of the
  // sentence flow), but ```fences``` are dropped wholesale.
  const proseOnly = trimmed.replace(/```[\s\S]*?```/g, " ");
  const tokens = proseOnly.split(/\s+/).filter((w) => w.length > 0);
  const words = tokens.length;
  const endsQ = /[?!]$/.test(trimmed.replace(/[\s\)\]"]+$/, ""));
  return { words, endsQ, charCount: trimmed.length };
}

// ─── Single-conversation runner ──────────────────────────────────────

async function runScenario(scenario: Scenario, idx: number) {
  header(scenario, idx);

  // Capture this scenario into the run-log accumulator. Every turn
  // appends a TurnLog into scenarioLog.turns; the markdown writer reads
  // RUN_LOG at the end of main().
  const scenarioLog: ScenarioLog = {
    number: idx + 1,
    name: scenario.name,
    why: scenario.why,
    turns: [],
    totalFailures: 0,
  };
  RUN_LOG.push(scenarioLog);

  // Mutable — every backend round returns updated messages (which include
  // the assistant's tool_use blocks + the user's tool_result blocks). We
  // overwrite our local copy each round, otherwise the next round sends
  // tool_results without their corresponding tool_use parent and the
  // Anthropic API rejects the request.
  let messages: OAITurn[] = [];
  let stickyMode: string | undefined;
  let scenarioFailures = 0;

  for (let t = 0; t < scenario.turns.length; t++) {
    const turn = scenario.turns[t];
    const turnNumber = t + 1;

    // Predict the mode the same way the extension would.
    let modeForRequest = stickyMode;
    if (t === 0) {
      modeForRequest = isTeachingShape(turn.user) ? "teaching-text" : "text";
      stickyMode = modeForRequest;
    }

    console.log("");
    console.log(colorize(`Turn ${turnNumber}`, C.bold));
    console.log(`${colorize("USER ▸", C.green)} ${turn.user.replace(/\n/g, "\n        ")}`);
    console.log(
      colorize(
        `  → mode: ${modeForRequest ?? "text"}  ·  history: ${messages.length / 2}`,
        C.dim
      )
    );

    // ─── Tool loop ───
    const recordedToolCalls: RecordedToolCall[] = [];
    const preTurnHistorySize = messages.length;
    let newUserMessage: string | undefined = turn.user;
    let toolResults: ToolResult[] | undefined;
    let toolsSeenThisTurn: string[] = [];
    let finalReply = "";
    let round = 0;
    let aborted = false;
    let abortError: string | undefined;

    while (true) {
      round++;
      if (round > 12) {
        console.log(colorize(`  ✗ aborted: tool loop exceeded 12 rounds`, C.red));
        aborted = true;
        break;
      }

      let res: ChatRunResponse;
      try {
        res = await callChat({
          userId: TEST_USER_ID,
          messages,
          newUserMessage,
          toolResults,
          mode: modeForRequest,
          backend: "haiku",
        });
      } catch (e) {
        abortError = (e as Error).message;
        console.log(
          colorize(`  ✗ backend call failed: ${abortError}`, C.red)
        );
        aborted = true;
        break;
      }

      // Backend is the source of truth for the running message stream — it
      // appends the assistant's tool_use blocks + our tool_results in the
      // exact shape the next round needs. If we kept our own version, the
      // tool-loop request bodies would lose the tool_use → tool_result
      // pairing and Anthropic 400s.
      if (res.messages && res.messages.length > 0) {
        messages = res.messages;
      }
      newUserMessage = undefined;
      toolResults = undefined;

      if (res.toolCalls && res.toolCalls.length > 0) {
        for (const tc of res.toolCalls) {
          toolsSeenThisTurn.push(tc.name);
          const argsJson = JSON.stringify(tc.arguments);
          const argPreview = argsJson.slice(0, 90);
          console.log(
            colorize(
              `  ⚙  ${tc.name}(${argPreview}${argPreview.length >= 90 ? "…" : ""})`,
              C.yellow
            )
          );
          recordedToolCalls.push({
            name: tc.name,
            argsJson,
            toolResultStub: simulateToolResult(tc.name, tc.arguments),
          });
        }
        toolResults = res.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          content: simulateToolResult(tc.name, tc.arguments),
        }));
        continue;
      }

      finalReply = res.reply ?? "";
      break;
    }

    if (aborted) {
      scenarioFailures++;
      // Even on abort, capture what we have so the log shows the failed turn.
      scenarioLog.turns.push({
        turnNumber,
        userMessage: turn.user,
        modeSent: modeForRequest ?? "text",
        preTurnHistorySize,
        toolCalls: recordedToolCalls,
        finalReply: "",
        proseWords: 0,
        endsWithQuestion: false,
        expectations: turn.expect,
        failures: [`backend aborted: ${abortError ?? "unknown"}`],
        passed: false,
        abortError,
      });
      continue;
    }
    // Note: do NOT push user/assistant manually — `messages` already
    // reflects the backend-managed conversation state including this turn.

    const { words, endsQ } = summarizeReply(finalReply);

    console.log("");
    console.log(box("PROTEGE ▸", C.blue, finalReply));
    console.log("");
    const meta: string[] = [
      `${words} words`,
      `ends with question: ${endsQ ? "yes ✓" : "no"}`,
    ];
    if (toolsSeenThisTurn.length > 0)
      meta.push(`tools: ${toolsSeenThisTurn.join(", ")}`);
    console.log(colorize(`  metrics ▸ ${meta.join(" · ")}`, C.dim));

    // ─── Assertions ───
    const turnFailures: string[] = [];
    if (turn.expect) {
      if (turn.expect.mode && modeForRequest !== turn.expect.mode) {
        turnFailures.push(
          `mode expected ${turn.expect.mode}, got ${modeForRequest}`
        );
      }
      if (turn.expect.endsWithQuestion && !endsQ) {
        turnFailures.push("expected reply to end with a question");
      }
      if (turn.expect.maxWords && words > turn.expect.maxWords) {
        turnFailures.push(`reply too long (${words} > ${turn.expect.maxWords})`);
      }
      if (turn.expect.minWords && words < turn.expect.minWords) {
        turnFailures.push(`reply too short (${words} < ${turn.expect.minWords})`);
      }
      if (
        turn.expect.hasToolCall &&
        !toolsSeenThisTurn.includes(turn.expect.hasToolCall)
      ) {
        turnFailures.push(
          `expected tool call ${turn.expect.hasToolCall} (saw: ${
            toolsSeenThisTurn.join(", ") || "none"
          })`
        );
      }
      if (turn.expect.hasCodeBlock !== undefined) {
        const hasFence = /```[\s\S]+?```/.test(finalReply);
        if (turn.expect.hasCodeBlock && !hasFence) {
          turnFailures.push("expected reply to include a fenced code block");
        }
      }
      if (turn.expect.noCodeBlock) {
        const hasFence = /```[\s\S]+?```/.test(finalReply);
        if (hasFence) {
          turnFailures.push(
            "expected NO code block (this phase should be prose-only)"
          );
        }
      }
      if (turn.expect.containsAny && turn.expect.containsAny.length > 0) {
        const lower = finalReply.toLowerCase();
        const hit = turn.expect.containsAny.find((s) =>
          lower.includes(s.toLowerCase())
        );
        if (!hit) {
          turnFailures.push(
            `expected reply to contain one of: ${turn.expect.containsAny.join(", ")}`
          );
        }
      }
      if (turn.expect.expectConceptMemory) {
        // Hit /memory to verify a concept row exists for this user.
        // Works for both paths: the model's own remember() (server-
        // executed inline) AND the server-side P6 auto-marker.
        try {
          const mems = await fetchMemories();
          const conceptRows = mems.filter((m) => m.type === "concept");
          if (conceptRows.length === 0) {
            turnFailures.push(
              "expected a concept memory row to exist; none found"
            );
          } else {
            console.log(
              colorize(
                `  ✓ concept memory found: ${conceptRows
                  .map((r) => r.content.slice(0, 80))
                  .join(" | ")}`,
                C.green
              )
            );
          }
        } catch (e) {
          turnFailures.push(
            `failed to fetch /memory for verification: ${(e as Error).message}`
          );
        }
      }

      if (turn.expect.note) {
        console.log(colorize(`  note ▸ ${turn.expect.note}`, C.gray));
      }

      if (turnFailures.length === 0) {
        console.log(colorize("  ✓ all expectations met", C.green));
      } else {
        scenarioFailures += turnFailures.length;
        for (const f of turnFailures) {
          console.log(colorize(`  ✗ ${f}`, C.red));
        }
      }
    }

    // Capture this turn into the scenario log.
    scenarioLog.turns.push({
      turnNumber,
      userMessage: turn.user,
      modeSent: modeForRequest ?? "text",
      preTurnHistorySize,
      toolCalls: recordedToolCalls,
      finalReply,
      proseWords: words,
      endsWithQuestion: endsQ,
      expectations: turn.expect,
      failures: turnFailures,
      passed: turnFailures.length === 0,
    });
  }
  scenarioLog.totalFailures = scenarioFailures;

  console.log("");
  if (scenarioFailures === 0) {
    console.log(colorize(`  scenario ${idx + 1} passed`, C.green + C.bold));
  } else {
    console.log(
      colorize(
        `  scenario ${idx + 1} had ${scenarioFailures} expectation failure${
          scenarioFailures === 1 ? "" : "s"
        }`,
        C.red + C.bold
      )
    );
  }
  return scenarioFailures;
}

// ─── Markdown log writer ─────────────────────────────────────────────
// Renders RUN_LOG into a single human-readable transcript file. Code
// fences are escaped via four-backtick wrappers so the user's pasted
// snippets (which already contain ``` triple fences) render as code in
// the surrounding markdown without breaking out.

function fenceWrap(content: string): string {
  // If the content already contains ``` we wrap with four backticks so
  // the inner triples don't terminate the outer fence. Otherwise three
  // is fine and renders cleaner in most viewers.
  if (content.includes("```")) {
    return `\`\`\`\`\n${content}\n\`\`\`\``;
  }
  return `\`\`\`\n${content}\n\`\`\``;
}

function formatRunLog(opts: {
  startedAt: string;
  finishedAt: string;
  totalFailures: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Teaching simulator transcript`);
  lines.push("");
  lines.push(`- **Started:** ${opts.startedAt}`);
  lines.push(`- **Finished:** ${opts.finishedAt}`);
  lines.push(`- **Backend:** ${BACKEND}`);
  lines.push(`- **User-id:** \`${TEST_USER_ID}\``);
  lines.push(`- **Bearer:** ${TEST_BEARER ? "set" : "not set (auth-required must be off)"}`);
  lines.push(
    `- **Result:** ${opts.totalFailures === 0 ? "all expectations met" : `${opts.totalFailures} expectation failure${opts.totalFailures === 1 ? "" : "s"}`}`
  );
  lines.push("");

  // ── Summary table ──
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| # | Scenario | Status | Failures | Why |`);
  lines.push(`|---|---|---|---|---|`);
  for (const s of RUN_LOG) {
    const status = s.totalFailures === 0 ? "✓ pass" : "✗ fail";
    const shortName = s.name.replace(/^\d+\.\s*/, "");
    const shortWhy = s.why.length > 90 ? s.why.slice(0, 87) + "…" : s.why;
    lines.push(
      `| ${s.number} | ${shortName} | ${status} | ${s.totalFailures} | ${shortWhy} |`
    );
  }
  lines.push("");

  // ── Detailed transcripts ──
  lines.push(`## Detailed transcripts`);
  lines.push("");

  for (const s of RUN_LOG) {
    lines.push(`### Scenario ${s.number} — ${s.name.replace(/^\d+\.\s*/, "")}`);
    lines.push("");
    lines.push(`**Why:** ${s.why}`);
    lines.push("");
    lines.push(
      `**Result:** ${s.totalFailures === 0 ? "all expectations met" : `${s.totalFailures} failure${s.totalFailures === 1 ? "" : "s"}`} across ${s.turns.length} turn${s.turns.length === 1 ? "" : "s"}`
    );
    lines.push("");

    for (const t of s.turns) {
      lines.push(`#### Turn ${t.turnNumber}`);
      lines.push("");
      lines.push(`- **Mode sent:** \`${t.modeSent}\``);
      lines.push(`- **Pre-turn history:** ${t.preTurnHistorySize} messages`);
      lines.push("");

      lines.push(`**USER said:**`);
      lines.push("");
      lines.push(fenceWrap(t.userMessage));
      lines.push("");

      if (t.toolCalls.length > 0) {
        lines.push(`**Tool calls fired (${t.toolCalls.length}):**`);
        lines.push("");
        for (let i = 0; i < t.toolCalls.length; i++) {
          const tc = t.toolCalls[i];
          lines.push(`${i + 1}. \`${tc.name}\``);
          lines.push("");
          lines.push(`   **args:**`);
          lines.push("");
          lines.push("   ```json");
          // Indent JSON so it stays inside the list item
          for (const argLine of tc.argsJson.split("\n")) {
            lines.push(`   ${argLine}`);
          }
          lines.push("   ```");
          lines.push("");
          lines.push(`   **simulated tool result:** \`${tc.toolResultStub.replace(/\n/g, " ⏎ ").slice(0, 200)}\``);
          lines.push("");
        }
      } else {
        lines.push(`**Tool calls fired:** _none_`);
        lines.push("");
      }

      if (t.abortError) {
        lines.push(`**Backend aborted this turn:**`);
        lines.push("");
        lines.push(fenceWrap(t.abortError));
        lines.push("");
      } else {
        lines.push(`**PROTEGE replied:**`);
        lines.push("");
        lines.push(fenceWrap(t.finalReply || "(empty reply)"));
        lines.push("");
      }

      lines.push(`**Metrics:**`);
      lines.push(`- Prose word count: ${t.proseWords}`);
      lines.push(`- Ends with question: ${t.endsWithQuestion ? "yes" : "no"}`);
      lines.push("");

      if (t.expectations) {
        lines.push(`**Expectations & assertions:**`);
        lines.push("");
        const e = t.expectations;
        if (e.note) lines.push(`- _Note:_ ${e.note}`);
        if (e.mode) lines.push(`- mode = \`${e.mode}\` ${t.modeSent === e.mode ? "✓" : "✗"} (got \`${t.modeSent}\`)`);
        if (e.endsWithQuestion !== undefined)
          lines.push(`- endsWithQuestion = ${e.endsWithQuestion} ${t.endsWithQuestion === e.endsWithQuestion ? "✓" : "✗"}`);
        if (e.minWords !== undefined)
          lines.push(`- minWords = ${e.minWords} ${t.proseWords >= e.minWords ? "✓" : "✗"} (got ${t.proseWords})`);
        if (e.maxWords !== undefined)
          lines.push(`- maxWords = ${e.maxWords} ${t.proseWords <= e.maxWords ? "✓" : "✗"} (got ${t.proseWords})`);
        if (e.hasToolCall)
          lines.push(`- hasToolCall = \`${e.hasToolCall}\` ${t.toolCalls.some((c) => c.name === e.hasToolCall) ? "✓" : "✗"}`);
        lines.push("");

        if (t.failures.length > 0) {
          lines.push(`**Failures:**`);
          for (const f of t.failures) lines.push(`- ✗ ${f}`);
          lines.push("");
        } else {
          lines.push(`✓ All expectations met for this turn.`);
          lines.push("");
        }
      }

      lines.push(`---`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function writeRunLog(totalFailures: number, startedAt: string): string {
  const finishedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "simulation-logs");
  mkdirSync(dir, { recursive: true });
  const filename = `run-${safeTimestamp}.md`;
  const fullPath = path.join(dir, filename);
  const body = formatRunLog({ startedAt, finishedAt, totalFailures });
  writeFileSync(fullPath, body, "utf8");
  return fullPath;
}

// ─── Interactive mode ────────────────────────────────────────────────

async function runInteractive() {
  console.log("");
  hr("═");
  console.log(colorize(" Interactive teaching simulator", C.bold + C.cyan));
  console.log(colorize(" Type to send · Ctrl+C to exit", C.dim));
  hr("═");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let messages: OAITurn[] = [];
  let stickyMode: string | undefined;

  const ask = () => {
    rl.question(`${colorize("you ▸", C.green)} `, async (text) => {
      if (!text.trim()) {
        ask();
        return;
      }

      let mode = stickyMode;
      if (messages.length === 0) {
        mode = isTeachingShape(text) ? "teaching-text" : "text";
        stickyMode = mode;
      }

      let newUserMessage: string | undefined = text;
      let toolResults: ToolResult[] | undefined;
      const tools: string[] = [];
      let finalReply = "";

      let round = 0;
      while (true) {
        round++;
        if (round > 12) {
          console.log(colorize("  (tool loop too long)", C.red));
          break;
        }
        try {
          const res = await callChat({
            userId: TEST_USER_ID,
            messages,
            newUserMessage,
            toolResults,
            mode,
            backend: "haiku",
          });
          // Backend owns the canonical message stream including tool_use /
          // tool_result blocks — overwrite local copy each round.
          if (res.messages && res.messages.length > 0) {
            messages = res.messages;
          }
          newUserMessage = undefined;
          toolResults = undefined;
          if (res.toolCalls && res.toolCalls.length > 0) {
            for (const tc of res.toolCalls) {
              tools.push(tc.name);
              const arg = JSON.stringify(tc.arguments).slice(0, 80);
              console.log(
                colorize(`  ⚙  ${tc.name}(${arg}…)`, C.yellow)
              );
            }
            toolResults = res.toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              content: simulateToolResult(tc.name, tc.arguments),
            }));
            continue;
          }
          finalReply = res.reply ?? "";
          break;
        } catch (e) {
          console.log(colorize(`  backend error: ${(e as Error).message}`, C.red));
          break;
        }
      }
      // messages already updated by backend — don't push manually.

      const { words, endsQ } = summarizeReply(finalReply);
      console.log(
        colorize(
          `  [mode=${mode ?? "text"} · ${words}w · ${endsQ ? "Q" : "."}${
            tools.length > 0 ? ` · tools=${tools.join(",")}` : ""
          }]`,
          C.dim
        )
      );
      console.log(`${colorize("protege ▸", C.blue)} ${finalReply}`);
      console.log("");
      ask();
    });
  };

  ask();
}

// ─── Entry point ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const interactive =
    args.includes("--interactive") || args.includes("-i");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? Math.max(1, Math.min(SCENARIOS.length, parseInt(onlyArg.split("=")[1], 10)))
    : undefined;

  console.log(colorize("Protege teaching simulator", C.bold));
  console.log(colorize(`  backend  : ${BACKEND}`, C.dim));
  console.log(colorize(`  user-id  : ${TEST_USER_ID}`, C.dim));
  console.log(
    colorize(
      `  bearer   : ${TEST_BEARER ? "set (env)" : "not set — backend must run with PROTEGE_AUTH_REQUIRED=false"}`,
      C.dim
    )
  );

  if (interactive) {
    await runInteractive();
    return;
  }

  const startedAt = new Date().toISOString();
  const list = only ? [SCENARIOS[only - 1]] : SCENARIOS;
  let totalFailures = 0;
  for (let i = 0; i < list.length; i++) {
    const idx = only ? only - 1 : i;
    const fails = await runScenario(list[i], idx);
    totalFailures += fails;
  }

  console.log("");
  hr("═");
  if (totalFailures === 0) {
    console.log(colorize(" All expectations met across all scenarios.", C.green + C.bold));
  } else {
    console.log(
      colorize(
        ` ${totalFailures} expectation failure${
          totalFailures === 1 ? "" : "s"
        } across ${list.length} scenario${list.length === 1 ? "" : "s"}.`,
        C.red + C.bold
      )
    );
    console.log(
      colorize(
        " Failing assertions don't necessarily mean the feature is broken — model output is non-deterministic.",
        C.dim
      )
    );
    console.log(
      colorize(
        " Re-run; treat repeated failures as real signal.",
        C.dim
      )
    );
  }
  hr("═");

  // Always write the markdown transcript — pass or fail, it's the
  // primary artifact the user reviews to see what the model actually did.
  try {
    const logPath = writeRunLog(totalFailures, startedAt);
    console.log("");
    console.log(colorize(" Full transcript written to:", C.bold + C.cyan));
    console.log(colorize(` ${logPath}`, C.cyan));
    console.log("");
  } catch (e) {
    console.error(
      colorize(`  failed to write transcript: ${(e as Error).message}`, C.red)
    );
  }

  process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(colorize((e as Error).stack ?? String(e), C.red));
  process.exit(1);
});
