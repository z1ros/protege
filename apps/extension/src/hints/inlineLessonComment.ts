import * as vscode from "vscode";
import { findSuggestionAtLine } from "../review/liveReview.js";
import type { Suggestion } from "../review/reviewEngine.js";
import { log } from "../log.js";

/**
 * Inline Lesson Comment — a multi-line decoration that LOOKS like a real
 * code comment block (C-family slash-star style, hash style for Python,
 * dash-dash for Lua) sitting between code lines. NOT a Comment Thread,
 * NOT a Problems-panel entry — just a visual overlay that reads like
 * the mentor dropped a comment into your file to explain what's going on.
 *
 * Why this exists: the user explicitly rejected VS Code's Comment Thread
 * bubble ("never show this dialog it is bad design") but wants a surface
 * that DOES show the full lesson inline — styled so it feels native to
 * the code, like a chunk of documentation the author left behind. This
 * is the third surface in the cascade: whisper (ambient) → hover
 * (teaser) → inline-lesson (full paragraph).
 *
 * How it works (the trick): VS Code doesn't have "insert a block between
 * lines" in the stable API. What it DOES have is `before.contentText`
 * with `\n` characters + a CSS `display: inline-block; white-space: pre`
 * injection via `textDecoration`. The result renders as a multi-line
 * text block BEFORE the finding line's content — visually equivalent to
 * inserting a comment block above.
 *
 * Cost: zero document changes. Undo history untouched. Decoration lives
 * purely in the editor render layer and disappears on dismiss / cursor
 * move.
 */

const MAX_BODY_LINES = 5;
const BODY_WRAP_WIDTH = 60;

/** One decoration type per active lesson so each can carry different
 *  contentText. VS Code reuses types efficiently — this isn't wasteful. */
interface ActiveLesson {
  type: vscode.TextEditorDecorationType;
  uri: string;
  line: number;
  editor: vscode.TextEditor;
}
const active = new Map<string, ActiveLesson>(); // key: uri
let leaveTimer: ReturnType<typeof setTimeout> | null = null;

// Pick comment markers per language. JS/TS/JSX/CSS use /* */, Python uses
// # lines, shell uses #, SQL uses --, etc. The user's file type decides
// the frame so the inline overlay feels native to what they're editing.
interface CommentStyle {
  open: string;
  line: string;
  close: string;
}
function commentStyleFor(languageId: string): CommentStyle {
  switch (languageId) {
    case "python":
    case "shellscript":
    case "ruby":
    case "yaml":
    case "toml":
      return { open: "#", line: "# ", close: "#" };
    case "sql":
    case "lua":
    case "haskell":
      return { open: "-- ─────", line: "-- ", close: "-- ─────" };
    case "html":
    case "xml":
    case "markdown":
      return { open: "<!-- ─────", line: "   ", close: "───── -->" };
    default:
      // C-family: js, ts, jsx, tsx, go, rust, java, c, cpp, php, css, scss
      return { open: "/* ─────", line: " * ", close: " * ───── */" };
  }
}

/**
 * Render the lesson comment for the given suggestion, anchored on the
 * finding line. Replaces any prior lesson on the same URI. Returns true
 * when something was drawn.
 */
export function showLessonComment(uri: string, line: number): boolean {
  const s = findSuggestionAtLine(uri, line);
  if (!s) {
    log("lessonComment", `show skip — no suggestion at ${shortUri(uri)}:${line}`);
    return false;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === uri
  );
  if (!editor) {
    log("lessonComment", `show skip — no visible editor for ${shortUri(uri)}`);
    return false;
  }

  // Drop any prior lesson for this doc before rendering the new one.
  closeLessonComment(uri);

  const style = commentStyleFor(editor.document.languageId);
  const contentText = buildCommentText(s, style);
  const indent = leadingWhitespace(editor.document.lineAt(s.range.start.line).text);
  const type = vscode.window.createTextEditorDecorationType({
    before: {
      contentText,
      color: "rgba(148, 192, 240, 0.78)",
      fontStyle: "italic",
      // The CSS hack that makes multi-line content actually render: VS Code
      // injects `textDecoration` as CSS on the `::before` pseudo-element.
      // `display: inline-block` + `white-space: pre` makes embedded `\n`
      // characters render as real line breaks. The padding keeps the
      // block visually offset from the code below.
      textDecoration: `none; display: inline-block; white-space: pre; padding: 0 0 4px ${indent.length}ch;`,
    },
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });
  const safeLine = Math.min(editor.document.lineCount - 1, s.range.start.line);
  const anchor = new vscode.Range(safeLine, 0, safeLine, 0);
  editor.setDecorations(type, [{ range: anchor }]);
  active.set(uri, { type, uri, line: safeLine, editor });

  log("lessonComment", `show ${shortUri(uri)}:${safeLine + 1} · ${s.ruleId}`);
  return true;
}

export function closeLessonComment(uri?: string): void {
  if (!uri) {
    for (const [k, info] of active) {
      try { info.type.dispose(); } catch {}
      active.delete(k);
    }
    return;
  }
  const info = active.get(uri);
  if (!info) return;
  try { info.type.dispose(); } catch {}
  active.delete(uri);
  log("lessonComment", `close ${shortUri(uri)}`);
}

export function hasLessonComment(uri: string): boolean {
  return active.has(uri);
}

// ---- Content builder ----

function buildCommentText(s: Suggestion, style: CommentStyle): string {
  const lines: string[] = [];
  const title = s.ruleId
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  lines.push(`${style.open}  PROTEGE · ${title.toUpperCase()}`);
  lines.push(style.line.trimEnd());

  const body = s.lesson && s.lesson.trim() ? s.lesson.trim() : s.message.trim();
  const wrapped = softWrap(body, BODY_WRAP_WIDTH).slice(0, MAX_BODY_LINES);
  for (const w of wrapped) {
    lines.push(`${style.line}${w}`);
  }
  if (softWrap(body, BODY_WRAP_WIDTH).length > MAX_BODY_LINES) {
    lines.push(`${style.line}… (click Fix or say "protege" for more)`);
  }

  if (s.fix && s.fix.trim()) {
    lines.push(style.line.trimEnd());
    lines.push(`${style.line}Fix: ${compactFix(s.fix.trim())}`);
  }

  lines.push(style.close);
  // Trailing newline so the actual code line appears directly BELOW the
  // comment block, not jammed against the close marker.
  return lines.join("\n") + "\n";
}

function softWrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length === 0) current = w;
    else if (current.length + 1 + w.length > width) {
      lines.push(current);
      current = w;
    } else current += " " + w;
  }
  if (current) lines.push(current);
  return lines;
}

function compactFix(fix: string): string {
  const firstLine = fix.split("\n")[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 79) + "…";
}

function leadingWhitespace(line: string): string {
  const m = /^\s*/.exec(line);
  return m ? m[0] : "";
}

function shortUri(uri: string): string {
  const m = uri.match(/[^/]+$/);
  return m ? m[0] : uri;
}

// ---- Registration ----

export function registerInlineLessonComment(
  _context: vscode.ExtensionContext
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Auto-close when the user moves the cursor away from the finding line.
  // 2 second grace so they can click ✕ / move INTO an action without the
  // comment vanishing mid-interaction.
  disposables.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const uri = e.textEditor.document.uri.toString();
      const info = active.get(uri);
      if (!info) return;
      const cursorLine = e.selections[0]?.active.line ?? -1;
      if (cursorLine === info.line) {
        if (leaveTimer) {
          clearTimeout(leaveTimer);
          leaveTimer = null;
        }
        return;
      }
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        const ed = vscode.window.activeTextEditor;
        const stillOff =
          !ed ||
          ed.document.uri.toString() !== uri ||
          ed.selection.active.line !== info.line;
        if (stillOff) closeLessonComment(uri);
      }, 2_000);
    })
  );

  // Clean up on editor switch — phantom lessons in bg editors look wrong
  // and the user can always re-open them by clicking Teach again.
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      for (const uri of Array.from(active.keys())) {
        if (uri !== activeUri) closeLessonComment(uri);
      }
    })
  );

  // ESC closes any open lesson — lightweight dismiss. Only active when a
  // lesson is on screen (context key below) so we don't steal Esc from
  // everything else.
  disposables.push(
    vscode.commands.registerCommand("protege.dismissLessonComment", () => {
      closeLessonComment();
    })
  );

  disposables.push(
    new vscode.Disposable(() => {
      if (leaveTimer) clearTimeout(leaveTimer);
      closeLessonComment();
    })
  );

  return disposables;
}
