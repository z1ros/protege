import * as vscode from "vscode";
import { explainSelection } from "./explainSelection.js";
import { summarizeFile } from "./summarizeFile.js";
import { showWeakSpots } from "./weakSpots.js";
import { quizMe } from "./quizMe.js";
import { whyCommand } from "./why.js";
import { findSimilarCommand } from "./findSimilar.js";
import { traceCommand } from "./trace.js";
import { compareCommand, registerCompareProvider } from "./compare.js";

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
    // Selection hover bar — five actions surfaced when the user
    // highlights code. See hints/selectionHover.ts for the popup that
    // dispatches these commands.
    vscode.commands.registerCommand("protege.why", whyCommand),
    vscode.commands.registerCommand("protege.findSimilar", findSimilarCommand),
    vscode.commands.registerCommand("protege.trace", traceCommand),
    vscode.commands.registerCommand("protege.compare", compareCommand),
    // Compare needs a TextDocumentContentProvider for its read-only
    // diff scheme. Registered alongside the commands so it's torn down
    // on extension deactivate.
    ...registerCompareProvider(context),
  ];
}
