import * as vscode from "vscode";
import {
  clearAutoInsertedForUri,
  getRegionsForUri,
  markExplained,
  onOwnershipChanged,
} from "../user/ownership.js";
import { log } from "../log.js";

/**
 * AI Block Highlighter — replaces the Vibecode Brief comment thread.
 *
 * Rather than interrupting with a popup after every auto-inserted
 * burst, this surface treats vibecoded regions as BROWSABLE ARTIFACTS
 * the user can review at any point:
 *
 *   1. Every unreviewed auto-inserted region (from ownership.ts)
 *      gets a subtle blue line-wash so the user can SEE at a glance
 *      which code the AI wrote.
 *   2. A single CodeLens at the top line of each region reads:
 *        ◎ AI block · N lines · ✿ Teach me this block
 *   3. Clicking the lens routes the block code into the Protege chat
 *      panel as a teaching prompt. No upfront LLM call on lens render —
 *      the surface stays free until the user actually opts in. Earlier
 *      builds fired a `kind: "teach"` summary on first render to swap
 *      the lens title from the placeholder to a per-block one-liner;
 *      that bypassed the auto-fire budget gate (teach-tier ignores it)
 *      and burned a premium-tier call every time `cmd+/` mis-flagged
 *      a region as auto-inserted. Removed 2026-05-01.
 *   4. Hover actions:
 *        ✓ Got it     → markExplained → decoration + lens disappear
 *        ↗ Tell me more → push context to sidebar chat + markExplained
 *        ✕ Dismiss    → markExplained (same effect as Got it)
 *
 * When a region's `explainedAt` is stamped (here, or by Explain-back,
 * or by a predict-and-reveal "Got it"), ownership.ts fires
 * `onOwnershipChanged`, and this module re-queries + repaints.
 */

// ---- Tuning ----

const COOLDOWN_MS = 5_000;
/** Max chars of block code sent to the LLM — prevents a single giant
 *  block from eating the context budget. Larger blocks get truncated
 *  with a marker in the prompt. */
const MAX_BLOCK_CHARS = 4_000;

// ---- Module state ----

/** Subtle blue wash + 2px left-border, applied to every unreviewed
 *  auto-inserted region. Distinct from the amber misconception
 *  highlight and the 6%-white error line highlight — Protege's
 *  "ambient informational" color. */
let blockDecoration: vscode.TextEditorDecorationType | null = null;

/** Per-block click cooldown, keyed by `${uri}:${startLine}:${endLine}`.
 *  Prevents spam-clicking the same lens — routes the click to chat only
 *  once per 5s window. */
const lastCallAt = new Map<string, number>();

/** Active hover anchor decoration for the most recently clicked block.
 *  Only one at a time — disposed before a new click renders. */
interface PendingHover {
  uri: vscode.Uri;
  decoration: vscode.TextEditorDecorationType;
  expireTimer: ReturnType<typeof setTimeout>;
}
let pendingHover: PendingHover | null = null;

/** Module-scope extension context — stashed on register so the teach
 *  command can open the Protege panel via openProtegePanel(context).
 *  Null before registration and after dispose. */
let aiBlocksContext: vscode.ExtensionContext | null = null;

/** CodeLens provider — one lens per unreviewed block. */
class AiBlockLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;
  refresh(): void {
    this.emitter.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isEnabled()) return [];
    if (doc.uri.scheme !== "file") return [];
    const regions = getRegionsForUri(doc.uri).filter(
      (r) => r.origin === "auto-inserted" && r.explainedAt === null
    );
    if (regions.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const r of regions) {
      const line = Math.max(0, Math.min(doc.lineCount - 1, r.startLine));
      const range = new vscode.Range(line, 0, line, 0);
      const lineCount = r.endLine - r.startLine + 1;
      const args: AiBlockArgs = {
        uri: doc.uri.toString(),
        startLine: r.startLine,
        endLine: r.endLine,
      };
      const title = `◎ AI block · ${lineCount} ${lineCount === 1 ? "line" : "lines"} · ✿ Teach me this block`;
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          tooltip:
            "Open the teaching hover for this block · Got it when reviewed",
          command: "protege.aiBlocks.teach",
          arguments: [args],
        })
      );
    }
    return lenses;
  }
}
let lensProvider: AiBlockLensProvider | null = null;

// ---- Registration ----

export function registerAiBlocks(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  aiBlocksContext = context;
  const disposables: vscode.Disposable[] = [];

  blockDecoration = vscode.window.createTextEditorDecorationType({
    // Whole-line wash — the block spans multiple lines, so isWholeLine
    // gives a continuous band down the left gutter.
    isWholeLine: true,
    backgroundColor: "rgba(120, 180, 255, 0.03)",
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    borderColor: "rgba(120, 180, 255, 0.5)",
    overviewRulerColor: "rgba(120, 180, 255, 0.6)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  disposables.push(blockDecoration);

  lensProvider = new AiBlockLensProvider();
  disposables.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lensProvider)
  );

  // Repaint on ownership changes (new region recorded, markExplained
  // stamped, etc.) — both the decoration AND the lens provider need
  // to refresh.
  disposables.push(
    onOwnershipChanged(() => {
      lensProvider?.refresh();
      const editor = vscode.window.activeTextEditor;
      if (editor) paintBlocksFor(editor);
    })
  );

  // Repaint when the user switches editor tabs — per-editor decoration
  // state doesn't survive tab changes on its own.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) paintBlocksFor(editor);
    })
  );

  // Seed any currently-visible editors on activation so the user sees
  // previously-recorded blocks immediately, before they edit anything.
  for (const editor of vscode.window.visibleTextEditors) {
    paintBlocksFor(editor);
  }

  // ---- Commands ----

  disposables.push(
    vscode.commands.registerCommand(
      "protege.aiBlocks.teach",
      async (args: AiBlockArgs | undefined) => {
        if (!args) return;
        await teachBlock(args);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.aiBlocks.gotIt",
      async (args: AiBlockArgs | undefined) => {
        if (!args) return;
        await markReviewed(args);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.aiBlocks.dismiss",
      async (args: AiBlockArgs | undefined) => {
        if (!args) return;
        // Dismiss = "I've looked at it, no deeper help needed". Same
        // effect as Got it — the block is marked reviewed so the user
        // doesn't see this lens again. If they wanted to keep the
        // block unreviewed they'd just not click anything.
        await markReviewed(args);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.aiBlocks.tellMore",
      async (args: (AiBlockArgs & { briefing?: string }) | undefined) => {
        if (!args) return;
        await tellMore(args);
      }
    )
  );

  // One-shot escape hatch: wipe every unreviewed AI block in the active
  // file. Useful when the detector leaves stale regions from an old
  // session or classifies the user's own code as auto-inserted.
  disposables.push(
    vscode.commands.registerCommand(
      "protege.aiBlocks.dismissAllInFile",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") {
          vscode.window.showInformationMessage(
            "Open a file first, then run this command."
          );
          return;
        }
        const cleared = clearAutoInsertedForUri(editor.document.uri);
        clearPendingHover();
        if (cleared === 0) {
          vscode.window.showInformationMessage(
            "No AI blocks to clear in this file."
          );
        } else {
          vscode.window.showInformationMessage(
            `Cleared ${cleared} AI block${cleared === 1 ? "" : "s"} in this file.`
          );
        }
      }
    )
  );

  disposables.push({
    dispose() {
      clearPendingHover();
      lastCallAt.clear();
      lensProvider = null;
      blockDecoration = null;
      aiBlocksContext = null;
    },
  });

  log("aiBlocks", "installed");
  return disposables;
}

// ---- Types ----

interface AiBlockArgs {
  uri: string;
  startLine: number;
  endLine: number;
}

// ---- Painting ----

function paintBlocksFor(editor: vscode.TextEditor): void {
  if (!blockDecoration) return;
  if (editor.document.uri.scheme !== "file") {
    editor.setDecorations(blockDecoration, []);
    return;
  }
  if (!isEnabled()) {
    editor.setDecorations(blockDecoration, []);
    return;
  }
  const regions = getRegionsForUri(editor.document.uri).filter(
    (r) => r.origin === "auto-inserted" && r.explainedAt === null
  );
  const ranges: vscode.Range[] = [];
  const doc = editor.document;
  for (const r of regions) {
    const start = Math.max(0, Math.min(doc.lineCount - 1, r.startLine));
    const end = Math.max(start, Math.min(doc.lineCount - 1, r.endLine));
    const endText = doc.lineAt(end).text;
    ranges.push(new vscode.Range(start, 0, end, Math.max(1, endText.length)));
  }
  try {
    editor.setDecorations(blockDecoration, ranges);
  } catch {
    /* editor disposed mid-paint */
  }
}

// ---- Teach flow ----

/**
 * Clicking "✿ Teach me this block" on the CodeLens opens the Protege
 * chat panel and sends a teaching prompt scoped to the block. No more
 * hover-with-briefing intermediate step — the user said the CodeLens
 * button implied "teach me in chat" and that the old hover-then-pick
 * flow felt like a dead end. One click → chat opens → teaching
 * response streams in. The block is also marked reviewed so the lens
 * + wash disappear immediately (the user committed to learning it).
 */
async function teachBlock(args: AiBlockArgs): Promise<void> {
  if (!isEnabled()) return;

  const key = keyFor(args);
  const now = Date.now();
  const last = lastCallAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    log("aiBlocks", `teach click ignored (cooldown) · ${wait}s remaining · ${key}`);
    return;
  }
  lastCallAt.set(key, now);

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(args.uri);
  } catch {
    return;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    log(
      "aiBlocks",
      `teach failed to open doc — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Reveal the block so the user sees what they're about to be taught
  // about when the chat panel pops open beside it.
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const safeStart = Math.max(0, Math.min(doc.lineCount - 1, args.startLine));
  const safeEnd = Math.max(
    safeStart,
    Math.min(doc.lineCount - 1, args.endLine)
  );
  editor.revealRange(
    new vscode.Range(safeStart, 0, safeEnd, 0),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );

  // Pull the block text + a small surrounding context window so the
  // chat prompt is self-contained — the chat handler doesn't re-read
  // the file.
  const endChar = doc.lineAt(safeEnd).text.length;
  let code = doc.getText(new vscode.Range(safeStart, 0, safeEnd, endChar));
  if (code.length > MAX_BLOCK_CHARS) {
    code = code.slice(0, MAX_BLOCK_CHARS) + "\n// ...truncated";
  }
  const fileName = doc.fileName.split(/[\\/]/).pop() ?? "file";
  const lang = doc.languageId;

  const { openProtegePanel } = await import("../panel.js");
  const { broadcast, mountedWebviewCount } = await import(
    "../chat/webviewHost.js"
  );

  // Open the Protege sidebar if it isn't mounted; give the webview a
  // beat to boot before we push the autoSend message in.
  if (mountedWebviewCount() === 0) {
    if (aiBlocksContext) openProtegePanel(aiBlocksContext);
    await new Promise((r) => setTimeout(r, 350));
  }

  const message =
    `Teach me about this block from \`${fileName}\` (lines ${safeStart + 1}–${safeEnd + 1}).\n\n` +
    `\`\`\`${lang}\n${code}\n\`\`\`\n\n` +
    `Walk me through it: what it actually does, what the non-obvious parts are, and one concrete way it could break in production. Keep it under 200 words.`;

  try {
    broadcast({ type: "chat/autoSend", message });
  } catch (err) {
    log(
      "aiBlocks",
      `teach broadcast failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Mark reviewed so the lens + decoration disappear — user committed
  // to the lesson, don't keep nagging them about this block.
  await markReviewed(args);
  log("aiBlocks", `teach routed to chat · ${key}`);
}

function clearPendingHover(): void {
  if (!pendingHover) return;
  try {
    clearTimeout(pendingHover.expireTimer);
  } catch {
    /* ignore */
  }
  try {
    pendingHover.decoration.dispose();
  } catch {
    /* ignore */
  }
  pendingHover = null;
}

// ---- Got it / dismiss / tell more ----

async function markReviewed(args: AiBlockArgs): Promise<void> {
  try {
    const uri = vscode.Uri.parse(args.uri);
    markExplained(uri, args.startLine, args.endLine);
    log(
      "aiBlocks",
      `marked reviewed · ${uri.fsPath.split("/").pop()} · lines ${args.startLine + 1}-${args.endLine + 1}`
    );
  } catch (err) {
    log(
      "aiBlocks",
      `markReviewed failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  clearPendingHover();
  // onOwnershipChanged fires from markExplained → lensProvider + decoration repaint.
}

async function tellMore(
  args: AiBlockArgs & { briefing?: string }
): Promise<void> {
  try {
    const { openProtegePanel } = await import("../panel.js");
    const { broadcast, mountedWebviewCount } = await import(
      "../chat/webviewHost.js"
    );
    if (mountedWebviewCount() === 0) {
      // Silent no-op when the panel isn't open. User sees nothing
      // visible happen; they'd need to open Protege and click again.
      // Acceptable because Tell-me-more is a pull-action, not critical.
      log("aiBlocks", "tellMore — panel not mounted, ignoring");
      return;
    }
    void openProtegePanel;
    const uri = vscode.Uri.parse(args.uri);
    const fileName = uri.fsPath.split("/").pop() ?? "this file";
    setTimeout(() => {
      try {
        broadcast({
          type: "chat/autoSend",
          message:
            `Protege flagged an AI-generated block in ${fileName} (lines ${args.startLine + 1}–${args.endLine + 1}).\n\n` +
            (args.briefing ? `Short briefing: "${args.briefing}"\n\n` : "") +
            `Walk me through this block in more depth — what else should I know before shipping? Include one concrete scenario where it breaks. Under 200 words.`,
        });
      } catch (err) {
        log(
          "aiBlocks",
          `tellMore broadcast failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, 200);
  } catch (err) {
    log(
      "aiBlocks",
      `tellMore failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // Mark reviewed — we're routing the depth version to chat, the block
  // is considered handled.
  await markReviewed(args);
}

// ---- Helpers ----

function keyFor(args: AiBlockArgs): string {
  return `${args.uri}:${args.startLine}:${args.endLine}`;
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("aiBlocks.enabled", true);
}
