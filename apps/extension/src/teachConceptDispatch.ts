import * as vscode from "vscode";
import { runSingleQuery } from "./chatRunner.js";
import { resolveExplainMode, trimForVoice } from "./explainMode.js";
import { openProtegePanel } from "./panel.js";
import { log } from "./log.js";

/**
 * `protege.teachConcept` dispatcher — routes a "teach me about X" request
 * to the right channel based on `protege.explainMode`:
 *
 *   "text"  → open sidebar, auto-send a full chat request (~150 words).
 *             Bigger reply, full code examples, all reading.
 *   "voice" → fetch a short spoken explanation (35–50 words, TTS-safe),
 *             play it via the existing `voice/playExplain` pipeline.
 *             NO big chat message — voice IS the teaching output.
 *   "both"  → fire both paths in parallel. User hears + reads.
 *
 * The voice path reuses:
 *   - `runSingleQuery(..., { mode: "voice" })` so the backend persona
 *     strips markdown + enforces the voice-style prompt rules.
 *   - `trimForVoice` for a hard word cap in case the model overshoots.
 *   - The webview's `voice/playExplain` handler (same as Ghost Mentor's
 *     Explain button).
 *
 * If no webview is mounted when voice plays, the panel is opened lazily
 * (same pattern as fileOpenGreeter's click handler). Popup preview of a
 * code example is deliberately out of scope — that's a follow-up.
 */

/**
 * Click-dedup window. If the user fires Teach for the same concept twice
 * within this many ms (e.g. accidental double-click, or impatient
 * re-click while waiting for the response), the second + every later
 * click within the window is dropped. Without this, 20 rapid clicks =
 * 20 backend calls + 20 chat messages stacked.
 *
 * Per-concept: clicking Teach for `useState` then for `useMemo` 1 second
 * apart fires both — they're different concepts, both deserve a reply.
 */
const DEDUP_WINDOW_MS = 6_000;
const lastFiredByConcept = new Map<string, number>();

export async function dispatchTeachConcept(
  concept: unknown,
  context: vscode.ExtensionContext
): Promise<void> {
  const conceptName =
    typeof concept === "string" && concept.trim() ? concept.trim() : null;

  // Palette entry with no concept → just open the panel so the user can
  // type their own question. Mirrors the original fallback.
  if (!conceptName) {
    openProtegePanel(context);
    return;
  }

  // Dedup rapid clicks — same concept inside the window = no-op.
  const now = Date.now();
  const lastFired = lastFiredByConcept.get(conceptName);
  if (lastFired && now - lastFired < DEDUP_WINDOW_MS) {
    log(
      "teachConcept",
      `dedup · concept="${conceptName}" · last fired ${now - lastFired}ms ago`
    );
    return;
  }
  lastFiredByConcept.set(conceptName, now);
  // Auto-prune the entry well after the window so the map doesn't grow.
  setTimeout(() => {
    if (lastFiredByConcept.get(conceptName) === now) {
      lastFiredByConcept.delete(conceptName);
    }
  }, DEDUP_WINDOW_MS * 5);

  const mode = resolveExplainMode();
  log("teachConcept", `dispatch · concept="${conceptName}" · mode=${mode}`);

  // Instant feedback so the user knows the click registered. The chat
  // round-trip can take 5–10s; without this the user clicks again,
  // again, again — exactly the multi-click pile-up we just fixed.
  // Status-bar message auto-clears after 6s; if the reply lands sooner,
  // it's overwritten naturally by other status bar activity.
  vscode.window.setStatusBarMessage(
    `$(book) Protege · teaching ${conceptName}…`,
    DEDUP_WINDOW_MS
  );

  const tasks: Promise<unknown>[] = [];

  if (mode === "voice" || mode === "both") {
    tasks.push(playVoiceExplanation(conceptName, context));
  }

  if (mode === "text" || mode === "both") {
    tasks.push(sendChatExplanation(conceptName, context));
  }

  await Promise.allSettled(tasks);
}

async function sendChatExplanation(
  concept: string,
  context: vscode.ExtensionContext
): Promise<void> {
  // Only force the 250ms beat when the panel is COLD (no webview yet).
  // When it's already mounted (the common case after the first Teach
  // click in a session), we broadcast immediately — no artificial wait,
  // no dead-time before the user sees their message land in the chat.
  const { broadcast, mountedWebviewCount } = await import("./webviewHost.js");
  const wasCold = mountedWebviewCount() === 0;
  openProtegePanel(context);
  if (wasCold) {
    await new Promise((r) => setTimeout(r, 250));
  }
  broadcast({
    type: "chat/autoSend",
    message: `Teach me about \`${concept}\` in the context of the file I have open. One paragraph on why it matters, one tiny snippet, and one probing question. Keep it under 150 words.`,
  });
}

async function playVoiceExplanation(
  concept: string,
  context: vscode.ExtensionContext
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const fileName =
    editor?.document.fileName.split(/[\\/]/).pop() ?? "the current file";
  const lang = editor?.document.languageId ?? "code";
  const nearLine = editor
    ? editor.document.lineAt(editor.selection.active.line).text.trim().slice(0, 160)
    : "";

  const prompt = `Briefly teach the concept "${concept}" to the user in the context of their ${lang} code.
File: ${fileName}${nearLine ? `\nLine near their cursor: ${nearLine}` : ""}

Rules:
- 35–50 words, plain spoken English.
- Sentence 1: what the concept is (concrete, not metaphor).
- Sentence 2: one thing to watch for OR a next step they can try.
- NO preamble, NO "let me explain", NO metaphors, NO markdown.
- Will be read aloud by TTS. Contractions are fine.`;

  let raw: string | null = null;
  try {
    raw = await runSingleQuery(prompt, { mode: "voice" });
  } catch (err) {
    log(
      "teachConcept",
      `voice fetch failed · ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!raw) return;

  const trimmed = trimForVoice(raw, 60);
  if (!trimmed) return;

  const { broadcast, mountedWebviewCount } = await import("./webviewHost.js");
  // Open the panel silently if nothing is mounted so the audio pipeline
  // has somewhere to play. In "voice" mode this is the only path that
  // touches the sidebar, and only on the first click per session.
  if (mountedWebviewCount() === 0) {
    openProtegePanel(context);
    await new Promise((r) => setTimeout(r, 350));
  }
  broadcast({ type: "voice/playExplain", text: trimmed });
  log(
    "teachConcept",
    `voice play · concept="${concept}" · ${trimmed.length}ch`
  );
}
