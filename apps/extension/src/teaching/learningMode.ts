import * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  LearningPlan,
  LearningSession,
  LearningSessionLogEntry,
  LearningSessionTrace,
  LearningStep,
  LearningTraceEvent,
} from "@protege/types";
// Inlined to keep @protege/types a type-only dependency of this file —
// importing a runtime value from it made tsup preserve a runtime
// `require("@protege/types")` in the bundle, which then tried to load
// the workspace package from source at activation time and crashed on
// `export * from "./concepts.js"` (a .ts file without a built .js pair).
// Must match the constant in packages/types/src/index.ts when we bump
// the trace schema.
const LEARNING_TRACE_SCHEMA_VERSION = 1;
import { aiQuery } from "../ai/aiBackend.js";
import { markExplained } from "../user/ownership.js";
import { log, logBlock } from "../log.js";
import { getActiveFileEditor } from "../workspace/activeFile.js";

/**
 * Learning Mode — the user builds, Protege validates.
 *
 * Triggered by `protege.learning.start` (command palette or Cmd+K L).
 * User types a goal in an InputBox. Protege reads the active file,
 * asks Haiku for a 3–5 step plan, opens the LearningSessionPanel in
 * the webview, and enters a turn loop:
 *
 *   1. Panel shows current step + success criteria.
 *   2. User writes code in the editor.
 *   3. User hits Cmd+Enter (or clicks "I'm done") → validator runs.
 *   4. Pass → next step. Partial/fail → inline feedback + retry.
 *   5. All steps pass → markExplained on the range, session logged.
 *
 * Only ONE session runs at a time. Module-scope state; survives webview
 * reloads since the panel reads from broadcast `learning/state`. A
 * WeakMap<session, vscode.Uri> keeps the URI captured against the
 * session object (same race-safe pattern explainBack.ts uses).
 *
 * Costs: one Haiku call per session start (plan ~1500 tokens), one per
 * step attempt (~500 tokens). A typical 4-step session with 1 retry
 * costs ~$0.002.
 */

// ---- Types ----

type Broadcaster = (
  msg:
    | { type: "learning/state"; state: LearningSession | null }
    | { type: "learning/devTrace"; trace: LearningSessionTrace | null }
) => void;

// ---- Module state ----

let broadcaster: Broadcaster | null = null;
let active: LearningSession | null = null;
let moduleContext: vscode.ExtensionContext | null = null;
// Guard against concurrent startSession calls (double-click fork chip,
// rapid command invocations). When true, a second startSession returns
// early instead of spawning a parallel Haiku call + racing state.
let sessionStarting = false;
const sessionUris = new WeakMap<LearningSession, vscode.Uri>();
const sessionPreSnapshots = new WeakMap<LearningSession, string>();
// Dev-mode trace per active session — captures raw plan + every validator
// call + reveal events. Attached to the log entry on session end. Read by
// `getLatestTrace()` for the export command.
const sessionTraces = new WeakMap<LearningSession, LearningSessionTrace>();
// Last completed trace, for `protege.learning.exportSession` after the
// session has ended (WeakMap value is gone once the session object is
// garbage-collected; this keeps one around for export).
let latestCompletedTrace: LearningSessionTrace | null = null;

/** Read `protege.learning.devLogging` config. True means capture traces +
 *  emit logBlock dumps + allow Dev drawer. Default true (dogfood posture;
 *  flip before external ship). */
function isDevLoggingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("learning.devLogging", true);
}

function truncateForTrace(s: string | undefined | null): string {
  if (!s) return "";
  return s.length > TRACE_SNIPPET_CAP_CHARS
    ? s.slice(0, TRACE_SNIPPET_CAP_CHARS) + "…[truncated]"
    : s;
}

/** Trim a trace's events from the front (keeping newest + session-ended)
 *  until the serialized size fits under the cap. Stamps `truncated: true`
 *  when any events are dropped. */
function enforceTraceSizeCap(
  trace: LearningSessionTrace
): LearningSessionTrace {
  let serialized = JSON.stringify(trace);
  if (serialized.length <= TRACE_SIZE_CAP_BYTES) return trace;
  const events = [...trace.events];
  // Keep the last event (session-ended if present) always — it's the
  // final verdict, most useful to retain.
  const pinnedLast = events.length > 0 ? events[events.length - 1] : null;
  const rest = pinnedLast ? events.slice(0, -1) : events;
  // Drop from the front while over-cap.
  while (rest.length > 0) {
    rest.shift();
    const trimmed: LearningSessionTrace = {
      ...trace,
      events: pinnedLast ? [...rest, pinnedLast] : rest,
      truncated: true,
    };
    serialized = JSON.stringify(trimmed);
    if (serialized.length <= TRACE_SIZE_CAP_BYTES) return trimmed;
  }
  // Even with all events dropped we're over — last resort, keep just the
  // plan and stamp truncated. Validator traces drop entirely.
  return {
    ...trace,
    events: pinnedLast ? [pinnedLast] : [],
    truncated: true,
  };
}

function pushTraceEvent(
  session: LearningSession,
  event: LearningTraceEvent
): void {
  const trace = sessionTraces.get(session);
  if (!trace) return;
  trace.events.push(event);
}

/** Returns the trace of the most recently completed session, for the
 *  `protege.learning.exportSession` command. Null if no session has
 *  completed yet or trace was disabled for that session. */
export function getLatestTrace(): LearningSessionTrace | null {
  return latestCompletedTrace;
}

// ---- Tuning ----

const PLAN_TOKENS = 1600;
const VALIDATE_TOKENS = 500;
const MAX_FILE_CHARS = 20_000; // cap file sent to plan generator
const LOG_KEY = "protege.learningSessions";
const LOG_CAP = 50;
// Retain full traces on at most the last N log entries. Older entries
// keep their summary but drop `trace` to stay under the globalState
// soft cap. 20 × ~64KB = ~1.3MB max, well under VS Code's ~10MB limit.
const TRACE_CAP = 20;
// Per-trace size ceiling. When exceeded, we drop oldest events (keeping
// newest + session-ended) and stamp `truncated: true`.
const TRACE_SIZE_CAP_BYTES = 64 * 1024;
// File snippets in validation events are the biggest consumer — truncate
// each to keep room for many events.
const TRACE_SNIPPET_CAP_CHARS = 2048;

// ---- Registration ----

export function registerLearningMode(
  context: vscode.ExtensionContext,
  broadcast: Broadcaster
): vscode.Disposable[] {
  broadcaster = broadcast;
  moduleContext = context;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(
      "protege.learning.start",
      // Optional pre-filled goal: bypass the InputBox when the chat
      // fork-chip fires the command ("✿ Learn it with me" already knows
      // what the user asked). Undefined / empty → falls back to prompting.
      async (arg?: { goal?: string }) => {
        await startSession(arg?.goal);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand("protege.learning.done", async () => {
      await submitCurrentStep();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.learning.hint", () => {
      revealHint();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.learning.show", () => {
      revealReferenceSnippet();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.learning.stop", async () => {
      await endSession("abandoned");
    })
  );

  disposables.push({
    dispose() {
      // Capture moduleContext before the dispose chain nulls it, so
      // endSession's persistLogEntry still has a live globalState to
      // write the final trace to. Without this, closing VS Code mid-
      // session silently discarded the log entry (B1).
      const ctxSnapshot = moduleContext;
      const pending = endSession("abandoned").catch((err) =>
        // eslint-disable-next-line no-console
        console.error("[protege] endSession on dispose failed:", err)
      );
      // Hold the nullification until persistLogEntry is done (best-effort;
      // VS Code may still kill us mid-await on hard shutdown).
      void pending.finally(() => {
        broadcaster = null;
        // Only null moduleContext once the write path is drained.
        if (moduleContext === ctxSnapshot) moduleContext = null;
      });
    },
  });

  return disposables;
}

export function getCurrentSession(): LearningSession | null {
  return active ? cloneSession(active) : null;
}

/** True only when a REAL learning session is active — i.e. the plan has
 *  been generated and the first step isn't the "planning" placeholder.
 *  Used by the chat fork-chip gate so a stuck / slow plan-generation
 *  doesn't suppress fork chips for subsequent turns. */
export function hasRealSession(): boolean {
  if (!active) return false;
  const firstId = active.plan.steps[0]?.id;
  return firstId !== "planning";
}

// ---- Lifecycle ----

async function startSession(preFilledGoal?: string): Promise<void> {
  // Concurrency guard (B4). A double-click on the "Learn it with me"
  // chip or two rapid command invocations would otherwise spawn two
  // parallel Haiku plan calls; only one wins but both eat tokens.
  if (sessionStarting) {
    log("learning", "startSession: already starting, skipping");
    return;
  }
  sessionStarting = true;
  try {
    await startSessionInner(preFilledGoal);
  } catch (err) {
    // Swallow + log — startSession is invoked from command callbacks
    // and chat fork-chip handlers; a re-throw would surface an ugly
    // "command failed" toast instead of our own error paths. The inner
    // finally already cleaned up any placeholder before this catch.
    log(
      "learning",
      `startSession threw — ${err instanceof Error ? err.message : String(err)}`
    );
    vscode.window.showErrorMessage(
      `Protege: couldn't start Learning Mode — ${err instanceof Error ? err.message : "unknown error"}.`
    );
  } finally {
    sessionStarting = false;
  }
}

async function startSessionInner(preFilledGoal?: string): Promise<void> {
  if (!isEnabled()) {
    vscode.window.showInformationMessage(
      "Protege Learning Mode is disabled. Enable it in Settings → Protege › Learning."
    );
    return;
  }

  // Use the "sticky last-real-editor" helper so clicking a button in the
  // Protege webview doesn't make this check fail. Raw activeTextEditor
  // flips to undefined the moment the webview steals focus, which meant
  // the "✿ Learn it with me" fork chip always fired the guard below.
  const editor = getActiveFileEditor();
  if (!editor) {
    vscode.window.showInformationMessage(
      "Protege: open a code file first — Learning Mode builds into the file you have focused."
    );
    return;
  }
  // getActiveFileEditor already filters for `scheme === "file"`, so we
  // don't need the secondary scheme guard — it's defensive-duplicate now.

  // Chat fork-chip passes the goal already; skip the InputBox in that
  // case so the user doesn't re-type what they just said. Fall back to
  // prompting when invoked from Cmd+K L or the palette.
  const goal = preFilledGoal?.trim()
    ? preFilledGoal.trim()
    : (await vscode.window.showInputBox({
        prompt: "What do you want to learn to build?",
        placeHolder: "e.g. add a filter dropdown so users can see all / active / completed todos",
        ignoreFocusOut: true,
      }))?.trim();
  if (!goal) return;

  // Only fire endSession when there's actually a prior session — avoids
  // a pointless learning/state:null broadcast + flicker when this is
  // the first session of the extension host's lifetime (B6).
  if (active) {
    await endSession("abandoned"); // replace any prior session
  }

  const doc = editor.document;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const relPath = root
    ? path.relative(root, doc.uri.fsPath).split(path.sep).join("/")
    : doc.uri.fsPath;

  const preSnapshot = doc.getText();

  // Ephemeral "thinking" state so the panel can open immediately with a
  // skeleton roadmap while the plan generates. We emit a one-step
  // placeholder; when the real plan lands, we overwrite.
  const placeholderId = randomUUID();
  const placeholder: LearningSession = {
    id: placeholderId,
    goal: goal.trim(),
    path: relPath,
    language: doc.languageId,
    plan: {
      goal: goal.trim(),
      steps: [
        {
          id: "planning",
          title: "Generating plan…",
          whatToDo: "Protege is writing a step-by-step roadmap for this goal.",
          successCriteria: "—",
          hint: "—",
          status: "current",
          attempts: 0,
          hintRevealed: false,
        },
      ],
      estimatedMinutes: 0,
      conceptsTagged: [],
      ownershipRange: { startLine: 0, endLine: Math.max(0, doc.lineCount - 1) },
    },
    currentStepIndex: 0,
    startedAt: Date.now(),
    completedAt: null,
    validating: false,
  };
  active = placeholder;
  sessionUris.set(placeholder, doc.uri);
  sessionPreSnapshots.set(placeholder, preSnapshot);
  broadcaster?.({ type: "learning/state", state: cloneSession(placeholder) });

  // Placeholder is now visible. Anything between here and "real session
  // set" that throws will leave `active = placeholder` in module state,
  // blocking future sessions (the stuck-planning UX bug we just fixed).
  // Wrap in try/finally: on any throw, clean up the placeholder BEFORE
  // propagating the error. (B3)
  let reachedRealSession = false;
  try {
    const { mountedWebviewCount } = await import("../chat/webviewHost.js");
    if (mountedWebviewCount() === 0) {
      await vscode.commands.executeCommand("protege.toggle");
    }

    let plan: LearningPlan | null = null;
    let planRaw = "";
    const planStartedAt = Date.now();
  // Hard 30s timeout on plan generation. Without this, a hung backend
  // leaves the panel stuck on the "Protege is writing a roadmap…"
  // placeholder forever — "I'm done" silent no-ops and the user
  // thinks the extension crashed. 30s is twice a normal Haiku call.
  try {
    const genResult = await Promise.race<
      { plan: LearningPlan; raw: string } | null | "timeout"
    >([
      generatePlan(doc, goal.trim()),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 30_000)
      ),
    ]);
    if (genResult === "timeout") {
      log("learning", `plan gen timed out after 30s`);
    } else {
      plan = genResult?.plan ?? null;
      planRaw = genResult?.raw ?? "";
    }
  } catch (err) {
    log(
      "learning",
      `plan gen failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const planElapsedMs = Date.now() - planStartedAt;

  // Race-protection: if the user already clicked × (endSession) while we
  // were waiting, `active` will have flipped. Don't promote stale plan.
  if (active !== placeholder) {
    return;
  }

  if (!plan) {
    vscode.window.showErrorMessage(
      "Protege: couldn't generate a learning plan (timed out or errored). Try again, or rephrase the goal."
    );
    await endSession("abandoned");
    return;
  }

  // Promote placeholder → real session with the generated plan.
  const realSession: LearningSession = {
    ...placeholder,
    plan: {
      ...plan,
      steps: plan.steps.map((s, i) => ({
        ...s,
        status: i === 0 ? "current" : "pending",
        attempts: 0,
        hintRevealed: false,
      })),
    },
  };
  active = realSession;
  sessionUris.set(realSession, doc.uri);
  sessionPreSnapshots.set(realSession, preSnapshot);
  reachedRealSession = true;

  // Dev-mode trace. Captures the full Haiku plan output + per-step
  // validator calls as the session runs. Attached to the log entry on
  // end; exposed via `getLatestTrace()` for the export command.
  if (isDevLoggingEnabled()) {
    const trace: LearningSessionTrace = {
      traceSchemaVersion: LEARNING_TRACE_SCHEMA_VERSION,
      sessionId: realSession.id,
      goal: realSession.plan.goal,
      planRaw,
      plan: realSession.plan,
      events: [
        {
          kind: "plan-generated",
          at: new Date().toISOString(),
          elapsedMs: planElapsedMs,
        },
      ],
    };
    sessionTraces.set(realSession, trace);
    logBlock(
      "learning",
      `plan generated · ${realSession.plan.steps.length} steps · ${planElapsedMs}ms`,
      JSON.stringify(realSession.plan, null, 2)
    );
    broadcaster?.({ type: "learning/devTrace", trace });
  }

  broadcaster?.({ type: "learning/state", state: cloneSession(realSession) });
  // Context key so the Cmd+Enter keybinding is only live while a
  // session is actually active — otherwise we'd hijack Enter globally.
  void vscode.commands.executeCommand(
    "setContext",
    "protege.learningActive",
    true
  );

  log(
    "learning",
    `started · ${relPath} · ${plan.steps.length} steps · "${goal.trim()}"`
  );
  } finally {
    // B3: if we never promoted the placeholder to a real session (throw
    // anywhere in the try block), clean up so the next startSession
    // isn't blocked by a zombie placeholder. If `active` changed to
    // something else while we were awaiting, leave it alone.
    if (!reachedRealSession && active === placeholder) {
      active = null;
      broadcaster?.({ type: "learning/state", state: null });
    }
  }
}

async function endSession(
  outcome: "complete" | "abandoned"
): Promise<void> {
  const finished = active;
  active = null;

  if (finished && finished.plan.steps[0]?.id !== "planning") {
    // Only log real sessions, not the placeholder-only abort path.
    finished.completedAt = Date.now();
    finished.outcome = outcome;
    // Stamp session-ended on the trace + promote to latest-completed so
    // `protege.learning.exportSession` can grab it. Run BEFORE persist
    // so the entry attaches the trace.
    const finalTrace = sessionTraces.get(finished) ?? null;
    if (finalTrace) {
      finalTrace.events.push({
        kind: "session-ended",
        at: new Date().toISOString(),
        outcome,
      });
      latestCompletedTrace = finalTrace;
    }
    await persistLogEntry(finished);
    if (outcome === "complete") {
      await stampOwnership(finished);
    }
    log(
      "learning",
      `end · ${outcome} · ${finished.path} · ${summarizeAttempts(finished)}`
    );
  }

  void vscode.commands.executeCommand(
    "setContext",
    "protege.learningActive",
    false
  );
  broadcaster?.({ type: "learning/state", state: null });
  broadcaster?.({ type: "learning/devTrace", trace: null });
}

// ---- Turn loop ----

async function submitCurrentStep(): Promise<void> {
  if (!active) return;
  if (active.validating) return;
  // "I'm done" during the planning placeholder → tell the user the plan
  // is still being generated instead of silent no-op. Without this, the
  // UI feels broken when the backend is slow or errored.
  if (active.plan.steps[0]?.id === "planning") {
    vscode.window.showInformationMessage(
      "Protege is still writing the plan. Give it a few seconds, or click × to stop."
    );
    return;
  }

  const capturedSession = active;
  const stepIdx = capturedSession.currentStepIndex;
  const step = capturedSession.plan.steps[stepIdx];
  if (!step) return;

  const uri = sessionUris.get(capturedSession);
  if (!uri) {
    log("learning", "submit: missing uri for session");
    return;
  }

  const preSnapshot = sessionPreSnapshots.get(capturedSession) ?? "";
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    log(
      "learning",
      `submit open failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  step.attempts++;
  capturedSession.validating = true;
  broadcaster?.({
    type: "learning/state",
    state: cloneSession(capturedSession),
  });

  let verdict: StepVerdict | null = null;
  let verdictRaw = "";
  let verdictElapsedMs = 0;
  const currentFileAtSubmit = doc.getText();
  try {
    const result = await validateStep(capturedSession, doc, preSnapshot, stepIdx);
    if (result) {
      verdict = result.verdict;
      verdictRaw = result.raw;
      verdictElapsedMs = result.elapsedMs;
    }
  } catch (err) {
    log(
      "learning",
      `validate failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Stop/restart race protection.
  if (active !== capturedSession) return;

  capturedSession.validating = false;

  // Trace the validation call (dev logging only). Captures the raw
  // prompt inputs, raw Haiku output, parsed verdict. Also fires a
  // logBlock dump to the Output channel for live tailing.
  if (verdict && isDevLoggingEnabled()) {
    pushTraceEvent(capturedSession, {
      kind: "validation",
      at: new Date().toISOString(),
      stepId: step.id,
      attempt: step.attempts,
      fileBefore: truncateForTrace(preSnapshot),
      fileNow: truncateForTrace(currentFileAtSubmit),
      verdictRaw,
      verdict: {
        status: verdict.status,
        note: verdict.note,
        hint: verdict.hint,
        caught_bonus: verdict.caught_bonus,
        ready_for_next: verdict.ready_for_next,
      },
      elapsedMs: verdictElapsedMs,
    });
    logBlock(
      "learning",
      `verdict stepId=${step.id} attempt=${step.attempts} status=${verdict.status} · ${verdictElapsedMs}ms`,
      JSON.stringify(verdict, null, 2)
    );
    const trace = sessionTraces.get(capturedSession);
    if (trace) {
      broadcaster?.({ type: "learning/devTrace", trace });
    }
  }

  if (!verdict) {
    step.status = "failed";
    step.lastNote =
      "Protege couldn't validate this right now — try again, or skip and keep going.";
    step.lastHintFromValidator = undefined;
    step.lastBonus = undefined;
    broadcaster?.({
      type: "learning/state",
      state: cloneSession(capturedSession),
    });
    return;
  }

  step.lastNote = verdict.note;
  step.lastBonus = verdict.caught_bonus ?? undefined;
  step.lastHintFromValidator =
    verdict.status !== "pass" ? verdict.hint ?? undefined : undefined;
  step.status =
    verdict.status === "pass"
      ? "passed"
      : verdict.status === "partial"
        ? "partial"
        : verdict.status === "off-track"
          ? "off-track"
          : "failed";

  // B5: `status === "pass"` is the authoritative "advance" signal. The
  // LLM sometimes pairs pass with `ready_for_next: false` (malformed or
  // overly cautious). Relying on BOTH leaves the user stuck on a step
  // the validator said they completed. Trust status; ignore the flag.
  if (verdict.status === "pass") {
    // Advance to next pending step, or complete the session.
    const nextIdx = stepIdx + 1;
    if (nextIdx < capturedSession.plan.steps.length) {
      capturedSession.currentStepIndex = nextIdx;
      capturedSession.plan.steps[nextIdx].status = "current";
      broadcaster?.({
        type: "learning/state",
        state: cloneSession(capturedSession),
      });
    } else {
      // All steps passed — complete.
      broadcaster?.({
        type: "learning/state",
        state: cloneSession(capturedSession),
      });
      await endSession("complete");
      vscode.window.showInformationMessage(
        `Protege: session complete · ${capturedSession.plan.steps.length} steps`
      );
    }
    return;
  }

  // Not advancing. Emit the updated feedback so the panel shows it.
  broadcaster?.({
    type: "learning/state",
    state: cloneSession(capturedSession),
  });

  log(
    "learning",
    `step ${stepIdx + 1} · ${verdict.status} · attempt ${step.attempts}`
  );
}

function revealHint(): void {
  if (!active) return;
  const step = active.plan.steps[active.currentStepIndex];
  if (!step) return;
  step.hintRevealed = true;
  pushTraceEvent(active, {
    kind: "hint-revealed",
    at: new Date().toISOString(),
    stepId: step.id,
  });
  const trace = sessionTraces.get(active);
  if (trace) broadcaster?.({ type: "learning/devTrace", trace });
  broadcaster?.({ type: "learning/state", state: cloneSession(active) });
}

function revealReferenceSnippet(): void {
  if (!active) return;
  const step = active.plan.steps[active.currentStepIndex];
  if (!step || !step.referenceSnippet) return;
  // "Show me" downgrades the step to "shown" — it can't count toward
  // the ownership / mastery reward since the user didn't build it.
  step.status = "shown";
  step.hintRevealed = true;
  pushTraceEvent(active, {
    kind: "show-revealed",
    at: new Date().toISOString(),
    stepId: step.id,
  });
  // Advance if there's a next step.
  const nextIdx = active.currentStepIndex + 1;
  if (nextIdx < active.plan.steps.length) {
    active.currentStepIndex = nextIdx;
    active.plan.steps[nextIdx].status = "current";
  }
  const trace = sessionTraces.get(active);
  if (trace) broadcaster?.({ type: "learning/devTrace", trace });
  broadcaster?.({ type: "learning/state", state: cloneSession(active) });
}

// ---- Plan generation ----

async function generatePlan(
  doc: vscode.TextDocument,
  goal: string
): Promise<{ plan: LearningPlan; raw: string } | null> {
  const lang = doc.languageId;
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const full = doc.getText();
  const code = full.length > MAX_FILE_CHARS ? full.slice(0, MAX_FILE_CHARS) : full;
  const truncatedNote =
    full.length > MAX_FILE_CHARS
      ? `\n\n(File truncated at ${MAX_FILE_CHARS} chars for the plan prompt.)`
      : "";

  const prompt = `The user wants to LEARN to build something in their code, not have it written for them. You are a senior engineer mentoring them 1:1 through the real pedagogy arc:

  TELL    (whyItMatters + whatToDo — mental model first, then the task)
  →  USER DOES IT
  →  CHECK  (successCriteria — objective, verifiable from file text)
  →  FEEDBACK  (pass → advance; fail → one hint via the Hint button)
  →  SHOW  (referenceSnippet — only if they click Show, the nuclear option)

Every step must support all four phases. The TELL phase is where you teach — not the SHOW phase. SHOW is the fallback for a stuck learner.

Their goal: "${goal}"

Current file (${fileName}, ${lang}):
\`\`\`${lang}
${code}
\`\`\`${truncatedNote}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "goal": "one-sentence restatement of what they'll build",
  "steps": [
    {
      "id": "step-1",
      "title": "short, under 60 chars — the ACTION, verb first",
      "whyItMatters": "one sentence of mental model. WHY this step exists in the bigger picture. e.g. 'State needs a slot before the UI can read from it.' Teaches the concept WITHOUT the code.",
      "whatToDo": "2–3 sentences. Describe the outcome they should produce. Reference real identifiers from the current file. NEVER paste code. Think 'told to a junior dev over your shoulder'.",
      "successCriteria": "one sentence, objectively verifiable from the file text alone. e.g. 'a useState<Filter>() exists alongside the other state slots'. Must be something we can regex/parse for.",
      "hint": "one sentence that narrows the search without solving it. e.g. 'Look at how the other slots are declared — same shape works here.' Never a code sample.",
      "referenceSnippet": "optional. ONE tight code sample, 5 lines max. Shown only if the user clicks Show me — the nuclear option after they've struggled. Omit if the step is simple enough to verbalize."
    }
  ],
  "estimatedMinutes": 4,
  "conceptsTagged": ["react/useState", "conditional-rendering"],
  "ownershipRange": { "startLine": 12, "endLine": 60 }
}

Pedagogy rules (NON-NEGOTIABLE):
 - 3–5 steps. Never fewer than 3, never more than 5.
 - Each step completable in under 3 minutes by someone seeing the pattern for the first time.
 - Steps build on each other — step N+1 must require step N to already be done.
 - whyItMatters teaches the concept; whatToDo describes the task. Both are required. If you can't write a whyItMatters, the step is too mechanical and should be merged or removed.
 - NO spoilers in whyItMatters or whatToDo. Describe outcomes, not code.
 - successCriteria: verifiable from file text alone (no runtime state, no test output). If you can't define one, the step is too fuzzy — rewrite it.
 - Hints are ladder rungs, not solutions. One rung at a time.
 - referenceSnippet = last resort. Prefer steps where a reference snippet isn't needed at all.
 - ownershipRange covers the lines the session will touch — used to raise the Map tab's ownership dot on completion.

Pacing rules:
 - First step is always ORIENTATION — the smallest, most trivial move that gets the learner's hands on the code. e.g. "Add a \`filter\` state slot" not "Wire the filter through the whole component tree."
 - Middle steps introduce ONE concept each. Never two.
 - Last step is always INTEGRATION — make the whole thing actually work end-to-end. Previous steps were pieces; this is where they fit together.

Return ONLY the JSON.`;

  const raw = await aiQuery(prompt, PLAN_TOKENS, { kind: "teach" });
  if (!raw) return null;
  const plan = parsePlan(raw);
  if (!plan) return null;
  return { plan, raw };
}

interface ParsedPlan {
  goal?: string;
  steps?: Array<{
    id?: string;
    title?: string;
    whyItMatters?: string;
    whatToDo?: string;
    successCriteria?: string;
    hint?: string;
    referenceSnippet?: string;
  }>;
  estimatedMinutes?: number;
  conceptsTagged?: string[];
  ownershipRange?: { startLine?: number; endLine?: number };
}

function parsePlan(raw: string): LearningPlan | null {
  const candidate = extractLargestJsonObject(raw);
  if (!candidate) return null;
  let parsed: ParsedPlan;
  try {
    parsed = JSON.parse(candidate) as ParsedPlan;
  } catch {
    return null;
  }

  if (
    typeof parsed.goal !== "string" ||
    !Array.isArray(parsed.steps) ||
    parsed.steps.length < 2 ||
    parsed.steps.length > 8
  ) {
    return null;
  }

  const steps: LearningStep[] = [];
  for (const s of parsed.steps) {
    if (
      typeof s.id !== "string" ||
      typeof s.title !== "string" ||
      typeof s.whatToDo !== "string" ||
      typeof s.successCriteria !== "string" ||
      typeof s.hint !== "string"
    ) {
      return null;
    }
    steps.push({
      id: s.id,
      title: s.title.slice(0, 120),
      whyItMatters:
        typeof s.whyItMatters === "string" && s.whyItMatters.trim().length > 0
          ? s.whyItMatters.trim()
          : undefined,
      whatToDo: s.whatToDo,
      successCriteria: s.successCriteria,
      hint: s.hint,
      referenceSnippet:
        typeof s.referenceSnippet === "string" &&
        s.referenceSnippet.trim().length > 0
          ? s.referenceSnippet
          : undefined,
      status: "pending",
      attempts: 0,
      hintRevealed: false,
    });
  }

  return {
    goal: parsed.goal,
    steps,
    estimatedMinutes:
      typeof parsed.estimatedMinutes === "number" ? parsed.estimatedMinutes : 5,
    conceptsTagged: Array.isArray(parsed.conceptsTagged)
      ? parsed.conceptsTagged.filter((c): c is string => typeof c === "string")
      : [],
    ownershipRange: {
      startLine:
        typeof parsed.ownershipRange?.startLine === "number"
          ? parsed.ownershipRange.startLine
          : 0,
      endLine:
        typeof parsed.ownershipRange?.endLine === "number"
          ? parsed.ownershipRange.endLine
          : 0,
    },
  };
}

// ---- Step validator ----

interface StepVerdict {
  status: "pass" | "partial" | "fail" | "off-track";
  note: string;
  hint?: string;
  caught_bonus?: string;
  ready_for_next: boolean;
}

async function validateStep(
  session: LearningSession,
  doc: vscode.TextDocument,
  preSnapshot: string,
  stepIdx: number
): Promise<{ verdict: StepVerdict; raw: string; elapsedMs: number } | null> {
  const lang = doc.languageId;
  const currentFile = doc.getText();
  const step = session.plan.steps[stepIdx];
  const stepsSummary = session.plan.steps
    .map((s, i) => `${i + 1}. ${s.title} — success: ${s.successCriteria}`)
    .join("\n");

  const prompt = `You are validating whether the user completed step ${stepIdx + 1} of their learning session.

Plan goal: ${session.plan.goal}

All steps (for context):
${stepsSummary}

Current step's success criteria: "${step.successCriteria}"

File BEFORE the session started:
\`\`\`${lang}
${truncate(preSnapshot, 8_000)}
\`\`\`

File NOW:
\`\`\`${lang}
${truncate(currentFile, 12_000)}
\`\`\`

Return ONLY a JSON object, no prose:
{
  "status": "pass" | "partial" | "fail" | "off-track",
  "note": "one short sentence, specific, reference real identifiers",
  "hint": "one nudge — only when status is NOT pass",
  "caught_bonus": "optional — one thing they did well that wasn't required",
  "ready_for_next": true | false
}

Status meanings:
 - pass: success criteria met. ready_for_next = true.
 - partial: most of the criteria met, one piece missing. ready_for_next = false. Give a hint.
 - fail: attempted but wrong. ready_for_next = false. Give a hint.
 - off-track: they wrote code for a different step (future or unrelated). Gentle redirect. ready_for_next = false.

BIAS — BE GENEROUS:
 - If they used a different idiom that still meets the criteria, pass it.
 - If the step has 2 criteria and they met 1, that's partial, not fail.
 - Over-failing kills engagement. Err on the side of acceptance.

Return ONLY the JSON.`;

  const startedAt = Date.now();
  const raw = await aiQuery(prompt, VALIDATE_TOKENS, { kind: "teach" });
  const elapsedMs = Date.now() - startedAt;
  if (!raw) return null;
  const verdict = parseVerdict(raw);
  if (!verdict) return null;
  return { verdict, raw, elapsedMs };
}

interface ParsedVerdict {
  status?: string;
  note?: string;
  hint?: string;
  caught_bonus?: string;
  ready_for_next?: boolean;
}

function parseVerdict(raw: string): StepVerdict | null {
  const candidate = extractLargestJsonObject(raw);
  if (!candidate) return null;
  let parsed: ParsedVerdict;
  try {
    parsed = JSON.parse(candidate) as ParsedVerdict;
  } catch {
    return null;
  }
  if (
    parsed.status !== "pass" &&
    parsed.status !== "partial" &&
    parsed.status !== "fail" &&
    parsed.status !== "off-track"
  ) {
    return null;
  }
  if (typeof parsed.note !== "string") return null;
  return {
    status: parsed.status,
    note: parsed.note,
    hint: typeof parsed.hint === "string" ? parsed.hint : undefined,
    caught_bonus:
      typeof parsed.caught_bonus === "string" ? parsed.caught_bonus : undefined,
    ready_for_next: Boolean(parsed.ready_for_next),
  };
}

// ---- Helpers ----

function extractLargestJsonObject(raw: string): string | null {
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
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n… [truncated ${s.length - maxChars} chars for prompt budget]`;
}

function cloneSession(s: LearningSession): LearningSession {
  return {
    id: s.id,
    goal: s.goal,
    path: s.path,
    language: s.language,
    plan: {
      goal: s.plan.goal,
      steps: s.plan.steps.map((step) => ({ ...step })),
      estimatedMinutes: s.plan.estimatedMinutes,
      conceptsTagged: [...s.plan.conceptsTagged],
      ownershipRange: { ...s.plan.ownershipRange },
    },
    currentStepIndex: s.currentStepIndex,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    validating: s.validating,
    outcome: s.outcome,
  };
}

function summarizeAttempts(s: LearningSession): string {
  const passed = s.plan.steps.filter((x) => x.status === "passed").length;
  const total = s.plan.steps.length;
  const attempts = s.plan.steps.reduce((a, x) => a + x.attempts, 0);
  return `${passed}/${total} passed · ${attempts} attempts`;
}

async function stampOwnership(session: LearningSession): Promise<void> {
  const uri = sessionUris.get(session);
  if (!uri) return;
  try {
    markExplained(
      uri,
      session.plan.ownershipRange.startLine,
      session.plan.ownershipRange.endLine
    );
  } catch (err) {
    log(
      "learning",
      `stampOwnership failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function persistLogEntry(session: LearningSession): Promise<void> {
  if (!moduleContext) return;
  const stepsPassed = session.plan.steps.filter(
    (s) => s.status === "passed"
  ).length;
  const totalAttempts = session.plan.steps.reduce((a, s) => a + s.attempts, 0);
  const rawTrace = sessionTraces.get(session) ?? null;
  const trace = rawTrace ? enforceTraceSizeCap(rawTrace) : undefined;
  const entry: LearningSessionLogEntry = {
    id: session.id,
    goal: session.goal,
    path: session.path,
    startedAt: session.startedAt,
    completedAt: session.completedAt ?? Date.now(),
    outcome: session.outcome ?? "abandoned",
    stepsPassed,
    stepsTotal: session.plan.steps.length,
    totalAttempts,
    elapsedMs: (session.completedAt ?? Date.now()) - session.startedAt,
    conceptsTagged: [...session.plan.conceptsTagged],
    trace,
  };
  const existing =
    moduleContext.globalState.get<LearningSessionLogEntry[]>(LOG_KEY) ?? [];
  existing.push(entry);
  // Retention: cap at LOG_CAP summaries total, AND drop the heavy
  // `trace` field from all but the last TRACE_CAP entries. Older
  // sessions keep their summary for analytics but free the trace bytes.
  const trimmed =
    existing.length > LOG_CAP
      ? existing.slice(existing.length - LOG_CAP)
      : existing;
  const traceCutoff = Math.max(0, trimmed.length - TRACE_CAP);
  for (let i = 0; i < traceCutoff; i++) {
    if (trimmed[i].trace) delete trimmed[i].trace;
  }
  await moduleContext.globalState.update(LOG_KEY, trimmed);
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("learning.enabled", true);
}
