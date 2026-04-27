import * as vscode from "vscode";
import type { UnpromptedNudge } from "@protege/types";
import { aiQuery } from "../ai/aiBackend.js";
import { log } from "../log.js";

/**
 * Struggle Chip — the in-editor alternative to force-opening the sidebar
 * on every watcher nudge.
 *
 * When the watcher detects user friction (error_persists, struggle_cluster,
 * build_fail_loop, stare_pause, …) we now render a tiny CodeLens chip
 * ABOVE the offending line:
 *
 *     ◎ Stuck here? Hint
 *
 * Clicking it fetches a 2-sentence hint tailored to THIS code + THIS error
 * and shows it as an information notification with a "Learn more" action
 * that — only on explicit request — opens the sidebar for deeper help.
 *
 * The previous behavior (unconditional `openProtegePanel()` from
 * extension.ts:158) is gone. Users keep control of context switches.
 *
 * Chips auto-expire after CHIP_TTL_MS so stale friction signals don't
 * accumulate. Each `uri:line` key holds at most one chip; a fresh nudge
 * on the same line replaces the previous one.
 */

const CHIP_TTL_MS = 60_000;

interface ActiveChip {
  nudge: UnpromptedNudge;
  uri: string;
  line: number;        // 0-based
  createdAt: number;
  cachedHint?: string; // populated after first fetch
}

const chips = new Map<string, ActiveChip>();     // key = `${uri}:${line}`
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

let lensProvider: StruggleLensProvider | null = null;

/** The hover is anchored to a line decoration. We keep one pending hint
 *  per uri so a second click doesn't stack popups on top of each other. */
interface PendingHint {
  uri: vscode.Uri;
  line: number;
  hint: string;
  decoration: vscode.TextEditorDecorationType;
  dismissTimer: ReturnType<typeof setTimeout>;
}
const pendingHints = new Map<string, PendingHint>(); // key = uri.toString()
const HINT_HOVER_TTL_MS = 20_000;

class StruggleLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const docUri = doc.uri.toString();
    const lenses: vscode.CodeLens[] = [];
    for (const chip of chips.values()) {
      if (chip.uri !== docUri) continue;
      const line = Math.max(0, Math.min(doc.lineCount - 1, chip.line));
      const range = new vscode.Range(line, 0, line, 0);
      const args = [{ key: keyFor(chip.uri, chip.line) }];

      // Three-action row matching ghostMentor.ts's vocabulary so the
      // watcher-driven lens reads the same as the scanner-driven one:
      //   ◎ Hint     — quick 2-sentence hover (the old "Stuck here?" path)
      //   ✿ Teach me — opens the sidebar with full context
      //   ✘ Dismiss  — removes the chip without firing the AI call
      // Glyphs: `◎` preserves the hint's unique marker, `✿`/`✘` match
      // ghostMentor. Unicode dingbats, not emoji — render in editor font.
      lenses.push(
        new vscode.CodeLens(range, {
          title: "◎ Hint",
          tooltip: "Get a 2-sentence hint for this error — no sidebar",
          command: "protege.struggleChip.hint",
          arguments: args,
        })
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: "✿ Teach me",
          tooltip: "Open Protege with full context on this struggle",
          command: "protege.struggleChip.teachMe",
          arguments: args,
        })
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: "✘ Dismiss",
          tooltip: "Hide this chip for the rest of the session",
          command: "protege.struggleChip.dismiss",
          arguments: args,
        })
      );
    }
    return lenses;
  }
}

function keyFor(uri: string, line: number): string {
  return `${uri}:${line}`;
}

/**
 * Entry point called from the watcher nudge handler. Adds a chip for the
 * nudge's file + errorLine (if present). No-op if the nudge has no
 * anchor — we can't place a chip without a line. Those fall back to the
 * sidebar via `engage` only if user explicitly asks.
 */
export function showStruggleChip(nudge: UnpromptedNudge): boolean {
  const filePath = nudge.context.filePath;
  const lineOneBased = nudge.context.errorLine;
  if (!filePath || typeof lineOneBased !== "number" || lineOneBased < 1) {
    return false;
  }

  const uri = vscode.Uri.file(filePath).toString();
  const line = Math.max(0, Math.floor(lineOneBased) - 1);
  const key = keyFor(uri, line);

  const chip: ActiveChip = {
    nudge,
    uri,
    line,
    createdAt: Date.now(),
  };
  chips.set(key, chip);

  // Reset expiry.
  const existing = expiryTimers.get(key);
  if (existing) clearTimeout(existing);
  expiryTimers.set(
    key,
    setTimeout(() => dismissChip(key, "expired"), CHIP_TTL_MS)
  );

  lensProvider?.refresh();
  log(
    "struggleChip",
    `show ${nudge.triggerId} · ${filePath}:${lineOneBased}`
  );
  return true;
}

function dismissChip(key: string, reason: string): void {
  if (!chips.delete(key)) return;
  const t = expiryTimers.get(key);
  if (t) {
    clearTimeout(t);
    expiryTimers.delete(key);
  }
  log("struggleChip", `dismiss ${key} · ${reason}`);
  lensProvider?.refresh();
}

async function fetchHint(chip: ActiveChip): Promise<string | null> {
  if (chip.cachedHint) return chip.cachedHint;

  // Read a small window of code around the struggle line so the model
  // can anchor the hint to what the user is actually looking at.
  let codeWindow = "";
  let lang = "plaintext";
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(chip.uri));
    lang = doc.languageId;
    const totalLines = doc.lineCount;
    const start = Math.max(0, chip.line - 5);
    const end = Math.min(totalLines - 1, chip.line + 5);
    const numbered: string[] = [];
    for (let i = start; i <= end; i++) {
      const marker = i === chip.line ? "→" : " ";
      const n = String(i + 1).padStart(3, " ");
      numbered.push(`${n}${marker} ${doc.lineAt(i).text}`);
    }
    codeWindow = numbered.join("\n");
  } catch (err) {
    log("struggleChip", `window read failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  const prompt = `The user is stuck. A watcher signal just fired: ${chip.nudge.triggerId}
(e.g. "error_persists" — error has been on the line for ≥10s;
"struggle_cluster" — user undid 5+ times in 20s;
"build_fail_loop" — 3+ consecutive save errors;
"stare_pause" — 90s idle on an error line).

Line of friction: ${chip.line + 1}
Code around that line (arrow marks the line):
\`\`\`${lang}
${codeWindow}
\`\`\`
${chip.nudge.context.errorMessage ? `Current error: ${chip.nudge.context.errorMessage}` : ""}

Give ONE helpful hint — two sentences max. Specific to THIS code and THIS error.
Sentence 1: the most likely cause in plain English.
Sentence 2: the next concrete thing to try.

NO preamble. NO "Don't worry, this happens." NO metaphors. Start with the noun.
If you genuinely don't know, return SKIP.`;

  const reply = await aiQuery(prompt, 180, { kind: "scan" });
  if (!reply) return null;
  const cleaned = cleanReply(reply);
  if (!cleaned || /^skip\b/i.test(cleaned)) return null;
  chip.cachedHint = cleaned;
  return cleaned;
}

/** Render the hint as an inline hover anchored to `line`. We set a
 *  line decoration with a Markdown hoverMessage, move the cursor to the
 *  line, then ask VS Code to show the hover at the cursor. The user
 *  gets a proper peek-style popup over the code — NOT a bottom-right
 *  toast. Decoration auto-clears after 20s or when the user clicks
 *  "Dismiss" inside the popup. */
async function showHintHover(
  uri: vscode.Uri,
  line: number,
  hint: string
): Promise<void> {
  const uriKey = uri.toString();
  // Drop any prior pending hover for this file — one at a time, no stack.
  clearPendingHint(uriKey);

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    // Can't open the file (deleted, moved) — silently bail.
    return;
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const safeLine = Math.max(0, Math.min(doc.lineCount - 1, line));
  const lineText = doc.lineAt(safeLine).text;
  const range = new vscode.Range(
    safeLine,
    0,
    safeLine,
    Math.max(1, lineText.length)
  );

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(`**Protege hint**\n\n${hint}\n\n`);
  md.appendMarkdown(
    `[Learn more](command:protege.struggleChip.learnMore?${encodeURIComponent(JSON.stringify({ uri: uriKey }))})` +
      " · " +
      `[Dismiss](command:protege.struggleChip.dismissHover?${encodeURIComponent(JSON.stringify({ uri: uriKey }))})`
  );

  // A thin bottom-border decoration marks the anchored line visually so
  // the user knows where the hover came from. The hoverMessage is what
  // actually pops.
  const decoration = vscode.window.createTextEditorDecorationType({
    borderStyle: "solid",
    borderWidth: "0 0 1px 0",
    borderColor: "rgba(120, 180, 255, 0.5)",
    isWholeLine: true,
  });
  editor.setDecorations(decoration, [{ range, hoverMessage: md }]);

  // Move the cursor onto the line and fire the native show-hover
  // command so the popup appears immediately — without this, the user
  // would have to mouse over the line to trigger the hover themselves.
  editor.selection = new vscode.Selection(safeLine, 0, safeLine, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand("editor.action.showHover");

  const dismissTimer = setTimeout(
    () => clearPendingHint(uriKey),
    HINT_HOVER_TTL_MS
  );
  pendingHints.set(uriKey, {
    uri,
    line: safeLine,
    hint,
    decoration,
    dismissTimer,
  });
}

function clearPendingHint(uriKey: string): void {
  const entry = pendingHints.get(uriKey);
  if (!entry) return;
  clearTimeout(entry.dismissTimer);
  entry.decoration.dispose();
  pendingHints.delete(uriKey);
}

function cleanReply(raw: string): string {
  return raw
    .trim()
    .replace(/<followups>[\s\S]*?<\/followups>/gi, "")
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/```$/g, "")
    .replace(/^"(.+)"$/s, "$1")
    .trim();
}

export function registerStruggleChip(
  context: vscode.ExtensionContext,
  openPanel: () => Promise<void> | void
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  lensProvider = new StruggleLensProvider();
  disposables.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider)
  );

  // Click the chip → fetch hint → render an INLINE HOVER at the line
  // instead of a bottom-right toast. The hint appears right where the
  // code is, like a VS Code native hover, with "Learn more" + "Dismiss"
  // as command links the user clicks inside the popup.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.struggleChip.hint",
      async (arg: { key: string } | undefined) => {
        const key = arg?.key;
        const chip = key ? chips.get(key) : undefined;
        if (!chip) return;

        // Dismiss optimistically so multi-click doesn't fire multiple AI
        // calls — we re-show on failure below.
        dismissChip(key!, "clicked");

        const hint = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "Protege: thinking…",
          },
          () => fetchHint(chip)
        );

        if (!hint) {
          // No hint path — keep this one as a tiny toast (no point in a
          // hover with no content). The "Open Protege" button still
          // works the same as before.
          vscode.window
            .showInformationMessage(
              "No hint yet — try again in a sec, or open Protege for deeper help.",
              "Open Protege"
            )
            .then((choice) => {
              if (choice === "Open Protege") void openPanel();
            });
          return;
        }

        await showHintHover(vscode.Uri.parse(chip.uri), chip.line, hint);
      }
    )
  );

  // Dismiss command invoked from the "Dismiss" link inside the hover
  // markdown. Clears the decoration so the hover disappears.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.struggleChip.dismissHover",
      (arg: { uri: string } | undefined) => {
        if (!arg?.uri) return;
        clearPendingHint(arg.uri);
      }
    )
  );

  // Lens-level "Teach me" — skips the hint hover and goes straight to
  // the sidebar with full struggle context. Same personalised prompt as
  // the hover's "Learn more" link, just without the intermediate hint.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.struggleChip.teachMe",
      async (arg: { key: string } | undefined) => {
        const key = arg?.key;
        const chip = key ? chips.get(key) : undefined;
        if (!chip) return;
        dismissChip(key!, "teach-me");
        await openPanel();
        const { broadcast } = await import("../chat/webviewHost.js");
        const fileName =
          chip.nudge.context.filePath?.split("/").pop() ??
          chip.uri.split("/").pop() ??
          "this file";
        const concept = chip.nudge.context.concept ?? chip.nudge.triggerId;
        const errorNote = chip.nudge.context.errorMessage
          ? ` The error on the line is: "${chip.nudge.context.errorMessage}".`
          : "";
        setTimeout(() => {
          broadcast({
            type: "chat/autoSend",
            message:
              `I'm stuck near line ${chip.line + 1} of ${fileName} — watcher trigger: ${chip.nudge.triggerId}.${errorNote} ` +
              `Teach me about ${concept} in plain English, under 150 words with a small example if it helps.`,
          });
        }, 250);
      }
    )
  );

  // Lens-level "Dismiss" — removes the chip without firing any AI call.
  // The chip auto-expires after CHIP_TTL_MS anyway, but explicit dismiss
  // frees the line immediately.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.struggleChip.dismiss",
      (arg: { key: string } | undefined) => {
        const key = arg?.key;
        if (!key || !chips.has(key)) return;
        dismissChip(key, "user-dismissed");
      }
    )
  );

  // "Learn more" → open sidebar + auto-send the teach prompt. Same
  // behaviour as the old toast, just triggered from inside the hover.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.struggleChip.learnMore",
      async (arg: { uri: string } | undefined) => {
        if (!arg?.uri) return;
        const entry = pendingHints.get(arg.uri);
        if (!entry) return;
        const { hint, line } = entry;
        // Find the chip's nudge context to personalise the teach prompt.
        // We don't persist the chip after dismissChip, so re-derive the
        // concept from the hint text + line. Good enough for the ask.
        clearPendingHint(arg.uri);
        await openPanel();
        const { broadcast } = await import("../chat/webviewHost.js");
        setTimeout(() => {
          broadcast({
            type: "chat/autoSend",
            message:
              `I was stuck near line ${line + 1} of ${arg.uri.split("/").pop() ?? "this file"} — ` +
              `the hint you gave was: "${hint}". Teach me more about what's happening here. ` +
              `Keep it under 150 words with a tiny code example if useful.`,
          });
        }, 250);
      }
    )
  );

  // Cleanup on deactivate: cancel any pending expiry timers AND dispose
  // live hover decorations so they don't linger as ghosts on reload.
  disposables.push({
    dispose() {
      for (const t of expiryTimers.values()) clearTimeout(t);
      expiryTimers.clear();
      chips.clear();
      for (const key of [...pendingHints.keys()]) clearPendingHint(key);
      lensProvider = null;
    },
  });

  return disposables;
}
