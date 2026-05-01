import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@protege/types";
import { vscode, onHostMessage } from "./vscode.js";
import { IconPlus, IconX, IconBook } from "./icons.js";
import "./styles/notes.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
} from "@blocknote/core";
import { createBnHighlighter } from "./syntax/shikiHighlighter.js";

/**
 * Notes editor schema — identical to BN's default schema except:
 *   1. `codeBlock` is wired to the same Shiki + One Dark Pro highlighter
 *      the chat tab uses (token colors and chrome match).
 *   2. The MEDIA block specs (image, video, audio, file) are stripped.
 *      Notes is a text + code surface; embedding media there isn't a
 *      use case we want to support, and pulling them out of the schema
 *      automatically prunes them from the slash-menu under "MEDIA".
 *
 * Keeping this at module scope (not inside the component) means React
 * reuses the same schema across all renders and notes share BN's
 * internal grammar cache.
 */
const {
  audio: _audio,
  video: _video,
  image: _image,
  file: _file,
  ...textOnlyBlockSpecs
} = defaultBlockSpecs;
const notesSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...textOnlyBlockSpecs,
    codeBlock: createCodeBlockSpec({
      defaultLanguage: "text",
      // BN's `createHighlighter` expects `HighlighterGeneric<any, any>`;
      // our wrapper exposes `HighlighterCore` which is the parent type.
      // Cast through `unknown` rather than importing `@shikijs/types`
      // (not a direct dep of the webview).
      createHighlighter: createBnHighlighter as unknown as () => Promise<
        ReturnType<typeof createBnHighlighter> extends Promise<infer T>
          ? T
          : never
      >,
      // CRITICAL: BN's `getLanguageId` resolves `block.props.language`
      // by looking it up in this map — every entry needs to be here, or
      // its shiki plugin returns undefined and the tokens render as
      // plain text. Aliases let us accept VS Code's own language ids
      // (`typescriptreact` → `tsx`, `javascriptreact` → `jsx`) plus the
      // short fence labels we may have stamped on legacy notes.
      // The corresponding BN <select> dropdown is hidden in notes.css —
      // we just want the resolution map, not the UI affordance.
      supportedLanguages: {
        text: { name: "Plain Text", aliases: ["plain", "plaintext", "txt"] },
        typescript: { name: "TypeScript", aliases: ["ts"] },
        javascript: {
          name: "JavaScript",
          aliases: ["js", "mjs", "cjs"],
        },
        tsx: { name: "TSX", aliases: ["typescriptreact"] },
        jsx: { name: "JSX", aliases: ["javascriptreact"] },
        python: { name: "Python", aliases: ["py"] },
        html: { name: "HTML", aliases: ["htm", "xml", "svg", "markup"] },
        css: { name: "CSS" },
        scss: { name: "SCSS" },
        json: { name: "JSON" },
        yaml: { name: "YAML", aliases: ["yml"] },
        bash: {
          name: "Shell",
          aliases: ["sh", "zsh", "shell", "shellscript"],
        },
        markdown: { name: "Markdown", aliases: ["md"] },
        sql: { name: "SQL" },
        go: { name: "Go" },
        rust: { name: "Rust", aliases: ["rs"] },
        java: { name: "Java" },
        c: { name: "C" },
        cpp: { name: "C++", aliases: ["c++"] },
        csharp: { name: "C#", aliases: ["cs", "c#"] },
        php: { name: "PHP" },
        ruby: { name: "Ruby", aliases: ["rb"] },
        swift: { name: "Swift" },
        kotlin: { name: "Kotlin", aliases: ["kt"] },
      },
    }),
  },
});

/**
 * Notes tab — Notion-style WYSIWYG editor.
 *
 * Editor: BlockNote (built on ProseMirror). It ships the Notion-style
 * surface out of the box — slash menu, bubble (formatting) toolbar,
 * drag handles, paste handling, undo, code blocks, all of it. We just
 * mount `<BlockNoteView />`, hand it HTML on load, and read HTML back
 * on change.
 *
 * Storage: the host's `body` field stays a string of HTML. We convert
 * HTML ↔ blocks on each load/save via `editor.tryParseHTMLToBlocks`
 * and `editor.blocksToHTMLLossy`. Legacy markdown bodies are routed
 * through the same parser — BlockNote interprets `# foo` as a heading
 * the same way a markdown reader would.
 */

// ---------- Search helpers (shared with the rail) ------------------

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Strip HTML tags + decode common entities so search/snippet code
 *  sees plain text. Cheap regex pass — good enough for in-memory
 *  search across a few hundred notes; we don't need a real parser. */
function bodyToText(body: string): string {
  return body
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreNote(note: Note, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const title = note.title.toLowerCase();
  const body = bodyToText(note.body).toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    let tokScore = 0;
    if (title === tok) tokScore += 50;
    else if (title.startsWith(tok)) tokScore += 30;
    else if (title.includes(tok)) tokScore += 10;

    let bodyHits = 0;
    if (body.includes(tok)) {
      let i = body.indexOf(tok);
      while (i !== -1 && bodyHits < 5) {
        bodyHits += 1;
        i = body.indexOf(tok, i + tok.length);
      }
      tokScore += bodyHits;
    }

    if (tokScore === 0) return 0;
    score += tokScore;
  }
  const ageHours =
    (Date.now() - new Date(note.updatedAt).getTime()) / (1000 * 60 * 60);
  if (Number.isFinite(ageHours)) {
    score += Math.max(0, 1 - ageHours / 720);
  }
  return score;
}

function snippetForQuery(body: string, tokens: string[], maxLen = 80): string {
  const cleaned = bodyToText(body);
  if (!cleaned) return "Empty note";
  if (tokens.length === 0) return cleaned.slice(0, maxLen);

  const lower = cleaned.toLowerCase();
  let earliest = -1;
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest === -1) return cleaned.slice(0, maxLen);

  const start = Math.max(0, earliest - 20);
  const end = Math.min(cleaned.length, start + maxLen);
  let out = cleaned.slice(start, end);
  if (start > 0) out = "…" + out.slice(1);
  if (end < cleaned.length) out = out.slice(0, -1) + "…";
  return out;
}

function highlight(text: string, tokens: string[]): React.ReactNode {
  if (tokens.length === 0 || !text) return text;
  const set = new Set(tokens.map((t) => t.toLowerCase()));
  const sorted = [...set].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((part, i) => {
    if (set.has(part.toLowerCase())) {
      return (
        <mark key={i} className="notes-hit">
          {part}
        </mark>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

/** Heuristic: which Shiki/BlockNote language tag fits this snippet?
 *  Returns undefined if no strong signal — caller defaults to "text".
 *  Order matters: most specific signals first. We prefer false negatives
 *  (untagged code block) over false positives (wrong syntax highlight
 *  is more disorienting than no highlight). */
function detectLanguage(text: string): string | undefined {
  // Shebangs are unambiguous.
  if (/^#!.*\bpython\b/m.test(text)) return "python";
  if (/^#!.*\bnode\b/m.test(text)) return "javascript";
  if (/^#!.*\b(?:bash|sh|zsh)\b/m.test(text)) return "bash";

  // PHP open tag.
  if (/<\?php\b/.test(text)) return "php";

  // HTML doctype / <html> root (not JSX, which has component PascalCase).
  if (/^\s*<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text))
    return "html";

  // JSX/TSX hallmarks: closing tags or self-closing PascalCase components.
  const hasJsx =
    /<\/[A-Za-z][\w]*>/.test(text) || /<[A-Z][\w]*[\s/>]/.test(text);

  // TypeScript markers — type annotations, interfaces, generics, casts.
  const hasTs =
    /:\s*(?:string|number|boolean|any|void|unknown|never|null|undefined|Promise<|Record<|Map<|Set<|Array<|\w+\[\])\b/.test(
      text
    ) ||
    /\binterface\s+\w+/.test(text) ||
    /\btype\s+\w+\s*=/.test(text) ||
    /\bas\s+(?:string|number|boolean|const|\w+(?:\[\])?)\b/.test(text) ||
    /<\w+(?:\s*,\s*\w+)*>\s*\(/.test(text);

  // Generic JS hallmarks.
  const hasJs =
    /\b(?:const|let|var|function)\s+\w/.test(text) ||
    /=>\s*[{(]/.test(text) ||
    /\b(?:console\.|document\.|window\.|require\(|module\.exports|export\s+(?:default|const|function|class))/.test(
      text
    );

  if (hasTs && hasJsx) return "tsx";
  if (hasTs) return "typescript";
  if (hasJs && hasJsx) return "jsx";
  if (hasJs) return "javascript";

  // Python — def/class/import patterns + colon block starters.
  if (
    /^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+|def\s+\w+\s*\(|class\s+\w+\s*(?:\([^)]*\))?\s*:|if\s+__name__\s*==)/m.test(
      text
    )
  )
    return "python";

  // Go — package + func, or := walrus + func.
  if (/^\s*package\s+\w+/m.test(text) && /\bfunc\s+\w+\s*\(/.test(text))
    return "go";
  if (/:=/.test(text) && /\bfunc\s+\w+\s*\(/.test(text)) return "go";

  // Rust — fn + pub/impl/let-mut combo.
  if (
    /\bfn\s+\w+\s*\(/.test(text) &&
    (/\blet\s+mut\b/.test(text) ||
      /\bimpl\s+\w+/.test(text) ||
      /\bpub\s+(?:fn|struct|enum|mod)\b/.test(text) ||
      /\b\w+::/.test(text))
  )
    return "rust";

  // Java — public class + main/println.
  if (
    /\bpublic\s+(?:class|interface|enum)\s+\w+/.test(text) &&
    /\b(?:System\.out\.print|public\s+static\s+void\s+main)/.test(text)
  )
    return "java";

  // C / C++ — #include is the giveaway; std:: or templates push to cpp.
  if (/^\s*#include\s*[<"]/m.test(text)) {
    if (
      /\bstd::/.test(text) ||
      /\btemplate\s*</.test(text) ||
      /\bclass\s+\w+/.test(text)
    )
      return "cpp";
    return "c";
  }

  // SQL — capitalized keywords are the strongest signal.
  if (
    /\b(?:SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(
      text
    )
  )
    return "sql";

  // Shell — control structures, $-substitutions, common builtins. Only
  // commit if there's a multi-line shell-shape, otherwise "echo foo" in
  // a JS comment would false-positive.
  if (
    /^\s*(?:if\s+\[|for\s+\w+\s+in|while\s+\[|case\s+\$|export\s+\w+=)/m.test(
      text
    ) ||
    /\$\([^)]+\)/.test(text)
  )
    return "bash";

  // CSS — selector { property: value; } shape.
  if (
    /[.#@]?[\w-]+\s*\{[^}]*\b(?:color|background|margin|padding|display|font|width|height|border|flex|grid)\s*:/i.test(
      text
    )
  )
    return "css";

  // JSON — try to parse the whole thing.
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* not valid JSON — fall through */
    }
  }

  // YAML — key: value with indentation, no braces/semicolons. Last-resort
  // because it overlaps with too many other shapes.
  if (
    /^[\w-]+:\s+\S/m.test(text) &&
    !/[{};]/.test(text) &&
    text.split("\n").length >= 3
  )
    return "yaml";

  return undefined;
}

/** Heuristic: does this clipboard text look like code? Used by the
 *  paste interceptor to decide between codeBlock-insert and BN's
 *  default plain-text paste. Conservative — single-line snippets and
 *  short prose with stray punctuation fall through unchanged. */
function looksLikeCode(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < 2) return false;

  // Any one of these strong signals is enough to flip to code.
  const strongPatterns: RegExp[] = [
    /\bfunction\s+\w+\s*\(/,
    /\b(const|let|var)\s+\w+\s*=/,
    /\bimport\s+[^;]+\s+from\s+['"]/,
    /\bclass\s+\w+/,
    /\bdef\s+\w+\s*\(/,
    /=>\s*[{(]/,
    /\bif\s*\(.+\)\s*[{:]/,
    /\bfor\s*\(.+\)\s*[{:]/,
    /^\s*#include\b/m,
    /^\s*(public|private|protected)\s+\w/m,
    /<\/[a-zA-Z][\w-]*>/, // closing JSX/HTML tag
    /^\s*[}\])]\s*$/m, // line that's only a closer
    /;\s*$/m, // semicolon line endings
  ];
  if (strongPatterns.some((re) => re.test(text))) return true;

  // Indentation heuristic: at least 3 non-empty lines, with >30% of
  // them starting with whitespace. Catches indented JSX, Python,
  // YAML-shaped configs, etc., while ignoring unindented prose.
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 3) return false;
  const indented = nonEmpty.filter((l) => /^\s/.test(l)).length;
  return indented / nonEmpty.length > 0.3;
}

/** True when a note has no title and no visible body content. Used by
 *  the editor-head "+" to dedupe — clicking "+" while already on a
 *  blank note creates a duplicate empty that looks identical to the
 *  current one, so the user can't tell anything happened. We treat
 *  pure-whitespace as empty too. */
function isNoteEmpty(n: Note): boolean {
  if (n.title.trim() !== "") return false;
  // Body is HTML — strip tags + entities and check what's left. The
  // BN editor stores `<p></p>` for a brand-new empty doc; that's
  // empty by every UX definition.
  const stripped = n.body
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
  return stripped === "";
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMs = Date.now() - ts;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ---------- BlockNote editor wrapper -------------------------------

interface NotesEditorProps {
  /** Note id — when this changes we replace the document with the
   *  newly-loaded HTML. We pass it to `key` on the parent so React
   *  remounts the editor on switch (cleaner than imperative reset). */
  noteId: string;
  /** Initial HTML for the active note. Supports the legacy markdown
   *  bodies because BlockNote's parseHTMLToBlocks accepts plain text
   *  and falls back to a paragraph. */
  initialHtml: string;
  /** Called with the current HTML on every editor change. The parent
   *  debounces and forwards to the host. */
  onChange: (html: string) => void;
}

function NotesEditor({
  initialHtml,
  onChange,
}: NotesEditorProps): React.ReactElement {
  // Editor instance lives for the lifetime of this component. Parent
  // remounts (via `key={noteId}`) when the user switches notes, so
  // each note gets a fresh editor with no leaked state.
  const editor = useCreateBlockNote({ schema: notesSchema });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Initial load: parse the stored HTML into BlockNote blocks and
  // replace the empty document. tryParseHTMLToBlocks is async because
  // it spins up a hidden iframe parser on first use.
  //
  // CRITICAL: deps are `[editor]` only — NOT `[editor, initialHtml]`.
  // The parent remounts NotesEditor via `key={noteId}` whenever the
  // user switches notes, so we get a fresh `initialHtml` per mount.
  // Reacting to `initialHtml` changes here would re-fire after every
  // save round-trip (host echoes the saved body back through state),
  // calling `replaceBlocks` and resetting the caret to the start
  // mid-typing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const blocks = await editor.tryParseHTMLToBlocks(
        initialHtml || "<p></p>"
      );
      if (cancelled) return;
      if (blocks.length > 0) {
        // Cast: `tryParseHTMLToBlocks` is schema-agnostic and returns
        // blocks typed against the *default* schema (includes media),
        // but our notesSchema strips those — `replaceBlocks` only
        // accepts blocks our schema knows about. Legacy HTML with an
        // `<img>` would parse to an image block we can't insert; in
        // practice none of our stored notes contain media tags, but
        // the static type doesn't know that.
        editor.replaceBlocks(
          editor.document,
          blocks as Parameters<typeof editor.replaceBlocks>[1]
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Save on every change. blocksToHTMLLossy is async — the "lossy"
  // suffix only means BlockNote's own metadata (e.g. block ids) is
  // dropped; the visual HTML round-trips cleanly.
  useEffect(() => {
    return editor.onChange(async () => {
      const html = await editor.blocksToHTMLLossy(editor.document);
      onChangeRef.current(html);
    });
  }, [editor]);

  // Paste-as-code-block. BlockNote's default paste path treats
  // multi-line code as plain paragraphs, which destroys indentation
  // and reads as a wall of text. We intercept paste at capture phase
  // (before ProseMirror's handler), and if the clipboard text looks
  // like code, insert it as a `codeBlock` instead. Non-code pastes
  // fall through to BN unchanged.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".notes-bn-host .ProseMirror")) return;

      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text || !looksLikeCode(text)) return;

      e.preventDefault();
      e.stopPropagation();

      const cursor = editor.getTextCursorPosition();
      if (!cursor?.block) return;

      const blockContent = cursor.block.content;
      const isEmpty =
        Array.isArray(blockContent) && blockContent.length === 0;

      const language = detectLanguage(text);
      editor.insertBlocks(
        [
          {
            type: "codeBlock",
            content: text,
            ...(language ? { props: { language } } : {}),
          },
        ],
        cursor.block,
        isEmpty ? "before" : "after"
      );

      if (isEmpty) {
        try {
          editor.removeBlocks([cursor.block]);
        } catch {
          // BN throws if the block is the only block in the document;
          // leaving the empty paragraph in that case is harmless.
        }
      }
    };

    document.addEventListener("paste", onPaste, { capture: true });
    return () => {
      document.removeEventListener("paste", onPaste, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [editor]);

  return (
    <BlockNoteView
      editor={editor}
      theme="dark"
      // We render our own toolbar/menus in the surrounding chrome
      // (or rely on BlockNote's defaults — which we DO want here for
      // bubble + slash). Keep BlockNote's defaults on.
    />
  );
}

// ---------- Tab shell (rail + search + editor host) ----------------

export function NotesTab(): React.ReactElement {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // History panel — full-area overlay (modeled after ChatHistoryPanel).
  // Hidden by default; opened via the editor head's history button or
  // the empty-state CTA when no note is selected.
  const [railOpen, setRailOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest editor HTML, written by NotesEditor's onChange. The save
  // timer reads from this ref so blur/unmount paths see the freshest
  // value without needing a state-driven re-render.
  const bodyDraftRef = useRef<string>("");
  // Set to true the moment we post `notes/create`; the next inbound
  // notes/state echo uses this to auto-switch to the newest note (the
  // one we just created) instead of staying on the current note.
  // Without this the new note was made silently in the background and
  // the user couldn't tell anything happened.
  const pendingCreateRef = useRef(false);
  // Carries the "this was a fresh create" signal from the receiver
  // into the activeId-change effect, where it triggers visible
  // feedback (focus + pulse + "NEW" chip). A separate ref is needed
  // because by the time the effect runs, `pendingCreateRef` has
  // already been cleared.
  const justCreatedRef = useRef(false);
  // Title input ref so we can focus it on:
  //   - the dedupe path (clicking "+" while already on an empty note)
  //   - the just-created path (a brand-new note → caret in the title
  //     field is the strongest "this is new, name it" cue)
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Drives the 1.2s "fresh note" treatment — a card-border pulse and a
  // "NEW" chip in the editor head. Auto-clears so the chip fades and
  // the editor returns to its resting state.
  const [freshHighlight, setFreshHighlight] = useState(false);

  useEffect(() => {
    vscode.postMessage({ type: "notes/list" });
    const off = onHostMessage((msg) => {
      if (msg.type === "notes/state") {
        setNotes(msg.notes);
        setActiveId((curr) => {
          // Just-created note path: pick whichever has the latest
          // createdAt. Notes are user-owned and only this client
          // creates them, so the newest by timestamp is always ours.
          if (pendingCreateRef.current && msg.notes.length > 0) {
            pendingCreateRef.current = false;
            justCreatedRef.current = true;
            let newest = msg.notes[0];
            for (const n of msg.notes) {
              if (
                new Date(n.createdAt).getTime() >
                new Date(newest.createdAt).getTime()
              ) {
                newest = n;
              }
            }
            return newest.id;
          }
          if (curr && msg.notes.some((n) => n.id === curr)) return curr;
          return msg.notes[0]?.id ?? null;
        });
      }
    });
    return () => off();
  }, []);

  // Visible feedback when `activeId` flips to a *just-created* note.
  // Fires once per fresh create:
  //   1. Focus the title input — caret in the title is the clearest
  //      "this is new, type a name" signal.
  //   2. Toggle the `freshHighlight` flag for 1.2s — the editor card
  //      flashes an electric-blue border pulse and a "NEW" chip fades
  //      into the editor head and out again.
  // The 1.2s window matches the CSS animation in notes.css so the
  // class removes exactly when the animation ends.
  useEffect(() => {
    if (!justCreatedRef.current) return;
    justCreatedRef.current = false;
    // Defer the focus to the next frame: the editor's rerender from
    // the activeId change happens first, then we focus into the
    // already-mounted title input. Without rAF the focus call can
    // race the rerender and miss.
    requestAnimationFrame(() => titleInputRef.current?.focus());
    setFreshHighlight(true);
    const t = setTimeout(() => setFreshHighlight(false), 1200);
    return () => clearTimeout(t);
  }, [activeId]);

  const activeNote = useMemo(
    () => notes?.find((n) => n.id === activeId) ?? null,
    [notes, activeId]
  );

  // Sync title + body draft to the active note **during render** when
  // `activeId` changes. Earlier we did this in a `useEffect`, but the
  // effect runs after paint — that means there was always at least one
  // frame where the title input still showed the previous note's title.
  // If React scheduled an extra render between the click and the effect
  // (e.g. a `notes/state` echo from a save round-trip), the stale title
  // could stay visible until the user typed.
  //
  // The "adjust state during render" pattern (React docs) is the
  // canonical fix: detect the activeId mismatch in render, call setters,
  // React queues a re-render with the corrected state — but the user
  // never sees a stale frame because the in-render setters short-circuit
  // the bad render. Crucially we do NOT add `notes` as a dep — the host
  // re-broadcasts notes/state after every save, and re-running this on
  // notes-change would clobber characters typed during the round-trip.
  const [prevActiveId, setPrevActiveId] = useState<string | null>(null);
  if (prevActiveId !== activeId) {
    setPrevActiveId(activeId);
    setTitle(activeNote?.title ?? "");
    bodyDraftRef.current = activeNote?.body ?? "";
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 120);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Esc to close the history panel handled inside NotesHistoryPanel
  // (so the listener only attaches while the panel is mounted).

  const tokens = useMemo(() => tokenize(debouncedQuery), [debouncedQuery]);

  const visibleNotes = useMemo(() => {
    if (!notes) return [];
    if (tokens.length === 0) return notes;
    const scored: Array<{ note: Note; score: number }> = [];
    for (const n of notes) {
      const s = scoreNote(n, tokens);
      if (s > 0) scored.push({ note: n, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.note);
  }, [notes, tokens]);

  function flushSave(): void {
    if (!activeId) return;
    vscode.postMessage({
      type: "notes/update",
      id: activeId,
      title,
      body: bodyDraftRef.current,
    });
  }

  function scheduleSave(opts?: { nextTitle?: string }): void {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // Snapshot id/title/body at call time. Without these the
    // timer's closure would read `bodyDraftRef.current` at fire-time,
    // which by then has been overwritten with the NEXT note's body
    // if the user switched notes inside the 400ms debounce window.
    // The result was a destructive save: `{ id: oldNote, body:
    // newNote.body }` overwriting the old note with new content.
    const id = activeId;
    const titleSnap = opts?.nextTitle ?? title;
    const bodySnap = bodyDraftRef.current;
    saveTimerRef.current = setTimeout(() => {
      if (!id) return;
      vscode.postMessage({
        type: "notes/update",
        id,
        title: titleSnap,
        body: bodySnap,
      });
    }, 400);
  }

  function handleNew(): void {
    // Tell the notes/state receiver to auto-switch to the newest note
    // when the host echoes the updated list back. Without this the
    // create succeeded silently — the user stayed on the previous note
    // and couldn't tell anything happened.
    pendingCreateRef.current = true;
    vscode.postMessage({ type: "notes/create" });
  }

  // Editor-head "+" wrapper: if the active note is already empty,
  // creating another one stacks duplicate blanks the user can't
  // distinguish. Soft-fail by focusing the title input instead — the
  // caret-appearing-in-the-input is the same affordance a brand-new
  // note would give them.
  function handleNewFromEditorHead(): void {
    if (activeNote && isNoteEmpty(activeNote)) {
      titleInputRef.current?.focus();
      return;
    }
    handleNew();
  }

  // Two-click confirm pattern for destructive delete. VS Code webviews
  // silently block `confirm()` (returns false), so we can't use the
  // native dialog — instead the trash button arms on first click
  // (visual: red + tooltip swap) and commits on second. Resets after
  // 3s of inactivity so a stray first-click doesn't linger forever.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const deleteResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleDelete(id: string): void {
    if (pendingDeleteId === id) {
      // Second click — commit.
      if (deleteResetRef.current) clearTimeout(deleteResetRef.current);
      deleteResetRef.current = null;
      setPendingDeleteId(null);
      vscode.postMessage({ type: "notes/delete", id });
      return;
    }
    // First click — arm.
    setPendingDeleteId(id);
    if (deleteResetRef.current) clearTimeout(deleteResetRef.current);
    deleteResetRef.current = setTimeout(() => {
      setPendingDeleteId(null);
      deleteResetRef.current = null;
    }, 3000);
  }

  // Clean up the timer if the tab unmounts mid-arm.
  useEffect(() => {
    return () => {
      if (deleteResetRef.current) clearTimeout(deleteResetRef.current);
    };
  }, []);

  function handleEditorBodyChange(html: string): void {
    bodyDraftRef.current = html;
    scheduleSave();
  }

  if (notes === null) {
    return <div className="notes-loading microcaps">Loading notes…</div>;
  }

  if (notes.length === 0) {
    return (
      <div className="notes-empty">
        <div className="notes-empty-icon">
          <IconBook size={28} />
        </div>
        <div className="notes-empty-title">A blank canvas</div>
        <div className="notes-empty-sub">
          Capture an idea, paste a snippet, or sketch a plan.
          <br />
          Highlight text or type <kbd>/</kbd> for blocks and formatting.
        </div>
        <button className="notes-empty-btn" onClick={handleNew}>
          <IconPlus size={14} />
          New note
        </button>
      </div>
    );
  }

  if (railOpen) {
    return (
      <div className="notes-tab">
        <NotesHistoryPanel
          notes={visibleNotes}
          activeId={activeId}
          searchQuery={searchQuery}
          debouncedQuery={debouncedQuery}
          tokens={tokens}
          pendingDeleteId={pendingDeleteId}
          onSearch={setSearchQuery}
          onPick={(id) => {
            setActiveId(id);
            setRailOpen(false);
          }}
          onNew={() => {
            handleNew();
            setRailOpen(false);
          }}
          onDelete={handleDelete}
          onClose={() => setRailOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="notes-tab">
      {activeNote ? (
        <section
          className={`notes-editor ${freshHighlight ? "is-fresh" : ""}`}
        >
          {freshHighlight && (
            <span
              className="notes-fresh-chip"
              role="status"
              aria-live="polite"
            >
              New
            </span>
          )}
          <div className="notes-editor-head">
            <button
              className="notes-head-btn notes-history-btn"
              onClick={() => setRailOpen(true)}
              title="Notes history"
              aria-label="Open notes history"
            >
              {/* History icon — clock with a counter-clockwise arrow,
                  same convention the chat tab uses for its history
                  toggle. */}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="13"
                height="13"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <polyline points="3 4 3 9 8 9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
            </button>
            <button
              className="notes-head-btn notes-new-btn"
              onClick={handleNewFromEditorHead}
              title={
                isNoteEmpty(activeNote)
                  ? "You're already on a blank note — start typing"
                  : "New note"
              }
              aria-label="New note"
            >
              <IconPlus size={13} />
            </button>
            <input
              ref={titleInputRef}
              className="notes-title-input"
              value={title}
              onChange={(e) => {
                const nextTitle = e.target.value;
                setTitle(nextTitle);
                scheduleSave({ nextTitle });
              }}
              onBlur={() => flushSave()}
              placeholder="Untitled"
              spellCheck={false}
            />
            <button
              className={`notes-head-btn notes-trash-btn ${
                pendingDeleteId === activeNote.id
                  ? "notes-trash-btn--armed"
                  : ""
              }`}
              onClick={() => handleDelete(activeNote.id)}
              title={
                pendingDeleteId === activeNote.id
                  ? "Click again to confirm delete"
                  : "Delete note"
              }
              aria-label={
                pendingDeleteId === activeNote.id
                  ? "Confirm delete (click again)"
                  : "Delete note"
              }
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          </div>

          <div className="notes-bn-host">
            <NotesEditor
              key={activeNote.id}
              noteId={activeNote.id}
              initialHtml={activeNote.body}
              onChange={handleEditorBodyChange}
            />
          </div>
        </section>
      ) : (
        <div className="notes-empty">
          <div className="notes-empty-icon">
            <IconBook size={28} />
          </div>
          <div className="notes-empty-title">Pick a note</div>
          <div className="notes-empty-sub">
            Open the history panel to find an existing note, or create a
            fresh one.
          </div>
          <div className="notes-empty-actions">
            <button className="notes-empty-btn" onClick={handleNew}>
              <IconPlus size={14} />
              New note
            </button>
            <button
              className="notes-empty-btn notes-empty-btn-ghost"
              onClick={() => setRailOpen(true)}
            >
              Open history
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ---------- Notes history panel (chat-history visual parity) -------

interface NotesHistoryPanelProps {
  notes: Note[];
  activeId: string | null;
  searchQuery: string;
  debouncedQuery: string;
  tokens: string[];
  /** Id of the note whose trash button is currently armed (first
   *  click registered, waiting on second click to commit). Lifted up
   *  to NotesTab so the same `pendingDeleteId` covers both the editor
   *  head's trash and the history-panel per-card trash. */
  pendingDeleteId: string | null;
  onSearch: (q: string) => void;
  onPick: (id: string) => void;
  onNew: () => void;
  /** Two-click delete. First call arms; second call within 3s commits.
   *  Wired in NotesTab to share state with the editor-head trash. */
  onDelete: (id: string) => void;
  onClose: () => void;
}

function NotesHistoryPanel({
  notes,
  activeId,
  searchQuery,
  debouncedQuery,
  tokens,
  pendingDeleteId,
  onSearch,
  onPick,
  onNew,
  onDelete,
  onClose,
}: NotesHistoryPanelProps): React.ReactElement {
  // Esc closes the panel — same convention as the chat history panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="chp" role="dialog" aria-label="Notes history">
      <header className="chp-head">
        <div className="chp-head-main">
          <h2 className="chp-title">Notes history</h2>
          <span className="chp-meta">
            {notes.length} {notes.length === 1 ? "note" : "notes"}
          </span>
        </div>
        <div className="chp-head-actions">
          <button
            className="chp-pill chp-pill-primary"
            onClick={onNew}
            title="Create a new note"
          >
            <IconPlus size={13} />
            New
          </button>
          <button
            className="chp-icon"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close history"
          >
            <IconX size={13} />
          </button>
        </div>
      </header>

      <div className="chp-search">
        <div className="chp-search-box">
          <svg
            className="chp-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            className="chp-search-input"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) {
                e.preventDefault();
                onSearch("");
                return;
              }
              if (e.key === "Enter" && notes.length > 0) {
                onPick(notes[0].id);
              }
            }}
            placeholder="Search notes by title or body"
            spellCheck={false}
            autoFocus
            aria-label="Search notes"
          />
          {searchQuery && (
            <button
              className="chp-search-clear"
              onClick={() => onSearch("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <IconX size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="chp-body">
        {tokens.length > 0 && notes.length === 0 ? (
          <div className="chp-empty">
            <div className="chp-empty-mark">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </div>
            <p className="chp-empty-title">
              No matches for &ldquo;{debouncedQuery}&rdquo;
            </p>
            <p className="chp-empty-sub">
              Try a shorter query or clear the search to see all notes.
            </p>
          </div>
        ) : notes.length === 0 ? (
          <div className="chp-empty">
            <div className="chp-empty-mark">
              <IconBook size={20} />
            </div>
            <p className="chp-empty-title">No notes yet</p>
            <p className="chp-empty-sub">
              Hit New to start your first note. Slash menu and Markdown
              shortcuts are supported once you start typing.
            </p>
          </div>
        ) : (
          <ul className="chp-turns">
            {notes.map((n) => {
              const isActive = n.id === activeId;
              const isArmed = pendingDeleteId === n.id;
              return (
                <li key={n.id}>
                  {/* Card is a div + role=button (instead of <button>) so
                      we can nest the trash button without invalid HTML.
                      Keyboard parity with a real button: Enter/Space
                      triggers onPick. */}
                  <div
                    role="button"
                    tabIndex={0}
                    className={`chp-turn ${isActive ? "chp-turn--active" : ""} ${
                      isArmed ? "chp-turn--armed" : ""
                    }`}
                    onClick={() => onPick(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPick(n.id);
                      }
                    }}
                  >
                    <div className="chp-turn-head">
                      <span className="chp-turn-title">
                        {highlight(n.title || "Untitled", tokens)}
                      </span>
                      <span className="chp-turn-time">
                        {formatRelativeTime(n.updatedAt)}
                      </span>
                    </div>
                    <p className="chp-turn-reply">
                      {highlight(snippetForQuery(n.body, tokens, 160), tokens)}
                    </p>
                    <button
                      type="button"
                      className={`chp-turn-trash ${
                        isArmed ? "chp-turn-trash--armed" : ""
                      }`}
                      onClick={(e) => {
                        // Don't bubble up to the card's onClick (which
                        // would open the note we're trying to delete).
                        e.stopPropagation();
                        onDelete(n.id);
                      }}
                      title={
                        isArmed
                          ? "Click again to confirm delete"
                          : "Delete note"
                      }
                      aria-label={
                        isArmed
                          ? "Confirm delete (click again)"
                          : "Delete note"
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        width="13"
                        height="13"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
