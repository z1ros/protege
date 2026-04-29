import * as vscode from "vscode";
import { spawn } from "node:child_process";
import type { ToolCall, ToolResult, WorkspaceContext } from "@protege/types";
import { getActiveFileEditor } from "../workspace/activeFile.js";

/**
 * Tool executors run inside the extension host — only it has workspace FS access.
 * Every tool is defensive: bad paths / regex errors return error strings,
 * never throw (the chat loop would stall).
 */

const MAX_FILE_BYTES = 120_000;
const MAX_GREP_RESULTS = 50;

/** Decoration used to briefly flash edited lines green. */
const editFlashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(74, 158, 255, 0.18)",
  borderRadius: "3px",
  isWholeLine: true,
  overviewRulerColor: "#4a9eff",
  overviewRulerLane: vscode.OverviewRulerLane.Center,
});

const showFlashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(124, 179, 255, 0.12)",
  borderRadius: "3px",
  isWholeLine: true,
});

/** Persistent highlight decorations — one per semantic kind. */
type HighlightKind = "focus" | "bug" | "pattern" | "tip";

/**
 * Set of file URIs that currently have Protege highlights applied.
 * Used by the save listener to know when to auto-clear: if the user
 * saves a file in this set, we wipe the decorations (assumption: they
 * touched the code, so the stale highlight no longer matches reality).
 *
 * Also drives the `protege.hasHighlights` VS Code context key, which
 * gates the Escape keybinding so we only steal Esc when we have UI.
 */
const activeHighlightFiles = new Set<string>();

/** Full metadata for each active highlight, keyed by uri.toString().
 *  Read by HighlightCodeLensProvider to render the "Fix · Teach · Dismiss"
 *  row ABOVE the highlighted line. Separate from activeHighlightFiles so
 *  the provider can map a single URI to multiple highlight regions. */
interface ActiveHighlight {
  range: vscode.Range;
  kind: HighlightKind;
  label?: string;
  issue?: string;
  fix?: string;
  explanation?: string;
  meta: { path: string; startLine: number; endLine: number };
}
const activeHighlightMeta = new Map<string, ActiveHighlight[]>();

class HighlightCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this._onDidChange.event;
  refresh(): void {
    this._onDidChange.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const list = activeHighlightMeta.get(doc.uri.toString());
    if (!list || list.length === 0) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const h of list) {
      // CodeLens anchors to a zero-width range at the start of the line —
      // VS Code renders the lens row in the gutter space above that line.
      const lensRange = new vscode.Range(h.range.start.line, 0, h.range.start.line, 0);
      // Full payload — issue, fix, explanation, AND the corrected line
      // range — so the teach handler can quote the actual code instead of
      // sending the model a generic "what was that thing again?" prompt.
      // Using h.range (post-anchor-correction) means we always quote the
      // line the user is actually looking at, not the model's pre-snap
      // claim.
      const teachArgs = encodeURIComponent(
        JSON.stringify({
          kind: h.kind,
          label: h.label ?? "",
          issue: h.issue ?? "",
          fix: h.fix ?? "",
          explanation: h.explanation ?? "",
          path: h.meta.path,
          startLine: h.range.start.line + 1,
          endLine: h.range.end.line + 1,
        })
      );
      // Detect "teaching highlight" — the bot is highlighting a line
      // mid-lesson to point at it while explaining. Two signals:
      //   1. h has NO fix and NO issue — pure "look at this" highlight
      //   2. there's an active lesson session (lessonActive flag) —
      //      EVEN if h has fix/issue, the user is in a lesson so the
      //      "Teach me" / "Apply fix" buttons don't fit (they'd open
      //      a new teach prompt or rewrite while a lesson is running).
      // Either way → strip Teach me + Apply fix; keep summary + Dismiss.
      const isTeachingHighlight = (!h.fix && !h.issue) || isLessonActive();

      // First lens: one-line summary of what's wrong — picked from the
      // richest available field (issue > label > explanation), capped so
      // the row never wraps. Icon reflects the kind so users can tell
      // bug/focus/tip/pattern apart at a glance without reading the text.
      // Click opens the full hover card (same target as the old hover).
      const summary = shortSummary(h.issue, h.label, h.explanation);
      if (summary) {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: `${kindLensIcon(h.kind)} ${summary}`,
            command: "editor.action.showHover",
          })
        );
      }
      if (h.fix && !isTeachingHighlight) {
        // Use the post-anchor-correction range — applyFix should overwrite
        // the line the highlight is actually painted on, not the line the
        // model originally claimed.
        const fixArgs = encodeURIComponent(
          JSON.stringify({
            path: h.meta.path,
            startLine: h.range.start.line + 1,
            endLine: h.range.end.line + 1,
            fix: h.fix,
          })
        );
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: `✔ Apply fix`,
            command: "protege.applyFix",
            arguments: [JSON.parse(decodeURIComponent(fixArgs))],
          })
        );
      }
      if (!isTeachingHighlight) {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: `✿ Teach me`,
            command: "protege.teachHighlight",
            arguments: [JSON.parse(decodeURIComponent(teachArgs))],
          })
        );
      }
      lenses.push(
        new vscode.CodeLens(lensRange, {
          title: `✘ Dismiss`,
          command: "protege.clearHighlights",
        })
      );
    }
    return lenses;
  }
}

let highlightLensProvider: HighlightCodeLensProvider | null = null;

export function registerHighlightCodeLens(): vscode.Disposable {
  highlightLensProvider = new HighlightCodeLensProvider();
  return vscode.languages.registerCodeLensProvider({ scheme: "file" }, highlightLensProvider);
}

// Lesson-active flag — flipped by webviewHost when the chat response
// carries a lessonState with phase=TEACHING. The codelens reads this
// and renders a stripped-down lens (no "Teach me", no "Apply fix")
// during lessons, since the user is ALREADY being taught — those
// buttons just create recursive teach prompts that pull focus.
let lessonActive = false;
export function setLessonActive(active: boolean): void {
  if (lessonActive === active) return;
  lessonActive = active;
  // Refresh the codelens so the change takes effect on screens that
  // are currently rendering highlights.
  highlightLensProvider?.refresh();
}
function isLessonActive(): boolean {
  return lessonActive;
}

/** Pick the most descriptive field and cap it so the lens row never wraps.
 *  Keeps the first sentence only — CodeLens is a one-liner affordance, not
 *  a full explanation. Deeper detail lives in the hover card behind it. */
function shortSummary(
  issue: string | undefined,
  label: string | undefined,
  explanation: string | undefined
): string {
  const raw = (issue || label || explanation || "").trim();
  if (!raw) return "";
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] ?? raw;
  const MAX = 80;
  if (firstSentence.length <= MAX) return firstSentence;
  return firstSentence.slice(0, MAX - 1).trimEnd() + "…";
}

/** Codicon for the summary lens, matched to the highlight kind so the user
 *  can tell a bug from a tip without reading the text. */
function kindLensIcon(kind: HighlightKind): string {
  switch (kind) {
    case "bug":
      return "$(bug)";
    case "pattern":
      return "$(symbol-structure)";
    case "tip":
      return "$(lightbulb)";
    case "focus":
    default:
      return "$(target)";
  }
}
let highlightAutoTimer: ReturnType<typeof setTimeout> | null = null;

/** Auto-clear highlights after this many ms of inactivity. */
const HIGHLIGHT_AUTO_CLEAR_MS = 45_000;

function setHighlightContext() {
  vscode.commands.executeCommand(
    "setContext",
    "protege.hasHighlights",
    activeHighlightFiles.size > 0
  );
}

function scheduleAutoClear() {
  if (highlightAutoTimer) clearTimeout(highlightAutoTimer);
  if (activeHighlightFiles.size === 0) return;
  highlightAutoTimer = setTimeout(async () => {
    highlightAutoTimer = null;
    await clearHighlights();
  }, HIGHLIGHT_AUTO_CLEAR_MS);
}

export function hasActiveHighlights(): boolean {
  return activeHighlightFiles.size > 0;
}

export function isFileHighlighted(uri: vscode.Uri): boolean {
  return activeHighlightFiles.has(uri.toString());
}

/**
 * True while a Protege tool (edit_file / create_file) is writing to a
 * file. The change listener in extension.ts skips clearing highlights
 * during these programmatic edits — they're expected, not user intent.
 */
let _protegeEditing = false;
export function isProtegeEditing(): boolean {
  return _protegeEditing;
}
function withProtegeEditing<T>(fn: () => Promise<T>): Promise<T> {
  _protegeEditing = true;
  return fn().finally(() => {
    // Keep the flag true for one animation frame after the edit resolves
    // so the onDidChangeTextDocument event (which fires async) still sees it.
    setTimeout(() => {
      _protegeEditing = false;
    }, 100);
  });
}
export { withProtegeEditing };

const HIGHLIGHT_STYLES: Record<HighlightKind, { bg: string; border: string }> = {
  focus:   { bg: "rgba(124, 229, 179, 0.14)", border: "#7ce5b3" }, // green
  bug:     { bg: "rgba(255, 143, 168, 0.17)", border: "#ff6fa8" }, // rose
  pattern: { bg: "rgba(74, 158, 255, 0.16)",  border: "#4a9eff" }, // electric
  tip:     { bg: "rgba(255, 215, 128, 0.14)", border: "#ffcf5c" }, // gold
};

const HIGHLIGHT_DECORATIONS: Record<HighlightKind, vscode.TextEditorDecorationType> =
  Object.fromEntries(
    (Object.entries(HIGHLIGHT_STYLES) as Array<[HighlightKind, { bg: string; border: string }]>).map(
      ([kind, { bg, border }]) => [
        kind,
        vscode.window.createTextEditorDecorationType({
          backgroundColor: bg,
          borderWidth: "0 0 0 3px",
          borderStyle: "solid",
          borderColor: border,
          isWholeLine: true,
          overviewRulerColor: border,
          overviewRulerLane: vscode.OverviewRulerLane.Full,
        }),
      ]
    )
  ) as Record<HighlightKind, vscode.TextEditorDecorationType>;

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  try {
    const content = await dispatch(call);
    return { id: call.id, name: call.name, content };
  } catch (err) {
    return {
      id: call.id,
      name: call.name,
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dispatch(call: ToolCall): Promise<string> {
  switch (call.name) {
    case "read_file":
      return readFile(String(call.arguments.path ?? ""));
    case "list_files":
      return listFiles(
        call.arguments.pattern ? String(call.arguments.pattern) : undefined,
        typeof call.arguments.limit === "number" ? call.arguments.limit : 100
      );
    case "grep":
      return grep(
        String(call.arguments.pattern ?? ""),
        call.arguments.glob ? String(call.arguments.glob) : undefined,
        typeof call.arguments.limit === "number"
          ? call.arguments.limit
          : MAX_GREP_RESULTS
      );
    case "show_code":
      return showCode(
        String(call.arguments.path ?? ""),
        Number(call.arguments.startLine ?? 1),
        Number(call.arguments.endLine ?? 1)
      );
    case "highlight_code":
      return highlightCode(
        (call.arguments.regions as HighlightRegion[] | undefined) ?? []
      );
    case "clear_highlights":
      return clearHighlights();
    case "create_scratch_file":
      return createScratchFile(
        String(call.arguments.name ?? ""),
        String(call.arguments.content ?? ""),
        call.arguments.explanation ? String(call.arguments.explanation) : undefined
      );
    case "run_file":
      return runFile(String(call.arguments.path ?? ""));
    case "edit_file":
      return withProtegeEditing(() =>
        editFile(
          String(call.arguments.path ?? ""),
          String(call.arguments.oldString ?? ""),
          String(call.arguments.newString ?? ""),
          Boolean(call.arguments.replaceAll)
        )
      );
    case "teach_step": {
      const { runTeachStep } = await import("../teaching/teachingStep.js");
      // Double cast via `unknown` — the Anthropic tool args arrive as
      // `Record<string, unknown>` and don't overlap TeachStepArgs' shape
      // at the type level. Runtime validation happens inside runTeachStep.
      return runTeachStep(
        call.arguments as unknown as Parameters<typeof runTeachStep>[0]
      );
    }
    case "create_file":
      return "This tool has been disabled. Teach through chat responses instead.";
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

function resolveUri(pathLike: string): vscode.Uri {
  if (!pathLike) throw new Error("path is required");
  if (pathLike.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathLike)) {
    return vscode.Uri.file(pathLike);
  }
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error("no workspace open");
  return vscode.Uri.joinPath(root.uri, pathLike);
}

/* ========== read / list / grep ========== */

async function readFile(pathLike: string): Promise<string> {
  const uri = resolveUri(pathLike);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  if (text.length > MAX_FILE_BYTES) {
    return (
      text.slice(0, MAX_FILE_BYTES) +
      `\n\n/* … truncated, file is ${text.length} bytes, showed first ${MAX_FILE_BYTES} … */`
    );
  }
  // Prepend line numbers so the model can reference lines accurately
  return numberLines(text);
}

function numberLines(text: string): string {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width, " ")}  ${l}`)
    .join("\n");
}

async function listFiles(pattern = "**/*", limit = 100): Promise<string> {
  const files = await vscode.workspace.findFiles(
    pattern,
    "**/{node_modules,dist,build,.next,.turbo,.git,coverage,out}/**",
    limit
  );
  const rels = files.map((u) => vscode.workspace.asRelativePath(u));
  if (rels.length === 0) return `(no files matched "${pattern}")`;
  return rels.join("\n");
}

async function grep(
  pattern: string,
  glob = "**/*",
  limit = MAX_GREP_RESULTS
): Promise<string> {
  if (!pattern) throw new Error("grep pattern is required");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regex: ${String(e)}`);
  }

  const files = await vscode.workspace.findFiles(
    glob,
    "**/{node_modules,dist,build,.next,.turbo,.git,coverage,out}/**",
    500
  );

  const hits: string[] = [];
  outer: for (const uri of files) {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder().decode(bytes);
    } catch {
      continue;
    }
    if (text.length > 500_000) continue; // skip huge binaries/minified
    const lines = text.split("\n");
    const rel = vscode.workspace.asRelativePath(uri);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}  ${lines[i].slice(0, 200)}`);
        if (hits.length >= limit) break outer;
      }
    }
  }

  if (hits.length === 0) return `(no matches for /${pattern}/ in ${glob})`;
  return `${hits.length} match${hits.length === 1 ? "" : "es"}:\n${hits.join("\n")}`;
}

/* ========== highlight ========== */

export interface HighlightRegion {
  path: string;
  startLine: number;
  endLine: number;
  kind?: HighlightKind;
  label?: string;
  issue?: string;
  fix?: string;
  explanation?: string;
  /**
   * Verification anchor — a short, unique substring that MUST appear on the
   * highlighted start line. The model is required to include this so we can
   * detect off-by-N mistakes and snap to the correct line (or refuse to paint
   * if the anchor doesn't exist). Without this guard the model regularly
   * lands highlights on the wrong line and we have no way to know.
   */
  anchor?: string;
}

/**
 * Verify the anchor against the model's claimed line and return the corrected
 * 0-indexed start line. Returns null if the anchor genuinely cannot be located
 * in a small window around the claim — in that case we drop the region rather
 * than paint somewhere wrong.
 *
 * If no anchor is supplied we trust the model (legacy behavior). The persona
 * prompt will start asking for an anchor on every region, but older cached
 * tool calls + the teach_step path don't always set it.
 */
const ANCHOR_SEARCH_WINDOW = 8;
function resolveAnchorLine(
  doc: vscode.TextDocument,
  claimedZeroIdx: number,
  anchor: string | undefined
): number | null {
  if (!anchor) return claimedZeroIdx;
  const target = anchor.trim();
  if (!target) return claimedZeroIdx;

  const inBounds = (i: number) => i >= 0 && i < doc.lineCount;
  // Fast path — the model was right.
  if (inBounds(claimedZeroIdx) && doc.lineAt(claimedZeroIdx).text.includes(target)) {
    return claimedZeroIdx;
  }
  // Search outward from the claim — closer matches win.
  for (let delta = 1; delta <= ANCHOR_SEARCH_WINDOW; delta++) {
    for (const idx of [claimedZeroIdx - delta, claimedZeroIdx + delta]) {
      if (!inBounds(idx)) continue;
      if (doc.lineAt(idx).text.includes(target)) return idx;
    }
  }
  return null;
}

/** Exported alias so the teach_step tool can reuse the same highlight
 *  pipeline without duplicating decoration/hover logic. */
export { highlightCode as highlightCodeForTeaching };

async function highlightCode(regions: HighlightRegion[]): Promise<string> {
  if (!regions || regions.length === 0) {
    return "no regions provided";
  }

  // Clear previous highlights across all kinds / all visible editors.
  await clearHighlights();

  // Group by (uri, kind)
  const groups = new Map<
    string,
    {
      uri: vscode.Uri;
      kind: HighlightKind;
      options: vscode.DecorationOptions[];
    }
  >();

  const skipped: Array<{ path: string; anchor: string; claimedLine: number }> = [];
  for (const r of regions) {
    const kind: HighlightKind = r.kind && r.kind in HIGHLIGHT_DECORATIONS ? r.kind : "focus";
    const uri = resolveUri(r.path);
    const key = `${uri.toString()}|${kind}`;
    const doc = await vscode.workspace.openTextDocument(uri);
    const claimedStart = Math.max(0, (r.startLine | 0) - 1);
    const claimedEnd = Math.max(claimedStart, (r.endLine | 0) - 1);

    // Anchor check — if the model supplied one, snap the range when its
    // line drifted, or refuse to paint if the anchor isn't in this file
    // anywhere near the claim. Multi-line ranges shift as a block by the
    // same delta as the start line, so spans stay intact. Done BEFORE the
    // group is created so a fully-rejected file doesn't end up in
    // activeHighlightFiles with zero options.
    const correctedStart = resolveAnchorLine(doc, claimedStart, r.anchor);
    if (correctedStart === null) {
      skipped.push({
        path: r.path,
        anchor: r.anchor ?? "",
        claimedLine: r.startLine,
      });
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, { uri, kind, options: [] });
    }
    const delta = correctedStart - claimedStart;
    const startIdx = correctedStart;
    const endIdx = Math.max(startIdx, claimedEnd + delta);
    const lineEnd = doc.lineAt(Math.min(endIdx, doc.lineCount - 1));
    // Final 1-indexed range for the model + downstream consumers (hover
    // card, lens commands). Use the corrected lines, NOT the claim.
    const correctedStartLine = startIdx + 1;
    const correctedEndLine = endIdx + 1;
    // End column = MAX_SAFE_INTEGER so the wash extends across the full
    // editor width, not just to the last visible character. `isWholeLine`
    // alone wasn't reliably painting past end-of-text for the bordered kinds.
    const range = new vscode.Range(
      startIdx,
      0,
      lineEnd.lineNumber,
      Number.MAX_SAFE_INTEGER
    );

    const label = r.label?.trim();
    // Corrected range goes into the hover so its embedded action links
    // (Fix it for me, Teach me more) target the line the highlight is
    // actually painted on — not the model's pre-snap claim.
    const hover = buildRichHover(kind, label, r.issue, r.fix, r.explanation, {
      path: r.path,
      startLine: correctedStartLine,
      endLine: correctedEndLine,
    });

    // Hover stays (discoverability on mouseover); the right-side italic
    // `← <tag>` after-decoration is gone — replaced by a proper CodeLens
    // row above the line (see HighlightCodeLensProvider) with directly
    // clickable Apply / Teach / Dismiss actions. The hover is now the
    // deep-detail layer; the CodeLens is the primary action surface.
    const opt: vscode.DecorationOptions = { range, hoverMessage: hover };

    groups.get(key)!.options.push(opt);

    // Track metadata so the CodeLens provider can render actions above
    // this range. Keyed by URI; each URI can have multiple regions.
    const uriKey = uri.toString();
    let bucket = activeHighlightMeta.get(uriKey);
    if (!bucket) {
      bucket = [];
      activeHighlightMeta.set(uriKey, bucket);
    }
    bucket.push({
      range,
      kind,
      label,
      issue: r.issue,
      fix: r.fix,
      explanation: r.explanation,
      meta: {
        path: r.path,
        startLine: correctedStartLine,
        endLine: correctedEndLine,
      },
    });
  }
  highlightLensProvider?.refresh();

  // Apply per-file + reveal first region
  let firstShown: { editor: vscode.TextEditor; range: vscode.Range } | undefined;
  for (const group of groups.values()) {
    const doc = await vscode.workspace.openTextDocument(group.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
    });
    editor.setDecorations(HIGHLIGHT_DECORATIONS[group.kind], group.options);
    activeHighlightFiles.add(group.uri.toString());
    if (!firstShown && group.options.length > 0) {
      firstShown = { editor, range: group.options[0].range };
    }
  }
  setHighlightContext();
  scheduleAutoClear();

  if (firstShown) {
    firstShown.editor.revealRange(
      firstShown.range,
      vscode.TextEditorRevealType.InCenter
    );
    // Move the cursor to the start of the highlighted range so VS Code's
    // native hover popup has an anchor point, then trigger it. This makes
    // the rich tooltip appear immediately — no need for the user to hover.
    try {
      const start = firstShown.range.start;
      firstShown.editor.selection = new vscode.Selection(start, start);
      // Slight delay so setDecorations has flushed before showHover runs
      setTimeout(() => {
        vscode.commands.executeCommand("editor.action.showHover").then(
          () => {},
          () => {}
        );
      }, 120);
    } catch {}
  }

  const placed = regions.length - skipped.length;
  // When EVERY region failed anchor verification, the user sees zero
  // highlights in their editor but the chat chip would still flash ✓
  // "Highlighting code". That's a lie. Throw so the chip flips to ✗ and
  // the model gets a clear retry signal in the error message.
  if (placed === 0 && skipped.length > 0) {
    const detail = skipped
      .map(
        (s) =>
          `· ${s.path}:${s.claimedLine} — anchor ${
            s.anchor ? JSON.stringify(s.anchor) : "(missing)"
          } not found near that line`
      )
      .join("\n");
    throw new Error(
      `highlight_code placed 0 regions — every anchor failed verification:\n${detail}\nRe-issue with a unique substring copied verbatim from the target line.`
    );
  }
  let summary = `Highlighted ${placed} region${
    placed === 1 ? "" : "s"
  } across ${groups.size} file${groups.size === 1 ? "" : "s"}`;
  if (skipped.length > 0) {
    // Some succeeded, some failed. Tell the model which dropped so it can
    // retry the failed ones with a correct anchor.
    const detail = skipped
      .map(
        (s) =>
          `· ${s.path}:${s.claimedLine} — anchor ${
            s.anchor ? JSON.stringify(s.anchor) : "(missing)"
          } not found near that line`
      )
      .join("\n");
    summary += `\nSkipped ${skipped.length} region${
      skipped.length === 1 ? "" : "s"
    } (anchor verification failed):\n${detail}\nRe-issue these with a unique substring from the actual line.`;
  }
  return summary;
}

// ---- Inline tag derivation ----
//
// Inline decorations can't wrap — VS Code's `after.contentText` is single-
// line. Long `issue` messages (full sentences) get cut off on any real
// screen. Keep the inline useful by emitting a punchy 3–5 word *tag* and
// leaving the sentence for the hover and the full paragraph for the thread.
//
// Preference order:
//   1. `label` — the chat tool's short annotation (already punchy)
//   2. first ≤5 words of `issue`, stripped of filler verbs like "Using",
//      "Don't", "This", "The" etc. that usually open a sentence
//   3. first sentence of `issue`, capped at 40 chars

/**
 * Build a rich MarkdownString hover — this is what VS Code pops up when
 * the user (or we programmatically) trigger the hover at the highlighted
 * line. Looks like the native HTML docs tooltip: bold header with codicon,
 * horizontal rule, explanation body, then action links at the bottom.
 */
function buildRichHover(
  kind: HighlightKind,
  label: string | undefined,
  issue: string | undefined,
  fix: string | undefined,
  explanation: string | undefined,
  meta: { path: string; startLine: number; endLine: number }
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = false;

  const icon = kindIcon(kind);
  const title = kindTitle(kind);
  md.appendMarkdown(`### ${icon} Protege — ${title}\n\n`);

  // Issue / what's wrong
  if (issue) {
    md.appendMarkdown(`**What's happening:** ${escapeMd(issue)}\n\n`);
  } else if (label) {
    md.appendMarkdown(`${escapeMd(label)}\n\n`);
  }

  // Fix / suggested code
  if (fix) {
    md.appendMarkdown(`**Suggested fix:**\n\n`);
    md.appendCodeblock(fix, "");
    md.appendMarkdown(`\n`);
  }

  // Explanation / why it matters
  if (explanation) {
    md.appendMarkdown(`**Why it matters:** ${escapeMd(explanation)}\n\n`);
  }

  md.appendMarkdown(`---\n\n`);

  // Action bar
  const actions: string[] = [];
  if (fix) {
    const fixArgs = encodeURIComponent(JSON.stringify({
      path: meta.path,
      startLine: meta.startLine,
      endLine: meta.endLine,
      fix,
    }));
    actions.push(`[$(wrench) Fix it for me](command:protege.applyFix?${fixArgs})`);
  }
  // Full payload — same shape as the CodeLens click, so the teach handler
  // can quote real code and run the two-way checkpoint flow regardless of
  // whether the user came from the hover or the lens.
  const teachArgs = encodeURIComponent(JSON.stringify({
    kind,
    label: label ?? "",
    issue: issue ?? "",
    fix: fix ?? "",
    explanation: explanation ?? "",
    path: meta.path,
    startLine: meta.startLine,
    endLine: meta.endLine,
  }));
  actions.push(`[$(comment-discussion) Teach me more](command:protege.teachHighlight?${teachArgs})`);
  actions.push(`[$(close) Clear](command:protege.clearHighlights)`);
  md.appendMarkdown(actions.join(" · "));

  return md;
}

function kindTitle(kind: HighlightKind): string {
  switch (kind) {
    case "focus":
      return "Focus";
    case "bug":
      return "Bug";
    case "pattern":
      return "Pattern";
    case "tip":
      return "Tip";
  }
}

async function clearHighlights(): Promise<string> {
  for (const editor of vscode.window.visibleTextEditors) {
    for (const kind of Object.keys(HIGHLIGHT_DECORATIONS) as HighlightKind[]) {
      try {
        editor.setDecorations(HIGHLIGHT_DECORATIONS[kind], []);
      } catch {}
    }
  }
  activeHighlightFiles.clear();
  activeHighlightMeta.clear();
  highlightLensProvider?.refresh();
  setHighlightContext();
  return "cleared";
}

/**
 * Public wrapper so outside callers (webviewHost) can wipe highlights
 * between turns. "Highlights stay forever" was a real UX bug — this
 * lets the chat loop clear them before each new user message, so every
 * turn starts with a fresh canvas.
 */
export async function clearAllHighlights(): Promise<void> {
  await clearHighlights();
}

function kindIcon(kind: HighlightKind): string {
  // Uses VS Code codicons in hover MarkdownString — they render inline as SVG.
  switch (kind) {
    case "focus":
      return "$(target)";
    case "bug":
      return "$(bug)";
    case "pattern":
      return "$(symbol-class)";
    case "tip":
      return "$(lightbulb)";
  }
}

function escapeMd(s: string): string {
  return s.replace(/([*_`~])/g, "\\$1");
}

/* ========== show ========== */

async function showCode(
  pathLike: string,
  startLine: number,
  endLine: number
): Promise<string> {
  const uri = resolveUri(pathLike);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
  });
  const start = Math.max(0, (startLine | 0) - 1);
  const end = Math.max(start, (endLine | 0) - 1);
  const lineEnd = doc.lineAt(Math.min(end, doc.lineCount - 1));
  const range = new vscode.Range(start, 0, lineEnd.lineNumber, lineEnd.text.length);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  // Soft flash the range so the user notices
  flash(editor, [range], showFlashDecoration, 1800);
  return `Highlighted ${pathLike} lines ${startLine}-${endLine}`;
}

/* ========== edit / create ========== */

/**
 * Accept gate — when the AI calls edit_file, the user must accept the
 * proposed edit before it's written. Silent auto-writes were the cause of
 * a real incident where a teaching question refactored a live file
 * without consent. The only way to bypass the prompt is for the user to
 * explicitly enable `protege.autoAcceptEdits` in settings (or click
 * "Always accept" in the modal, which flips the same setting).
 */
function isAutoAcceptOn(): boolean {
  return (
    vscode.workspace
      .getConfiguration("protege")
      .get<boolean>("autoAcceptEdits", false) === true
  );
}

async function setAutoAcceptOn(): Promise<void> {
  await vscode.workspace
    .getConfiguration("protege")
    .update("autoAcceptEdits", true, vscode.ConfigurationTarget.Global);
}

/** Build a short side-by-side snippet for the accept modal. */
function buildDiffPreview(oldString: string, newString: string): string {
  const MAX_LINES = 8;
  const MAX_CHARS = 280;
  const clipBlock = (s: string): string => {
    const lines = s.split("\n");
    const clipped = lines.slice(0, MAX_LINES).join("\n");
    const more = lines.length > MAX_LINES ? `\n… (+${lines.length - MAX_LINES} more lines)` : "";
    const full = clipped + more;
    if (full.length > MAX_CHARS) return full.slice(0, MAX_CHARS - 1) + "…";
    return full;
  };
  return `BEFORE:\n${clipBlock(oldString)}\n\nAFTER:\n${clipBlock(newString)}`;
}

async function confirmEditWithUser(
  pathLike: string,
  oldString: string,
  newString: string
): Promise<"accept" | "reject"> {
  if (isAutoAcceptOn()) return "accept";

  const ACCEPT = "Accept";
  const REJECT = "Reject";
  const ALWAYS = "Always accept";

  const choice = await vscode.window.showInformationMessage(
    `Protege wants to edit ${pathLike}`,
    {
      modal: true,
      detail: buildDiffPreview(oldString, newString),
    },
    ACCEPT,
    ALWAYS,
    REJECT
  );

  if (choice === ALWAYS) {
    await setAutoAcceptOn();
    vscode.window.setStatusBarMessage(
      "$(check) Protege edits will now auto-accept — toggle off via: Protege: Toggle Auto-Accept Edits",
      5000
    );
    return "accept";
  }
  if (choice === ACCEPT) return "accept";
  return "reject";
}

async function editFile(
  pathLike: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<string> {
  if (!oldString) throw new Error("oldString is required");
  const uri = resolveUri(pathLike);
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();

  const edit = new vscode.WorkspaceEdit();
  const changedRanges: vscode.Range[] = [];

  if (replaceAll) {
    const parts = text.split(oldString);
    if (parts.length === 1) {
      throw new Error(`oldString not found in ${pathLike}`);
    }

    // Gate the write on explicit user acceptance.
    const decision = await confirmEditWithUser(pathLike, oldString, newString);
    if (decision === "reject") {
      throw new Error(
        `User rejected the proposed edit to ${pathLike}. Do not retry automatically — ask them what they want to change before proposing another edit.`
      );
    }

    const newText = parts.join(newString);
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(text.length)
    );
    edit.replace(uri, fullRange, newText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) throw new Error(`applyEdit failed for ${pathLike}`);
    await doc.save();
    const count = parts.length - 1;
    // Can't flash specific ranges easily in replaceAll mode — flash whole doc briefly
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri.toString()
    );
    if (editor) {
      const all = new vscode.Range(0, 0, doc.lineCount, 0);
      flash(editor, [all], editFlashDecoration, 1200);
    }
    return `Edited ${pathLike} — replaced ${count} occurrence${count === 1 ? "" : "s"}`;
  }

  const idx = text.indexOf(oldString);
  if (idx === -1) throw new Error(`oldString not found in ${pathLike}`);
  const second = text.indexOf(oldString, idx + 1);
  if (second !== -1) {
    throw new Error(
      `oldString appears more than once in ${pathLike}; include more context or set replaceAll=true`
    );
  }

  // Gate the write on explicit user acceptance.
  const decision = await confirmEditWithUser(pathLike, oldString, newString);
  if (decision === "reject") {
    throw new Error(
      `User rejected the proposed edit to ${pathLike}. Do not retry automatically — ask them what they want to change before proposing another edit.`
    );
  }

  const startPos = doc.positionAt(idx);
  const endPos = doc.positionAt(idx + oldString.length);
  const range = new vscode.Range(startPos, endPos);
  edit.replace(uri, range, newString);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) throw new Error(`applyEdit failed for ${pathLike}`);
  await doc.save();

  // Compute new range for flash (use the new string's length)
  const newLines = newString.split("\n");
  const endLine = startPos.line + (newLines.length - 1);
  const endCol = newLines.length === 1
    ? startPos.character + newString.length
    : (newLines[newLines.length - 1]?.length ?? 0);
  const flashRange = new vscode.Range(startPos.line, 0, endLine, endCol);

  // Open the file so the user can see what changed
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
  });
  editor.revealRange(flashRange, vscode.TextEditorRevealType.InCenter);
  flash(editor, [flashRange], editFlashDecoration, 1800);

  changedRanges.push(flashRange);
  return `Edited ${pathLike} at line ${startPos.line + 1}`;
}

async function createFile(
  pathLike: string,
  content: string
): Promise<string> {
  const uri = resolveUri(pathLike);
  // Check existence
  try {
    await vscode.workspace.fs.stat(uri);
    throw new Error(`${pathLike} already exists — use edit_file to modify it`);
  } catch (e) {
    // File does not exist — good.
    if (e instanceof Error && e.message.includes("already exists")) throw e;
  }

  // Create parent dirs via WorkspaceEdit's createFile
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { ignoreIfExists: false });
  edit.insert(uri, new vscode.Position(0, 0), content);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) throw new Error(`create failed for ${pathLike}`);

  const doc = await vscode.workspace.openTextDocument(uri);
  await doc.save();
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
  });
  const lineCount = content.split("\n").length;
  const range = new vscode.Range(0, 0, lineCount, 0);
  flash(editor, [range], editFlashDecoration, 1800);

  return `Created ${pathLike} — ${lineCount} lines`;
}

function flash(
  editor: vscode.TextEditor,
  ranges: vscode.Range[],
  decoration: vscode.TextEditorDecorationType,
  ms: number
) {
  editor.setDecorations(decoration, ranges);
  setTimeout(() => {
    try {
      editor.setDecorations(decoration, []);
    } catch {}
  }, ms);
}

/* ========== scratch files & code execution (mentor layer) ========== */

async function createScratchFile(
  name: string,
  content: string,
  explanation?: string
): Promise<string> {
  if (!name) throw new Error("name is required");
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error("no workspace open");

  const scratchDir = vscode.Uri.joinPath(root.uri, ".protege", "lessons");
  try {
    await vscode.workspace.fs.createDirectory(scratchDir);
  } catch {}

  // Sanitize name, collapse unsafe chars, keep extension
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");

  let uri = vscode.Uri.joinPath(scratchDir, safeName);
  let finalName = safeName;

  // If exists, append short timestamp before the extension
  try {
    await vscode.workspace.fs.stat(uri);
    const dot = safeName.lastIndexOf(".");
    const base = dot === -1 ? safeName : safeName.slice(0, dot);
    const ext = dot === -1 ? "" : safeName.slice(dot);
    const ts = Date.now().toString(36).slice(-5);
    finalName = `${base}-${ts}${ext}`;
    uri = vscode.Uri.joinPath(scratchDir, finalName);
  } catch {
    // doesn't exist — good
  }

  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
  });
  const range = new vscode.Range(0, 0, doc.lineCount, 0);
  flash(editor, [range], editFlashDecoration, 2000);

  const relPath = `.protege/lessons/${finalName}`;
  const lineCount = content.split("\n").length;
  const suffix = explanation ? ` — ${explanation}` : "";
  return `Created ${relPath} (${lineCount} lines)${suffix}`;
}

interface RunFileResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 10_000
): Promise<RunFileResult> {
  return new Promise((resolve) => {
    let finished = false;
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    const MAX_OUT = 8000;

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUT) stdout = stdout.slice(0, MAX_OUT) + "\n…(truncated)";
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUT) stderr = stderr.slice(0, MAX_OUT) + "\n…(truncated)";
    });

    const timer = setTimeout(() => {
      if (!finished) {
        try {
          child.kill("SIGKILL");
        } catch {}
        finished = true;
        resolve({ stdout, stderr, exitCode: null, timedOut: true });
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1, timedOut: false });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });
  });
}

async function runFile(pathLike: string): Promise<string> {
  const uri = resolveUri(pathLike);
  const fsPath = uri.fsPath;

  // Safety: must live inside the workspace
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !fsPath.startsWith(root)) {
    throw new Error("refusing to run files outside the workspace");
  }

  const ext = fsPath.split(".").pop()?.toLowerCase() ?? "";
  let cmd: string;
  let args: string[];
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      cmd = "node";
      args = [fsPath];
      break;
    case "ts":
    case "tsx":
      cmd = "npx";
      args = ["--yes", "tsx", fsPath];
      break;
    case "py":
      cmd = "python3";
      args = [fsPath];
      break;
    case "sh":
    case "bash":
      cmd = "bash";
      args = [fsPath];
      break;
    default:
      throw new Error(`unsupported file type: .${ext} (supported: js, mjs, cjs, ts, tsx, py, sh)`);
  }

  const result = await runProcess(cmd, args, root, 10_000);
  const parts: string[] = [];
  if (result.timedOut) parts.push("⚠ timed out after 10s");
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  parts.push(`exit: ${result.exitCode ?? "killed"}`);
  return parts.join("\n\n");
}

/* ========== workspace context ========== */

export async function buildWorkspaceContext(): Promise<WorkspaceContext> {
  const editor = getActiveFileEditor();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const activeFile = editor
    ? {
        path: vscode.workspace.asRelativePath(editor.document.uri),
        language: editor.document.languageId,
        content: editor.document.getText().slice(0, 8000),
        selection: !editor.selection.isEmpty
          ? editor.document.getText(editor.selection)
          : undefined,
      }
    : undefined;

  let fileTree: string[] = [];
  try {
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,dist,build,.next,.turbo,.git,coverage,out}/**",
      120
    );
    fileTree = uris.map((u) => vscode.workspace.asRelativePath(u));
  } catch {}

  return { root, activeFile, fileTree };
}
