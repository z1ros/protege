import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * One-time setup wizard for the Editor Inset proposed API.
 *
 * Protege's inline "custom popup" card renders via VS Code's `editorInsets`
 * proposed API. Proposed APIs are gated — extensions can't self-enable them.
 * Without the flag, we fall back to the sidebar overlay.
 *
 * This wizard runs on activation:
 *  1. Detect if the inset API is live in the current runtime
 *  2. If yes → do nothing
 *  3. If no + we haven't asked before → show a one-time modal
 *  4. If user clicks "Enable" → write the flag into argv.json and prompt reload
 *
 * Supports Cursor (`~/.cursor/argv.json`) and VS Code (`~/.vscode/argv.json`).
 */

const SHOWN_KEY = "protege.insetWizardShown";
const API_PROPOSAL = "editorInsets";
const EXTENSION_ID = "protege.protege";

function isInsetApiAvailable(): boolean {
  const w = vscode.window as unknown as {
    createWebviewTextEditorInset?: unknown;
  };
  return typeof w.createWebviewTextEditorInset === "function";
}

function detectHost(): "cursor" | "vscode" {
  // Cursor's app name contains "Cursor"; VS Code is "Visual Studio Code"
  const name = (vscode.env as { appName?: string }).appName ?? "";
  if (/cursor/i.test(name)) return "cursor";
  return "vscode";
}

function argvPath(): string {
  const home = os.homedir();
  const host = detectHost();
  const dir = host === "cursor" ? ".cursor" : ".vscode";
  return path.join(home, dir, "argv.json");
}

function stripJsonComments(raw: string): string {
  // Conservative: strip // line comments and /* */ block comments.
  // Argv.json is small and Cursor/VS Code tolerate plain JSON.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function parseArgv(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return {};
  }
}

function writeArgvSafely(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.protege.bak`);
    } catch {}
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function ensureFlag(argv: Record<string, unknown>): boolean {
  // Shape: "enable-proposed-api": ["publisher.ext", ...]
  const current = argv["enable-proposed-api"];
  let list: string[] = [];
  if (Array.isArray(current)) {
    list = current.filter((x): x is string => typeof x === "string");
  } else if (typeof current === "string") {
    list = [current];
  }
  if (list.includes(EXTENSION_ID)) return false;
  list.push(EXTENSION_ID);
  argv["enable-proposed-api"] = list;
  return true;
}

export async function runInsetWizard(context: vscode.ExtensionContext): Promise<void> {
  // Already good — proposed API live, nothing to do
  if (isInsetApiAvailable()) return;

  // Only nag once per install
  const shown = context.globalState.get<boolean>(SHOWN_KEY);
  if (shown) return;

  const host = detectHost();
  const answer = await vscode.window.showInformationMessage(
    "Protege can render fully-styled inline cards in the editor. " +
      "Enable this one-time? (Edits your argv.json and restarts the window.)",
    { modal: false },
    "Enable inline cards",
    "Not now"
  );

  await context.globalState.update(SHOWN_KEY, true);

  if (answer !== "Enable inline cards") return;

  const filePath = argvPath();
  let argv: Record<string, unknown> = {};
  try {
    if (fs.existsSync(filePath)) {
      argv = parseArgv(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Protege: couldn't read argv.json (${(err as Error).message}). You can add "enable-proposed-api": ["${EXTENSION_ID}"] manually.`
    );
    return;
  }

  const changed = ensureFlag(argv);

  try {
    writeArgvSafely(filePath, argv);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Protege: couldn't write argv.json (${(err as Error).message}). Please add "enable-proposed-api": ["${EXTENSION_ID}"] manually in ${filePath}.`
    );
    return;
  }

  const hostLabel = host === "cursor" ? "Cursor" : "VS Code";
  if (!changed) {
    vscode.window.showInformationMessage(
      `Protege: flag already set. Restart ${hostLabel} for inline cards to activate.`,
      "Reload window"
    ).then((pick) => {
      if (pick === "Reload window") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
    return;
  }

  vscode.window
    .showInformationMessage(
      `Protege: inline cards enabled. Restart ${hostLabel} to activate them.`,
      "Reload window",
      "Later"
    )
    .then((pick) => {
      if (pick === "Reload window") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
}

/** Command-palette entry so power users can re-run the wizard any time. */
export function registerInsetWizardCommand(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("protege.enableInlineCards", async () => {
    // Reset the "shown" gate so the prompt appears again
    await context.globalState.update(SHOWN_KEY, false);
    await runInsetWizard(context);
  });
}
