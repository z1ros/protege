import * as vscode from "vscode";
import { aiQuery, getAiBackend } from "./aiBackend.js";
import { log, logBlock } from "./log.js";

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
const MAX_ISSUES = 5;          // on-device + SAVE/FLOW tiers
const MAX_CLOUD_ISSUES = 2;    // cloud LIVE (LEARN mode) — silence > noise

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
- If the code looks fine, return []
- Output ONLY the JSON array (starts with \`[\`, ends with \`]\`)

File: ${fileName}

${focused}

Now review the file above and return the JSON array.`;
  }

  // Learning-first cloud prompt (Haiku / Sonnet).
  //
  // Framing: you are watching a developer write code, not auditing it.
  // Goal: help them UNDERSTAND what they just wrote — build confidence,
  // not catalogue defects. Silence is a valid answer (return []).
  //
  // Each item carries a `kind`: "praise" (concrete good choice worth
  // explaining), "concept" (pattern they used — unpack it so they own
  // it), or "watch-out" (real risk, framed as "next time, watch for this").
  // Cap is intentionally low (${MAX_CLOUD_ISSUES}) — two teaching moments
  // per file, not five findings. Most files should return 0 or 1.
  return `You are watching a developer write code in their editor. You are their mentor — not a code reviewer. Your job is to help them UNDERSTAND what they just wrote, not catch every issue.

Review the code below and return ONLY a JSON array with at most ${MAX_CLOUD_ISSUES} items. Most files should return 0 or 1. If the code is clean and the user is clearly solid on what they're doing, return [] — silence is a valid answer. No prose, no markdown, no code fences — just the JSON array.

Each item is a teaching moment, not a defect. Fields:
- "line": 1-based line number
- "kind": one of "praise" | "concept" | "watch-out"
    • "praise" = they did something well + worth understanding why
    • "concept" = a pattern they used — explain it so they own it
    • "watch-out" = a real risk — frame as "next time, watch for this"
- "severity": MUST match kind — "info" for praise/concept, "warn" or "perf" for watch-out
- "ruleId": short kebab-case concept name (e.g. "use-state-derived", "index-as-key", "promise-all-parallelism")
- "label": 3–5 word tag suitable for an inline annotation (e.g. "clean setter pattern", "array index key"). No punctuation, no verbs, just the concept.
- "message": one sentence — what's interesting/good/risky, plain English, specific to THIS code
- "teaser": one-sentence WHY this matters (≤ 100 chars) — punchy preview, different phrasing from "message"
- "lesson": exactly 2 sentences. Sentence 1 = what the concept is (not metaphors). Sentence 2 = why it matters HERE. No analogies, no "imagine if…", no preamble.
- "voiceScript": 35–50 words, plain spoken English. Start with the fact. End with the action or invitation. NO preamble, NO metaphors, NO "let me explain…". Read aloud by TTS.
- "fix": OPTIONAL one-line replacement — ONLY for "watch-out" and ONLY if you're confident

Rules:
- At most ${MAX_CLOUD_ISSUES} items. Zero is often right.
- If the user did something well, SAY so — use "praise". Confidence is the goal of this product.
- Never open "message" with "You should" / "This is wrong" / "Bug:" / "Issue:". Mentor voice, not critique voice.
- Skip issues in commented-out code.
- Skip trivial style nits a linter would catch.
- Output ONLY the JSON array.

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
 * Pull the "subject" of an issue message — the specific token it's about.
 * Priority: angle-bracketed tag → backtick-quoted identifier → first
 * identifier-looking word. Used to validate that the anchored line
 * actually contains what the issue is talking about.
 */
function extractKeyToken(message: string): string | null {
  const tag = message.match(/<\/?([a-zA-Z][\w-]*)\b/);
  if (tag && tag[1]) return `<${tag[1]}`;
  const quoted = message.match(/`([^`\s][^`]{0,40})`/);
  if (quoted && quoted[1]) return quoted[1];
  const ident = message.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\b/);
  if (ident && ident[1]) {
    const stopwords = new Set([
      "The", "This", "That", "Using", "Adding", "Missing", "Unused", "Empty",
      "When", "Which", "You", "your", "should", "could", "would", "will",
      "does", "array", "object", "value", "state", "element", "line",
    ]);
    if (!stopwords.has(ident[1])) return ident[1];
  }
  return null;
}

/**
 * Search ±`window` lines around `hint` for a line containing `token`.
 * Returns the best-matching 0-based line index, or null if nowhere.
 * Prefers the nearest line to the hint on ties.
 */
function findTokenNearLine(
  lines: string[],
  token: string,
  hint: number,
  window = 5
): number | null {
  const needle = token.toLowerCase();
  for (let d = 0; d <= window; d++) {
    const candidates = d === 0 ? [hint] : [hint - d, hint + d];
    for (const i of candidates) {
      if (i < 0 || i >= lines.length) continue;
      if (lines[i]!.toLowerCase().includes(needle)) return i;
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

  // Layer 3 — token validation. Pull the key token from the message and
  // check the anchored line actually contains it. If not, search ±5 lines.
  const token = extractKeyToken(issue.message ?? "");
  if (token) {
    const anchorText = doc.lineAt(anchor).text.toLowerCase();
    if (!anchorText.includes(token.toLowerCase())) {
      const lines = Array.from({ length: lineCount }, (_, i) => doc.lineAt(i).text);
      const found = findTokenNearLine(lines, token, anchor, 5);
      if (found !== null) {
        log(
          "reviewEngine",
          `anchor-retargeted ${fileName} · token="${token}" was at line ${found + 1}, not ${anchor + 1} · ruleId=${issue.ruleId ?? "?"}`
        );
        anchor = found;
      } else {
        // Layer 4 — drop. Token doesn't exist anywhere near the reported
        // line; the finding is too unreliable to render.
        log(
          "reviewEngine",
          `anchor-dropped ${fileName} · token="${token}" not found within 5 lines of ${anchor + 1} · ruleId=${issue.ruleId ?? "?"}`
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
  activeLine?: number
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
  const prompt = buildPrompt(document.languageId, fileName, code, {
    allLines,
    activeLine,
  });

  log(
    "reviewEngine",
    `scan start · ${fileName} · ${allLines.length} lines${truncated ? " (truncated to " + MAX_FILE_LINES + ")" : ""} · prompt ${prompt.length}ch${activeLine !== undefined ? ` · focus@L${activeLine + 1}` : ""}`
  );

  const started = Date.now();
  const raw = await aiQuery(prompt, 512, { kind: "scan" });
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

  log("reviewEngine", `scan got raw reply · ${raw.length}ch · ${elapsed}ms`);

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
