import * as vscode from "vscode";
import { explainSelection } from "./explainSelection.js";
import { summarizeFile } from "./summarizeFile.js";
import { showWeakSpots } from "./weakSpots.js";
import { quizMe } from "./quizMe.js";
import { compareCommand, registerCompareProvider } from "./compare.js";
import { fixItCommand } from "./fixIt.js";

/**
 * Register all Protege command palette commands.
 * Each command works without the Protege sidebar being open.
 */
export function registerCommands(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("protege.explainSelection", explainSelection),
    vscode.commands.registerCommand("protege.summarizeFile", summarizeFile),
    vscode.commands.registerCommand("protege.weakSpots", showWeakSpots),
    vscode.commands.registerCommand("protege.quizMe", quizMe),
    // Selection hover bar — three actions surfaced when the user
    // highlights code: Explain, Compare, Fix it.
    // See hints/selectionHover.ts for the popup that dispatches these.
    vscode.commands.registerCommand("protege.compare", compareCommand),
    vscode.commands.registerCommand("protege.fixIt", fixItCommand),
    // Compare needs a TextDocumentContentProvider for its read-only
    // diff scheme. Registered alongside the commands so it's torn down
    // on extension deactivate.
    ...registerCompareProvider(context),
  ];
}
