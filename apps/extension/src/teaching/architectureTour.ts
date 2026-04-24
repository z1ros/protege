import * as vscode from "vscode";
import * as path from "node:path";
import type { TourState, TourStep } from "@protege/types";
import { collectProjectMap } from "../workspace/projectMap.js";
import { aiQuery } from "../ai/aiBackend.js";
import { log } from "../log.js";

/**
 * Architecture Tour (A2) — a guided 5-stop walk through the codebase.
 *
 * Mechanics:
 *   1. Picker — deterministic. Uses Project Map data (entry points +
 *      hot files) to order 5 files into a tour. No AI for picking.
 *   2. Narration — one Haiku call per stop, fired in parallel so the
 *      first narration is usually ready by the time the user starts
 *      reading step 1. Each prompt knows about the previous + next
 *      stop so the narrations connect as a tour, not 5 independent
 *      summaries.
 *   3. Playback — opens the file, scrolls to a focal line (first
 *      export-ish signature, else line 0), highlights a 3-line
 *      window. Session strip in the webview shows progress.
 *   4. Navigation — user clicks "Next" (webview button) or runs
 *      `protege.tour.next`. Walking off the end ends the tour.
 *
 * Architecture notes:
 *   - State lives here at module scope. One tour per workspace session.
 *     If user starts a new tour mid-flight, the old one's timers are
 *     disposed.
 *   - The `tour/state` message is the single source of truth for the
 *     webview's session strip. Every mutation (start / advance / stop
 *     / narration-landed) broadcasts a fresh state.
 */

const MAX_STOPS = 5;
const NARRATION_TOKENS = 220;
const FOCUS_HIGHLIGHT_LINES = 3;

// Regexes that reveal "the most interesting line" in a file — used to
// decide where to scroll + highlight when the stop first opens.
const EXPORT_SIGS = [
  /^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)/,
  /^\s*export\s+(?:async\s+)?function\s+(\w+)/,
  /^\s*export\s+class\s+(\w+)/,
  /^\s*export\s+const\s+(\w+)\s*=/,
  /^\s*export\s+default\s+class\s+(\w+)/,
  /^\s*export\s+default\s+/, // fallback — default export of anything
  /^\s*def\s+(\w+)\s*\(/, // python top-level def
  /^\s*class\s+(\w+)[:(]/, // python class
  /^\s*func\s+(\w+)\s*\(/, // go func
];

// ---- Module state ----

let active: TourState | null = null;
let activeAbort: AbortController | null = null;
const highlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(120, 180, 255, 0.08)",
  borderRadius: "2px",
  isWholeLine: true,
});
let activeHighlight: { editor: vscode.TextEditor; range: vscode.Range } | null =
  null;

// Caller passes this so we can post state to the active webviews without
// importing webviewHost here (avoids a cycle).
type Broadcaster = (msg: {
  type: "tour/state" | "tour/narrationReady";
  state?: TourState | null;
  index?: number;
  narration?: string;
}) => void;

let broadcaster: Broadcaster | null = null;

// ---- Public API ----

export function registerArchitectureTour(
  _context: vscode.ExtensionContext,
  broadcast: Broadcaster
): vscode.Disposable[] {
  broadcaster = broadcast;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("protege.tour.next", async () => {
      await advanceTour();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.tour.stop", async () => {
      await stopTour();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.tour.startCodebase", async () => {
      await startTour("codebase");
    })
  );

  disposables.push({
    dispose() {
      void stopTour();
      highlightDecoration.dispose();
    },
  });

  return disposables;
}

/** Kick off a new tour. Replaces any active tour. */
export async function startTour(intent: "codebase"): Promise<void> {
  await stopTour();
  const abort = new AbortController();
  activeAbort = abort;

  const map = await collectProjectMap();
  if (!map.root || map.files.length === 0) {
    broadcaster?.({ type: "tour/state", state: null });
    vscode.window.showInformationMessage(
      "Protege: couldn't tour this workspace — no source files detected."
    );
    return;
  }
  if (abort.signal.aborted) return;

  // ---- Pick the stops ----
  const picks = pickCodebaseStops(map);
  if (picks.length === 0) {
    broadcaster?.({ type: "tour/state", state: null });
    vscode.window.showInformationMessage(
      "Protege: not enough code to tour — add some source files first."
    );
    return;
  }

  // ---- Resolve focal line per stop ----
  const steps: TourStep[] = [];
  for (const relPath of picks) {
    const focus = await resolveFocus(map.root, relPath);
    steps.push({
      path: relPath,
      focusLine: focus.line,
      focusLabel: focus.label,
      narration: null,
    });
  }
  if (abort.signal.aborted) return;

  active = {
    intent,
    steps,
    currentIndex: 0,
    startedAt: Date.now(),
  };
  broadcaster?.({ type: "tour/state", state: cloneState(active) });

  // Open stop 0 immediately — don't wait for narration.
  await revealStep(map.root, steps[0]!);

  // Fetch all narrations in parallel. First one usually lands before
  // the user has finished reading the file open, so it feels instant.
  void fetchAllNarrations(map.root, steps, abort);
  log("tour", `start codebase · ${picks.length} stops`);
}

/** Advance to the next stop, or end the tour if we were on the last one. */
export async function advanceTour(): Promise<void> {
  if (!active) return;
  const next = active.currentIndex + 1;
  if (next >= active.steps.length) {
    log("tour", `complete · ${active.steps.length} stops`);
    await stopTour();
    vscode.window.showInformationMessage(
      "Protege: tour complete. Want another one?"
    );
    return;
  }
  active.currentIndex = next;
  broadcaster?.({ type: "tour/state", state: cloneState(active) });
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  await revealStep(root, active.steps[next]!);
}

/** Cancel whatever tour is active. Idempotent. */
export async function stopTour(): Promise<void> {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (activeHighlight) {
    try {
      activeHighlight.editor.setDecorations(highlightDecoration, []);
    } catch {
      // editor may have closed; ignore
    }
    activeHighlight = null;
  }
  if (active) {
    log("tour", `stop · was on ${active.currentIndex + 1}/${active.steps.length}`);
  }
  active = null;
  broadcaster?.({ type: "tour/state", state: null });
}

/** Host-side accessor so webview-host can send current state on `ready`. */
export function getCurrentTour(): TourState | null {
  return active ? cloneState(active) : null;
}

// ---- Internals ----

/**
 * Pick the codebase tour stops from the Project Map.
 *
 * Strategy (deterministic, no AI):
 *   1. Up to 2 entry points (if any).
 *   2. Fill with hot files by edit count, skipping files already picked.
 *   3. Cap at MAX_STOPS.
 *   4. De-dupe; preserve order.
 */
function pickCodebaseStops(
  map: Awaited<ReturnType<typeof collectProjectMap>>
): string[] {
  const picks: string[] = [];
  const seen = new Set<string>();
  const take = (p: string) => {
    if (picks.length >= MAX_STOPS) return;
    if (seen.has(p)) return;
    seen.add(p);
    picks.push(p);
  };

  for (const f of map.entryPoints.slice(0, 2)) take(f.path);
  for (const f of map.hotFiles) take(f.path);
  // Fallback: if neither entry points nor hot files existed (fresh repo,
  // no git), just take the first few files in the tree.
  if (picks.length === 0) {
    for (const f of map.files.slice(0, MAX_STOPS)) take(f.path);
  }
  return picks;
}

/**
 * Find the most interesting line to scroll to for a file — a default
 * export's signature, a top-level function, etc. Falls back to the
 * first non-blank line after the imports.
 */
async function resolveFocus(
  root: string,
  relPath: string
): Promise<{ line: number; label: string }> {
  const abs = path.join(root, relPath);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const lines = doc.getText().split("\n");
    for (let i = 0; i < Math.min(lines.length, 250); i++) {
      const line = lines[i]!;
      for (const re of EXPORT_SIGS) {
        const m = line.match(re);
        if (m) {
          const name = m[1] ?? "default export";
          return { line: i, label: name };
        }
      }
    }
    // Fallback — first non-blank non-import line.
    for (let i = 0; i < Math.min(lines.length, 80); i++) {
      const t = lines[i]!.trim();
      if (!t) continue;
      if (/^(import|from|require|#include)\b/.test(t)) continue;
      return { line: i, label: "" };
    }
    return { line: 0, label: "" };
  } catch {
    return { line: 0, label: "" };
  }
}

/** Open the file, scroll to the focus line, and paint the highlight. */
async function revealStep(root: string, step: TourStep): Promise<void> {
  try {
    if (activeHighlight) {
      try {
        activeHighlight.editor.setDecorations(highlightDecoration, []);
      } catch {}
      activeHighlight = null;
    }
    const abs = path.join(root, step.path);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const startLine = Math.max(0, Math.min(doc.lineCount - 1, step.focusLine));
    const endLine = Math.min(doc.lineCount - 1, startLine + FOCUS_HIGHLIGHT_LINES);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, 0)
    );
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.setDecorations(highlightDecoration, [range]);
    activeHighlight = { editor, range };
  } catch (err) {
    log(
      "tour",
      `revealStep fail · ${step.path} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Fire one Haiku call per stop, in parallel. Update tour state + push
 * a narrationReady broadcast as each lands. Guards against the tour
 * being stopped mid-fetch via the passed AbortController.
 */
async function fetchAllNarrations(
  root: string,
  steps: TourStep[],
  abort: AbortController
): Promise<void> {
  const texts = await Promise.all(
    steps.map((s) => readFilePreview(root, s.path))
  );
  if (abort.signal.aborted) return;

  await Promise.all(
    steps.map(async (step, idx) => {
      const prev = idx > 0 ? steps[idx - 1]!.path : null;
      const next = idx < steps.length - 1 ? steps[idx + 1]!.path : null;
      const text = texts[idx] ?? "";
      const prompt = buildNarrationPrompt({
        step,
        stepNumber: idx + 1,
        totalSteps: steps.length,
        prevPath: prev,
        nextPath: next,
        lang: extOf(step.path),
        content: text,
      });
      const narration = await aiQuery(prompt, NARRATION_TOKENS, {
        kind: "teach",
      });
      if (abort.signal.aborted) return;
      const cleaned = cleanNarration(narration ?? "") || fallbackNarration(step);
      // Mutate in place AND push a partial update so the webview can
      // light up each step as it lands, not just when all 5 finish.
      step.narration = cleaned;
      if (active && active.steps === steps) {
        broadcaster?.({
          type: "tour/narrationReady",
          index: idx,
          narration: cleaned,
        });
      }
    })
  );
}

async function readFilePreview(root: string, relPath: string): Promise<string> {
  try {
    const abs = path.join(root, relPath);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const lines = doc.getText().split("\n");
    return lines.slice(0, 150).join("\n");
  } catch {
    return "";
  }
}

function buildNarrationPrompt(opts: {
  step: TourStep;
  stepNumber: number;
  totalSteps: number;
  prevPath: string | null;
  nextPath: string | null;
  lang: string;
  content: string;
}): string {
  const { step, stepNumber, totalSteps, prevPath, nextPath, lang, content } =
    opts;
  const prevLine = prevPath ? `Previous stop: ${prevPath}` : "First stop.";
  const nextLine = nextPath ? `Next stop: ${nextPath}` : "Last stop.";
  const focus = step.focusLabel
    ? `Focal symbol: ${step.focusLabel} (line ${step.focusLine + 1})`
    : "";

  return `You're a guide walking a developer through an unfamiliar codebase. This is stop ${stepNumber} of ${totalSteps}.

Tour context: guided tour of this codebase.
Current stop: ${step.path}
${prevLine}
${nextLine}
${focus}

File content (first 150 lines):
\`\`\`${lang}
${content}
\`\`\`

Narrate this stop for a developer who's reading + listening:
 - 2–3 sentences, under 50 words total.
 - Sentence 1: what this file DOES in the project (concrete, not "this is a TypeScript file").
 - Sentence 2: the key export / function / class worth pointing at.
 - Sentence 3 (optional): how it connects to the previous or next stop.

No preamble. No "This file...". Plain English, contractions OK. Read-aloud style, no markdown, no code blocks.`;
}

function cleanNarration(raw: string): string {
  return raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/```$/g, "")
    .replace(/^"(.+)"$/s, "$1")
    .trim();
}

function fallbackNarration(step: TourStep): string {
  const base = step.path.split("/").pop() ?? step.path;
  if (step.focusLabel) {
    return `${base} — starts around ${step.focusLabel}. Open it to explore.`;
  }
  return `${base} — worth a look as part of this tour.`;
}

function extOf(relPath: string): string {
  const ext = path.extname(relPath).slice(1);
  return ext || "txt";
}

function cloneState(s: TourState): TourState {
  return {
    intent: s.intent,
    steps: s.steps.map((step) => ({ ...step })),
    currentIndex: s.currentIndex,
    startedAt: s.startedAt,
  };
}
