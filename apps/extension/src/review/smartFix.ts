import * as vscode from "vscode";
import { findSuggestionAtLine } from "./liveReview.js";
import { log } from "../log.js";

/**
 * Smart Fix — route the "Fix" button through the chat pipeline.
 *
 * Why chat instead of a silent one-shot apply:
 *   - The user can SEE what Claude is doing (read_file, edit_file) as
 *     tool-activity rows in chat. Silent applies made them distrust the
 *     result because nothing explained it.
 *   - Claude gets its full tool belt — not just "return a line", but
 *     "read surrounding imports, update hooks, touch a neighbor file
 *     if needed". Fixes for index-as-key often need an upstream `id`
 *     field, which a one-shot apply can't do.
 *   - One mental model: Fix, Teach, and typing into chat all route
 *     through the same conversation, so history is coherent.
 *
 * Cost: user-triggered only, ~5-20 clicks/day, and Haiku's edit_file tool
 * loop is cached on subsequent rounds. Still cheap relative to margin.
 */

export async function smartFix(args: { uri: string; line: number }): Promise<void> {
  const s = findSuggestionAtLine(args.uri, args.line);
  if (!s) return;

  // Resolve the document to read the current line — the scan may be a
  // few seconds stale. The prompt quotes the ACTUAL line, so Claude
  // operates on what the user sees right now.
  const docUri = vscode.Uri.parse(args.uri);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(docUri);
  } catch (err) {
    log("smartFix", `open doc FAIL — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const targetLine = Math.min(doc.lineCount - 1, s.range.start.line);
  const fileHint = args.uri.split("/").pop() ?? "the file";
  const lineNum = targetLine + 1;

  // Build a windowed view (±8 lines) around the reported line. The scan
  // sometimes mis-anchors by a few lines (e.g. Haiku reports `non-unique-
  // key` at line 16 when the actual `<li key={...}>` is on line 20), so
  // sending JUST the reported line as "current line" can be useless or
  // confusing. The window lets Claude see the real issue near the
  // reported line and pick the right edit target itself. The reported
  // line is marked with `→` so Claude knows what the scan flagged.
  const WINDOW = 8;
  const winStart = Math.max(0, targetLine - WINDOW);
  const winEnd = Math.min(doc.lineCount - 1, targetLine + WINDOW);
  const windowLines: string[] = [];
  for (let i = winStart; i <= winEnd; i++) {
    const n = String(i + 1).padStart(3, " ");
    const marker = i === targetLine ? "→" : " ";
    windowLines.push(`${n}${marker} ${doc.lineAt(i).text}`);
  }
  const windowBlock = windowLines.join("\n");

  // Compose the chat prompt. Claude's tool loop will read more of the
  // file via `read_file` if needed and call `edit_file` to apply the fix.
  // We're explicit that the reported line might be off so Claude trusts
  // the issue more than the line number.
  const message = `Fix this \`${s.ruleId}\` issue near ${fileHint}:${lineNum}.

**Issue:** ${s.message}

**Code around the reported line** (the \`→\` marks what the scan flagged — actual issue may be ±a few lines off):
\`\`\`${doc.languageId}
${windowBlock}
\`\`\`

Locate the real issue in this window, then use \`edit_file\` to apply the fix. Keep the change minimal and explain in one sentence what you changed and why.`;

  log("smartFix", `routing fix via chat · ${fileHint}:${lineNum} · ${s.ruleId}`);

  // Optimistically mark the finding as "fix in progress" BEFORE opening
  // the chat. The CodeLens / underline / inlay all clear instantly so the
  // user sees immediate feedback. The key is suppressed from re-ingestion
  // for 60s — if Claude's edit_file actually resolves the issue the
  // finding stays gone; if it doesn't, the TTL lapses and the next scan
  // re-adds it (honest signal that the fix failed).
  // Also acts as the natural dedup: a second click on the same finding
  // finds nothing in the store (markFixPending removed it) so smartFix
  // returns at the top guard above instead of stacking another chat call.
  const { markFixPending } = await import("./liveReview.js");
  markFixPending(args.uri, args.line);

  // Instant visual confirmation so the user doesn't re-click while
  // Claude is mid-edit. Auto-clears after 8s — chat reply usually lands
  // in that window and naturally overwrites the message.
  vscode.window.setStatusBarMessage(
    `$(wand) Protege · fixing ${s.ruleId}…`,
    8000
  );

  // Open the Protege panel so the chat conversation is visible when the
  // tool calls start firing. The webview is what actually renders the
  // message and streams back the reply; autoSend makes it behave as
  // though the user typed the prompt themselves.
  const { broadcast, mountedWebviewCount } = await import("../chat/webviewHost.js");
  if (mountedWebviewCount() === 0) {
    await vscode.commands.executeCommand("protege.toggle");
    // Give the webview a beat to mount + hydrate its message listener.
    await new Promise((r) => setTimeout(r, 400));
  }
  broadcast({ type: "chat/autoSend", message });
}

export function registerSmartFix(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  disposables.push(
    vscode.commands.registerCommand(
      "protege.smartFix",
      async (args: { uri: string; line: number }) => {
        if (!args || typeof args.line !== "number" || !args.uri) return;
        await smartFix(args);
      }
    )
  );
  return disposables;
}
