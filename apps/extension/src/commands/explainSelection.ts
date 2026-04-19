import * as vscode from "vscode";
import { aiQuery } from "../aiBackend.js";

/**
 * "Protege: Explain selection" — explains highlighted code inline.
 *
 * If text is selected, explains that. Otherwise explains the current line.
 * Shows result as a hover-style information message with "Teach more" action.
 */
export async function explainSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.selection;
  const text = selection.isEmpty
    ? editor.document.lineAt(selection.active.line).text.trim()
    : editor.document.getText(selection);

  if (!text) {
    vscode.window.showInformationMessage("Select some code first, then try again.");
    return;
  }

  const lang = editor.document.languageId;
  const truncated = text.length > 500 ? text.slice(0, 497) + "..." : text;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Protege: explaining...",
    },
    async () => {
      try {
        const reply = await aiQuery(
          `Explain this ${lang} code in 2-3 sentences. Be concise and practical — what does it do, why, and any gotchas:\n\n\`\`\`${lang}\n${truncated}\n\`\`\``,
          256,
          { kind: "teach" }
        );

        if (!reply) {
          vscode.window.showWarningMessage("Protege: no response from AI backend.");
          return;
        }

        const choice = await vscode.window.showInformationMessage(
          reply.slice(0, 500),
          "Teach me more",
          "OK"
        );

        if (choice === "Teach me more") {
          // Get the first word/symbol for teaching
          const firstWord = text.match(/\b[a-zA-Z_]\w+/)?.[0];
          if (firstWord) {
            vscode.commands.executeCommand("protege.teachConcept", firstWord);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Explain failed: ${msg}`);
      }
    }
  );
}
