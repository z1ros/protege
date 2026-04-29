import * as vscode from "vscode";
import { broadcast } from "../chat/webviewHost.js";

/**
 * "Protege: Explain selection" — explains highlighted code through chat.
 *
 * Previously showed a `vscode.window.showInformationMessage` popup with
 * the AI reply baked in. Users found it disruptive: the dialog blocked
 * the editor, ignored their text/voice mode preference, and stranded the
 * answer outside the conversation history.
 *
 * Now we open the Protege panel and inject the prompt as if the user
 * had typed it. The chat pipeline owns the AI call from there, which
 * means:
 *   - reply lands in the chat tab (visible, scrollable, persisted)
 *   - voice mode plays the reply through the speakers automatically
 *     (the speak path is gated on `protege.explainMode` upstream)
 *   - the "Teach me more" follow-up is just a normal chat turn — no
 *     separate dialog/button plumbing needed.
 */
export async function explainSelection(): Promise<void> {
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
  const truncated = text.length > 500 ? text.slice(0, 497) + "..." : text;

  // Reuse the existing open-panel command so we don't need
  // ExtensionContext threaded through every command file.
  await vscode.commands.executeCommand("protege.openInNewTab");

  const prompt =
    `Explain this ${lang} code in 2-3 sentences — what does it do, why, and any gotchas?\n\n` +
    "```" + lang + "\n" + truncated + "\n```";

  // 300ms matches the delay used by `protege.teachHighlight` — gives
  // the webview's React app time to mount and post `ready` before the
  // chat/autoSend message arrives, otherwise it gets dropped.
  setTimeout(() => {
    broadcast({ type: "chat/autoSend", message: prompt });
  }, 300);
}
