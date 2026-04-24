import * as vscode from "vscode";
import { log } from "../log.js";
import {
  onChangeOrigin,
  type ChangeOriginEvent,
} from "../detection/changeOriginDetector.js";
import { runPredictOnRange } from "../detection/predict.js";

/**
 * Misconception Catcher — the belief-updater.
 *
 * Not a linter. When the user accepts vibecoded code, this module
 * scans the pasted range against a small library of rules that flag
 * SPECIFIC wrong mental models — the kind of thing Claude confidently
 * writes and a fast-moving user doesn't notice:
 *
 *   - `items.map(async (x) => await fetch(x))` runs parallel, not serial
 *   - `JSON.parse(JSON.stringify(x))` loses Date/Map/Set/undefined
 *   - `.filter(Boolean)` drops 0 / "" / NaN too
 *   - `.sort()` mutates in place
 *   - `for…in` on arrays iterates KEYS as strings
 *   - `arr.length = 0` mutates; `arr = []` rebinds
 *   - `=== NaN` is always false
 *   - `.reduce(fn)` with no seed throws on empty arrays
 *
 * When a rule fires on a freshly-inserted region, we attach a subtle
 * amber-border decoration to the matched line and wire a hover with:
 *   - The wrong belief explicitly named
 *   - The correct model in one sentence
 *   - [? Quiz me] — fires predict.ts with a MisconceptionHint so the
 *     LLM-generated quiz targets THIS specific belief
 *   - [✿ Show fix] — opens the Protege panel with a chat asking for
 *     the correct version
 *   - [✕ Dismiss] — removes the flag for this range
 *
 * Pull, not push: the decoration appears silently; the hover opens
 * only when the user hovers the line. No toasts, no auto-popup.
 *
 * Also exposes `protege.misconceptions.showInFile` as a palette entry
 * so keyboard-first users can jump through the flags on demand.
 */

// ---- Types ----

export interface MisconceptionRule {
  tag: string;
  languages: Set<string>;
  /** The wrong belief a vibecoder likely holds about this code. */
  belief: string;
  /** The correct mental model — one sentence. */
  truth: string;
  /** Optional: a one-line suggested fix expression. */
  fixHint?: string;
  /** Scan a code region. Return the zero-based line offset (relative
   *  to the start of `code`) where the pattern was matched, plus the
   *  exact matched text. Null if no match. */
  match(code: string, language: string): MisconceptionMatch | null;
}

interface MisconceptionMatch {
  offsetLine: number;
  matchText: string;
}

interface LiveMisconception {
  uri: vscode.Uri;
  /** Document line where the match lives (absolute, not offset). */
  line: number;
  rule: MisconceptionRule;
  matchText: string;
  ts: number;
}

// ---- Rule library ----

const JS_TS_LANGS = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

/** Turn a regex match index into a zero-based line offset within `code`. */
function lineOffsetOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length - 1;
}

const RULES: MisconceptionRule[] = [
  {
    tag: "await-in-map",
    languages: JS_TS_LANGS,
    belief:
      "that `.map(async x => await …)` runs the work serially, one at a time.",
    truth:
      "It runs in PARALLEL — every async callback returns a promise immediately, so all fetches start at once. For serial work, use `for (const x of items) { await fn(x) }`.",
    fixHint: "for (const x of items) { await fn(x); }",
    match(code) {
      const re = /\.map\s*\(\s*async\b[\s\S]{0,200}?\bawait\b/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
  {
    tag: "reduce-no-seed",
    languages: JS_TS_LANGS,
    belief:
      "that `arr.reduce(fn)` returns a sensible default on an empty array.",
    truth:
      "Without a seed, `.reduce` throws `TypeError: Reduce of empty array with no initial value`. Always pass an initial value: `.reduce(fn, 0)`.",
    fixHint: "items.reduce((a, b) => a + b, 0)",
    match(code) {
      // .reduce(SINGLE_ARG) — exactly one argument (no comma at depth 0
      // between the parens). Walks the parens to handle nested commas
      // inside the callback.
      let depth = 0;
      let start = -1;
      const REDUCE = /\.reduce\s*\(/g;
      let hit: RegExpExecArray | null;
      while ((hit = REDUCE.exec(code))) {
        const openIdx = hit.index + hit[0].length - 1; // position of (
        depth = 1;
        start = openIdx + 1;
        let hasTopLevelComma = false;
        for (let i = start; i < code.length; i++) {
          const ch = code[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth === 0) {
              if (!hasTopLevelComma) {
                return {
                  offsetLine: lineOffsetOf(code, hit.index),
                  matchText: code.slice(hit.index, i + 1),
                };
              }
              break;
            }
          } else if (ch === "," && depth === 1) {
            hasTopLevelComma = true;
          }
        }
      }
      return null;
    },
  },
  {
    tag: "json-parse-stringify",
    languages: JS_TS_LANGS,
    belief:
      "that `JSON.parse(JSON.stringify(x))` is a safe deep clone.",
    truth:
      "It loses `Date`, `Map`, `Set`, `undefined`, functions, and Symbol keys — they become strings, empty objects, or disappear. Use `structuredClone(x)` for a real deep clone.",
    fixHint: "structuredClone(x)",
    match(code) {
      const re = /JSON\.parse\s*\(\s*JSON\.stringify\s*\(/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
  {
    tag: "for-in-array",
    languages: JS_TS_LANGS,
    belief:
      "that `for (const x in arr)` iterates array elements in order.",
    truth:
      "`for…in` iterates KEYS as strings, in engine-defined order, INCLUDING inherited enumerable properties. For arrays, use `for…of` or `.forEach`.",
    fixHint: "for (const item of arr)",
    match(code) {
      const re = /\bfor\s*\(\s*(?:const|let|var)?\s*[\w$]+\s+in\s+[\w$.]+\s*\)/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
  {
    tag: "filter-boolean",
    languages: JS_TS_LANGS,
    belief:
      "that `.filter(Boolean)` only removes null and undefined.",
    truth:
      "It also removes `0`, `''`, `NaN`, and `false` — any falsy value. If you only want to drop null/undefined, use `.filter(x => x != null)`.",
    fixHint: "arr.filter(x => x != null)",
    match(code) {
      const re = /\.filter\s*\(\s*Boolean\s*\)/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
  {
    tag: "array-length-zero",
    languages: JS_TS_LANGS,
    belief:
      "that `arr.length = 0` is the same as `arr = []`.",
    truth:
      "`arr.length = 0` MUTATES the array in place — other references to it become empty too. `arr = []` rebinds the variable and leaves the original untouched.",
    fixHint: "Use arr = [] for a fresh array; arr.length = 0 to empty in place.",
    match(code) {
      const re = /\b[\w$]+\.length\s*=\s*0\b/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
  {
    tag: "sort-mutation",
    languages: JS_TS_LANGS,
    belief:
      "that `arr.sort(...)` returns a new sorted array.",
    truth:
      "`.sort` mutates the original array AND returns it. Callers holding the old reference see the reorder. Use `[...arr].sort(...)` or `arr.slice().sort(...)` for a copy.",
    fixHint: "[...arr].sort((a, b) => a - b)",
    match(code) {
      // `name.sort(` where `name` is NOT preceded by a `]` (which would
      // indicate `[...arr].sort(` — already a copy).
      const re = /([\w$]+)\.sort\s*\(/g;
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(code))) {
        const prev = hit.index > 0 ? code[hit.index - 1] : "";
        if (prev === "]") continue; // already sorted on a copy
        return { offsetLine: lineOffsetOf(code, hit.index), matchText: hit[0] };
      }
      return null;
    },
  },
  {
    tag: "nan-equality",
    languages: JS_TS_LANGS,
    belief:
      "that `x === NaN` works for checking if `x` is NaN.",
    truth:
      "`NaN === NaN` is false — NaN isn't equal to anything, including itself. Use `Number.isNaN(x)` or `x !== x`.",
    fixHint: "Number.isNaN(value)",
    match(code) {
      const re = /(?:===?\s*NaN\b|\bNaN\s*===?\s)/;
      const m = re.exec(code);
      if (!m) return null;
      return { offsetLine: lineOffsetOf(code, m.index), matchText: m[0] };
    },
  },
];

// ---- State ----

/** Live misconceptions per file, keyed by `uri.toString()`. Replaced
 *  on each new auto-insert in the same range, cleared on file close. */
const perFile = new Map<string, LiveMisconception[]>();

/** Per-session "dismissed" set — `uri:line:tag` entries that we've
 *  been told not to re-surface on that exact spot. Resets on reload;
 *  intentional — a user dismissing a reduce flag today may want the
 *  reminder tomorrow if the pattern still hasn't been fixed. */
const dismissed = new Set<string>();

/** Decoration type — amber left-border, applied to every flagged line. */
let decoration: vscode.TextEditorDecorationType | null = null;

/** Captured context so command handlers can open the Protege panel
 *  without plumbing context through every call site. Same pattern
 *  predict.ts / struggleChip.ts / ownership.ts use. */
let moduleContext: vscode.ExtensionContext | null = null;

// ---- Registration ----

export function registerMisconceptions(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  moduleContext = context;
  const disposables: vscode.Disposable[] = [];

  decoration = vscode.window.createTextEditorDecorationType({
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    borderColor: "rgba(240, 200, 120, 0.75)",
    overviewRulerColor: "rgba(240, 200, 120, 0.85)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: true,
  });

  disposables.push(
    onChangeOrigin((evt) => {
      if (evt.origin !== "auto-inserted") return;
      if (!isEnabled()) return;
      void scanAndFlag(evt);
    })
  );

  // Clear flags when a file closes — memory hygiene.
  disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      perFile.delete(doc.uri.toString());
    })
  );

  // Re-render decorations when the user switches editors (new active
  // editor needs its flags re-applied).
  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      renderDecorations(editor);
    })
  );

  // Commands the hover's command-links fire
  disposables.push(
    vscode.commands.registerCommand(
      "protege.misconceptions.quizMe",
      async (args: { uri: string; line: number; tag: string } | undefined) => {
        if (!args) return;
        const flag = findFlag(args.uri, args.line, args.tag);
        if (!flag) return;
        await runPredictOnRange(flag.uri, flag.line, flag.line, {
          tag: flag.rule.tag,
          belief: flag.rule.belief,
          truth: flag.rule.truth,
        });
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.misconceptions.showFix",
      async (args: { uri: string; line: number; tag: string } | undefined) => {
        if (!args) return;
        const flag = findFlag(args.uri, args.line, args.tag);
        if (!flag) return;
        await openFixInSidebar(flag);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.misconceptions.dismiss",
      (args: { uri: string; line: number; tag: string } | undefined) => {
        if (!args) return;
        dismissed.add(keyOf(args.uri, args.line, args.tag));
        removeFlag(args.uri, args.line, args.tag);
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "protege.misconceptions.showInFile",
      async () => {
        await showFlagsInFile();
      }
    )
  );

  // Cleanup
  disposables.push({
    dispose() {
      if (decoration) {
        try {
          decoration.dispose();
        } catch {
          /* ignore */
        }
        decoration = null;
      }
      perFile.clear();
      dismissed.clear();
      moduleContext = null;
    },
  });

  log("misconceptions", `installed · ${RULES.length} rules`);
  return disposables;
}

// ---- Scan + flag ----

async function scanAndFlag(evt: ChangeOriginEvent): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(evt.uri).then(
    (d) => d,
    () => null
  );
  if (!doc) return;

  // Safe ranges
  const start = Math.max(0, Math.min(doc.lineCount - 1, evt.startLine));
  const end = Math.max(start, Math.min(doc.lineCount - 1, evt.endLine));
  const endChar = doc.lineAt(end).text.length;
  const code = doc.getText(new vscode.Range(start, 0, end, endChar));

  const matches: LiveMisconception[] = [];
  for (const rule of RULES) {
    if (!rule.languages.has(doc.languageId)) continue;
    const m = rule.match(code, doc.languageId);
    if (!m) continue;
    const docLine = start + m.offsetLine;
    const dismissKey = keyOf(evt.uri.toString(), docLine, rule.tag);
    if (dismissed.has(dismissKey)) continue;
    matches.push({
      uri: evt.uri,
      line: docLine,
      rule,
      matchText: m.matchText,
      ts: evt.ts,
    });
  }

  if (matches.length === 0) return;

  const uriKey = evt.uri.toString();
  // Merge: drop prior flags for the same line+tag (fresh edit replaces
  // the old flag ts), keep ones not touched by this scan's range.
  const existing = perFile.get(uriKey) ?? [];
  const kept = existing.filter(
    (f) =>
      f.line < start ||
      f.line > end ||
      !matches.some((m) => m.line === f.line && m.rule.tag === f.rule.tag)
  );
  perFile.set(uriKey, [...kept, ...matches]);

  for (const m of matches) {
    log(
      "misconceptions",
      `flagged · ${m.rule.tag} · ${doc.fileName.split("/").pop()}:${m.line + 1}`
    );
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.toString() === uriKey) {
    renderDecorations(activeEditor);
  }
}

function renderDecorations(editor: vscode.TextEditor): void {
  if (!decoration) return;
  const uriKey = editor.document.uri.toString();
  const flags = perFile.get(uriKey) ?? [];
  const options: vscode.DecorationOptions[] = flags.map((f) => ({
    range: lineRange(editor.document, f.line),
    hoverMessage: buildHover(f),
  }));
  editor.setDecorations(decoration, options);
}

function lineRange(doc: vscode.TextDocument, line: number): vscode.Range {
  const safe = Math.max(0, Math.min(doc.lineCount - 1, line));
  const text = doc.lineAt(safe).text;
  return new vscode.Range(safe, 0, safe, Math.max(1, text.length));
}

function buildHover(flag: LiveMisconception): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(`**You might believe…**\n\n`);
  md.appendMarkdown(`_${flag.rule.belief}_\n\n`);
  md.appendMarkdown(`**The truth:** ${flag.rule.truth}\n\n`);
  if (flag.rule.fixHint) {
    md.appendMarkdown(`_Quick fix:_ \`${flag.rule.fixHint}\`\n\n`);
  }
  md.appendMarkdown(`---\n\n`);
  const args = encodeURIComponent(
    JSON.stringify({
      uri: flag.uri.toString(),
      line: flag.line,
      tag: flag.rule.tag,
    })
  );
  md.appendMarkdown(
    `**[? Quiz me](command:protege.misconceptions.quizMe?${args})**` +
      ` · ` +
      `**[✿ Show fix](command:protege.misconceptions.showFix?${args})**` +
      ` · ` +
      `**[✘ Dismiss](command:protege.misconceptions.dismiss?${args})**`
  );
  return md;
}

// ---- Command handlers ----

function findFlag(
  uriStr: string,
  line: number,
  tag: string
): LiveMisconception | null {
  const flags = perFile.get(uriStr);
  if (!flags) return null;
  return flags.find((f) => f.line === line && f.rule.tag === tag) ?? null;
}

function removeFlag(uriStr: string, line: number, tag: string): void {
  const flags = perFile.get(uriStr);
  if (!flags) return;
  const next = flags.filter(
    (f) => !(f.line === line && f.rule.tag === tag)
  );
  if (next.length === flags.length) return;
  perFile.set(uriStr, next);
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.toString() === uriStr) {
    renderDecorations(activeEditor);
  }
}

async function openFixInSidebar(flag: LiveMisconception): Promise<void> {
  try {
    const { openProtegePanel } = await import("../panel.js");
    const { broadcast, mountedWebviewCount } = await import(
      "../chat/webviewHost.js"
    );
    if (mountedWebviewCount() === 0) {
      if (moduleContext) {
        openProtegePanel(moduleContext);
      } else {
        vscode.window.showInformationMessage(
          "Protege: open the side panel first, then click Show fix again."
        );
        return;
      }
    }
    const fileName = flag.uri.fsPath.split("/").pop() ?? "this file";
    setTimeout(() => {
      try {
        broadcast({
          type: "chat/autoSend",
          message:
            `Protege flagged a misconception in ${fileName} around line ` +
            `${flag.line + 1}:\n\n` +
            `Belief tested: "${flag.rule.belief}"\n` +
            `Truth: "${flag.rule.truth}"\n` +
            `Code match: \`${flag.matchText}\`\n\n` +
            `Show me the corrected version as a minimal diff. Under 150 words.`,
        });
      } catch (err) {
        log(
          "misconceptions",
          `showFix broadcast failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, 250);
  } catch (err) {
    log(
      "misconceptions",
      `showFix failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function showFlagsInFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Protege: open a file first.");
    return;
  }
  const flags = perFile.get(editor.document.uri.toString()) ?? [];
  if (flags.length === 0) {
    vscode.window.showInformationMessage(
      "Protege: no misconceptions flagged in this file. Nothing subtle here."
    );
    return;
  }
  interface FlagItem extends vscode.QuickPickItem {
    flag: LiveMisconception;
  }
  const items: FlagItem[] = flags.map((f) => ({
    label: `Line ${f.line + 1} · ${f.rule.tag}`,
    description: f.matchText,
    detail: f.rule.belief,
    flag: f,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Jump to a misconception in this file",
    title: `Misconceptions · ${flags.length} flagged`,
  });
  if (!picked) return;
  const range = lineRange(editor.document, picked.flag.line);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ---- Helpers ----

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("protege")
    .get<boolean>("misconceptions.enabled", true);
}

function keyOf(uri: string, line: number, tag: string): string {
  return `${uri}:${line}:${tag}`;
}
