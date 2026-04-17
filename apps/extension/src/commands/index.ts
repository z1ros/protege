import * as vscode from "vscode";
import { explainSelection } from "./explainSelection.js";
import { summarizeFile } from "./summarizeFile.js";
import { showWeakSpots } from "./weakSpots.js";
import { quizMe } from "./quizMe.js";

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
  ];
}
