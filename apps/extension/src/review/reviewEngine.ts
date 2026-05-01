import * as vscode from "vscode";
import { aiQuery, getAiBackend, getLastCall } from "../ai/aiBackend.js";
import { log, logBlock } from "../log.js";

/**
 * Per-scan cost estimate in USD. Uses the standard ~4-chars-per-token
 * heuristic and the published per-million pricing for each backend.
 * On-device runs locally so the cost is zero.
 *
 *   gpt-4o-mini (the "cheap" tier scans go through): $0.15/Mtok in,
 *     $0.60/Mtok out. The Protege backend pins kind="scan" requests to
 *     this model regardless of your local pick (see backend/routes/chat).
 *   haiku 4.5 (only fires for kind="teach"): $1/Mtok in, $5/Mtok out.
 *     Listed for completeness — scan-tier callsites won't see it.
 */
function estimateScanCostUsd(
  backend: string,
  inTokens: number,
  outTokens: number
): number {
  if (backend === "on-device") return 0;
  // Cloud scans go through the backend's "cheap tier" routing (see
  // backend/routes/chat.ts → OPENAI_CHEAP_MODEL, default gpt-4o-mini).
  // Cheap-tier published pricing: $0.15/Mtok input, $0.60/Mtok output.
  // Teach-tier callsites go through a separate code path and aren't
  // priced by this estimator.
  return (inTokens * 0.15 + outTokens * 0.6) / 1_000_000;
}

/** Running totals since extension activation. Reset on reload. Surfaced
 *  in the scan log so you can see cost climbing in real time. */
let sessionScanCount = 0;
let sessionCostUsd = 0;

/**
 * Review Engine — AI-powered code review.
 *
 * Ships the active file to the user's selected backend (on-device Qwen or
 * Claude Haiku/Sonnet) and asks for a JSON array of issues. Unlike the
 * previous regex engine, this catches real bugs, logic errors, and
 * language-aware anti-patterns — not just surface patterns.
 */

/**
 * A location in the workspace that's *related* to a suggestion but lives
 * in a different line or file. Used for block-scope findings (function-
 * wide bugs) and flow-scope findings (multi-file architectural issues).
 */
export interface Anchor {
  /** `uri.toString()` of the related document. */
  uri: string;
  /** 0-based line number. */
  line: number;
  /** Short human-readable reason this anchor is part of the finding. */
  label: string;
}

export interface Suggestion {
  range: vscode.Range;
  message: string;
  severity: "info" | "warn" | "perf";
  fix?: string;
  ruleId: string;
  /**
   * Short 3–5 word tag suitable for inline decorations (e.g. "array index key").
   * Always safe to render on a single line — never a full sentence.
   * Falls back to a prettified `ruleId` when the model omits it.
   */
  label: string;
  /**
   * One-sentence teaser for the hover card (≤ 100 chars). Slightly punchier
   * than `message` — a "why this matters" preview, not the full lesson.
   */
  teaser: string;
  /**
   * Full teaching paragraph (2–3 sentences). Rendered inside the inline
   * Comment-thread bubble where it can wrap properly.
   */
  lesson: string;
  /**
   * Pre-trimmed prose for TTS — should read naturally when spoken aloud
   * (no code fences, no markdown). Aim for 60–80 words.
   */
  voiceScript: string;
  /**
   * How big the issue is:
   *  - "atom"  → one line / one token (default; what the LIVE scanner emits)
   *  - "block" → a function / component body
   *  - "flow"  → spans 2+ files, tracked by `flowId`
   */
  scope?: "atom" | "block" | "flow";
  /** Related locations elsewhere in the same file or across files. */
  anchors?: Anchor[];
  /** Groups flow-scope findings that belong to the same architectural flow. */
  flowId?: string;
  /**
   * Which scan tier emitted this finding. Used by the store to dedup
   * and by telemetry/debug to trace where a suggestion came from.
   */
  tier?: "live" | "save" | "idle";
  /**
   * Teaching framing for the LEARN cloud scan path:
   *   "praise"    → they did something well, worth understanding why
   *   "concept"   → a pattern they're using — explain it so they own it
   *   "watch-out" → a real risk — framed as "next time, watch for this"
   * Absent on older SAVE/FLOW findings and on-device scans.
   */
  kind?: "praise" | "concept" | "watch-out";
}

interface AiIssue {
  line: number;
  severity: "info" | "warn" | "perf";
  message: string;
  fix?: string;
  ruleId?: string;
  label?: string;
  teaser?: string;
  lesson?: string;
  voiceScript?: string;
  kind?: "praise" | "concept" | "watch-out";
}

const MAX_FILE_LINES = 400;
const MAX_ISSUES = 5;          // on-device scans
// Raised 2026-04-23 from 2 → 5. The "silence > noise" cap + URI-wide
// rule cooldown combined to make LIVE feel dead — users reported "it
// almost never finds anything." With per-line cooldowns now in place
// the gate handles de-duplication; let the model surface what it
// actually sees.
const MAX_CLOUD_ISSUES = 5;

interface PromptOptions {
  /** All lines of the document (before truncation). Used for focus window. */
  allLines?: string[];
  /** 0-based cursor line at scan time. */
  activeLine?: number;
}

// Few-shot examples — compact input→output pairs that show Qwen EXACTLY
// what a well-formed finding looks like. Small models like Qwen follow
// examples dramatically better than they follow instructions. Each example
// is kept as short as possible to avoid eating the context budget. We pick
// patterns the user would actually see in a real React/TS file — the exact
// three issues that prompted this tuning pass (prefer-const, index-as-key,
// missing-await-in-map) are all represented.
const FEW_SHOT_EXAMPLES = `Examples:

Input (JavaScript):
\`\`\`
let name = "Alice"
console.log(name)
\`\`\`
Output: [{"line":1,"severity":"info","ruleId":"prefer-const","message":"\`name\` is never reassigned — use \`const\`.","fix":"const name = \\"Alice\\""}]

Input (React):
\`\`\`
items.map((item, i) => <li key={i}>{item.name}</li>)
\`\`\`
Output: [{"line":1,"severity":"warn","ruleId":"index-as-key","message":"Array index as React \`key\` causes buggy reconciliation when items reorder.","fix":"items.map((item) => <li key={item.id}>{item.name}</li>)"}]

Input (JavaScript):
\`\`\`
const data = users.map(u => fetchProfile(u))
\`\`\`
Output: [{"line":1,"severity":"warn","ruleId":"missing-await","message":"\`fetchProfile\` returns a Promise — wrap the map in \`Promise.all\` and \`await\`.","fix":"const data = await Promise.all(users.map(u => fetchProfile(u)))"}]

Input:
\`\`\`
const sum = 1 + 2
\`\`\`
Output: []
`;

// Language-specific rule hints. Qwen does much better when the prompt
// lists concrete rule names to look for vs "find bugs". Hints are layered:
// base rules always apply; language-specific rules are appended based on
// file extension / languageId.
function ruleHintsFor(languageId: string, fileName: string): string {
  const base = [
    "prefer-const (let that's never reassigned)",
    "off-by-one (loop bounds, slice indices)",
    "stale-closure (captured variable in async/callback)",
    "unused-variable / unused-parameter",
    "magic-number (unexplained numeric literal)",
    "nullable-access (property on maybe-null value)",
  ];
  const isTsx = /\.(tsx|jsx)$/i.test(fileName) || languageId === "typescriptreact" || languageId === "javascriptreact";
  const isAsync = ["javascript", "typescript", "javascriptreact", "typescriptreact"].includes(languageId);

  const extras: string[] = [];
  if (isTsx) {
    extras.push(
      "index-as-key (array index used as React \`key\`)",
      "missing-key (list element without \`key\`)",
      "useEffect-missing-deps (effect references state without depping it)",
      "useState-derived (state that could be derived from props)",
      "stale-state-in-setter (setX(x + 1) instead of setX(p => p + 1))"
    );
  }
  if (isAsync) {
    extras.push(
      "missing-await (Promise-returning call not awaited)",
      "promise-in-map (array.map returning promises without Promise.all)",
      "unhandled-rejection (async call without try/catch)"
    );
  }

  return [...base, ...extras].map((r) => `  - ${r}`).join("\n");
}

// Prefix every line with its 1-based number. Used by ALL scan prompts so
// the model copies the digit instead of counting lines itself — the
// primary defense against JSON.line ≠ prose-line drift. JSX nesting and
// other multi-line syntax reliably trips unnumbered prompts; numbered
// prompts are near-immune.
function numberLines(code: string): string {
  const lines = code.split("\n");
  return lines
    .map((l, i) => `${String(i + 1).padStart(3, " ")}  ${l}`)
    .join("\n");
}

// Build a focus-window view of the code: the full file, but with a
// CURSOR marker at the active line and the ±N line window labeled as
// the "focus region". Qwen then knows where the user is actively
// editing and concentrates attention there. When no cursor is provided
// (SAVE / FLOW), we just return the plain code block (still numbered).
function buildFocusedCode(
  code: string,
  lang: string,
  allLines: string[] | undefined,
  activeLine: number | undefined
): string {
  if (activeLine === undefined || !allLines || allLines.length === 0) {
    return `\`\`\`${lang}\n${numberLines(code)}\n\`\`\``;
  }
  const start = Math.max(0, activeLine - FOCUS_WINDOW_LINES);
  const end = Math.min(allLines.length - 1, activeLine + FOCUS_WINDOW_LINES);
  // Emit the code with line numbers and an arrow at the cursor line so
  // Qwen sees exactly where the user is. Annotated output is more tokens,
  // but it dramatically improves "focus" in practice.
  const numbered = allLines
    .map((l, i) => {
      const n = String(i + 1).padStart(3, " ");
      const inFocus = i >= start && i <= end;
      const isCursor = i === activeLine;
      const marker = isCursor ? "→" : inFocus ? "·" : " ";
      return `${n}${marker} ${l}`;
    })
    .join("\n");
  return `\`\`\`${lang}
${numbered}
\`\`\`

The \`→\` marker shows where the user's cursor is. Lines with \`·\` are
inside the focus window (±${FOCUS_WINDOW_LINES} around cursor). Prioritize
findings inside the focus window — that's what the user is actively
editing. Still report critical bugs outside the window if you spot them.`;
}

function buildPrompt(
  languageId: string,
  fileName: string,
  code: string,
  opts: PromptOptions = {}
): string {
  // On-device Qwen2.5-Coder 7B handles the rich 8-field schema reasonably
  // well — but we still keep a compact prompt for on-device as a safety
  // margin. Smaller on-device models (or earlier Qwen variants) under a
  // 512-token budget reliably produced one of:
  //   (a) truncated JSON → parse fail → zero findings shown,
  //   (b) findings dropped to fit the budget,
  //   (c) shallow / generic content for the extra fields.
  // 7B is much more reliable but inference is slower, so trimming the
  // schema keeps latency in check. Cloud models (Haiku/Sonnet) always
  // get the rich schema — they're big enough and fast enough to handle it.
  //
  // Strategy: give on-device a MINIMAL schema (5 fields). The client-side
  // `deriveLabel/Teaser/Lesson/VoiceScript` fallbacks synthesize the rest.
  // Surfaces keep working — they just look less teacher-y until the user
  // switches to Haiku for real lessons.
  const backend = getAiBackend();
  const isOnDevice =
    backend === "on-device" ||
    (backend === "auto" && false); // "auto" resolves at call site; treat as cloud for prompt sizing

  if (isOnDevice) {
    // Three things are doing the heavy lifting for Qwen 7B here:
    //   1. Few-shot examples — Qwen follows examples much better than
    //      pure instructions. Three concrete input→output pairs teach
    //      the exact schema and the bar for "is this a finding".
    //   2. Language-specific rule list — telling Qwen to look for
    //      "index-as-key" explicitly is 5-10× more effective than asking
    //      it to "find React anti-patterns". Small models need names.
    //   3. Focus window + cursor marker — Qwen's attention is finite;
    //      concentrate it on where the user is actually editing.
    const focused = buildFocusedCode(code, languageId, opts.allLines, opts.activeLine);
    const rules = ruleHintsFor(languageId, fileName);

    return `You are a code reviewer. Return ONLY a JSON array of issues. No prose, no markdown, no code fences — just the JSON array.

Schema for each issue:
- "line": 1-based line number
- "severity": "warn" | "perf" | "info"
- "ruleId": short kebab-case id
- "message": one plain-English sentence
- "fix": optional full-line replacement

Rules to look for in this file (${languageId}):
${rules}

${FEW_SHOT_EXAMPLES}

Output rules:
- Max ${MAX_ISSUES} issues, highest-value first
- Skip issues in commented-out code
- NEVER flag placeholder / scaffolding code: empty arrays, empty divs, hardcoded stubs, TODO comments, half-written components. The user knows it's not done — narrating "X is empty" is noise.
- NEVER flag observational stuff ("this variable holds X", "this renders Y"). Only flag things a senior reviewer would actually mention.
- Quality bar: if the finding could be answered with "yeah, obviously" or "I haven't finished that yet", drop it.
- If the code looks fine OR is clearly mid-edit, return []
- Output ONLY the JSON array (starts with \`[\`, ends with \`]\`)

File: ${fileName}

${focused}

Now review the file above and return the JSON array.`;
  }

  // Learning-first cloud prompt (Haiku / Sonnet).
  //
  // Silence-first framing. Most files SHOULD return []. A finding is a
  // signal worth interrupting for; everything else is noise. The prior
  // version told the model "err toward MORE, 2-4 per file is typical" —
  // that anchored output toward at least 2 findings, which the model
  // then filled with observational noise on placeholder code.
  //
  // Field shape (kind/label/lesson/voiceScript) is preserved so existing
  // surfaces keep rendering.
  return `You are a senior engineer reviewing a developer's editor. Your default is SILENCE. Speak only when something is genuinely worth a colleague tapping you on the shoulder for.

Return ONLY a JSON array. Most files should return []. Up to ${MAX_CLOUD_ISSUES} items maximum, but 0 is the most common correct answer.

The bar for emitting a finding (apply to EACH candidate before including it):
1. Would a senior dev pause on this line in a real PR review? If they'd skip past, you skip.
2. Is the code finished enough to comment on? Half-written components, empty stubs, scaffolding placeholders, TODO comments, single-line returns — DO NOT flag. The user knows their code isn't done.
3. Does the message TEACH or CHANGE something? "This variable holds X", "this renders Y", "this maps names to items" — that's narration, not teaching. Drop it.
4. Could a thoughtful reader respond "yeah, obviously"? Drop it.

Hard exclusions — never emit a finding for any of these:
- Empty arrays, empty objects, empty divs, empty function bodies. ANY message that mentions "is empty", "always empty", "renders nothing", "no items", "is hardcoded", "static empty array", "placeholder" is forbidden — the user is already aware. Drop it.
- Components that return placeholder JSX (\`<div></div>\`, \`<></>\`, scaffolding markup).
- Hardcoded stub data the user is clearly going to replace. Examples to NEVER flag: \`{ name: 'Completed', items: [] }\` ← classic mid-build placeholder; \`return <div></div>\` ← scaffolding; \`const data = []\` ← stub.
- "praise" for default imports, basic destructuring, normal variable names, "uses TypeScript", "uses React hooks". Praise must be earned by a non-obvious good call (clean state shape, derived state instead of duplicated, an early return that prevents a subtle bug).
- "concept" findings that just describe a built-in language feature in passing.
- Pure formatting nits: whitespace, quote style, semicolons, indentation, trailing commas. Those are linter territory, not teaching.
- Anything in commented-out code.

DO emit (these are real teaching moments, NOT style nits):
- \`let\` that's never reassigned in the file → "prefer-const" (info). This is about declaring intent — the user is signaling "this will change" when it won't. Worth a 2-sentence lesson.
- Likely typos in identifiers (e.g. component named \`Hme\` next to imports named \`Home\`).
- Stale-closure / missing-dep bugs in hooks and async callbacks.
- Mutating arrays/objects in place when an immutable update is expected.
- Index-as-React-key when items have a stable id available.
- Off-by-one in loop bounds, slice indices, range checks.

Output schema (each item):
- "line": 1-based line number where the actual issue token lives
- "kind": "praise" | "concept" | "watch-out"
    • "praise" = a non-obvious good call worth understanding
    • "concept" = a meaningful pattern worth unpacking (NOT just naming what's there)
    • "watch-out" = a real risk — framed as "next time, watch for this"
- "severity": "info" for praise/concept, "warn" or "perf" for watch-out
- "ruleId": short kebab-case (e.g. "stale-closure", "index-as-key", "promise-all-parallelism")
- "label": 3–5 word concept tag, no punctuation, no verbs
- "message": one sentence, plain English, specific to THIS code. No "You should…", no "This is wrong", no "Bug:", no "Issue:".
- "teaser": one sentence WHY this matters, ≤100 chars, different phrasing from "message"
- "lesson": exactly 2 sentences. Sentence 1 = what the concept is. Sentence 2 = why it matters HERE. No metaphors, no "imagine if", no preamble.
- "voiceScript": 35–50 words, plain spoken English. Start with the fact. End with the action. NO preamble, NO metaphors.
- "fix": OPTIONAL one-line replacement — ONLY for "watch-out" and ONLY when confident

Output ONLY the JSON array — no prose, no markdown, no code fences. \`[]\` is a complete, correct answer.

Line-number contract (STRICT):
- Every line below is prefixed with its 1-based number (e.g. "020  <header>"). Your "line" field MUST be the number of the line where the ACTUAL issue token lives.
- If your message or lesson mentions "line N", the "line" field MUST equal N. They must agree.
- For nested syntax (JSX, decorators, chained calls), anchor to the INNER element the issue is about — never the structural parent. The tag the issue names is the line.

File: ${fileName}
Language: ${languageId}

\`\`\`${languageId}
${numberLines(code)}
\`\`\``;
}

/**
 * Refinement prompt — used by hybrid Live Review phase 2.
 *
 * Instead of asking the cloud model to re-scan the whole file, we
 * hand it the candidate findings the on-device pass already detected
 * and ask for two things:
 *   1. Validate each (drop false positives).
 *   2. Produce the rich teaching content (label, teaser, lesson,
 *      voiceScript) the on-device prompt's minimal schema doesn't
 *      include.
 *
 * Code excerpt is narrow: just the lines around each candidate (±10
 * lines), not the whole file. Cuts phase-2 prompt size ~75% vs the
 * detection prompt, which is the primary cost reduction in the hybrid
 * pipeline. Latency is also faster — smaller prompt = faster TTFT.
 */
const REFINEMENT_CONTEXT_LINES = 10;

function buildRefinementPrompt(
  languageId: string,
  fileName: string,
  allLines: string[],
  candidates: Suggestion[]
): string {
  // Build the union of line ranges we need to show. Adjacent / overlapping
  // candidate windows merge so we don't emit duplicate code blocks.
  const sortedLines = [...candidates]
    .map((c) => c.range.start.line)
    .sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of sortedLines) {
    const start = Math.max(0, line - REFINEMENT_CONTEXT_LINES);
    const end = Math.min(allLines.length - 1, line + REFINEMENT_CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // Render each range as a numbered code block so line numbers in the
  // candidates match what the model sees.
  const codeBlocks = ranges
    .map(({ start, end }) => {
      const numbered = allLines
        .slice(start, end + 1)
        .map((l, i) => `${String(start + 1 + i).padStart(3, " ")}  ${l}`)
        .join("\n");
      return `\`\`\`${languageId}\n${numbered}\n\`\`\``;
    })
    .join("\n\n");

  const candidatesJson = JSON.stringify(
    candidates.map((c) => ({
      line: c.range.start.line + 1,
      ruleId: c.ruleId,
      severity: c.severity,
      message: c.message,
    })),
    null,
    2
  );

  return `You are refining a code review. An on-device model produced the candidate findings below; your job is to (1) drop any that are false positives or not worth saying, and (2) polish the survivors into rich teaching content.

File: ${fileName}
Language: ${languageId}

Code (only the regions around each candidate, ±${REFINEMENT_CONTEXT_LINES} lines):

${codeBlocks}

Candidate findings (from on-device pass):
${candidatesJson}

For each candidate you choose to keep, emit a JSON object with these fields:
- "line": 1-based line — MUST match the candidate's line
- "kind": "praise" | "concept" | "watch-out"
- "severity": "info" for praise/concept, "warn" or "perf" for watch-out
- "ruleId": MUST be the candidate's ruleId verbatim. Do NOT rename it, even if you think a better name exists. The orchestrator uses ruleId equality to detect which candidates you kept; renaming causes valid findings to be falsely blocklisted as false positives.
- "label": 3–5 word concept tag
- "message": one sentence, mentor-voice, specific to THIS code
- "teaser": one sentence WHY this matters (≤100 chars), different phrasing from message
- "lesson": exactly 2 sentences. Sentence 1 = what the concept is. Sentence 2 = why it matters HERE.
- "voiceScript": 35–50 words, plain spoken English
- "fix": OPTIONAL one-line replacement (only for watch-out)

Drop a candidate (don't include it in output) when:
- It's a false positive on closer inspection
- The flagged line is empty / scaffolding / placeholder
- The finding describes the code rather than teaching something
- A senior dev would skip past it in a real PR review

Return ONLY a JSON array. \`[]\` is valid if every candidate fails the bar.`;
}

// ---- Fallback synthesis ----
// If the model omits any of label/teaser/lesson/voiceScript, derive a
// sensible default from ruleId + message so downstream surfaces never
// render "undefined". Old review pipelines that haven't adopted the new
// prompt still work — they just get plainer content.

function prettyRule(ruleId: string): string {
  return ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveLabel(issue: AiIssue): string {
  if (issue.label && issue.label.trim()) return issue.label.trim();
  if (issue.ruleId) return prettyRule(issue.ruleId).toLowerCase();
  const words = issue.message.trim().split(/\s+/).slice(0, 4).join(" ");
  return words || "heads up";
}

function deriveTeaser(issue: AiIssue): string {
  const t = (issue.teaser ?? issue.message ?? "").trim();
  if (t.length <= 100) return t;
  return t.slice(0, 99) + "…";
}

function deriveLesson(issue: AiIssue): string {
  const l = (issue.lesson ?? "").trim();
  if (l) return l;
  // Fall back to message — better a single sentence than an empty thread.
  return issue.message.trim();
}

function deriveVoiceScript(issue: AiIssue): string {
  const v = (issue.voiceScript ?? "").trim();
  if (v) return v;
  // Synthesize a speakable line from message. Strip trailing quotes/code.
  const clean = issue.message
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

/**
 * Pull a JSON array out of a small-model response that might be wrapped
 * in markdown fences, prefaced with prose ("Here's the JSON:"), or even
 * contain brackets in the prose itself. Strategy, in order:
 *
 *   1. Strip ```json / ``` fences.
 *   2. Try to parse the whole thing as JSON.
 *   3. Scan for balanced top-level `[...]` blocks, biggest first, and
 *      parse each until one succeeds.
 *
 * The old impl (`first [` → `last ]`) broke the moment the model wrote
 * anything like "I see [useState] in the code — here are the issues: [...]".
 */
function extractJsonArray(text: string): AiIssue[] | null {
  // 1. Strip common markdown wrappers
  let cleaned = text.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```\s*$/m;
  const fenceMatch = cleaned.match(fence);
  if (fenceMatch && fenceMatch[1]) cleaned = fenceMatch[1].trim();

  // 2. Direct parse attempt
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // 3. Find every balanced top-level [...] and try each, largest first
  const candidates: string[] = [];
  let depth = 0;
  let startIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "[") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        candidates.push(cleaned.slice(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function tryParse(raw: string): AiIssue[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Synthesize severity from kind if the LEARN cloud prompt omits it.
    // praise/concept → info, watch-out → warn. Keeps downstream rendering
    // (color, gutter icon) working without special-casing kind everywhere.
    for (const x of parsed) {
      if (x && typeof x === "object" && !x.severity && typeof x.kind === "string") {
        x.severity = x.kind === "watch-out" ? "warn" : "info";
      }
    }
    return parsed.filter(
      (x): x is AiIssue =>
        x &&
        typeof x === "object" &&
        typeof x.line === "number" &&
        typeof x.message === "string" &&
        (x.severity === "warn" || x.severity === "perf" || x.severity === "info")
    );
  } catch {
    return null;
  }
}

/**
 * Number of lines above AND below the cursor to emphasize as the "focus
 * window" when on-device Qwen scans. Qwen 7B has 32k context but its
 * attention is still finite — a smaller, centered window gets deeper
 * analysis than dumping 400 lines at it. 40 lines above + 40 below ≈
 * one screen, which matches what the user is actually looking at.
 * Cloud models (Haiku / Sonnet) still get the full file — they have the
 * scale for it and catch cross-function issues the focus window misses.
 */
const FOCUS_WINDOW_LINES = 40;

// ---- Line-anchor reconciliation ----
// Models occasionally disagree with themselves: JSON.line points at the
// parent JSX element while the prose says "on line 20" about the inner
// tag. Clamping to bounds hides this silently and renders findings on
// the wrong line. Instead we run four layers:
//   1. Prevention via numbered-line prompt (see numberLines / buildPrompt).
//   2. Prose reconciliation: if message/lesson mentions "line N" and
//      N ≠ issue.line, trust the prose.
//   3. Token validation: the "key token" from the message (e.g. <header>)
//      should actually appear on the anchored line. If not, search ±5
//      lines for it and re-anchor.
//   4. Drop-if-unsafe: if nothing validates, we drop the finding instead
//      of rendering on a wrong line (better silence than misinformation).

const PROSE_LINE_REGEX = /\b(?:on|at)\s+line\s+(\d+)\b/gi;

/**
 * Pull all candidate "subject" tokens from an issue message — specific
 * identifiers / tags / quoted literals the finding is about. Returns
 * an ordered list, most-specific first. Used to validate that the
 * anchored line actually contains what the issue talks about.
 *
 * Previously returned a single token; multi-token fixes the case where
 * the first-choice token (e.g. the generic word "state") doesn't
 * appear on the right line but a later-choice token (the specific
 * identifier `useState`) does. Widens the success rate of Layer 3.
 */
function extractKeyTokens(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const norm = t.toLowerCase();
    if (norm.length < 2) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(t);
  };

  // Tags — `<header>`, `</ul>`. Highest specificity, always first.
  const tagRe = /<\/?([a-zA-Z][\w-]*)\b/g;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(message)) !== null) {
    if (tm[1]) add(`<${tm[1]}`);
  }

  // Backtick-quoted — `useState`, `reduce`, `Array.isArray`.
  const btRe = /`([^`\s][^`]{0,60})`/g;
  let bm: RegExpExecArray | null;
  while ((bm = btRe.exec(message)) !== null) {
    if (bm[1]) add(bm[1]);
  }

  // Single/double quoted short strings — `'let'`, `"const"`. Keep the
  // quotes off; we search the raw symbol.
  const qRe = /['"]([^'"\s]{2,40})['"]/g;
  let qm: RegExpExecArray | null;
  while ((qm = qRe.exec(message)) !== null) {
    if (qm[1]) add(qm[1]);
  }

  // Bare identifiers as a last-resort. Stopwords culled so we don't
  // match prose-y words that happen to look like identifiers.
  const stopwords = new Set([
    "The", "This", "That", "Using", "Adding", "Missing", "Unused", "Empty",
    "When", "Which", "You", "your", "should", "could", "would", "will",
    "does", "array", "object", "value", "state", "element", "line",
    "function", "variable", "constant", "string", "number", "boolean",
    "true", "false", "null", "undefined", "return", "const", "let", "var",
  ]);
  const identRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\b/g;
  let im: RegExpExecArray | null;
  while ((im = identRe.exec(message)) !== null) {
    if (im[1] && !stopwords.has(im[1])) add(im[1]);
  }

  return out;
}

/**
 * Search ±`window` lines around `hint` for a line containing ANY of
 * `tokens`. Returns the best-matching 0-based line index (closest to
 * hint, first matching token wins), or null if none found.
 *
 * Window widened 5 → 15. User report: CodeLens off by 4–10 lines on
 * findings where the LLM's JSON.line disagreed with the actual code
 * position. Old narrow window dropped those findings via Layer 4
 * (better silence than misinformation) — but the user wanted the
 * finding SHOWN on the right line, not dropped. 15 lines of search is
 * still tight enough that we won't re-anchor to an unrelated block —
 * the token has to actually appear somewhere nearby.
 */
function findAnyTokenNearLine(
  lines: string[],
  tokens: string[],
  hint: number,
  window = 15
): { lineIdx: number; token: string } | null {
  if (tokens.length === 0) return null;
  const needles = tokens.map((t) => t.toLowerCase());
  for (let d = 0; d <= window; d++) {
    const candidates = d === 0 ? [hint] : [hint - d, hint + d];
    for (const i of candidates) {
      if (i < 0 || i >= lines.length) continue;
      const lineLower = lines[i]!.toLowerCase();
      for (let k = 0; k < needles.length; k++) {
        if (lineLower.includes(needles[k]!)) {
          return { lineIdx: i, token: tokens[k]! };
        }
      }
    }
  }
  return null;
}

/**
 * Returns a trusted 0-based line index for this issue, or null if we
 * can't produce a confident anchor (in which case the caller should
 * drop the finding). Applies Layers 2-4 of the line-anchor fix.
 */
function reconcileIssueLine(
  issue: AiIssue,
  doc: vscode.TextDocument,
  fileName: string
): number | null {
  const lineCount = doc.lineCount;
  if (lineCount === 0) return null;

  // Start with the JSON line, 1→0 indexed.
  let anchor = Math.floor(issue.line) - 1;

  // Layer 2 — prose reconciliation. Scan message + lesson for any "on line N"
  // references. If there's exactly one unique number and it disagrees
  // with the JSON, trust the prose.
  const proseBlob = `${issue.message ?? ""} ${issue.lesson ?? ""}`;
  const proseMatches = new Set<number>();
  let m: RegExpExecArray | null;
  PROSE_LINE_REGEX.lastIndex = 0;
  while ((m = PROSE_LINE_REGEX.exec(proseBlob)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= lineCount) proseMatches.add(n);
  }
  if (proseMatches.size === 1) {
    const [proseLine] = [...proseMatches];
    const proseIdx = proseLine! - 1;
    if (proseIdx !== anchor) {
      log(
        "reviewEngine",
        `line-mismatch ${fileName} · prose=${proseLine} json=${issue.line} ruleId=${issue.ruleId ?? "?"} → trusting prose`
      );
      anchor = proseIdx;
    }
  }

  // Bounds guard. If the anchor is out of range and prose didn't save us,
  // it's already unconfident — don't silently clamp to EOF.
  if (anchor < 0 || anchor >= lineCount) {
    log(
      "reviewEngine",
      `anchor-dropped ${fileName} · line=${issue.line} out of bounds (file has ${lineCount} lines) · ruleId=${issue.ruleId ?? "?"}`
    );
    return null;
  }

  // Layer 3 — multi-token validation. Pull ALL candidate tokens from
  // the message and check the anchored line contains ANY of them.
  // If not, search ±15 lines. Widened from ±5 because user reported
  // findings landing 4–10 lines off the real position — the tight
  // window was silently dropping those via Layer 4 rather than
  // re-anchoring, making findings appear on "random wrong lines."
  // Multi-token covers the case where the first-choice token doesn't
  // hit but a secondary one (e.g. `useState` vs. generic "state") does.
  const tokens = extractKeyTokens(issue.message ?? "");
  if (tokens.length > 0) {
    const anchorText = doc.lineAt(anchor).text.toLowerCase();
    const hitOnAnchor = tokens.some((t) =>
      anchorText.includes(t.toLowerCase())
    );
    if (!hitOnAnchor) {
      const lines = Array.from(
        { length: lineCount },
        (_, i) => doc.lineAt(i).text
      );
      const found = findAnyTokenNearLine(lines, tokens, anchor, 15);
      if (found !== null) {
        log(
          "reviewEngine",
          `anchor-retargeted ${fileName} · token="${found.token}" was at line ${found.lineIdx + 1}, not ${anchor + 1} · ruleId=${issue.ruleId ?? "?"}`
        );
        anchor = found.lineIdx;
      } else {
        // Layer 4 — drop. None of the candidate tokens exist within
        // 15 lines of the reported line; the finding is too unreliable
        // to render at all.
        log(
          "reviewEngine",
          `anchor-dropped ${fileName} · no token from [${tokens.slice(0, 3).join(",")}] found within 15 lines of ${anchor + 1} · ruleId=${issue.ruleId ?? "?"}`
        );
        return null;
      }
    }
  }

  return anchor;
}

export async function reviewDocument(
  document: vscode.TextDocument,
  signal?: { cancelled: boolean },
  /**
   * 0-based cursor line at scan time. When provided (and on-device is
   * the active backend), the prompt emphasizes the window around this
   * line — "the user is editing here, deep-dive it". When omitted, the
   * prompt covers the whole file evenly. LiveReview passes the active
   * editor's cursor; SAVE/FLOW tiers don't (they want full-file view).
   */
  activeLine?: number,
  /**
   * Override the user's persisted backend for this single call. Used by
   * the hybrid Live Review orchestrator (phase 1 forces "on-device",
   * phase 2 forces "cloud"). Doesn't change setAiBackend / globalState.
   */
  forceBackend?: import("../ai/aiBackend.js").AiBackend,
  /**
   * Refinement mode. When provided, the model is asked to validate +
   * polish these specific findings (instead of detecting from scratch),
   * and the prompt only includes the relevant line ranges + a small
   * window of context around each. Drops phase-2 cloud cost ~75% by
   * eliminating the "re-detect what Qwen already found" pass.
   */
  candidates?: Suggestion[]
): Promise<Suggestion[]> {
  const fullText = document.getText();
  if (!fullText.trim()) {
    log("reviewEngine", `skip ${fileNameOf(document)} — empty`);
    return [];
  }

  const allLines = fullText.split("\n");
  const truncated = allLines.length > MAX_FILE_LINES;
  const code = truncated ? allLines.slice(0, MAX_FILE_LINES).join("\n") : fullText;

  const fileName = fileNameOf(document);
  const prompt =
    candidates && candidates.length > 0
      ? buildRefinementPrompt(document.languageId, fileName, allLines, candidates)
      : buildPrompt(document.languageId, fileName, code, {
          allLines,
          activeLine,
        });

  log(
    "reviewEngine",
    `scan start · ${fileName} · ${allLines.length} lines${truncated ? " (truncated to " + MAX_FILE_LINES + ")" : ""} · prompt ${prompt.length}ch${activeLine !== undefined ? ` · focus@L${activeLine + 1}` : ""}`
  );

  const started = Date.now();
  const raw = await aiQuery(prompt, 512, { kind: "scan", forceBackend });
  const elapsed = Date.now() - started;

  if (signal?.cancelled) {
    log("reviewEngine", `scan cancelled ${fileName} after ${elapsed}ms`);
    return [];
  }
  if (!raw) {
    log(
      "reviewEngine",
      `scan FAIL ${fileName} after ${elapsed}ms — aiQuery returned null (model unavailable? on-device not ready?)`
    );
    return [];
  }

  // Cost + transparency log. Each scan emits one rich line so you can
  // tail the Protege output channel and see exactly what fired, on which
  // model, what it cost, and what the model said. ~4 chars per token is
  // the standard rough estimate for English/code mixes; close enough for
  // a running cost picture.
  const lastCall = getLastCall();
  const backendUsed = lastCall?.backend ?? "?";
  const inTokens = Math.ceil(prompt.length / 4);
  const outTokens = Math.ceil(raw.length / 4);
  const costUsd = estimateScanCostUsd(backendUsed, inTokens, outTokens);
  sessionScanCount++;
  sessionCostUsd += costUsd;
  // Prefix matches the hybrid orchestrator log: [QWEN] for on-device,
  // [CLOUD] for any cloud-routed scan. The actual cloud model is decided
  // by the backend env (OPENAI_CHEAP_MODEL, default gpt-4o-mini); the
  // extension just labels it "cloud" generically.
  const prefix = backendUsed === "on-device" ? "[QWEN]  " : "[CLOUD] ";
  const displayBackend =
    backendUsed === "on-device"
      ? "qwen-7b (local)"
      : "cloud (cheap-tier · model configured server-side)";
  log(
    "reviewEngine",
    `${prefix}scan · ${fileName} · ` +
      `via=${displayBackend} · ` +
      `tokens=${inTokens}in/${outTokens}out · ` +
      `cost=${costUsd === 0 ? "$0 (free)" : "$" + costUsd.toFixed(5)} · ` +
      `${elapsed}ms · ` +
      `session=${sessionScanCount} scans · $${sessionCostUsd.toFixed(4)} total`
  );
  // The model's raw output — truncated to 500 chars so the log stays
  // readable but you can still see what it "thought" before our parsing
  // and gating filtered it. Useful when a finding looks wrong: you can
  // tell "model said X" vs "model said Y but our parser dropped it."
  logBlock(
    "reviewEngine",
    `[scan] raw reply for ${fileName} (${raw.length}ch, first 500 shown)`,
    raw.slice(0, 500)
  );

  const issues = extractJsonArray(raw);
  if (!issues) {
    // Critical: the model returned text but we couldn't parse JSON. Dump
    // the raw reply so you can see what it actually said. Most common
    // cause on Qwen 1.5B is markdown fences or prose before/after the array.
    logBlock(
      "reviewEngine",
      `JSON PARSE FAIL for ${fileName} — first 800 chars of raw reply`,
      raw.slice(0, 800)
    );
    return [];
  }

  if (issues.length === 0) {
    // Deliberate zero — the model said "the code looks fine, return []".
    // Distinct from a parse failure. Log it so you can see the difference
    // from silence ("scan returned nothing" vs "scan thinks code is clean").
    log(
      "reviewEngine",
      `scan CLEAN · ${fileName} · model parsed as empty array (no issues)`
    );
    return [];
  }

  log("reviewEngine", `parsed ${issues.length} issue${issues.length === 1 ? "" : "s"}`);

  const suggestions: Suggestion[] = [];
  let dropped = 0;

  for (const issue of issues) {
    const lineIdx = reconcileIssueLine(issue, document, fileName);
    if (lineIdx === null) {
      dropped++;
      continue;
    }
    const lineText = document.lineAt(lineIdx).text;
    const startCol = lineText.search(/\S/);
    const start = new vscode.Position(lineIdx, startCol === -1 ? 0 : startCol);
    const end = new vscode.Position(lineIdx, lineText.length);

    suggestions.push({
      range: new vscode.Range(start, end),
      message: issue.message.trim(),
      severity: issue.severity,
      ruleId: issue.ruleId?.trim() || "ai-review",
      fix: issue.fix?.trim() || undefined,
      label: deriveLabel(issue),
      teaser: deriveTeaser(issue),
      lesson: deriveLesson(issue),
      voiceScript: deriveVoiceScript(issue),
      scope: "atom",
      tier: "live",
      kind: issue.kind,
    });
  }

  if (dropped > 0) {
    log("reviewEngine", `dropped ${dropped} unconfident issue${dropped === 1 ? "" : "s"} (line mismatch or token not found)`);
  }

  const order = { warn: 0, perf: 1, info: 2 };
  suggestions.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.range.start.line - b.range.start.line
  );

  // Cloud (LEARN) caps tighter than on-device: two teaching moments per
  // file beats five findings for confidence-first framing.
  const backend = getAiBackend();
  const isCloud = backend !== "on-device";
  const cap = isCloud ? MAX_CLOUD_ISSUES : MAX_ISSUES;

  log(
    "reviewEngine",
    `scan done · ${suggestions.length} final suggestion${suggestions.length === 1 ? "" : "s"} after cap (${cap})`
  );

  return suggestions.slice(0, cap);
}

function fileNameOf(doc: vscode.TextDocument): string {
  return doc.fileName.split(/[\\/]/).pop() ?? "file";
}
