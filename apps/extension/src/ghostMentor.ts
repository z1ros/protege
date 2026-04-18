import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  onSuggestionsChanged,
} from "./liveReview.js";
import type { Suggestion } from "./reviewEngine.js";

/**
 * Ghost Mentor — a CodeLens that floats above the cursor line whenever
 * Protege has a high-confidence teachable moment there.
 *
 * Shape (one logical row, three buttons):
 *   💡 <short title> — <short reason>     [Apply fix] [Explain] [Dismiss]
 *
 * Why CodeLens instead of end-of-line ghost text (earlier iteration):
 *   • End-of-line text gets clipped on long lines (disappears off-screen).
 *   • End-of-line text can't carry real, discoverable buttons. Users saw
 *     the hint and said "I still don't know what to do."
 *   • CodeLens renders on its own row above the line — no clipping, two
 *     real buttons, native chrome that feels like it belongs in VS Code.
 *
 * The lens is active only when the user parks the cursor on a teachable
 * line for ≥800ms (same debounce as before — preserves the "flow over
 * noise" rule and avoids stealing Tab from Copilot while the user is
 * typing).
 *
 * Keyboard parity: `Tab` → Apply · `Cmd+.` → Explain · `Esc` → Dismiss.
 * The `protege.ghostActive` context key gates the Tab/Esc keybindings so
 * they never fire unless the lens is actually visible.
 *
 * See Architecture/ambient-coach-plan.md → Surface 2.
 */

// ---- State ----

interface ActiveGhost {
  uri: string;
  line: number;
  suggestion: Suggestion;
}

let active: ActiveGhost | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 800;

// ---- CodeLens provider ----

class GhostLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const g = active;
    if (!g) return [];
    if (g.uri !== doc.uri.toString()) return [];
    if (g.line < 0 || g.line >= doc.lineCount) return [];

    const range = new vscode.Range(g.line, 0, g.line, 0);
    const s = g.suggestion;

    const headlineTitle = buildHeadline(s);
    const lenses: vscode.CodeLens[] = [];

    // Headline — informational, not clickable (we still attach a no-op
    // command so the title renders as a proper lens row).
    lenses.push(
      new vscode.CodeLens(range, {
        title: headlineTitle,
        command: "protege.ghostHeadlineNoop",
      })
    );

    if (s.fix) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(wand) Apply fix",
          tooltip: "Apply the suggested fix · Tab",
          command: "protege.applyGhost",
        })
      );
    }

    lenses.push(
      new vscode.CodeLens(range, {
        title: "$(mortar-board) Explain",
        tooltip: "Open the teaching for this rule · ⌘.",
        command: "protege.explainGhost",
      })
    );

    // Flow-scope findings get a "View N related" button that jumps across
    // files. Block-scope findings without cross-file anchors skip this.
    const anchors = s.anchors ?? [];
    if (anchors.length > 0) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(references) View ${anchors.length} related`,
          tooltip: "Jump through the related locations that make up this flow",
          command: "protege.viewGhostAnchors",
        })
      );
    }

    lenses.push(
      new vscode.CodeLens(range, {
        title: "$(close) Dismiss",
        tooltip: "Hide this ghost · Esc",
        command: "protege.dismissGhost",
      })
    );

    return lenses;
  }
}

let lensProvider: GhostLensProvider | null = null;

// ---- Public API ----

export function registerGhostMentor(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  lensProvider = new GhostLensProvider();

  // Register the CodeLens provider broadly — we gate inside provideCodeLenses.
  disposables.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider)
  );

  // ---- Commands ----

  disposables.push(
    vscode.commands.registerCommand("protege.applyGhost", async () => {
      const g = active;
      if (!g) return;
      hideGhost();

      if (!g.suggestion.fix) {
        // Fall through to Explain if no fix is available.
        await vscode.commands.executeCommand(
          "protege.teachConcept",
          g.suggestion.ruleId
        );
        return;
      }

      await vscode.commands.executeCommand(
        "protege.applyReviewFix",
        JSON.stringify({
          uri: g.uri,
          line: g.suggestion.range.start.line,
          fix: g.suggestion.fix,
        })
      );
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.explainGhost", async () => {
      const g = active;
      if (!g) return;
      hideGhost();
      await vscode.commands.executeCommand(
        "protege.teachConcept",
        g.suggestion.ruleId
      );
    })
  );

  disposables.push(
    vscode.commands.registerCommand("protege.dismissGhost", () => {
      hideGhost();
    })
  );

  // View the cross-file anchors tied to the current ghost. Opens a Quick
  // Pick listing every anchor; picking one jumps the caret to that line.
  // Zero new UI — we reuse VS Code's native picker so users feel at home.
  disposables.push(
    vscode.commands.registerCommand("protege.viewGhostAnchors", async () => {
      const g = active;
      if (!g || !g.suggestion.anchors || g.suggestion.anchors.length === 0) return;

      const items: vscode.QuickPickItem[] = g.suggestion.anchors.map((a) => {
        const uri = vscode.Uri.parse(a.uri);
        return {
          label: `$(arrow-right)  ${shortName(uri)}:${a.line + 1}`,
          description: a.label,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Protege flow — ${g.suggestion.anchors.length} related location${g.suggestion.anchors.length === 1 ? "" : "s"}`,
      });
      if (!picked) return;

      const idx = items.indexOf(picked);
      const anchor = g.suggestion.anchors[idx];
      if (!anchor) return;

      const uri = vscode.Uri.parse(anchor.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });
      const line = Math.max(0, Math.min(doc.lineCount - 1, anchor.line));
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    })
  );

  // No-op for the headline lens. Registered so clicking the title doesn't
  // error out in case a user decides to click it.
  disposables.push(
    vscode.commands.registerCommand("protege.ghostHeadlineNoop", () => {
      /* intentional no-op */
    })
  );

  // ---- Triggers ----

  // Cursor moves → re-evaluate after debounce.
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      scheduleEvaluate(e.textEditor);
    })
  );

  // Typing → evaporate on next keystroke (respect flow). We also re-schedule
  // so that, after an 800ms pause, a fresh ghost can appear if appropriate.
  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || e.document !== editor.document) return;
      if (active) hideGhost();
      scheduleEvaluate(editor);
    })
  );

  // New scan completed → re-evaluate (maybe the current line now has a hit).
  disposables.push(
    onSuggestionsChanged((uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== uri) return;
      scheduleEvaluate(editor);
    })
  );

  // Editor switch → reset and re-evaluate.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      hideGhost();
      if (editor) scheduleEvaluate(editor);
    })
  );

  // Cleanup.
  disposables.push(
    new vscode.Disposable(() => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      active = null;
      setContext(false);
      lensProvider?.refresh();
      lensProvider = null;
    })
  );

  // First paint.
  if (vscode.window.activeTextEditor) {
    scheduleEvaluate(vscode.window.activeTextEditor);
  }

  return disposables;
}

// ---- Scheduling + evaluation ----

function scheduleEvaluate(editor: vscode.TextEditor): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    evaluate(editor);
  }, DEBOUNCE_MS);
}

function evaluate(editor: vscode.TextEditor): void {
  if (vscode.window.activeTextEditor !== editor) return;

  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;
  const s = findSuggestionAtLine(uri, line);

  if (!s) {
    hideGhost();
    return;
  }

  showGhost({ uri, line: s.range.start.line, suggestion: s });
}

// ---- Show / hide ----

function showGhost(next: ActiveGhost): void {
  // No-op if identical ghost is already active (avoids CodeLens churn).
  if (
    active &&
    active.uri === next.uri &&
    active.line === next.line &&
    active.suggestion.ruleId === next.suggestion.ruleId
  ) {
    return;
  }

  active = next;
  setContext(true);
  lensProvider?.refresh();
}

function hideGhost(): void {
  if (!active) return;
  active = null;
  setContext(false);
  lensProvider?.refresh();
}

function setContext(value: boolean): void {
  void vscode.commands.executeCommand(
    "setContext",
    "protege.ghostActive",
    value
  );
}

// ---- Headline formatting ----

function buildHeadline(s: Suggestion): string {
  const MAX = 80;

  const clean = s.ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const prefix =
    s.severity === "warn"
      ? "$(circle-filled)"
      : s.severity === "perf"
      ? "$(zap)"
      : "$(lightbulb)";

  // Scope badge — makes block/flow findings visually distinct from atoms.
  const scopeBadge =
    s.scope === "flow" ? " (flow)" : s.scope === "block" ? " (block)" : "";

  const head = `${prefix}  💡 ${clean}${scopeBadge}`;
  const message = s.message.trim();

  const full = `${head} — ${message}`;
  if (full.length <= MAX) return full;

  const room = Math.max(0, MAX - head.length - 4);
  return `${head} — ${message.slice(0, room)}…`;
}

function shortName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}
