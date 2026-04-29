import * as vscode from "vscode";
import { broadcast } from "../chat/webviewHost.js";

/**
 * "Protege: Fix it" — selection hover action.
 *
 * The user highlights some code that's broken / awkward / smells off and
 * wants Protege to fix it. We route the request through the chat panel
 * (same pattern as `explainSelection`) so the proposed fix lands in the
 * conversation: it's persisted, scrollable, and naturally follows the
 * user's text/voice mode preference via `protege.explainMode`.
 *
 * Deliberately NOT a one-shot edit: showing the diff in chat lets the
 * user read the explanation, push back, ask "why", or ignore it — much
 * better than silently rewriting code under the cursor.
 */
export async function fixItCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.selection;
  const text = selection.isEmpty
    ? editor.document.lineAt(selection.active.line).text.trim()
    : editor.document.getText(selection);

  if (!text) {
    vscode.window.setStatusBarMessage(
      "Protege: select some code first, then try again.",
      3000
    );
    return;
  }

  const lang = editor.document.languageId;
  const truncated = text.length > 800 ? text.slice(0, 797) + "..." : text;

  await vscode.commands.executeCommand("protege.openInNewTab");

  const prompt =
    `Fix this ${lang} code. Tell me what's wrong in 1-2 sentences, then ` +
    `show the corrected version in a code block:\n\n` +
    "```" + lang + "\n" + truncated + "\n```";

  // 300ms matches the delay used by other chat-routing commands so the
  // webview is mounted before the message arrives.
  setTimeout(() => {
    broadcast({ type: "chat/autoSend", message: prompt });
  }, 300);
}
