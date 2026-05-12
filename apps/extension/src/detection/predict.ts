import * as vscode from "vscode";
import * as ts from "typescript";
import { log } from "../log.js";
import { markExplained } from "../user/ownership.js";
import { aiQuery } from "../ai/aiBackend.js";
import {
  onChangeOrigin,
  type ChangeOriginEvent,
} from "./changeOriginDetector.js";
import { onBreak, type BreakEvent } from "./breakDetector.js";

/**
 * Predict-and-Reveal — the foundational "feels like learning" mechanic.
 *
 * Flow:
 *   1. User triggers (selection hover action, Cmd+K P, or end-of-day chip).
 *   2. `extractTarget` pulls the code — either the active selection or
 *      the enclosing expression/function at the cursor (via TS AST).
 *   3. `generateQuiz` asks Claude for a 4-choice quiz probing a NON-
 *      OBVIOUS behavior of the code.  [Day 2 — stub for now.]
 *   4. `showPredictionPick` pops a QuickPick: user picks a choice or
 *      bails with Esc.
 *   5. `showRevealPick` pops a second QuickPick with the actual answer,
 *      the one-line reason, and next-step actions (Fix it / Deep dive /
 *      Got it).
 *   6. On "Got it" we call `markExplained(uri, start, end)` so the
 *      ownership score rises on regions the user *demonstrated* they
 *      understand. Wrong predictions record the `misconceptionTag` for
 *      later — no punishment, just a signal for Mechanic 2.
 *
 * DAY 1 SCOPE: scaffold + hardcoded dummy quiz. LLM wiring lands Day 2.
 * This lets us validate the full UX end-to-end before the prompt
 * engineering starts. If any step feels clunky as a QuickPick cascade,
 * we catch it here without burning token budget on dev iterations.
 */

// ---- Public types (exported so Day 2's generator has a shape to aim at) ----

export interface PredictTarget {
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
  /** The exact code text we'll feed into the LLM quiz generator. */
  code: string;
  language: string;
  kind: "selection" | "expression" | "function";
  /** Name of the enclosing function/method, if any. Useful for framing
   *  the quiz question ("What does `fetchUserTodos` return for…"). */
  enclosingFunctionName?: string;
}

export interface PredictionQuiz {
  inputDescription: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  correctId: string;
  reason: string;
  fixHint: string | null;
  misconceptionTag: string | null;
  target: PredictTarget;
}

/** Pre-diagnosed misconception passed from misconceptions.ts. When
 *  present, the LLM is told to steer the quiz specifically at this
 *  belief, so clicking "Quiz me" from a misconception hover doesn't
 *  produce a quiz about random behavior. */
export interface MisconceptionHint {
  tag: string;
  belief: string;
  truth: string;
}

export interface Reveal {
  correct: boolean;
  userChoiceId: string | null;
  correctChoice: { id: string; label: string };
  reason: string;
  fixHint: string | null;
  target: PredictTarget;
  misconceptionTag: string | null;
}

// ---- Module state ----

/** One-prediction-in-flight-per-file guard. A rapid-fire Cmd+K P
 *  pair would otherwise stack QuickPicks on top of each other, which
 *  looks cursed. */
const inFlight = new Set<string>();

/** Global in-flight cap. Even across different files, we don't want
 *  someone to spawn 10 concurrent predictions — the LLM cost + the
 *  UI chaos aren't worth it. */
const GLOBAL_MAX_IN_FLIGHT = 2;
let globalInFlight = 0;

/** Per-file cooldown so a user can't spam Cmd+K P on the same file.
 *  30s is enough to actually read a reveal + come back with intention. */
const COOLDOWN_MS = 30_000;
const COOLDOWN_MAP_CAP = 500;
const COOLDOWN_GC_AGE_MS = 10 * 60_000;
const lastCallAt = new Map<string, number>();

/** Max output tokens for the quiz-generating LLM call. The prompt is
 *  tight JSON — 600 is roomy. */
const QUIZ_TOKENS = 600;

/** Captured on registerPredict so handlers can call openProtegePanel
 *  without plumbing context through every pipeline step. Same pattern
 *  struggleChip + ownership modules use. */
let moduleContext: vscode.ExtensionContext | null = null;

// ---- End-of-day auto-trigger state ----

/** globalState key holding the ISO date (YYYY-MM-DD) of the last day
 *  we fired the end-of-day predict chip. Prevents repeat firings on the
 *  same calendar day even across extension reloads. */
const EOD_LAST_FIRED_KEY = "protege.predict.eodLastFiredDate";

interface TopBurstRecord {
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
  /** Rough "how much vibecoding" score — chars added in the burst. */
  charsAdded: number;
  ts: number;
}

/** Biggest auto-inserted burst per file for the current local day.
 *  Cleared at midnight local time (lazy: on each add we check the day). */
const topBurstToday = new Map<string, TopBurstRecord>();
let topBurstDay: string | null = null;

/** Singleton status-bar item we reuse across end-of-day firings. Kept
 *  hidden until we actually have something to show. */
let eodStatusBar: vscode.StatusBarItem | null = null;
/** The range the current chip is offering to predict on — captured at
 *  chip-show-time so a later burst on the same file doesn't move the
 *  target mid-click. */
let eodPending: TopBurstRecord | null = null;
let eodAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
const EOD_CHIP_TTL_MS = 5 * 60_000;

// ---- Misconception persistence ----

/** globalState key for the per-user record of misconceptions the
 *  prediction loop has caught them on. Feeds Mechanic 2 — when we see
 *  a pattern the user has ALREADY been wrong about, we can escalate
 *  the catcher hover's tone + priority. */
const SEEN_MISCONCEPTIONS_KEY = "protege.seenMisconceptions";

interface SeenMisconceptionEntry {
  /** Total times the user has been wrong on a quiz tagged with this. */
  wrongCount: number;
  /** Times the user answered correctly (proxy for "I'm past this now"). */
  rightCount: number;
  /** ms epoch of the last wrong answer on this tag. */
  lastWrongAt: number;
  /** ms epoch of the last correct answer on this tag. */
  lastRightAt: number;
}

type SeenMisconceptionMap = Record<string, SeenMisconceptionEntry>;

// ---- Registration ----

export function registerPredict(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  moduleContext = context;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(
      "protege.predict.fromSelection",
      async () => {
        await runPredict("selection");
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.predict.fromCursor",
      async () => {
        await runPredict("cursor");
      }
    )
  );

  // ---- End-of-day auto-trigger ----

  eodStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    108 // just left of the ownership inviter chip (110)
  );
  eodStatusBar.command = "protege.predict.acceptEndOfDay";
  disposables.push(eodStatusBar);

  // Track the biggest auto-inserted burst per file, per local day. This
  // is what the end-of-day chip will offer to predict on — the code
  // the user most clearly vibecoded today.
  disposables.push(
    onChangeOrigin((evt) => {
      // "Biggest unowned burst per file per day" — both AI inserts and
      // user pastes count as unowned-by-default.
      if (evt.origin !== "auto-inserted" && evt.origin !== "pasted") return;
      recordTopBurst(evt);
    })
  );

  // Subscribe to natural-break events. `end-of-day` is our main hook;
  // `post-commit` is a softer one — if a user commits a vibecode-heavy
  // day's work mid-afternoon, that's a reasonable moment too. We gate
  // on per-day dedup so neither fires more than once.
  disposables.push(
    onBreak((evt) => {
      if (evt.type !== "end-of-day" && evt.type !== "post-commit") return;
      void maybeShowEndOfDayChip(evt);
    })
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.predict.acceptEndOfDay",
      async () => {
        await acceptEndOfDayChip();
      }
    )
  );

  // Also accept end-of-day dismissal so we can manually hide the chip
  // from tests / palette.
  disposables.push(
    vscode.commands.registerCommand("protege.predict.dismissEndOfDay", () => {
      hideEndOfDayChip();
    })
  );

  log("predict", "installed");
  return disposables;
}

// ---- Pipeline ----

async function runPredict(source: "selection" | "cursor"): Promise<void> {
  if (!isEnabled()) {
    vscode.window.showInformationMessage(
      "Protege Predict is disabled. Enable it in Settings → Protege › Predict."
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Protege: open a file and put your cursor on some code first."
    );
    return;
  }

  if (!isSupportedLanguage(editor.document.languageId)) {
    vscode.window.showInformationMessage(
      `Protege Predict only works on TypeScript, JavaScript, JSX, and TSX (got ${editor.document.languageId}).`
    );
    return;
  }

  const target = extractTarget(
    editor,
    source === "selection" && !editor.selection.isEmpty
      ? editor.selection
      : undefined
  );
  if (!target) {
    vscode.window.showInformationMessage(
      source === "selection"
        ? "Protege: select some code first — a function body or an expression."
        : "Protege: nothing useful to quiz right where your cursor is."
    );
    return;
  }

  await runPredictFromTarget(target);
}

/** Run the full quiz pipeline on a pre-extracted target. Shared by
 *  `runPredict` (user-triggered via Cmd+K P) and
 *  `runPredictOnRange` (triggered by the end-of-day chip or the
 *  misconceptions hover's "Quiz me" button). All cooldown + cap guards
 *  apply here so external callers don't need to re-implement them. */
async function runPredictFromTarget(
  target: PredictTarget,
  hint?: MisconceptionHint
): Promise<void> {
  if (!isEnabled()) return;

  const uriKey = target.uri.toString();
  const now = Date.now();

  if (inFlight.has(uriKey)) {
    log("predict", `skipped · already in flight · ${uriKey}`);
    return;
  }

  const since = now - (lastCallAt.get(uriKey) ?? 0);
  if (since < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - since) / 1000);
    vscode.window.showInformationMessage(
      `Protege: slow down — one more prediction on this file in ${wait}s.`
    );
    return;
  }

  if (globalInFlight >= GLOBAL_MAX_IN_FLIGHT) {
    vscode.window.showInformationMessage(
      "Protege: too many predictions in flight — try again in a moment."
    );
    return;
  }

  inFlight.add(uriKey);
  globalInFlight++;
  if (lastCallAt.size >= COOLDOWN_MAP_CAP) gcLastCallMap(now);
  lastCallAt.set(uriKey, now);

  try {
    const quiz = await generateQuiz(target, hint);
    if (!quiz) {
      vscode.window.showInformationMessage(
        "Protege: couldn't generate a quiz for this code — try another spot."
      );
      return;
    }

    const reveal = await showPredictionPick(quiz);
    if (!reveal) return; // user bailed mid-flow

    const action = await showRevealPick(reveal);
    await handleRevealAction(action, reveal);
  } catch (err) {
    log(
      "predict",
      `run failed — ${err instanceof Error ? err.message : String(err)}`
    );
    vscode.window.showErrorMessage(
      `Protege: prediction failed — ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    inFlight.delete(uriKey);
    globalInFlight = Math.max(0, globalInFlight - 1);
  }
}

/** Public entry point for other modules (misconceptions, etc.) to fire
 *  a prediction on a specific range. Opens the file, extracts the
 *  target from that range, and runs the pipeline with the optional
 *  misconception hint so the quiz targets a specific wrong belief. */
export async function runPredictOnRange(
  uri: vscode.Uri,
  startLine: number,
  endLine: number,
  hint?: MisconceptionHint
): Promise<void> {
  if (!isEnabled()) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (!isSupportedLanguage(doc.languageId)) {
      vscode.window.showInformationMessage(
        `Protege Predict only works on TypeScript, JavaScript, JSX, and TSX (got ${doc.languageId}).`
      );
      return;
    }
    const safeStart = Math.max(0, Math.min(doc.lineCount - 1, startLine));
    const safeEnd = Math.max(
      safeStart,
      Math.min(doc.lineCount - 1, endLine)
    );
    const endChar = doc.lineAt(safeEnd).text.length;
    const code = doc.getText(new vscode.Range(safeStart, 0, safeEnd, endChar));
    if (!isQuizzable(code)) {
      vscode.window.showInformationMessage(
        "Protege: that range is too trivial to quiz."
      );
      return;
    }
    const target: PredictTarget = {
      uri,
      startLine: safeStart,
      endLine: safeEnd,
      code,
      language: doc.languageId,
      kind: "selection",
    };
    await runPredictFromTarget(target, hint);
  } catch (err) {
    log(
      "predict",
      `runOnRange failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("predict.enabled", true);
}

const SUPPORTED_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

function isSupportedLanguage(languageId: string): boolean {
  return SUPPORTED_LANGUAGES.has(languageId);
}

function gcLastCallMap(now: number): void {
  const cutoff = now - COOLDOWN_GC_AGE_MS;
  for (const [k, ts] of lastCallAt) {
    if (ts < cutoff) lastCallAt.delete(k);
  }
  if (lastCallAt.size > COOLDOWN_MAP_CAP) {
    const sorted = [...lastCallAt.entries()].sort((a, b) => a[1] - b[1]);
    const overBy = lastCallAt.size - COOLDOWN_MAP_CAP;
    for (let i = 0; i < overBy; i++) lastCallAt.delete(sorted[i][0]);
  }
}

// ---- extractTarget: find the code to quiz on ----

/** Minimum characters we'll bother quizzing. Anything below this is
 *  almost certainly a keyword, operator, or one-token expression. */
const MIN_TARGET_CHARS = 6;
/** Maximum characters we'll send to the LLM. Functions over ~80 lines
 *  rarely reduce to a single useful input/output quiz — the function
 *  does too much. Above this cap, we truncate or refuse. */
const MAX_TARGET_CHARS = 2400;
const MAX_TARGET_LINES = 80;

export function extractTarget(
  editor: vscode.TextEditor,
  explicitSelection?: vscode.Selection
): PredictTarget | null {
  const doc = editor.document;
  if (doc.uri.scheme !== "file") return null;

  // Path 1 — user gave us an explicit selection. Use it verbatim.
  if (explicitSelection && !explicitSelection.isEmpty) {
    const code = doc.getText(explicitSelection);
    if (!isQuizzable(code)) return null;
    const startLine = explicitSelection.start.line;
    const endLine = explicitSelection.end.line;
    if (!isValidRange(doc, startLine, endLine)) return null;
    return {
      uri: doc.uri,
      startLine,
      endLine,
      code,
      language: doc.languageId,
      kind: "selection",
    };
  }

  // Path 2 — walk the AST (TypeScript / JavaScript family only). Find
  // the smallest enclosing expression or function at the cursor.
  // `runPredict` already gates on `isSupportedLanguage`, so this path
  // is only reachable on JS/TS/JSX/TSX, but the extractTarget function
  // is exported and could be called directly — keep the guard.
  if (!isSupportedLanguage(doc.languageId)) return null;

  const sourceFile = ts.createSourceFile(
    doc.fileName,
    doc.getText(),
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(doc.languageId)
  );

  const offset = doc.offsetAt(editor.selection.active);
  const smallest = findSmallestEnclosing(sourceFile, offset);
  if (!smallest) return null;

  const start = doc.positionAt(smallest.getStart(sourceFile));
  const end = doc.positionAt(smallest.getEnd());
  const code = doc.getText(new vscode.Range(start, end));
  if (!isQuizzable(code)) return null;
  if (!isValidRange(doc, start.line, end.line)) return null;

  const enclosingFn = findEnclosingFunctionName(smallest);
  return {
    uri: doc.uri,
    startLine: start.line,
    endLine: end.line,
    code,
    language: doc.languageId,
    kind: ts.isFunctionLike(smallest) ? "function" : "expression",
    enclosingFunctionName: enclosingFn,
  };
}

/** Guards against a document edit that happens between AST parse and
 *  return. If the computed range no longer fits the current doc (user
 *  deleted the function mid-pipeline), we bail rather than emit a
 *  bogus target. */
function isValidRange(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number
): boolean {
  if (startLine < 0 || endLine < startLine) return false;
  if (endLine >= doc.lineCount) return false;
  return true;
}

function scriptKindFor(languageId: string): ts.ScriptKind {
  if (languageId === "typescriptreact") return ts.ScriptKind.TSX;
  if (languageId === "javascriptreact") return ts.ScriptKind.JSX;
  if (languageId === "typescript") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Walk the tree starting from `sourceFile`, descending into the node
 *  that contains `offset`. Return the smallest node that's ALSO a
 *  plausible quiz target (expression or function), not a leaf like an
 *  identifier token. */
function findSmallestEnclosing(
  sourceFile: ts.SourceFile,
  offset: number
): ts.Node | null {
  function visit(node: ts.Node): ts.Node | null {
    if (offset < node.getStart(sourceFile) || offset > node.getEnd()) {
      return null;
    }
    let childHit: ts.Node | null = null;
    ts.forEachChild(node, (child) => {
      if (childHit) return;
      const inner = visit(child);
      if (inner) childHit = inner;
    });
    // Return the deepest hit that's a plausible target. If the child
    // is a better target, prefer it; otherwise use ourselves.
    if (childHit && isPlausibleTarget(childHit)) return childHit;
    if (isPlausibleTarget(node)) return node;
    return childHit; // bubble up even if not plausible, so parents can decide
  }
  return visit(sourceFile);
}

function isPlausibleTarget(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return true;
  // Expressions are good targets — CallExpression, ArrayLiteral, BinaryExpression, etc.
  if (ts.isCallExpression(node)) return true;
  if (ts.isArrayLiteralExpression(node)) return true;
  if (ts.isObjectLiteralExpression(node)) return true;
  if (ts.isBinaryExpression(node)) return true;
  if (ts.isConditionalExpression(node)) return true;
  if (ts.isArrowFunction(node)) return true;
  if (ts.isTemplateExpression(node)) return true;
  // Statements that wrap these — e.g. a VariableStatement — act as
  // fallbacks when the cursor is on whitespace near the expression.
  if (ts.isVariableStatement(node)) return true;
  if (ts.isReturnStatement(node)) return true;
  return false;
}

function findEnclosingFunctionName(node: ts.Node): string | undefined {
  let cursor: ts.Node | undefined = node;
  while (cursor) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name) {
      return cursor.name.getText();
    }
    if (ts.isMethodDeclaration(cursor) && ts.isIdentifier(cursor.name)) {
      return cursor.name.getText();
    }
    if (
      ts.isVariableDeclaration(cursor) &&
      cursor.initializer &&
      ts.isArrowFunction(cursor.initializer) &&
      ts.isIdentifier(cursor.name)
    ) {
      return cursor.name.getText();
    }
    cursor = cursor.parent;
  }
  return undefined;
}

function isQuizzable(code: string): boolean {
  const trimmed = code.trim();
  if (trimmed.length < MIN_TARGET_CHARS) return false;
  if (trimmed.length > MAX_TARGET_CHARS) return false;
  const lineCount = trimmed.split("\n").length;
  if (lineCount > MAX_TARGET_LINES) return false;
  // Reject pure keywords / one-token expressions.
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed)) return false;
  if (/^["'`].*["'`]$/.test(trimmed) && trimmed.length < 20) return false;
  // Reject pure comment blocks.
  const withoutComments = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();
  if (!withoutComments) return false;
  return true;
}

// ---- generateQuiz: Day 2 — real LLM call ----

/** Asks Claude to generate a 4-choice quiz about a NON-OBVIOUS behavior
 *  of the code. The prompt is tight JSON with `skip: true` as the
 *  bail-out sentinel for code that isn't quizzable. Returns null on
 *  failure so the caller can show a friendly message instead of hanging. */
async function generateQuiz(
  target: PredictTarget,
  hint?: MisconceptionHint
): Promise<PredictionQuiz | null> {
  log(
    "predict",
    `fire · ${target.kind} · ${target.endLine - target.startLine + 1}L · ${target.uri.fsPath.split("/").pop()}${hint ? ` · hint=${hint.tag}` : ""}`
  );

  const enclosingLine = target.enclosingFunctionName
    ? `Enclosing function: ${target.enclosingFunctionName}`
    : "";

  const hintBlock = hint
    ? `\n\nADDITIONAL CONTEXT — a known misconception rule fired on this code:
The user likely believes: "${hint.belief}"
The truth is: "${hint.truth}"
Design the quiz to specifically test this belief. The "wrong answer a fast vibecoder would guess" should match the belief; the correct answer should match the truth. Set "misconception_tag" to "${hint.tag}".`
    : "";

  const prompt = `The user is about to predict what a piece of code does. Generate a 4-choice multiple-choice quiz that tests a NON-OBVIOUS runtime behavior — not syntax trivia.

Code:
\`\`\`${target.language}
${target.code}
\`\`\`

${enclosingLine}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "input_description": "short phrase describing the input scenario — e.g. 'items = []' or 'user missing email'",
  "question": "one sentence, under 15 words. e.g. 'What does this return for items = []?'",
  "choices": [
    {"id": "a", "label": "..."},
    {"id": "b", "label": "..."},
    {"id": "c", "label": "..."},
    {"id": "d", "label": "..."}
  ],
  "correct_id": "a | b | c | d",
  "reason": "one sentence under 30 words explaining WHY the correct choice is correct. Reference the specific mechanism (e.g. 'reduce with no seed uses items[0], which is undefined on an empty array, so it throws').",
  "fix_hint": "one sentence describing the simplest fix IF the correct answer reveals a bug. Otherwise null.",
  "misconception_tag": "short slug if this tests a known misconception (e.g. 'reduce-no-seed', 'map-async-parallel', 'shallow-spread', 'await-in-map'). Otherwise null."
}

Rules:
 - Choices must be PLAUSIBLE — common wrong answers, not joke options.
 - At least ONE choice must match what a fast vibecoder would guess.
 - Correct answer must be DERIVABLE from the code shown — no external context.
 - Question should expose a non-obvious behavior: empty input, null, type coercion, edge case, async timing, mutation, reference sharing, scope.
 - Never test syntax ("is this valid JS?") — test SEMANTICS.
 - No exclamation marks.
 - Choice labels under 40 chars each.
 - If the code is too trivial or ambiguous to quiz, return EXACTLY {"skip": true} and nothing else.${hintBlock}

Return ONLY the JSON.`;

  let raw: string | null = null;
  try {
    raw = await aiQuery(prompt, QUIZ_TOKENS, { kind: "teach" });
  } catch (err) {
    log(
      "predict",
      `aiQuery failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!raw) return null;

  const parsed = parseQuizJson(raw);
  if (!parsed) return null;
  if ("skip" in parsed && parsed.skip) {
    log("predict", "llm returned skip — code not quizzable");
    return null;
  }

  // Validate shape. The LLM occasionally drops a field or returns a
  // string where we expect an object — reject silently rather than
  // show the user a malformed quiz.
  const choices = parsed.choices;
  if (
    !Array.isArray(choices) ||
    choices.length !== 4 ||
    !choices.every(
      (c) =>
        c && typeof c.id === "string" && typeof c.label === "string"
    )
  ) {
    log("predict", "llm returned malformed choices");
    return null;
  }
  if (
    typeof parsed.correct_id !== "string" ||
    !choices.some((c) => c.id === parsed.correct_id)
  ) {
    log("predict", `llm correct_id "${parsed.correct_id}" not in choices`);
    return null;
  }
  if (
    typeof parsed.input_description !== "string" ||
    typeof parsed.question !== "string" ||
    typeof parsed.reason !== "string"
  ) {
    log("predict", "llm missing required strings");
    return null;
  }

  return {
    inputDescription: parsed.input_description,
    question: parsed.question,
    choices: choices.map((c) => ({ id: c.id, label: c.label })),
    correctId: parsed.correct_id,
    reason: parsed.reason,
    fixHint:
      typeof parsed.fix_hint === "string" && parsed.fix_hint.length > 0
        ? parsed.fix_hint
        : null,
    misconceptionTag:
      typeof parsed.misconception_tag === "string" &&
      parsed.misconception_tag.length > 0
        ? parsed.misconception_tag
        : null,
    target,
  };
}

/** Parse the LLM's JSON response. Same balanced-brace approach as
 *  `explainBack.parseGrade` — strips markdown fences + follow-ups
 *  pollution, then scans for the largest valid JSON object. */
interface ParsedQuizRaw {
  skip?: boolean;
  input_description?: string;
  question?: string;
  choices?: Array<{ id: string; label: string }>;
  correct_id?: string;
  reason?: string;
  fix_hint?: string | null;
  misconception_tag?: string | null;
}

function parseQuizJson(raw: string): ParsedQuizRaw | null {
  const cleaned = raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(cleaned.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try the largest candidate first — the LLM sometimes emits a tiny
  // `{"skip": true}` at the top and a larger JSON below, or vice versa.
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as ParsedQuizRaw;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ---- UI: QuickPick cascade ----

interface PredictionItem extends vscode.QuickPickItem {
  choiceId: string;
}

async function showPredictionPick(
  quiz: PredictionQuiz
): Promise<Reveal | null> {
  const items: PredictionItem[] = quiz.choices.map((c) => ({
    label: c.label,
    description: c.id.toUpperCase(),
    choiceId: c.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: quiz.question,
    title: `Predict · ${quiz.inputDescription}`,
    ignoreFocusOut: false,
    matchOnDescription: false,
    matchOnDetail: false,
  });

  if (!picked) {
    // User pressed Esc — count as "skipped" for telemetry, don't show reveal.
    log("predict", `skipped · ${quiz.misconceptionTag ?? "untagged"}`);
    return null;
  }

  const correct = picked.choiceId === quiz.correctId;
  const correctChoice = quiz.choices.find((c) => c.id === quiz.correctId)!;
  log(
    "predict",
    `result · ${correct ? "right" : "wrong"} · user=${picked.choiceId} correct=${quiz.correctId} · ${quiz.misconceptionTag ?? "untagged"}`
  );

  // Persist the outcome on tagged misconceptions. Fire-and-forget —
  // globalState.update is async but we don't need to block the reveal.
  if (quiz.misconceptionTag) {
    void recordMisconceptionOutcome(quiz.misconceptionTag, correct);
  }

  return {
    correct,
    userChoiceId: picked.choiceId,
    correctChoice,
    reason: quiz.reason,
    fixHint: quiz.fixHint,
    target: quiz.target,
    misconceptionTag: quiz.misconceptionTag,
  };
}

type RevealAction = "fix" | "deepDive" | "gotIt" | "reportWrong" | null;

interface RevealItem extends vscode.QuickPickItem {
  action: RevealAction;
}

async function showRevealPick(reveal: Reveal): Promise<RevealAction> {
  const items: RevealItem[] = [
    {
      label: reveal.correct
        ? `✓ You got it — ${reveal.correctChoice.label}`
        : `✗ Actual: ${reveal.correctChoice.label}`,
      description: reveal.reason,
      action: null,
    },
  ];

  if (reveal.fixHint) {
    items.push({
      label: "◎ Fix it",
      description: reveal.fixHint,
      action: "fix",
    });
  }

  items.push({
    label: "✿ Deep dive",
    description: "Open Protege with more context on this pattern",
    action: "deepDive",
  });

  items.push({
    label: "✓ Got it",
    description: "Mark this range as explained and close",
    action: "gotIt",
  });

  // Report-wrong — ships so we can debug LLM failure modes from real
  // use. Worded neutrally so users don't feel they're filing a bug.
  items.push({
    label: "⚠ This answer looks wrong",
    description: "Tell Protege — we'll log it and tune the prompts",
    action: "reportWrong",
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: reveal.correct ? "Nice — what now?" : "Now you know — what now?",
    // Confidence-indicator footer — the title shows on the QuickPick
    // header, so we use it to set expectations about LLM fallibility.
    title: "Reveal · Claude can be wrong — flag if so",
    ignoreFocusOut: false,
  });

  return picked?.action ?? null;
}

async function handleRevealAction(
  action: RevealAction,
  reveal: Reveal
): Promise<void> {
  if (!action) return; // user closed the reveal pick without choosing

  switch (action) {
    case "gotIt":
      // This is the ownership hand-off — a correct prediction (or even
      // reading through the reason after a wrong one) means the user
      // has now reasoned about this range. Count it as explained.
      try {
        markExplained(reveal.target.uri, reveal.target.startLine, reveal.target.endLine);
      } catch (err) {
        log(
          "predict",
          `markExplained failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      break;

    case "deepDive": {
      // Open the Protege panel and seed a chat prompt asking for the
      // deeper lesson on this pattern. Reuses the `chat/autoSend`
      // pathway struggleChip → sidebar uses.
      try {
        const { openProtegePanel } = await import("../panel.js");
        const { broadcast, mountedWebviewCount } = await import(
          "../chat/webviewHost.js"
        );
        if (mountedWebviewCount() === 0) {
          if (moduleContext) {
            openProtegePanel(moduleContext);
          } else {
            // Extension context got cleared between registerPredict
            // and this callback — rare but possible on dispose race.
            // Surface the situation instead of silently dropping it.
            vscode.window.showInformationMessage(
              "Protege: open the side panel first, then click Deep dive again."
            );
            return;
          }
        }
        const fileName =
          reveal.target.uri.fsPath.split("/").pop() ?? "this file";
        setTimeout(() => {
          try {
            broadcast({
              type: "chat/autoSend",
              message:
                `I just got a prediction quiz about ${fileName} lines ` +
                `${reveal.target.startLine + 1}–${reveal.target.endLine + 1}. ` +
                `I ${reveal.correct ? "answered correctly" : "got it wrong"}. ` +
                `The correct answer was "${reveal.correctChoice.label}" because: ${reveal.reason}. ` +
                `Teach me more about this pattern — under 200 words with a small example if useful.`,
            });
          } catch (err) {
            log(
              "predict",
              `deepDive broadcast failed — ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }, 250);
      } catch (err) {
        log(
          "predict",
          `deepDive failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      break;
    }

    case "fix":
      // Day 1: just surface the fix hint as an info message. Day 6+ can
      // wire this into smartFix to actually apply the change.
      if (reveal.fixHint) {
        vscode.window.showInformationMessage(`Protege fix hint: ${reveal.fixHint}`);
      }
      break;

    case "reportWrong": {
      // User is telling us Claude's "correct" answer looks wrong. We
      // ask for a one-line reason via InputBox and persist. No LLM
      // call — this is raw ground-truth signal for future prompt
      // tuning. Also flips the misconception counter back (if the
      // tag was wrongly credited a miss).
      await handleReportWrong(reveal);
      break;
    }
  }
}

async function handleReportWrong(reveal: Reveal): Promise<void> {
  const note = await vscode.window.showInputBox({
    prompt: "What looks wrong? (one line — totally optional)",
    placeHolder: "e.g. 'this actually returns 0, not TypeError'",
    ignoreFocusOut: false,
  });
  // User bailed on the input box → we still record the report, just
  // without a note. The act of clicking "This answer looks wrong" is
  // itself useful signal.
  const report = {
    ts: Date.now(),
    file: reveal.target.uri.fsPath,
    startLine: reveal.target.startLine,
    endLine: reveal.target.endLine,
    code: reveal.target.code,
    correctIdClaimed: reveal.correctChoice.id,
    correctLabelClaimed: reveal.correctChoice.label,
    reasonClaimed: reveal.reason,
    misconceptionTag: reveal.misconceptionTag,
    userNote: typeof note === "string" ? note : null,
  };
  log(
    "predict",
    `reportWrong · ${reveal.misconceptionTag ?? "untagged"} · ${note ? `"${note}"` : "no note"}`
  );
  await persistReport(report);

  // If the tag had a "wrong" credited against the user, roll it back —
  // they're telling us the quiz itself was bad, so punishing their
  // misconception score is wrong.
  if (reveal.misconceptionTag && !reveal.correct && moduleContext) {
    try {
      const map =
        moduleContext.globalState.get<SeenMisconceptionMap>(
          SEEN_MISCONCEPTIONS_KEY
        ) ?? {};
      const prev = map[reveal.misconceptionTag];
      if (prev && prev.wrongCount > 0) {
        map[reveal.misconceptionTag] = {
          ...prev,
          wrongCount: prev.wrongCount - 1,
        };
        await moduleContext.globalState.update(
          SEEN_MISCONCEPTIONS_KEY,
          map
        );
        log(
          "predict",
          `rolled back wrong on ${reveal.misconceptionTag} after reportWrong`
        );
      }
    } catch (err) {
      log(
        "predict",
        `rollback failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  vscode.window.showInformationMessage(
    "Protege: flagged — thanks. We'll review and tune the prompts."
  );
}

/** Stores a single prediction-wrong report. We keep the last 200
 *  entries in globalState so future prompt tuning has real-use
 *  signal to read. Trimmed by age + count on each insert. */
const REPORTS_KEY = "protege.predict.reports";
const REPORTS_MAX = 200;

interface PersistedReport {
  ts: number;
  file: string;
  startLine: number;
  endLine: number;
  code: string;
  correctIdClaimed: string;
  correctLabelClaimed: string;
  reasonClaimed: string;
  misconceptionTag: string | null;
  userNote: string | null;
}

async function persistReport(report: PersistedReport): Promise<void> {
  if (!moduleContext) return;
  const existing =
    moduleContext.globalState.get<PersistedReport[]>(REPORTS_KEY) ?? [];
  existing.push(report);
  // Keep only the most recent N to avoid unbounded growth on heavy users.
  const trimmed =
    existing.length > REPORTS_MAX
      ? existing.slice(existing.length - REPORTS_MAX)
      : existing;
  await moduleContext.globalState.update(REPORTS_KEY, trimmed);
}

// ---- Misconception persistence helpers ----

/** Record the outcome of a predict round on a tagged misconception.
 *  Increments the relevant counter + stamps the timestamp. Stored in
 *  globalState so Mechanic 2 can later read the history and escalate
 *  hovers for tags the user has missed multiple times. */
async function recordMisconceptionOutcome(
  tag: string,
  correct: boolean
): Promise<void> {
  if (!moduleContext) return;
  const now = Date.now();
  const map =
    moduleContext.globalState.get<SeenMisconceptionMap>(
      SEEN_MISCONCEPTIONS_KEY
    ) ?? {};
  const prev = map[tag] ?? {
    wrongCount: 0,
    rightCount: 0,
    lastWrongAt: 0,
    lastRightAt: 0,
  };
  const next: SeenMisconceptionEntry = {
    wrongCount: prev.wrongCount + (correct ? 0 : 1),
    rightCount: prev.rightCount + (correct ? 1 : 0),
    lastWrongAt: correct ? prev.lastWrongAt : now,
    lastRightAt: correct ? now : prev.lastRightAt,
  };
  map[tag] = next;
  await moduleContext.globalState.update(SEEN_MISCONCEPTIONS_KEY, map);
  log(
    "predict",
    `misconception ${correct ? "cleared" : "caught"} · ${tag} · wrong=${next.wrongCount} right=${next.rightCount}`
  );
}

/** Read the stored record. Exported so misconceptions.ts can escalate
 *  hover tone based on history ("you've been wrong about this 3 times"). */
export function getSeenMisconceptions(): SeenMisconceptionMap {
  if (!moduleContext) return {};
  return (
    moduleContext.globalState.get<SeenMisconceptionMap>(
      SEEN_MISCONCEPTIONS_KEY
    ) ?? {}
  );
}

// ---- End-of-day helpers ----

function todayLocalISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Roll the per-day record forward when the calendar day changes. A
 *  user leaving Cursor open overnight will see the map cleared at
 *  midnight — today's vibecoding is today's, not yesterday's residue. */
function maybeRollTopBurstDay(): void {
  const today = todayLocalISO();
  if (topBurstDay !== today) {
    topBurstToday.clear();
    topBurstDay = today;
  }
}

function recordTopBurst(evt: ChangeOriginEvent): void {
  if (evt.uri.scheme !== "file") return;
  maybeRollTopBurstDay();
  const key = evt.uri.toString();
  const prev = topBurstToday.get(key);
  // Only replace the stored burst if this one is BIGGER. "Biggest" is
  // our coarse proxy for "most vibecoded" — more accurate signals (like
  // ownership deltas) can layer in later, but this gets 80% of the
  // value with 0 extra infrastructure.
  if (!prev || evt.charsAdded > prev.charsAdded) {
    topBurstToday.set(key, {
      uri: evt.uri,
      startLine: evt.startLine,
      endLine: evt.endLine,
      charsAdded: evt.charsAdded,
      ts: evt.ts,
    });
  }
}

async function maybeShowEndOfDayChip(_evt: BreakEvent): Promise<void> {
  if (!moduleContext || !eodStatusBar) return;
  if (!isEnabled()) return;

  // Per-calendar-day dedup. globalState so it survives reloads.
  const today = todayLocalISO();
  const lastFired = moduleContext.globalState.get<string>(EOD_LAST_FIRED_KEY);
  if (lastFired === today) return;

  maybeRollTopBurstDay();
  const candidate = pickBiggestBurstToday();
  if (!candidate) {
    log("predict", "end-of-day skipped · no vibecoded burst today");
    return;
  }

  // Stamp NOW so we can't fire twice even if two break events race.
  await moduleContext.globalState.update(EOD_LAST_FIRED_KEY, today);
  showEndOfDayChip(candidate);
}

function pickBiggestBurstToday(): TopBurstRecord | null {
  let best: TopBurstRecord | null = null;
  for (const rec of topBurstToday.values()) {
    if (!best || rec.charsAdded > best.charsAdded) best = rec;
  }
  return best;
}

function showEndOfDayChip(candidate: TopBurstRecord): void {
  if (!eodStatusBar) return;
  eodPending = candidate;
  const fileName = candidate.uri.fsPath.split("/").pop() ?? "today's work";
  eodStatusBar.text = `◎ Predict what you shipped — ${fileName}`;
  eodStatusBar.tooltip =
    `Protege: quiz yourself on lines ${candidate.startLine + 1}–${candidate.endLine + 1} of ${fileName} — 15s`;
  eodStatusBar.show();

  if (eodAutoHideTimer) clearTimeout(eodAutoHideTimer);
  eodAutoHideTimer = setTimeout(() => {
    log(
      "predict",
      `end-of-day chip expired unclaimed · ${candidate.uri.fsPath.split("/").pop()}`
    );
    hideEndOfDayChip();
  }, EOD_CHIP_TTL_MS);

  log(
    "predict",
    `end-of-day chip shown · ${fileName} · ${candidate.charsAdded}ch · lines ${candidate.startLine}-${candidate.endLine}`
  );
}

function hideEndOfDayChip(): void {
  if (eodStatusBar) eodStatusBar.hide();
  if (eodAutoHideTimer) {
    clearTimeout(eodAutoHideTimer);
    eodAutoHideTimer = null;
  }
  eodPending = null;
}

async function acceptEndOfDayChip(): Promise<void> {
  const candidate = eodPending;
  hideEndOfDayChip();
  if (!candidate) return;

  // Open the file and scroll the range into view so the user sees
  // what's being quizzed, then dispatch through the shared pipeline
  // — same cooldown + cap + prompt path as Cmd+K P.
  try {
    const doc = await vscode.workspace.openTextDocument(candidate.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const safeStart = Math.max(
      0,
      Math.min(doc.lineCount - 1, candidate.startLine)
    );
    const safeEnd = Math.max(
      safeStart,
      Math.min(doc.lineCount - 1, candidate.endLine)
    );
    const endChar = doc.lineAt(safeEnd).text.length;
    editor.selection = new vscode.Selection(safeStart, 0, safeEnd, endChar);
    editor.revealRange(
      new vscode.Range(safeStart, 0, safeEnd, endChar),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
    await runPredictOnRange(candidate.uri, safeStart, safeEnd);
  } catch (err) {
    log(
      "predict",
      `end-of-day accept failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
