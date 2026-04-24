import * as vscode from "vscode";
import { detectConcepts } from "../concepts/detector.js";
import { log } from "../log.js";

/**
 * Save-time retrospective recap — the "what I just used" reinforcement
 * signal at a natural break.
 *
 * On every save:
 *  1. Run the existing concept detector on the file.
 *  2. Diff against the last-seen concept set for that URI.
 *  3. If any new concepts appeared, render a 4-second status-bar toast:
 *     "used useMemo · useCallback · clean"
 *
 * Costs zero attention — status bar is peripheral. Zero sidebar opens,
 * zero voice. Purely positive reinforcement at the moment the user
 * hit Ctrl+S. See ~/.claude/plans/learn-in-flow-audit.md Move 2.
 *
 * The first save of a file establishes the baseline — no toast fires
 * until something NEW shows up. That avoids spam when a user opens a
 * mature file and saves it once without changes.
 */

const TOAST_MS = 4_000;
const MAX_CONCEPTS_IN_TOAST = 4;

const SUPPORTED_LANGS = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "go", "rust", "java", "csharp", "cpp", "c", "ruby",
  "php", "swift", "kotlin", "scala", "vue", "svelte",
]);

// Per-URI remembered concept set. Survives within the session only —
// intentional, so the first save after a restart quietly re-baselines
// instead of emitting a giant "used X Y Z …" toast for the whole file.
const seenByUri = new Map<string, Set<string>>();

export function registerSaveRecap(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        handleSave(doc);
      } catch (err) {
        // Never let a toast failure break save — log and move on.
        log(
          "saveRecap",
          `handleSave failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  disposables.push({
    dispose() {
      seenByUri.clear();
    },
  });

  return disposables;
}

function handleSave(doc: vscode.TextDocument): void {
  if (doc.uri.scheme !== "file") return;
  if (!SUPPORTED_LANGS.has(doc.languageId)) return;

  const fileName = doc.fileName.toLowerCase();
  if (fileName.endsWith(".d.ts")) return;
  if (
    fileName.includes(".test.") ||
    fileName.includes(".spec.") ||
    fileName.includes("__fixtures__") ||
    fileName.includes("__mocks__")
  ) {
    return;
  }

  const text = doc.getText();
  if (!text.trim()) return;

  const concepts = detectConcepts(doc.languageId, text);
  const uriKey = doc.uri.toString();
  const prior = seenByUri.get(uriKey);

  // First save of this file in the session → baseline, no toast.
  // Swallowing the first save avoids showing a mega-recap for code
  // that was already written before Protege ever watched it.
  if (!prior) {
    seenByUri.set(uriKey, new Set(concepts));
    log("saveRecap", `baseline ${shortName(doc.uri)} · ${concepts.length} concepts`);
    return;
  }

  const added = concepts.filter((c) => !prior.has(c));
  if (added.length === 0) {
    log("saveRecap", `no new concepts on save · ${shortName(doc.uri)}`);
    return;
  }

  // Update baseline BEFORE rendering the toast so a fast double-save
  // doesn't repeat itself.
  for (const c of added) prior.add(c);

  const message = buildToast(added);
  log(
    "saveRecap",
    `toast ${shortName(doc.uri)} · new=${added.join(",")} · "${message}"`
  );
  vscode.window.setStatusBarMessage(message, TOAST_MS);
}

/**
 * Build the status-bar line from a list of newly-used concepts.
 *
 * ≤ MAX_CONCEPTS_IN_TOAST → render them all
 *  > that → render the first three and append "+N more"
 *
 * The trailing vibe word (clean/tight/solid/crisp) is picked from a
 * small pool; the exact choice is deterministic off the concept names
 * so the same save doesn't change its vibe if re-fired, but different
 * saves naturally rotate vibes as the concept list changes.
 */
function buildToast(added: string[]): string {
  const VIBES = ["clean", "tight", "solid", "crisp", "nice"];
  const take = added.slice(0, MAX_CONCEPTS_IN_TOAST);
  const extra = added.length - take.length;

  // Pick a vibe deterministically from the joined concept names.
  const hash = take.reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const vibe = VIBES[hash % VIBES.length];

  const concepts = take.join(" · ");
  const tail = extra > 0 ? ` · +${extra} more` : "";
  // $(sparkle) matches the existing +N IQ toast shape at extension.ts:131
  // so the two feel like the same ambient family.
  return `$(sparkle) used ${concepts}${tail} — ${vibe}`;
}

function shortName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}
