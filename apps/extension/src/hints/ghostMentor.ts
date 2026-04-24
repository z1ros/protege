import * as vscode from "vscode";
import {
  findSuggestionAtLine,
  getSuggestionsForUri,
  onSuggestionsChanged,
} from "../review/liveReview.js";
import type { Suggestion } from "../review/reviewEngine.js";
import {
  hasNativeDiagnosticInRange,
  hasNativeDiagnosticOnLine,
} from "../review/nativeDiagnostics.js";
import {
  shouldSuppress as gateShouldSuppress,
  onGateChanged,
} from "../review/findingGate.js";

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

/** Short-lived decoration that carries the peek-hover markdown when the
 *  user clicks the finding headline in the CodeLens row. One at a time —
 *  disposed before the next click renders or after PEEK_TTL_MS. */
interface PendingPeek {
  decoration: vscode.TextEditorDecorationType;
  expireTimer: ReturnType<typeof setTimeout>;
}
let pendingPeek: PendingPeek | null = null;
const PEEK_TTL_MS = 30_000;

function clearPendingPeek(): void {
  if (!pendingPeek) return;
  try {
    clearTimeout(pendingPeek.expireTimer);
  } catch {
    /* ignore */
  }
  try {
    pendingPeek.decoration.dispose();
  } catch {
    /* ignore */
  }
  pendingPeek = null;
}

// Dropped from 800ms → 300ms. The longer debounce was a hedge against
// stealing Tab from Copilot while the user is typing — but when the
// cursor MOVES (click, arrow keys) they've stopped typing, so a fast
// reveal is what they want. Typing-triggered debounce still behaves
// because `onDidChangeTextDocument` also calls `hideGhost()` first.
const DEBOUNCE_MS = 300;

// ---- CodeLens provider ----

class GhostLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    // Show a CodeLens row above EVERY finding on the file — not just
    // the cursor-parked one. The user wants the small "💡 Title — Message
    // | Apply fix | Teach | Dismiss" row to be the primary always-visible
    // surface, replacing the inline `← <label>` tag we removed.
    //
    // We still keep the cursor-park `active` ghost concept around for
    // keyboard shortcuts (Tab=Apply, ⌘.=Teach, Esc=Dismiss), but the
    // CodeLens itself no longer hides until the cursor lands on the line.
    const uri = doc.uri.toString();
    const allSuggestions = getSuggestionsForUri(uri);
    if (allSuggestions.length === 0) {
      // No findings anywhere in this file — clear any lingering
      // line-wash from a previous scan.
      renderedLinesPerUri.set(uri, new Set());
      queueMicrotask(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === uri) {
          paintFindingLines(editor, new Set());
        }
      });
      return [];
    }

    // Two-stage filter:
    //   1) Dedup against native diagnostics — if TS / ESLint / cSpell /
    //      Cursor agent already squiggled this range, skip.
    //   2) Finding-gate (A1 + B1) — skip if the line was edited in the
    //      last 45s, the user's cursor is within ±2 lines, or the same
    //      ruleId was shown on this URI in the last 5 min.
    const uriKey = uri;
    const filtered = allSuggestions.filter((s) => {
      const rangeHasNative =
        s.scope === "block" || s.scope === "flow"
          ? hasNativeDiagnosticInRange(doc.uri, s.range)
          : hasNativeDiagnosticOnLine(doc.uri, s.range.start.line);
      if (rangeHasNative) return false;
      if (gateShouldSuppress(uriKey, s)) return false;
      return true;
    });
    if (filtered.length === 0) {
      // All findings suppressed by the gate — clear the line-wash so
      // stale highlights don't linger after a cursor-proximity bump.
      renderedLinesPerUri.set(uri, new Set());
      queueMicrotask(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === uri) {
          paintFindingLines(editor, new Set());
        }
      });
      return [];
    }

    // B1 cooldown is armed at ingestion (liveReview.runReview and
    // ingestFindings) per spec — not at render time. Ghost doesn't
    // note findings itself because that would miss the SAVE/IDLE
    // tiers and double-cover the LIVE tier.

    // Cap to ONE finding per line. Multiple CodeLenses on the same line
    // are rendered horizontally by VS Code, which stretches the row off
    // screen. If two findings compete for the same line, keep the
    // highest-priority one (warn > perf > info; then kind watch-out >
    // concept > praise). Dismiss on the shown one lets the next
    // suggestion for that line pop to the top on re-render.
    const SEV_WEIGHT = { warn: 0, perf: 1, info: 2 } as const;
    const KIND_WEIGHT = { "watch-out": 0, concept: 1, praise: 2 } as const;
    const topByLine = new Map<number, typeof allSuggestions[number]>();
    for (const s of allSuggestions) {
      const ln = Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line));
      const prev = topByLine.get(ln);
      if (!prev) {
        topByLine.set(ln, s);
        continue;
      }
      const prevScore =
        SEV_WEIGHT[prev.severity] * 10 +
        (KIND_WEIGHT[prev.kind as keyof typeof KIND_WEIGHT] ?? 1);
      const nextScore =
        SEV_WEIGHT[s.severity] * 10 +
        (KIND_WEIGHT[s.kind as keyof typeof KIND_WEIGHT] ?? 1);
      if (nextScore < prevScore) topByLine.set(ln, s);
    }
    const suggestions = [...topByLine.values()];

    // Stash the set of lines that survived the filter so the line-wash
    // decoration can paint them. We record here (inside provideCodeLenses)
    // rather than re-running the filter in a separate listener, keeping
    // the "what gets a lens" and "what gets highlighted" logic exactly
    // in sync. Repaint fires on the next tick to avoid mutating
    // decorations inside the CodeLens provider callback.
    const lineSet = new Set<number>();
    for (const s of suggestions) {
      lineSet.add(
        Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line))
      );
    }
    renderedLinesPerUri.set(uri, lineSet);
    queueMicrotask(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === uri) {
        paintFindingLines(editor, lineSet);
      }
    });

    const lenses: vscode.CodeLens[] = [];
    for (const s of suggestions) {
      const line = Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line));
      const range = new vscode.Range(line, 0, line, 0);
      const payload = JSON.stringify({ uri, line: s.range.start.line });

      lenses.push(
        new vscode.CodeLens(range, {
          title: buildHeadline(s),
          tooltip: "Peek the finding — opens the hover card",
          command: "protege.ghostHeadlinePeek",
          arguments: [{ uri, line: s.range.start.line }],
        })
      );

      // Action labels carry small unicode glyphs as visual leaders
      // (NOT emoji): ✔ check (U+2714), 𖤍 cherokee letter MV (U+16B8D),
      // ✔ heavy check (U+2714), ✿ black florette (U+273F),
      // ✘ heavy ballot X (U+2718). User explicitly chose these — they
      // render as text dingbats in VS Code's editor font, no emoji-style
      // colored fallback. Consistent brand vocabulary: Apply / Teach /
      // Dismiss keep the same three marks everywhere they appear.
      if (s.fix) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "✔ Apply fix",
            tooltip: "Replace this line with Protege's fix",
            command: "protege.smartFix",
            arguments: [{ uri, line: s.range.start.line }],
          })
        );
      }

      lenses.push(
        new vscode.CodeLens(range, {
          title: "✿ Teach me",
          tooltip: "Open the full lesson — popup + voice",
          command: "protege.openTeachingThread",
          arguments: [{ uri, line: s.range.start.line }],
        })
      );

      lenses.push(
        new vscode.CodeLens(range, {
          title: "✘ Dismiss",
          tooltip: "Hide this finding for the rest of the session",
          command: "protege.dismissWhisper",
          arguments: [{ uri, line: s.range.start.line }],
        })
      );

      // Suppress unused-var: keep `payload` reference in case we later
      // need a single-arg JSON encoding for command-URI parity.
      void payload;
    }
    return lenses;
  }
}

let lensProvider: GhostLensProvider | null = null;

/** Subtle line-background decoration that paints the CODE LINE a
 *  finding's CodeLens sits above. The lens itself tells the user
 *  "here's a teachable moment", but without a line wash the user has
 *  to visually connect the lens to the line beneath it — which on a
 *  dense function is easy to miss. The wash draws the eye down.
 *
 *  Style is intentionally quieter than the error-line highlight (6%
 *  white → 4% white) since Protege findings are advisory, not errors
 *  the user MUST fix. Same decoration is applied to every filtered
 *  finding's start line, deduped so stacked findings on one line
 *  don't double-shade. */
let findingLineDecoration: vscode.TextEditorDecorationType | null = null;

/** Cache of the last filtered line set we rendered per-uri. Used to
 *  repaint the active editor without recomputing the filter when the
 *  editor changes (user tabs between files). Keyed by `uri.toString()`. */
const renderedLinesPerUri = new Map<string, Set<number>>();

function paintFindingLines(
  editor: vscode.TextEditor,
  lines: Set<number>
): void {
  if (!findingLineDecoration) return;
  const doc = editor.document;
  const ranges: vscode.Range[] = [];
  for (const line of lines) {
    const safe = Math.max(0, Math.min(doc.lineCount - 1, line));
    const text = doc.lineAt(safe).text;
    ranges.push(new vscode.Range(safe, 0, safe, Math.max(1, text.length)));
  }
  try {
    editor.setDecorations(findingLineDecoration, ranges);
  } catch {
    /* editor disposed mid-paint, ignore */
  }
}

function repaintActiveEditorFindings(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const lines = renderedLinesPerUri.get(editor.document.uri.toString()) ?? new Set<number>();
  paintFindingLines(editor, lines);
}

// ---- Public API ----

export function registerGhostMentor(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  lensProvider = new GhostLensProvider();

  // Line-wash decoration applied to every line with a rendered
  // finding. Alpha kept below the error-line highlight so findings
  // advisories don't compete visually with real compiler errors.
  findingLineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    isWholeLine: true,
  });
  disposables.push(findingLineDecoration);

  // Repaint the active editor's finding-line wash when the user
  // switches tabs — `provideCodeLenses` fires for the new doc but the
  // decoration state is per-editor, so we need to re-apply what we
  // cached for that uri.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      repaintActiveEditorFindings();
    })
  );

  // Free the cached line set when a file closes — keeps the map bounded
  // on long sessions where the user opens hundreds of files.
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      renderedLinesPerUri.delete(doc.uri.toString());
    })
  );

  // Module-state cleanup on full deactivate.
  disposables.push({
    dispose() {
      clearPendingPeek();
      renderedLinesPerUri.clear();
      findingLineDecoration = null;
    },
  });

  // Register the CodeLens provider broadly — we gate inside provideCodeLenses.
  disposables.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider)
  );

  // Whole-line HoverProvider — complements underlineWhisper's token-
  // range hover. Whisper only fires INSIDE a registered token (good
  // for block/statement-scope suggestions with a real target word), so
  // block-scope and flow-scope findings that don't have a whisper
  // registered used to produce nothing when the user clicked the
  // CodeLens title → cursor moved → showHover → no provider matched.
  // This provider ensures EVERY line with a rendered finding opens a
  // rich teaching popup on click or hover. Reuses buildActionHover so
  // the content matches the whisper hover exactly.
  disposables.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        async provideHover(doc, position) {
          const uri = doc.uri.toString();
          const all = getSuggestionsForUri(uri);
          if (all.length === 0) return;
          // Find the top-priority suggestion on the hovered line (same
          // prioritization as the CodeLens provider — keep them in lockstep).
          const line = position.line;
          const onLine = all.filter(
            (s) =>
              !gateShouldSuppress(uri, s) &&
              Math.max(0, Math.min(doc.lineCount - 1, s.range.start.line)) ===
                line &&
              !(s.scope === "block" || s.scope === "flow"
                ? hasNativeDiagnosticInRange(doc.uri, s.range)
                : hasNativeDiagnosticOnLine(doc.uri, s.range.start.line))
          );
          if (onLine.length === 0) return;

          const SEV_WEIGHT = { warn: 0, perf: 1, info: 2 } as const;
          const KIND_WEIGHT = { "watch-out": 0, concept: 1, praise: 2 } as const;
          onLine.sort((a, b) => {
            const aScore =
              SEV_WEIGHT[a.severity] * 10 +
              (KIND_WEIGHT[a.kind as keyof typeof KIND_WEIGHT] ?? 1);
            const bScore =
              SEV_WEIGHT[b.severity] * 10 +
              (KIND_WEIGHT[b.kind as keyof typeof KIND_WEIGHT] ?? 1);
            return aScore - bScore;
          });
          const top = onLine[0];

          // Defer the import so we don't pull underlineWhisper on
          // extension load if a user hasn't touched a finding line yet.
          const { buildActionHover } = await import("./underlineWhisper.js");
          const md = buildActionHover(top, uri, doc.languageId);
          // Anchor the hover on the whole finding line so the popup
          // stays open while the user moves their mouse from the
          // CodeLens down to the action links.
          const lineText = doc.lineAt(line).text;
          const range = new vscode.Range(
            line,
            0,
            line,
            Math.max(1, lineText.length)
          );
          return new vscode.Hover(md, range);
        },
      }
    )
  );

  // Re-render when a new scan delivers findings to the store. VS Code
  // re-calls provideCodeLenses on doc changes but NOT on our custom
  // store-update events — without this subscription, "paste then wait"
  // would show nothing because the scan completes silently after the
  // doc settled and no natural trigger fires provideCodeLenses again.
  disposables.push(
    onSuggestionsChanged(() => {
      lensProvider?.refresh();
    })
  );

  // Re-render when the finding gate's suppression state changes (cursor
  // moved, file edited, rule cooldown expired via churn). Without this,
  // the CodeLens only updates when VS Code decides to re-call provide —
  // which isn't guaranteed on pure cursor movement.
  disposables.push(
    onGateChanged(() => {
      lensProvider?.refresh();
    })
  );

  // ---- Commands ----

  disposables.push(
    vscode.commands.registerCommand("protege.applyGhost", async () => {
      const g = active;
      if (!g) return;
      hideGhost();
      // Route Apply through smartFix — generates a clean fix via Haiku
      // using the actual surrounding code, not whatever the scan stored.
      await vscode.commands.executeCommand("protege.smartFix", {
        uri: g.uri,
        line: g.suggestion.range.start.line,
      });
    })
  );

  // Ghost Lens "Teach" button — opens the inline thread AND plays voice.
  // Matches the hover's Teach button (one surface label, one behavior).
  // The old `protege.explainGhost` command stays registered below as an
  // alias for back-compat (command-palette users, any stray references).
  disposables.push(
    vscode.commands.registerCommand("protege.ghostTeach", async () => {
      const g = active;
      if (!g) return;
      hideGhost();
      await vscode.commands.executeCommand("protege.openTeachingThread", {
        uri: g.uri,
        line: g.suggestion.range.start.line,
      });
    })
  );

  // Back-compat alias — points at the same handler so anything still
  // firing `protege.explainGhost` keeps working. Will remove once we're
  // sure nothing else references it.
  disposables.push(
    vscode.commands.registerCommand("protege.explainGhost", async () => {
      await vscode.commands.executeCommand("protege.ghostTeach");
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

  // Headline click = "peek" the finding. Builds the action-hover markdown
  // for the suggestion and attaches it to a short-lived decoration that
  // spans the whole finding line, then fires VS Code's built-in showHover
  // at the anchor. Attaching the markdown directly (rather than relying
  // on the registered HoverProvider firing at the cursor) makes the
  // popup open reliably from any column on the line, with the same
  // content the underline-token hover shows.
  //
  // This is the lightweight counterpart to the "Teach" button on the
  // same CodeLens row: title = peek (read & dismiss), Teach = commit
  // (chat or voice per explainMode), Dismiss = hide.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.ghostHeadlinePeek",
      async (arg: { uri?: string; line?: number } | undefined) => {
        const uri = arg?.uri;
        const line = typeof arg?.line === "number" ? arg.line : undefined;
        if (!uri || line === undefined) return;

        const editors = vscode.window.visibleTextEditors;
        const active = vscode.window.activeTextEditor;
        const editor =
          active && active.document.uri.toString() === uri
            ? active
            : editors.find((e) => e.document.uri.toString() === uri);
        if (!editor) return;

        const clampedLine = Math.max(
          0,
          Math.min(editor.document.lineCount - 1, Math.floor(line))
        );

        const suggestion = findSuggestionAtLine(uri, clampedLine);
        if (!suggestion) return;

        // Build the popup content up front so we can bind it directly
        // to the decoration's hoverMessage. Same markdown the underline
        // hover produces — one surface, one vocabulary.
        const { buildActionHover } = await import("./underlineWhisper.js");
        const md = buildActionHover(suggestion, uri, editor.document.languageId);

        // Span the hover anchor across the whole finding line so the
        // popup opens from any column the user clicked, and stays open
        // while the mouse travels down to the action links.
        const lineText = editor.document.lineAt(clampedLine).text;
        const fallbackCol = Math.max(0, lineText.search(/\S/));
        const anchorRange = new vscode.Range(
          clampedLine,
          0,
          clampedLine,
          Math.max(1, lineText.length)
        );
        const anchorPos = new vscode.Position(clampedLine, fallbackCol);

        // Show editor + move cursor onto the line first so showHover
        // anchors at the right spot when it fires.
        await vscode.window.showTextDocument(editor.document, {
          viewColumn: editor.viewColumn,
          preserveFocus: false,
          preview: false,
        });
        const curr = editor.selection.active;
        const needsMove =
          curr.line !== anchorPos.line ||
          Math.abs(curr.character - anchorPos.character) > 2;
        if (needsMove) {
          editor.selection = new vscode.Selection(anchorPos, anchorPos);
          editor.revealRange(
            anchorRange,
            vscode.TextEditorRevealType.Default
          );
        }

        // Retire any prior peek decoration before creating the new one.
        clearPendingPeek();

        const anchorDeco = vscode.window.createTextEditorDecorationType({});
        try {
          editor.setDecorations(anchorDeco, [
            { range: anchorRange, hoverMessage: md },
          ]);
        } catch {
          try {
            anchorDeco.dispose();
          } catch {
            /* ignore */
          }
          return;
        }
        const expireTimer = setTimeout(() => {
          if (pendingPeek && pendingPeek.decoration === anchorDeco) {
            clearPendingPeek();
          }
        }, PEEK_TTL_MS);
        pendingPeek = { decoration: anchorDeco, expireTimer };

        await vscode.commands.executeCommand("editor.action.showHover");
      }
    )
  );

  // Legacy alias — earlier CodeLenses shipped with this command id. Safe
  // to remove once the user reloads once post-deploy, but cheap to keep.
  disposables.push(
    vscode.commands.registerCommand("protege.ghostHeadlineNoop", () => {
      /* intentional no-op — preserved for back-compat */
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

  // New scan completed → refresh the CodeLens IMMEDIATELY (don't wait
  // for the 300ms cursor-debounce). The user wants the small top-of-line
  // row to appear instantly when a finding lands. Cursor-park evaluation
  // still goes through scheduleEvaluate to keep typing churn debounced.
  disposables.push(
    onSuggestionsChanged((uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== uri) return;
      lensProvider?.refresh();
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
  // Title-only headline (no message). User feedback: the prior
  // "Title — Long message text… | Apply fix | Teach | Dismiss" row was
  // wider than most editors. The full message is one hover away (click
  // the title → showHover) so we can drop it from the always-visible
  // strip and recover ~70% of the row width.
  const clean = s.ruleId.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const scopeBadge =
    s.scope === "flow" ? " (flow)" : s.scope === "block" ? " (block)" : "";
  return `${clean}${scopeBadge}`;
}

function shortName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}

// ---- Voice explanation path ----
//
// When `protege.explainMode` is "voice" or "both", clicking Explain sends
// the concept to the cloud in `voice` chat mode, trims the reply to the
// 8-second budget, and broadcasts `voice/playExplain` to the webview.
// The webview hits /tts and plays the WAV via its persistent AudioContext
// (same pipeline Voice Mode uses).
//
// While the audio plays, we paint a small "🔊 Protege speaking…" chip on
// the ghost line so the user can see what the voice is attached to. The
// chip auto-fades when playback ends (or after a 15s safety cap).

// After-decorations don't render codicons — contentText is literal
// text. So we use plain words instead of emoji here; codicons only go
// in CodeLens/QuickPick/hover-MarkdownString surfaces where VS Code
// actually parses `$(name)` syntax.
const SPEAKING_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(255,255,255,0.55)",
    contentText: "  Protege speaking…",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Shown right after the voice clip finishes — a gentle invitation to keep
// the conversation going. Fades after 4s so it never becomes clutter. The
// wake-word path is still future work (plan §11 Stage E); for now the chip
// doubles as discoverability for the 📖 Teach hover button.
const POST_VOICE_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(140, 200, 255, 0.7)",
    contentText: '  Say "protege" for a follow-up',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Shown when playback failed (TTS 5xx, autoplay block, empty clip). Fades
// after 5s. Previously a failure was silent — the speaking chip just hung
// until the 15s safety timer cleared it, leaving the user confused about
// whether Protege was thinking or broken.
const VOICE_ERROR_DECORATION = vscode.window.createTextEditorDecorationType({
  after: {
    margin: "0 0 0 2em",
    fontStyle: "italic",
    color: "rgba(255, 180, 180, 0.85)",
    contentText: "  voice didn't play — click the Protege panel once to enable it",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

// Pending voice-playback handoff state. Set when runVoiceExplanation
// broadcasts the clip; consumed when the webview reports playbackDone.
// Stored globally because `voice/playbackDone` arrives through webviewHost.ts,
// not as a function return — it's decoupled from the broadcast in time.
interface PendingHandoff {
  editor: vscode.TextEditor;
  range: vscode.Range;
  uri: string;
  // The 15s "webview never reported back" safety timer. Cancelled the
  // moment playbackDone arrives — otherwise the safety could clear the
  // post-voice chip prematurely.
  safetyTimer: ReturnType<typeof setTimeout>;
  // Guard against stale chips sticking on screen if two voice clips fire
  // back-to-back and the second's playbackDone arrives after the first's
  // 4s fade timer is already running.
  fadeTimer: ReturnType<typeof setTimeout> | null;
}
let pendingHandoff: PendingHandoff | null = null;

/**
 * Called from webviewHost.ts when the webview reports that the /tts audio
 * clip finished playing (or errored). Swaps the "speaking…" chip for the
 * post-voice handoff chip, which then fades after 4s.
 *
 * Suppresses the chip when the teaching thread is already open on that
 * file — the user has the written lesson in view, a voice follow-up
 * prompt would just be noise.
 */
export async function onVoicePlaybackDone(reason: "ended" | "error"): Promise<void> {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  if (!handoff) return;

  // Cancel the safety so it doesn't clobber the post-voice chip in 15s.
  clearTimeout(handoff.safetyTimer);

  const { editor, range, uri } = handoff;
  editor.setDecorations(SPEAKING_DECORATION, []);

  if (reason === "error") {
    // Surface a visible "voice failed" chip instead of silently pretending
    // everything worked. Most likely cause: autoplay policy block (needs a
    // gesture inside the webview to unlock) — the user needs to click the
    // Protege panel once. Reveal the view so the click target is obvious.
    vscode.commands
      .executeCommand("protege.launcher.focus")
      .then(undefined, () => {});
    editor.setDecorations(VOICE_ERROR_DECORATION, [{ range }]);
    if (handoff.fadeTimer) clearTimeout(handoff.fadeTimer);
    handoff.fadeTimer = setTimeout(() => {
      editor.setDecorations(VOICE_ERROR_DECORATION, []);
    }, 5_000);
    return;
  }

  try {
    const { hasOpenThread } = await import("../teaching/teachingThread.js");
    if (hasOpenThread(uri)) return;
  } catch {
    // If the thread module failed to load for any reason, still show
    // the chip — the chip is the safer default.
  }

  editor.setDecorations(POST_VOICE_DECORATION, [{ range }]);
  if (handoff.fadeTimer) clearTimeout(handoff.fadeTimer);
  handoff.fadeTimer = setTimeout(() => {
    editor.setDecorations(POST_VOICE_DECORATION, []);
  }, 4_000);
}

/**
 * Play a short voice explanation for a suggestion. Exported so other
 * surfaces (the Whisper hover's 🎙 Explain button) can reuse the same
 * pipeline without having to synthesize an "active ghost" first.
 *
 * Safe to call with any suggestion; if voice isn't available the
 * function logs and returns without side effects.
 */
export async function runVoiceExplanation(suggestion: Suggestion): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const editorAtStart = editor;

  const speakingRange = editor && editorAtStart
    ? (() => {
        const line = Math.min(
          editor.document.lineCount - 1,
          suggestion.range.start.line
        );
        const col = editor.document.lineAt(line).text.length;
        return new vscode.Range(line, col, line, col);
      })()
    : undefined;

  if (editorAtStart && speakingRange) {
    editorAtStart.setDecorations(SPEAKING_DECORATION, [{ range: speakingRange }]);
  }

  const safetyTimer = setTimeout(() => {
    if (!editorAtStart) return;
    editorAtStart.setDecorations(SPEAKING_DECORATION, []);
    editorAtStart.setDecorations(POST_VOICE_DECORATION, []);
    editorAtStart.setDecorations(VOICE_ERROR_DECORATION, []);
    // If the webview never reported playbackDone (TTS fetch failed, audio
    // errored silently, panel closed mid-clip), drop the pending handoff
    // so a future voice clip's handoff isn't attached to a stale editor.
    if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
    pendingHandoff = null;
  }, 15_000);

  try {
    const { trimForVoice } = await import("../teaching/explainMode.js");
    const { log } = await import("../log.js");
    const { broadcast, mountedWebviewCount } = await import("../chat/webviewHost.js");

    // Audio can only play from a mounted webview. If the Protege panel has
    // never been opened this session, our broadcast would go nowhere —
    // user would click Explain and get silence. Open it first, then wait
    // a beat for the webview to mount and hydrate its message listener.
    if (mountedWebviewCount() === 0) {
      log("voice", `no webview mounted — opening Protege panel first`);
      await vscode.commands.executeCommand("protege.toggle");
      await new Promise((r) => setTimeout(r, 400));
    }

    // Prefer the pre-generated `voiceScript` the scan already produced.
    // The original implementation called Claude AGAIN on every Explain
    // click, which: (a) added a 1–3s latency per click, (b) spent tokens
    // every time, (c) could produce DIFFERENT voice prose than the
    // thread's `lesson` — violating plan anti-feature #3 ("no duplicating
    // the lesson text across surfaces"). When the suggestion carries a
    // model-written script from the initial scan, speak that directly.
    // Claude fallback stays for older suggestions or degraded scans where
    // voiceScript is empty.
    let trimmed: string;
    if (suggestion.voiceScript && suggestion.voiceScript.trim()) {
      trimmed = trimForVoice(suggestion.voiceScript);
      log(
        "voice",
        `explain → using pre-generated voiceScript · ${trimmed.length}ch (no Claude round-trip)`
      );
    } else {
      const { runSingleQuery } = await import("../chat/chatRunner.js");
      const fileHint = editor?.document.fileName.split(/[\\/]/).pop() ?? "the file";
      const lineNum = suggestion.range.start.line + 1;
      const prompt =
        `Explain \`${suggestion.ruleId}\` at ${fileHint}:${lineNum} in 40–55 ` +
        `words of plain spoken English. ` +
        `Context: ${suggestion.message}. ` +
        `Direct and factual. NO metaphors, NO analogies, NO "imagine if", ` +
        `NO "let me explain", NO preamble. Open with what's wrong. Close ` +
        `with the fix. Will be read aloud by TTS.`;

      log("voice", `explain → no voiceScript, querying Claude (voice mode)`);
      const raw = await runSingleQuery(prompt, { mode: "voice" });
      log(
        "voice",
        `explain reply ${raw.length}ch · mountedWebviews=${mountedWebviewCount()}`
      );
      trimmed = trimForVoice(raw);
    }

    if (!trimmed) {
      log("voice", `empty reply — nothing to speak`);
      return;
    }

    // Tell the webview to play it. The webview fetches /tts, plays the
    // WAV via its persistent Audio element (same pipeline as Voice Mode),
    // and posts `voice/playbackDone` back when the clip ends. That fires
    // `onVoicePlaybackDone()` below, which swaps the chip at the REAL
    // moment of playback completion — not a guess based on word count.
    if (editorAtStart && speakingRange) {
      // Clear any prior pending handoff (two voices back-to-back) so the
      // new clip's chip doesn't compete with a stale fade timer.
      if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
      if (pendingHandoff?.safetyTimer) clearTimeout(pendingHandoff.safetyTimer);
      pendingHandoff = {
        editor: editorAtStart,
        range: speakingRange,
        uri: editorAtStart.document.uri.toString(),
        safetyTimer,
        fadeTimer: null,
      };
    }
    log(
      "voice",
      `broadcast voice/playExplain · text=${trimmed.length}ch · mountedWebviews=${mountedWebviewCount()}`
    );
    broadcast({ type: "voice/playExplain", text: trimmed });
    // Success path: DON'T clear the SPEAKING chip here — the webview is
    // about to play the clip, and we want "🔊 Protege speaking…" visible
    // for the full duration. The chip gets cleared by onVoicePlaybackDone
    // (real end-of-playback signal) or the 15s safety timer if the
    // webview never reports back.
    return;
  } catch (err) {
    const { log } = await import("../log.js");
    log(
      "voice",
      `explain FAIL — ${err instanceof Error ? err.message : String(err)}`
    );
    // On failure no audio will play, so clear the chip immediately.
    clearTimeout(safetyTimer);
    if (editorAtStart) editorAtStart.setDecorations(SPEAKING_DECORATION, []);
    if (pendingHandoff?.fadeTimer) clearTimeout(pendingHandoff.fadeTimer);
    pendingHandoff = null;
  }
}
