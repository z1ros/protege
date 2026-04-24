import * as vscode from "vscode";
import { aiQuery } from "../ai/aiBackend.js";
import { detectConcepts } from "../concepts/detector.js";

/**
 * "Protege: What does this file do?" — one-shot file summary.
 *
 * Sends the first ~200 lines to Claude with a focused prompt.
 * Shows result as a notification with concept count.
 */
export async function summarizeFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const lang = doc.languageId;
  const lines = doc.getText().split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const concepts = detectConcepts(lang, doc.getText());

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Protege: summarizing file...",
    },
    async () => {
      try {
        const reply = await aiQuery(
          `Summarize this ${lang} file in 3-4 sentences. What does it do, what's its role in the project, and what patterns does it use?\n\n\`\`\`${lang}\n${preview}\n\`\`\``,
          256,
          { kind: "teach" }
        );

        if (!reply) {
          vscode.window.showWarningMessage("Protege: no response from AI backend.");
          return;
        }

        const conceptNote =
          concepts.length > 0
            ? `\n\n📊 ${concepts.length} concepts detected: ${concepts.slice(0, 6).join(", ")}${concepts.length > 6 ? "..." : ""}`
            : "";

        vscode.window.showInformationMessage(
          reply.slice(0, 500) + conceptNote,
          "Open Protege"
        ).then((choice) => {
          if (choice === "Open Protege") {
            vscode.commands.executeCommand("protege.toggle");
          }
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Summary failed: ${msg}`);
      }
    }
  );
}
