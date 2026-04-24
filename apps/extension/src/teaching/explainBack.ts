import * as vscode from "vscode";
import * as path from "node:path";
import type {
  ExplainBackGrade,
  ExplainBackRound,
  ExplainBackSession,
} from "@protege/types";
import { aiQuery } from "../ai/aiBackend.js";
import { log } from "../log.js";
import { markExplained } from "../user/ownership.js";

/**
 * Explain-Back (B1) — reverse teaching.
 *
 * Mechanics:
 *   1. User selects code + invokes `protege.explainBack.start`.
 *   2. We capture the selection as a session anchor (code + lang + path).
 *   3. User types their explanation into the panel in the sidebar.
 *   4. On submit, we send (code + explanation + round number) to Haiku
 *      with a strict JSON-out prompt. Returned grade has:
 *         got_right, missed (nullable), follow_up, done.
 *   5. Session accumulates rounds until `done === true` or the user
 *      clicks Stop or hits `maxRounds` (default 4).
 *
 * Only ONE session runs at a time per workspace. Starting a new one
 * replaces the prior one (with a log line so behavior is traceable).
 * State is module-scoped and clears on reload.
 *
 * Voice input is NOT in this MVP — text-only. The same session state
 * works when we wire voice later; the webview is the only thing that
 * changes.
 */

const MAX_ROUNDS = 4;
const GRADING_TOKENS = 280;

type Broadcaster = (msg: {
  type: "explainBack/state";
  state: ExplainBackSession | null;
}) => void;

let active: ExplainBackSession | null = null;
let activeAbort: AbortController | null = null;
let broadcaster: Broadcaster | null = null;
/** Per-session URIs, keyed by the session object itself. Kept out of the
 *  serializable session so the webview `explainBack/state` payload stays
 *  clean, but captured alongside so a grade resolving after a
 *  stop/restart race can still resolve to the correct URI via the
 *  captured reference. Earlier design used a single module-scope
 *  `activeUri` which could be null during the stop→start window. */
const sessionUris = new WeakMap<ExplainBackSession, vscode.Uri>();

export function registerExplainBack(
  _context: vscode.ExtensionContext,
  broadcast: Broadcaster
): vscode.Disposable[] {
  broadcaster = broadcast;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("protege.explainBack.start", async () => {
      await startExplainBack();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.explainBack.stop", async () => {
      await stopExplainBack();
    })
  );

  disposables.push({
    dispose() {
      void stopExplainBack();
    },
  });

  return disposables;
}

/**
 * Kick off a session from the current editor selection. If there's
 * no non-empty selection, show a friendly message and do nothing.
 */
export async function startExplainBack(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Protege: open a file and select some code first."
    );
    return;
  }
  const selection = editor.selection;
  const code = editor.document.getText(selection);
  if (!code.trim()) {
    vscode.window.showInformationMessage(
      "Protege: select some code first — a function, a block, anything you want to explain."
    );
    return;
  }

  // Replace any prior session before starting a new one.
  await stopExplainBack();
  activeAbort = new AbortController();

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const relPath = root
    ? path.relative(root, editor.document.uri.fsPath).split(path.sep).join("/")
    : editor.document.uri.fsPath;

  active = {
    path: relPath,
    code,
    language: editor.document.languageId,
    rounds: [],
    grading: false,
    maxRounds: MAX_ROUNDS,
    startedAt: Date.now(),
    startLine: selection.start.line,
    endLine: selection.end.line,
  };
  sessionUris.set(active, editor.document.uri);
  broadcaster?.({ type: "explainBack/state", state: cloneSession(active) });

  // Pop open the Protege panel so the user SEES the overlay, but ONLY
  // if it's cold. `protege.toggle` genuinely toggles — invoking it on
  // an already-open panel CLOSES it, which was the opposite of what we
  // want here. The mounted-webview count tells us whether opening is
  // actually needed.
  const { mountedWebviewCount } = await import("../chat/webviewHost.js");
  if (mountedWebviewCount() === 0) {
    await vscode.commands.executeCommand("protege.toggle");
  }

  log("explainBack", `start · ${relPath} · ${code.length}ch`);
}

/**
 * Take the user's typed explanation, fire a grading call, and append
 * the round. No-op if no active session.
 */
export async function submitExplanation(explanation: string): Promise<void> {
  if (!active) return;
  const trimmed = explanation.trim();
  if (!trimmed) return;

  const abort = activeAbort;
  // Capture the session reference at the start. If the user stops +
  // restarts during the await below, `active` becomes the NEW session
  // and we don't want to mutate it with the stale grade.
  const capturedSession = active;
  const capturedRound: ExplainBackRound = {
    explanation: trimmed,
    grade: null,
    submittedAt: Date.now(),
  };
  capturedSession.rounds.push(capturedRound);
  capturedSession.grading = true;
  broadcaster?.({
    type: "explainBack/state",
    state: cloneSession(capturedSession),
  });

  let grade: ExplainBackGrade | null = null;
  try {
    grade = await runGrading(capturedSession, trimmed);
  } catch (err) {
    log(
      "explainBack",
      `grading failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // If the session was stopped (or replaced) mid-flight, don't mutate
  // stale state. Identity check catches both: null (stopped) and
  // different-object (replaced by a fresh start).
  if (active !== capturedSession || abort?.signal.aborted) return;

  // Fallback grade if Haiku was unavailable or returned garbage.
  if (!grade) {
    grade = {
      got_right: "You put your explanation in words — that's the hard part.",
      missed: null,
      follow_up: "Try again later — Protege couldn't grade that attempt.",
      done: false,
    };
  }

  capturedRound.grade = grade;
  capturedSession.grading = false;
  broadcaster?.({
    type: "explainBack/state",
    state: cloneSession(capturedSession),
  });
  log(
    "explainBack",
    `round ${capturedSession.rounds.length} · done=${grade.done} · missed=${grade.missed ? "yes" : "no"}`
  );

  // When the session reaches `done`, stamp the selection range as
  // explained in the ownership store so the code promotes from
  // red/yellow → green. Not on every round — half-correct explanations
  // shouldn't raise ownership. We use the URI captured alongside
  // `capturedSession` on start, NOT a module-scope `activeUri`, so a
  // stop/restart race during grading can't null the reference.
  const capturedUri = sessionUris.get(capturedSession);
  if (
    grade.done &&
    capturedUri &&
    typeof capturedSession.startLine === "number" &&
    typeof capturedSession.endLine === "number"
  ) {
    try {
      markExplained(
        capturedUri,
        capturedSession.startLine,
        capturedSession.endLine
      );
    } catch (err) {
      log(
        "explainBack",
        `markExplained failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export async function stopExplainBack(): Promise<void> {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (active) {
    log("explainBack", `stop · rounds=${active.rounds.length}`);
  }
  // sessionUris is a WeakMap — the old `active` reference becoming
  // unreachable means its entry is GC'd automatically. No manual delete
  // needed (and deletes wouldn't help the captured-reference path
  // anyway, which is the whole point of the WeakMap).
  active = null;
  broadcaster?.({ type: "explainBack/state", state: null });
}

export function getCurrentExplainBack(): ExplainBackSession | null {
  return active ? cloneSession(active) : null;
}

// ---- Grading call ----

async function runGrading(
  session: ExplainBackSession,
  explanation: string
): Promise<ExplainBackGrade | null> {
  const roundNum = session.rounds.length;
  const totalCap = session.maxRounds;

  const prompt = `You are evaluating a developer's OWN explanation of code they've selected. They're building articulation muscle — the real test of whether they understand the code is whether they can put it in words.

Round ${roundNum} of up to ${totalCap}.

Return ONLY a JSON object, no prose, no markdown fences:
{
  "got_right": "one sentence on what their explanation nailed (be specific, reference their words)",
  "missed": "one specific thing they missed — the MOST important gap — or null when the explanation is solid",
  "follow_up": "a pointed follow-up question that probes the gap, OR a harder adjacent question when they got it",
  "done": true | false
}

Rules:
 - Respectful peer, not quiz-master. Build confidence while being honest.
 - "got_right" should reference something specific they said — not generic praise.
 - "missed" is ONE thing, the most important. Never a list.
 - "follow_up" is never "does that make sense?" — always a concrete question about the code or its behavior.
 - "done": true only when their explanation covers the essential behavior AND any obvious edge case. Otherwise false.
 - If round ${totalCap} and still not done: set done = true, be gentle, don't leave them hanging.
 - Each string under 40 words.

Code (${session.language}, from ${session.path}):
\`\`\`${session.language}
${session.code}
\`\`\`

Their explanation:
"${explanation}"

Return ONLY the JSON object.`;

  const raw = await aiQuery(prompt, GRADING_TOKENS, { kind: "teach" });
  if (!raw) return null;
  return parseGrade(raw);
}

function parseGrade(raw: string): ExplainBackGrade | null {
  // Strip markdown fences / followups pollution then find the first
  // balanced {...} and JSON.parse it. Falls back to null if the shape
  // doesn't match — caller uses the "couldn't grade" fallback.
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
  // Try the largest candidate first.
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Partial<ExplainBackGrade>;
      if (
        typeof parsed.got_right === "string" &&
        typeof parsed.follow_up === "string" &&
        typeof parsed.done === "boolean"
      ) {
        return {
          got_right: parsed.got_right,
          missed: typeof parsed.missed === "string" ? parsed.missed : null,
          follow_up: parsed.follow_up,
          done: parsed.done,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function cloneSession(s: ExplainBackSession): ExplainBackSession {
  return {
    path: s.path,
    code: s.code,
    language: s.language,
    rounds: s.rounds.map((r) => ({ ...r, grade: r.grade ? { ...r.grade } : null })),
    grading: s.grading,
    maxRounds: s.maxRounds,
    startedAt: s.startedAt,
    startLine: s.startLine,
    endLine: s.endLine,
  };
}
