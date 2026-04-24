import * as vscode from "vscode";
import { detectConcepts } from "./detector.js";
import { log } from "../log.js";

/**
 * Concept Trail — ambient visualization of what the user is learning.
 *
 * As the user types, we detect concepts via the existing rule engine.
 * The FIRST time a concept shows up in a given file this session, we
 * drop a subtle blue dot in the gutter on the line where it appears.
 * Hovering the dot shows a tiny Markdown card with a "Learn more" link.
 *
 * No voice, no popup, no notification. Purely peripheral — the user
 * sees their own trail as they type. Move 4 of
 * ~/.claude/plans/learn-in-flow-audit.md.
 *
 * Session-scoped: the trail clears on window reload. That's intentional
 * — starting a fresh session shouldn't show a mega-trail for code the
 * user wrote months ago. The dots only appear for concepts that
 * materialized DURING this session.
 */

const DEBOUNCE_MS = 1500;

const SUPPORTED_LANGS = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "go", "rust", "java", "csharp", "cpp", "c", "ruby",
  "php", "swift", "kotlin", "scala", "vue", "svelte",
]);

// Tiny blue dot — subtle against common editor themes. Base64 encodes an
// SVG circle so we don't ship a binary asset. Two variants so the dot
// stays visible on both dark + light themes (VS Code auto-picks by theme
// kind when we pass an object with { light, dark }).
const SVG_DOT = (fill: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="2.2" fill="${fill}" opacity="0.9"/></svg>`
  ).toString("base64")}`;

// Per-file map: line index → set of concepts whose first appearance is
// anchored to that line. Used by both the decoration renderer and the
// hover provider.
const lineToConcepts = new Map<string, Map<number, Set<string>>>();
// Per-file set of concepts already dotted in this session. Prevents a
// concept from hopping to a new line if the user moves code around.
const sessionSeen = new Map<string, Set<string>>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

let decoration: vscode.TextEditorDecorationType | null = null;

export function registerConceptTrail(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  decoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.parse(SVG_DOT("#5a7fb5")),
    gutterIconSize: "contain",
    // VS Code supports theme-variant icons via light/dark keys. Slightly
    // brighter fill on dark themes, slightly deeper on light.
    dark: {
      gutterIconPath: vscode.Uri.parse(SVG_DOT("#7ba3d8")),
    },
    light: {
      gutterIconPath: vscode.Uri.parse(SVG_DOT("#3b5a85")),
    },
  });
  disposables.push(decoration);

  disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      if (!SUPPORTED_LANGS.has(e.document.languageId)) return;
      scheduleRefresh(e.document);
    })
  );

  disposables.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      if (!SUPPORTED_LANGS.has(doc.languageId)) return;
      scheduleRefresh(doc);
    })
  );

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      // Re-render decorations when switching to a file that already
      // has trail dots — each editor has its own decoration surface.
      renderDecorations(editor);
    })
  );

  // Initial pass for any already-open editors so the trail starts
  // populating immediately without requiring a keystroke first.
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== "file") continue;
    if (!SUPPORTED_LANGS.has(editor.document.languageId)) continue;
    scheduleRefresh(editor.document);
  }

  disposables.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        async provideHover(doc, pos) {
          const lineMap = lineToConcepts.get(doc.uri.toString());
          const concepts = lineMap?.get(pos.line);
          if (!concepts || concepts.size === 0) return;
          // Don't double-stack with the underline-whisper hover. If the
          // line already has a Suggestion, the whisper card carries the
          // teach link and richer context — showing the trail card too
          // would render two "Teach me" entries in the same popup, which
          // is exactly the duplicated-action UX the user flagged.
          const { findSuggestionAtLine } = await import("../review/liveReview.js");
          if (findSuggestionAtLine(doc.uri.toString(), pos.line)) return;
          return new vscode.Hover(buildHoverCard(concepts), doc.lineAt(pos.line).range);
        },
      }
    )
  );

  disposables.push({
    dispose() {
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      lineToConcepts.clear();
      sessionSeen.clear();
      decoration = null;
    },
  });

  return disposables;
}

function scheduleRefresh(doc: vscode.TextDocument): void {
  const uri = doc.uri.toString();
  const prev = debounceTimers.get(uri);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    debounceTimers.delete(uri);
    try {
      refresh(doc);
    } catch (err) {
      log(
        "conceptTrail",
        `refresh failed ${shortName(doc.uri)} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, DEBOUNCE_MS);
  debounceTimers.set(uri, timer);
}

function refresh(doc: vscode.TextDocument): void {
  const uriKey = doc.uri.toString();
  const text = doc.getText();
  if (!text.trim()) return;

  const concepts = detectConcepts(doc.languageId, text);
  if (concepts.length === 0) return;

  const seen = sessionSeen.get(uriKey) ?? new Set<string>();
  const newOnes = concepts.filter((c) => !seen.has(c));
  if (newOnes.length === 0) {
    // No new concepts; just re-render in case the document shifted.
    renderAll(uriKey);
    return;
  }

  const lines = text.split("\n");
  const lineMap = lineToConcepts.get(uriKey) ?? new Map<number, Set<string>>();

  for (const concept of newOnes) {
    const idx = findFirstLineOf(concept, doc.languageId, lines);
    if (idx === null) continue;
    const atLine = lineMap.get(idx) ?? new Set<string>();
    atLine.add(concept);
    lineMap.set(idx, atLine);
    seen.add(concept);
  }

  sessionSeen.set(uriKey, seen);
  lineToConcepts.set(uriKey, lineMap);

  log(
    "conceptTrail",
    `trail ${shortName(doc.uri)} · new=${newOnes.length} · totalDotted=${seen.size}`
  );

  renderAll(uriKey);
}

/**
 * For each concept, find the first line in `lines` whose own text matches
 * that concept's rule patterns. Re-uses the existing `detectConcepts`
 * function per-line so rules stay single-sourced. O(lines × rules) per
 * new concept — only runs on first appearance, not every keystroke.
 */
function findFirstLineOf(
  concept: string,
  lang: string,
  lines: string[]
): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const hits = detectConcepts(lang, line);
    if (hits.includes(concept)) return i;
  }
  return null;
}

function renderAll(uriKey: string): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriKey) renderDecorations(editor);
  }
}

function renderDecorations(editor: vscode.TextEditor): void {
  if (!decoration) return;
  const uriKey = editor.document.uri.toString();
  const lineMap = lineToConcepts.get(uriKey);
  if (!lineMap || lineMap.size === 0) {
    editor.setDecorations(decoration, []);
    return;
  }
  const lineCount = editor.document.lineCount;
  const ranges: vscode.Range[] = [];
  for (const [line, concepts] of lineMap) {
    if (line < 0 || line >= lineCount) continue;
    // Cap the range at 0..0 so the dot sits on the start of the line
    // in the gutter without highlighting any text.
    const r = new vscode.Range(line, 0, line, 0);
    // hoverMessage would show when hovering anywhere in the range, but
    // we use a dedicated HoverProvider instead so the card can be richer
    // and only trigger when the user hovers the line itself.
    void concepts;
    ranges.push(r);
  }
  editor.setDecorations(decoration, ranges);
}

function buildHoverCard(concepts: Set<string>): vscode.MarkdownString {
  // Keep the card to a SINGLE line. User feedback: the previous two-row
  // card (title + blank + teach link) stacked too tall next to the
  // native TS hover. Now: "useState · $(book) teach" — concept names
  // bold, one clickable teach link at the end covering the first
  // concept. The dot's presence implies "first time this session" so we
  // drop the preamble.
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  const list = [...concepts];
  const parts = list.map((c) => `**${c}**`);
  const first = list[0];
  if (first) {
    const args = encodeURIComponent(JSON.stringify(first));
    parts.push(`[$(book) teach](command:protege.teachConcept?${args})`);
  }
  md.appendMarkdown(parts.join(" · "));
  return md;
}

function shortName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}
