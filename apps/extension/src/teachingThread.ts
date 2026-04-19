import * as vscode from "vscode";
import { findSuggestionAtLine } from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";
import { log } from "./log.js";

/**
 * Teaching Thread — RE-DESIGNED (2026-04-18).
 *
 * Was: a native VS Code Comment Thread that docked a multi-line bubble
 * between code lines with title, paragraph, fix code block, and 4 action
 * buttons. User feedback: "never show this dialog again — it's bad
 * design." The bubble was too heavy, sat above the code, and also
 * registered with the Problems panel which added chrome we didn't want.
 *
 * Is now: a thin coordinator. When "Teach" is clicked we:
 *   1. Park the cursor on the finding line → this triggers the existing
 *      Ghost Lens CodeLens (ghostMentor.ts) which renders a compact
 *      single-row header above the line with Fix / Teach / Dismiss.
 *      That's the small surface the user prefers.
 *   2. Play the voice explanation alongside.
 *
 * No new UI. No Comment Thread. No Problems panel entry. The surface
 * the user liked (top-of-line CodeLens row) is already implemented —
 * we just route Teach at it + add voice.
 */

/**
 * There used to be a live `CommentController` here with open/close
 * lifecycle, grace timers, and per-thread state. All gone — this is
 * now a stub module. Keeping the public `openTeachingThread` /
 * `closeTeachingThread` / `hasOpenThread` names so existing callers
 * don't have to rewire; they just now focus the Ghost Lens + voice
 * instead of opening a panel.
 */

/**
 * "Teach" on a finding — renders the lesson as a multi-line "comment
 * block" decoration inline in the code (see inlineLessonComment.ts),
 * parks the cursor on the line so the Ghost Lens also surfaces, and
 * plays the voice narration. Three surfaces compose naturally:
 *
 *   - the slash-star styled comment overlay shows the full written lesson
 *   - the Ghost Lens above the line carries the action buttons
 *   - voice speaks the narrative
 *
 * No Comment Thread panel. No Problems-panel entry.
 */
export function openTeachingThread(uri: string, line: number): boolean {
  const s = findSuggestionAtLine(uri, line);
  if (!s) {
    log("teachingThread", `teach skip — no suggestion at ${shortUri(uri)}:${line}`);
    return false;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== uri) {
    // Different editor active — open the doc first.
    void (async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const ed = await vscode.window.showTextDocument(doc, { preserveFocus: false });
        parkAndReveal(ed, s.range.start.line);
        void renderSurfaces(uri, s);
      } catch (err) {
        log("teachingThread", `open doc FAIL — ${(err as Error).message}`);
      }
    })();
  } else {
    parkAndReveal(editor, s.range.start.line);
    void renderSurfaces(uri, s);
  }

  log("teachingThread", `teach ${shortUri(uri)}:${line + 1} · ${s.ruleId}`);
  return true;
}

async function renderSurfaces(uri: string, s: Suggestion): Promise<void> {
  // The big inline `/* PROTEGE · ... */` lesson comment was deliberately
  // dropped (2026-04-18) — too much chrome stacked on top of the line.
  // The user's preferred surface for the WRITTEN lesson is the popup
  // hover, which we now show programmatically on Teach. The Ghost Lens
  // CodeLens above the cursor-parked line carries the action buttons,
  // and voice plays the narrative. Three light surfaces, no fat block.

  // Show the hover popup (the rich card with title · line N · teaser
  // · suggested fix · actions). VS Code's `showHover` shows it at the
  // cursor — we already parked the cursor on the finding line above,
  // so the popup anchors there.
  void vscode.commands.executeCommand("editor.action.showHover");

  // Voice narration — fire-and-forget. Hover popup stays open even if
  // voice fails (TTS down, autoplay blocked); voice plays even if the
  // hover renders elsewhere.
  try {
    const { runVoiceExplanation } = await import("./ghostMentor.js");
    void runVoiceExplanation(s);
  } catch (err) {
    log("teachingThread", `voice FAIL — ${(err as Error).message}`);
  }
}

function parkAndReveal(editor: vscode.TextEditor, line: number): void {
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

/**
 * Back-compat stubs — the module used to have open/close lifecycle for
 * a Comment Thread. Callers that still import these just become no-ops
 * now. Left as exports so call sites don't need to change.
 */
export function closeTeachingThread(_uri?: string): void {
  /* no panel to close anymore */
}
export function hasOpenThread(_uri: string): boolean {
  // The post-voice handoff chip uses this to decide whether to show
  // "say protege for follow-up". With no thread, always return false
  // so the chip stays eligible.
  return false;
}

// ---- Registration ----

export function registerTeachingThread(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Primary entry: hover 📖 Teach, ⌘. keybinding, command palette.
  // Now parks cursor + plays voice instead of opening a panel.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.openTeachingThread",
      async (args: { uri?: string; line?: number } | undefined) => {
        const editor = vscode.window.activeTextEditor;
        const uri = args?.uri ?? editor?.document.uri.toString();
        const line =
          typeof args?.line === "number" ? args.line : editor?.selection.active.line;
        if (!uri || typeof line !== "number") return;
        openTeachingThread(uri, line);
      }
    )
  );

  // Back-compat: the old thread-action commands. Kept as thin wrappers
  // so anything still firing them (stale hover HTML, command palette)
  // still works. All route through the existing non-thread handlers.

  disposables.push(
    vscode.commands.registerCommand(
      "protege.threadApplyFix",
      async (args: { uri: string; line: number }) => {
        if (!args) return;
        await vscode.commands.executeCommand("protege.smartFix", {
          uri: args.uri,
          line: args.line,
        });
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.threadReplayVoice",
      async (args: { uri: string; line: number }) => {
        if (!args) return;
        const s = findSuggestionAtLine(args.uri, args.line);
        if (!s) return;
        const { runVoiceExplanation } = await import("./ghostMentor.js");
        void runVoiceExplanation(s);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.threadAsk",
      async (args: { uri: string; line: number }) => {
        if (!args) return;
        const s = findSuggestionAtLine(args.uri, args.line);
        if (!s) return;
        // Open Protege panel + prime voice chat with the lesson.
        const { broadcast, mountedWebviewCount } = await import("./webviewHost.js");
        if (mountedWebviewCount() === 0) {
          await vscode.commands.executeCommand("protege.toggle");
          await new Promise((r) => setTimeout(r, 400));
        }
        const fileHint = args.uri.split("/").pop() ?? "the file";
        const lineNum = s.range.start.line + 1;
        const codeFix = s.fix ? `\nSuggested fix:\n\`\`\`\n${s.fix.trim()}\n\`\`\`\n` : "";
        const message =
          `I just read a teaching note in my editor and want to discuss it out loud.\n\n` +
          `**Rule:** ${s.ruleId} (at ${fileHint}:${lineNum})\n` +
          `**What the note said:** ${s.lesson}\n` +
          codeFix +
          `\nGive me a one-sentence recap in your own words, then ask me one ` +
          `probing question to check I really get it. Keep it conversational — ` +
          `I'm in voice mode.`;
        broadcast({ type: "voice/primeConversation", message });
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand("protege.threadDismiss", () => {
      /* nothing to close anymore — no-op */
    })
  );

  return disposables;
}

function shortUri(uri: string): string {
  const m = uri.match(/[^/]+$/);
  return m ? m[0] : uri;
}
