import * as vscode from "vscode";
import type { UnpromptedNudge } from "@protege/types";
import { aiQuery } from "./aiBackend.js";
import { log } from "./log.js";

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
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(circle-large-outline) Stuck here? Hint",
          tooltip: "Get a 2-sentence hint for this error — no sidebar unless you ask",
          command: "protege.struggleChip.hint",
          arguments: [{ key: keyFor(chip.uri, chip.line) }],
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

  const reply = await aiQuery(prompt, 180, { kind: "teach" });
  if (!reply) return null;
  const cleaned = cleanReply(reply);
  if (!cleaned || /^skip\b/i.test(cleaned)) return null;
  chip.cachedHint = cleaned;
  return cleaned;
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

  // Click the chip → fetch hint → show as non-modal InformationMessage
  // with a single "Learn more" action that opens the sidebar IF the user
  // asks. Default path is zero sidebar opens.
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
          vscode.window.showInformationMessage(
            "No hint yet — try again in a sec, or open Protege for deeper help.",
            "Open Protege"
          ).then((choice) => {
            if (choice === "Open Protege") void openPanel();
          });
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          hint,
          "Learn more",
          "Thanks"
        );
        if (choice === "Learn more") {
          await openPanel();
          const { broadcast } = await import("./webviewHost.js");
          // Give the webview a beat to mount, then auto-send a teach
          // request tailored to this exact struggle.
          setTimeout(() => {
            const concept = chip.nudge.context.concept ?? chip.nudge.triggerId;
            broadcast({
              type: "chat/autoSend",
              message:
                `I was stuck near line ${chip.line + 1} of ${chip.nudge.context.filePath ?? "this file"} — ` +
                `the hint you gave was: "${hint}". Teach me more about ${concept}. ` +
                `Keep it under 150 words with a tiny code example if useful.`,
            });
          }, 250);
        }
      }
    )
  );

  // Cleanup on deactivate: cancel any pending expiry timers.
  disposables.push({
    dispose() {
      for (const t of expiryTimers.values()) clearTimeout(t);
      expiryTimers.clear();
      chips.clear();
      lensProvider = null;
    },
  });

  return disposables;
}
