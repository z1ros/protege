import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  getSuggestionsForUri,
  onSuggestionsChanged,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";

/**
 * Ghost Mentor — a CodeLens that floats above the cursor line whenever
 * Protege has a high-confidence teachable moment there.
 *
 * Shape (one logical row, three buttons):
 *   💡 <short title> — <short reason>     [Apply fix] [Explain] [Dismiss]
 *
 * Why CodeLens instead of end-of-line ghost text (earlier iteration):
 *   • End-of-line text gets clipped on long lines (disappears off-screen).
 *   • End-of-line text can't carry real, discoverable buttons. Users saw
 *     the hint and said "I still don't know what to do."
 *   • CodeLens renders on its own row above the line — no clipping, two
 *     real buttons, native chrome that feels like it belongs in VS Code.
 *
 * The lens is active only when the user parks the cursor on a teachable
 * line for ≥800ms (same debounce as before — preserves the "flow over
 * noise" rule and avoids stealing Tab from Copilot while the user is
 * typing).
 *
 * Keyboard parity: `Tab` → Apply · `Cmd+.` → Explain · `Esc` → Dismiss.
 * The `protege.ghostActive` context key gates the Tab/Esc keybindings so
 * they never fire unless the lens is actually visible.
 *
 * See Architecture/ambient-coach-plan.md → Surface 2.
 */

// ---- State ----

interface ActiveGhost {
  uri: string;
  line: number;
  suggestion: Suggestion;
}

let active: ActiveGhost | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

// Dropped from 800ms → 300ms. The longer debounce was a hedge against
// stealing Tab from Copilot while the user is typing — but when the
// cursor MOVES (click, arrow keys) they've stopped typing, so a fast
// reveal is what they want. Typing-triggered debounce still behaves
// because `onDidChangeTextDocument` also calls `hideGhost()` first.
const DEBOUNCE_MS = 300;

// ---- CodeLens provider ----

class GhostLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    // Show a CodeLens row above EVERY finding on the file — not just
    // the cursor-parked one. The user wants the small "💡 Title — Message
    // | Apply fix | Teach | Dismiss" row to be the primary always-visible
    // surface, replacing the inline `← <label>` tag we removed.
    //
    // We still keep the cursor-park `active` ghost concept around for
    // keyboard shortcuts (Tab=Apply, ⌘.=Teach, Esc=Dismiss), but the
    // CodeLens itself no longer hides until the cursor lands on the line.
    const uri = doc.uri.toString();
    const suggestions = getSuggestionsForUri(uri);
    if (suggestions.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const s of suggestions) {
      const line = Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line));
      const range = new vscode.Range(line, 0, line, 0);
      const payload = JSON.stringify({ uri, line: s.range.start.line });

      lenses.push(
        new vscode.CodeLens(range, {
          title: buildHeadline(s),
          command: "protege.ghostHeadlineNoop",
        })
      );

      if (s.fix) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(wand) Apply fix",
            tooltip: "Apply the suggested fix",
            command: "protege.smartFix",
            arguments: [{ uri, line: s.range.start.line }],
          })
        );
      }

      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(book) Teach",
          tooltip: "Open the full lesson — popup + voice",
          command: "protege.openTeachingThread",
          arguments: [{ uri, line: s.range.start.line }],
        })
      );

      const anchors = s.anchors ?? [];
      if (anchors.length > 0) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(references) View ${anchors.length} related`,
            tooltip: "Jump through the related locations",
            command: "protege.viewGhostAnchors",
            arguments: [{ uri, line: s.range.start.line }],
          })
        );
      }

      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(close) Dismiss",
          tooltip: "Hide this finding",
          command: "protege.dismissWhisper",
          arguments: [{ uri, line: s.range.start.line }],
        })
      );

      // Suppress unused-var: keep `payload` reference in case we later
      // need a single-arg JSON encoding for command-URI parity.
      void payload;
    }
    return lenses;
  }
}

let lensProvider: GhostLensProvider | null = null;

// ---- Public API ----

export function registerGhostMentor(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  lensProvider = new GhostLensProvider();

  // Register the CodeLens provider broadly — we gate inside provideCodeLenses.
  disposables.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider)
  );

  // ---- Commands ----

  disposables.push(
    vscode.commands.registerCommand("protege.applyGhost", async () => {
      const g = active;
      if (!g) return;
      hideGhost();
      // Route Apply through smartFix — generates a clean fix via Haiku
      // using the actual surrounding code, not whatever the scan stored.
      await vscode.commands.executeCommand("protege.smartFix", {
        uri: g.uri,
        line: g.suggestion.range.start.line,
      });
    })
  );

  // Ghost Lens "Teach" button — opens the inline thread AND plays voice.
  // Matches the hover's Teach button (one surface label, one behavior).
  // The old `protege.explainGhost` command stays registered below as an
  // alias for back-compat (command-palette users, any stray references).
  disposables.push(
    vscode.commands.registerCommand("protege.ghostTeach", async () => {
      const g = active;
      if (!g) return;
      hideGhost();
      await vscode.commands.executeCommand("protege.openTeachingThread", {
        uri: g.uri,
        line: g.suggestion.range.start.line,
      });
    })
  );

  // Back-compat alias — points at the same handler so anything still
  // firing `protege.explainGhost` keeps working. Will remove once we're
  // sure nothing else references it.
  disposables.push(
    vscode.commands.registerCommand("protege.explainGhost", async () => {
      await vscode.commands.executeCommand("protege.ghostTeach");
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.dismissGhost", () => {
      hideGhost();
    })
  );

  // View the cross-file anchors tied to the current ghost. Opens a Quick
  // Pick listing every anchor; picking one jumps the caret to that line.
  // Zero new UI — we reuse VS Code's native picker so users feel at home.
  disposables.push(
    vscode.commands.registerCommand("protege.viewGhostAnchors", async () => {
      const g = active;
      if (!g || !g.suggestion.anchors || g.suggestion.anchors.length === 0) return;

      const items: vscode.QuickPickItem[] = g.suggestion.anchors.map((a) => {
        const uri = vscode.Uri.parse(a.uri);
        return {
          label: `$(arrow-right)  ${shortName(uri)}:${a.line + 1}`,
          description: a.label,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Protege flow — ${g.suggestion.anchors.length} related location${g.suggestion.anchors.length === 1 ? "" : "s"}`,
      });
      if (!picked) return;

      const idx = items.indexOf(picked);
      const anchor = g.suggestion.anchors[idx];
      if (!anchor) return;

      const uri = vscode.Uri.parse(anchor.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });
      const line = Math.max(0, Math.min(doc.lineCount - 1, anchor.line));
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    })
  );

  // No-op for the headline lens. Registered so clicking the title doesn't
  // error out in case a user decides to click it.
  disposables.push(
    vscode.commands.registerCommand("protege.ghostHeadlineNoop", () => {
      /* intentional no-op */
    })
  );

  // ---- Triggers ----

  // Cursor moves → re-evaluate after debounce.
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      scheduleEvaluate(e.textEditor);
    })
  );

  // Typing → evaporate on next keystroke (respect flow). We also re-schedule
  // so that, after an 800ms pause, a fresh ghost can appear if appropriate.
  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document) return;
      if (active) hideGhost();
      scheduleEvaluate(editor);
    })
  );

  // New scan completed → refresh the CodeLens IMMEDIATELY (don't wait
  // for the 300ms cursor-debounce). The user wants the small top-of-line
  // row to appear instantly when a finding lands. Cursor-park evaluation
  // still goes through scheduleEvaluate to keep typing churn debounced.
  disposables.push(
    onSuggestionsChanged((uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== uri) return;
      lensProvider?.refresh();
      scheduleEvaluate(editor);
    })
  );

  // Editor switch → reset and re-evaluate.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      hideGhost();
      if (editor) scheduleEvaluate(editor);
    })
  );

  // Cleanup.
  disposables.push(
    new vscode.Disposable(() => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      active = null;
      setContext(false);
      lensProvider?.refresh();
      lensProvider = null;
    })
  );

  // First paint.
  if (vscode.window.activeTextEditor) {
    scheduleEvaluate(vscode.window.activeTextEditor);
  }

  return disposables;
}

// ---- Scheduling + evaluation ----

function scheduleEvaluate(editor: vscode.TextEditor): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    evaluate(editor);
  }, DEBOUNCE_MS);
}

function evaluate(editor: vscode.TextEditor): void {
  if (vscode.window.activeTextEditor !== editor) return;

  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;
  const s = findSuggestionAtLine(uri, line);

  if (!s) {
    hideGhost();
    return;
  }

  showGhost({ uri, line: s.range.start.line, suggestion: s });
}

// ---- Show / hide ----

function showGhost(next: ActiveGhost): void {
  // No-op if identical ghost is already active (avoids CodeLens churn).
  if (
    active &&
    active.uri === next.uri &&
    active.line === next.line &&
    active.suggestion.ruleId === next.suggestion.ruleId
  ) {
    return;
  }

  active = next;
  setContext(true);
  lensProvider?.refresh();
}

function hideGhost(): void {
  if (!active) return;
  active = null;
  setContext(false);
  lensProvider?.refresh();
}

function setContext(value: boolean): void {
  void vscode.commands.executeCommand(
    "setContext",
    "protege.ghostActive",
    value
  );
}

// ---- Headline formatting ----

function buildHeadline(s: Suggestion): string {
  const MAX = 90;

  const clean = s.ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // No dot emoji, no "line N" suffix — user said both were noise. The
  // CodeLens already sits visually above the relevant line, so the line
  // number is redundant; the action buttons that follow this title give
  // it identity (no need for an icon).
  const scopeBadge =
    s.scope === "flow" ? " (flow)" : s.scope === "block" ? " (block)" : "";

  const head = `${clean}${scopeBadge}`;
  const message = s.message.trim();

  const full = `${head} — ${message}`;
  if (full.length <= MAX) return full;

  const room = Math.max(0, MAX - head.length - 4);
  return `${head} — ${message.slice(0, room)}…`;
}

function shortName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}

// ---- Voice explanation path ----
//
// When `protege.explainMode` is "voice" or "both", clicking Explain sends
// the concept to the cloud in `voice` chat mode, trims the reply to the
// 8-second budget, and broadcasts `voice/playExplain` to the webview.
// The webview hits /tts and plays the WAV via its persistent AudioContext
// (same pipeline Voice Mode uses).
//
// While the audio plays, we paint a small "🔊 Protege speaking…" chip on
// the ghost line so the user can see what the voice is attached to. The
// chip auto-fades when playback ends (or after a 15s safety cap).

const SPEAKING_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(255,255,255,0.55)",
    contentText: "  🔊 Protege speaking…",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Shown right after the voice clip finishes — a gentle invitation to keep
// the conversation going. Fades after 4s so it never becomes clutter. The
// wake-word path is still future work (plan §11 Stage E); for now the chip
// doubles as discoverability for the 📖 Teach hover button.
const POST_VOICE_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(140, 200, 255, 0.7)",
    contentText: '  🎙 Say "protege" for a follow-up',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Shown when playback failed (TTS 5xx, autoplay block, empty clip). Fades
// after 5s. Previously a failure was silent — the speaking chip just hung
// until the 15s safety timer cleared it, leaving the user confused about
// whether Protege was thinking or broken.
const VOICE_ERROR_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(255, 180, 180, 0.85)",
    contentText: "  ⚠ voice unavailable · check the Protege panel is open",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Pending voice-playback handoff state. Set when runVoiceExplanation
// broadcasts the clip; consumed when the webview reports playbackDone.
// Stored globally because `voice/playbackDone` arrives through webviewHost.ts,
// not as a function return — it's decoupled from the broadcast in time.
interface PendingHandoff {
  editor: vscode.TextEditor;
  range: vscode.Range;
  uri: string;
  // The 15s "webview never reported back" safety timer. Cancelled the
  // moment playbackDone arrives — otherwise the safety could clear the
  // post-voice chip prematurely.
  safetyTimer: ReturnType<typeof setTimeout>;
  // Guard against stale chips sticking on screen if two voice clips fire
  // back-to-back and the second's playbackDone arrives after the first's
  // 4s fade timer is already running.
  fadeTimer: ReturnType<typeof setTimeout> | null;
}
let pendingHandoff: PendingHandoff | null = null;

/**
 * Called from webviewHost.ts when the webview reports that the /tts audio
 * clip finished playing (or errored). Swaps the "speaking…" chip for the
 * post-voice handoff chip, which then fades after 4s.
 *
 * Suppresses the chip when the teaching thread is already open on that
 * file — the user has the written lesson in view, a voice follow-up
 * prompt would just be noise.
 */
export async function onVoicePlaybackDone(reason: "ended" | "error"): Promise<void> {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  if (!handoff) return;

  // Cancel the safety so it doesn't clobber the post-voice chip in 15s.
  clearTimeout(handoff.safetyTimer);

  const { editor, range, uri } = handoff;
  editor.setDecorations(SPEAKING_DECORATION, []);

  if (reason === "error") {
    // Surface a visible "voice failed" chip instead of silently pretending
    // everything worked. Most likely causes: TTS backend not running,
    // autoplay policy block (needs a gesture inside the webview to
    // unlock), or empty /tts response.
    editor.setDecorations(VOICE_ERROR_DECORATION, [{ range }]);
    if (handoff.fadeTimer) clearTimeout(handoff.fadeTimer);
    handoff.fadeTimer = setTimeout(() => {
      editor.setDecorations(VOICE_ERROR_DECORATION, []);
    }, 5_000);
    return;
  }

  try {
    const { hasOpenThread } = await import("./teachingThread.js");
    if (hasOpenThread(uri)) return;
  } catch {
    // If the thread module failed to load for any reason, still show
    // the chip — the chip is the safer default.
  }

  editor.setDecorations(POST_VOICE_DECORATION, [{ range }]);
  if (handoff.fadeTimer) clearTimeout(handoff.fadeTimer);
  handoff.fadeTimer = setTimeout(() => {
    editor.setDecorations(POST_VOICE_DECORATION, []);
  }, 4_000);
}

/**
 * Play a short voice explanation for a suggestion. Exported so other
 * surfaces (the Whisper hover's 🎙 Explain button) can reuse the same
 * pipeline without having to synthesize an "active ghost" first.
 *
 * Safe to call with any suggestion; if voice isn't available the
 * function logs and returns without side effects.
 */
export async function runVoiceExplanation(suggestion: Suggestion): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const editorAtStart = editor;

  const speakingRange = editor && editorAtStart
    ? (() => {
        const line = Math.min(
          editor.document.lineCount - 1,
          suggestion.range.start.line
        );
        const col = editor.document.lineAt(line).text.length;
        return new vscode.Range(line, col, line, col);
      })()
    : undefined;

  if (editorAtStart && speakingRange) {
    editorAtStart.setDecorations(SPEAKING_DECORATION, [{ range: speakingRange }]);
  }

  const safetyTimer = setTimeout(() => {
    if (!editorAtStart) return;
    editorAtStart.setDecorations(SPEAKING_DECORATION, []);
    editorAtStart.setDecorations(POST_VOICE_DECORATION, []);
    editorAtStart.setDecorations(VOICE_ERROR_DECORATION, []);
    // If the webview never reported playbackDone (TTS fetch failed, audio
    // errored silently, panel closed mid-clip), drop the pending handoff
    // so a future voice clip's handoff isn't attached to a stale editor.
    if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
    pendingHandoff = null;
  }, 15_000);

  try {
    const { trimForVoice } = await import("./explainMode.js");
    const { log } = await import("./log.js");
    const { broadcast, mountedWebviewCount } = await import("./webviewHost.js");

    // Audio can only play from a mounted webview. If the Protege panel has
    // never been opened this session, our broadcast would go nowhere —
    // user would click Explain and get silence. Open it first, then wait
    // a beat for the webview to mount and hydrate its message listener.
    if (mountedWebviewCount() === 0) {
      log("voice", `no webview mounted — opening Protege panel first`);
      await vscode.commands.executeCommand("protege.toggle");
      await new Promise((r) => setTimeout(r, 400));
    }

    // Prefer the pre-generated `voiceScript` the scan already produced.
    // The original implementation called Claude AGAIN on every Explain
    // click, which: (a) added a 1–3s latency per click, (b) spent tokens
    // every time, (c) could produce DIFFERENT voice prose than the
    // thread's `lesson` — violating plan anti-feature #3 ("no duplicating
    // the lesson text across surfaces"). When the suggestion carries a
    // model-written script from the initial scan, speak that directly.
    // Claude fallback stays for older suggestions or degraded scans where
    // voiceScript is empty.
    let trimmed: string;
    if (suggestion.voiceScript && suggestion.voiceScript.trim()) {
      trimmed = trimForVoice(suggestion.voiceScript);
      log(
        "voice",
        `explain → using pre-generated voiceScript · ${trimmed.length}ch (no Claude round-trip)`
      );
    } else {
      const { runSingleQuery } = await import("./chatRunner.js");
      const fileHint = editor?.document.fileName.split(/[\\/]/).pop() ?? "the file";
      const lineNum = suggestion.range.start.line + 1;
      const prompt =
        `Explain \`${suggestion.ruleId}\` at ${fileHint}:${lineNum} in 40–55 ` +
        `words of plain spoken English. ` +
        `Context: ${suggestion.message}. ` +
        `Direct and factual. NO metaphors, NO analogies, NO "imagine if", ` +
        `NO "let me explain", NO preamble. Open with what's wrong. Close ` +
        `with the fix. Will be read aloud by TTS.`;

      log("voice", `explain → no voiceScript, querying Claude (voice mode)`);
      const raw = await runSingleQuery(prompt, { mode: "voice" });
      log(
        "voice",
        `explain reply ${raw.length}ch · mountedWebviews=${mountedWebviewCount()}`
      );
      trimmed = trimForVoice(raw);
    }

    if (!trimmed) {
      log("voice", `empty reply — nothing to speak`);
      return;
    }

    // Tell the webview to play it. The webview fetches /tts, plays the
    // WAV via its persistent Audio element (same pipeline as Voice Mode),
    // and posts `voice/playbackDone` back when the clip ends. That fires
    // `onVoicePlaybackDone()` below, which swaps the chip at the REAL
    // moment of playback completion — not a guess based on word count.
    if (editorAtStart && speakingRange) {
      // Clear any prior pending handoff (two voices back-to-back) so the
      // new clip's chip doesn't compete with a stale fade timer.
      if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
      if (pendingHandoff?.safetyTimer) clearTimeout(pendingHandoff.safetyTimer);
      pendingHandoff = {
        editor: editorAtStart,
        range: speakingRange,
        uri: editorAtStart.document.uri.toString(),
        safetyTimer,
        fadeTimer: null,
      };
    }
    log(
      "voice",
      `broadcast voice/playExplain · text=${trimmed.length}ch · mountedWebviews=${mountedWebviewCount()}`
    );
    broadcast({ type: "voice/playExplain", text: trimmed });
    // Success path: DON'T clear the SPEAKING chip here — the webview is
    // about to play the clip, and we want "🔊 Protege speaking…" visible
    // for the full duration. The chip gets cleared by onVoicePlaybackDone
    // (real end-of-playback signal) or the 15s safety timer if the
    // webview never reports back.
    return;
  } catch (err) {
    const { log } = await import("./log.js");
    log(
      "voice",
      `explain FAIL — ${err instanceof Error ? err.message : String(err)}`
    );
    // On failure no audio will play, so clear the chip immediately.
    clearTimeout(safetyTimer);
    if (editorAtStart) editorAtStart.setDecorations(SPEAKING_DECORATION, []);
    if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
    pendingHandoff = null;
  }
}
