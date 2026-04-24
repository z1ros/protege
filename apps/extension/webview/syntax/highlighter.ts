import { Prism } from "./prismBootstrap";
import { vscode } from "../vscode";

// Load base grammars first — Prism requires parent languages to be
// registered before extensions (e.g. `clike` before `java`/`cpp`,
// `javascript` before `jsx`/`typescript`, `typescript` before `tsx`,
// `css` before `scss`, `c` before `cpp`). Ordering below respects that.
import "prismjs/components/prism-markup"; // HTML + base for jsx/tsx
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-markup-templating"; // required by prism-php
import "prismjs/components/prism-php";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";

/**
 * Syntax highlighter — **Prism.js**, fully synchronous + offline.
 *
 * Replaced highlight.js because hljs's `typescript` grammar doesn't
 * tokenize JSX tags (`<div>`, attributes) — chat examples with React
 * looked half-styled. Prism has dedicated `jsx`/`tsx` grammars that
 * handle markup + expressions correctly, and covers every language
 * we previously loaded plus more. No WASM, no async, CSP-friendly.
 *
 * Same `highlightInner` contract as before: returns HTML ready for
 * `dangerouslySetInnerHTML`. Token classes are Prism's (`token.keyword`,
 * `token.string`, etc.) — theme CSS lives in main.tsx.
 */

// Aliases → canonical Prism language id. Anything not mapped falls
// through to the raw lang string; if still unknown we render plain text.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  // VS Code's languageId for .tsx / .jsx files is `typescriptreact` /
  // `javascriptreact`. smartFix.ts embeds this id directly in the code
  // fence, so without these aliases a .tsx window gets rendered with
  // the plain TypeScript grammar — which has no idea about JSX tags,
  // so `<div>` / `<input>` / attribute names stay uncolored.
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  shellscript: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  htm: "markup",
  svg: "markup",
  xml: "markup",
  rs: "rust",
  kt: "kotlin",
  rb: "ruby",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  text: "none",
  plain: "none",
  plaintext: "none",
};

function resolveLang(lang: string): string {
  const normalized = (lang ?? "").toLowerCase().trim();
  if (!normalized) return "";
  return LANG_ALIASES[normalized] ?? normalized;
}

/**
 * Highlight `code` in `lang`. Unknown / empty lang → escape + return
 * plain text (Prism has no built-in auto-detect, and a naive one
 * produces worse results than leaving tokens off).
 */
// Debug bridge: surface highlighter state in the extension's Output
// channel ("Protege") instead of the webview DevTools console, so the
// user can verify Prism registration without opening DevTools.
// Tag is "prism" — reveal with `Protege: Show Logs` if needed.
function logToHost(message: string): void {
  try {
    vscode.postMessage({ type: "debug/log", tag: "prism", message });
  } catch {
    // Best-effort only; never crash a render for a debug log.
  }
}

if (typeof window !== "undefined") {
  const state = {
    hasPrism: !!Prism,
    languages: Prism?.languages ? Object.keys(Prism.languages).length : 0,
    hasMarkup: !!Prism?.languages?.markup,
    hasTsx: !!Prism?.languages?.tsx,
    hasTypescript: !!Prism?.languages?.typescript,
    hasPython: !!Prism?.languages?.python,
    hasCpp: !!Prism?.languages?.cpp,
  };
  logToHost(`bootstrap ${JSON.stringify(state)}`);
}

export function highlightInner(code: string, lang: string): string {
  let resolved = resolveLang(lang);
  // Markdown fences without a language label (just ``` … ```) land here
  // with lang === "" — fall back to shape-based detection so HTML / JS /
  // Python snippets still colour instead of rendering as flat white text.
  if (!resolved || resolved === "none") {
    resolved = resolveLang(guessInlineLang(code));
  }
  if (!resolved || resolved === "none") return escapeHtml(code);
  const before = resolved;
  // Upgrade plain ts/js → tsx/jsx when the body clearly contains JSX.
  // Pattern matches `<TagName ` / `<TagName>` / `</TagName>` — distinct
  // from TypeScript generics like `Array<string>`. Without this, code
  // from a `typescript` / `javascript` fence that happens to contain
  // JSX gets tokenized without tag colors.
  if ((resolved === "typescript" || resolved === "javascript") &&
      /<[A-Za-z][A-Za-z0-9._-]*(\s|\/|>)/.test(code) &&
      /<\/[A-Za-z]/.test(code)) {
    resolved = resolved === "typescript" ? "tsx" : "jsx";
  }
  const grammar = Prism.languages[resolved];
  // Unconditional per-call trace. Remove once JSX highlighting is
  // confirmed working — this is the only way to see end-to-end which
  // lang string was actually passed and which grammar fired.
  logToHost(
    `call lang=${JSON.stringify(lang)} resolved=${before}${before !== resolved ? ` → ${resolved}` : ""} grammar=${grammar ? "ok" : "MISSING"} codeLen=${code.length} codePreview=${JSON.stringify(code.slice(0, 80))}`
  );
  if (!grammar) {
    return escapeHtml(code);
  }
  try {
    const html = Prism.highlight(code, grammar, resolved);
    if (!html.includes('class="token')) {
      logToHost(`no tokens lang=${resolved} codeLen=${code.length}`);
    }
    return html;
  } catch (err) {
    logToHost(`threw lang=${resolved} err=${(err as Error).message}`);
    return escapeHtml(code);
  }
}

/**
 * Best-effort guess for unlabelled inline `code` spans. Matches a few
 * shape patterns the user's chat actually surfaces (HTML tags, CSS
 * declarations, Python statements). Default = JavaScript since most
 * inline code in chat is JS expressions.
 */
export function guessInlineLang(text: string): string {
  const t = text.trim();
  if (!t) return "javascript";
  if (/^<\/?\w[\w-]*/.test(t)) return "markup";
  if (/^[-\w]+\s*:\s*[^;{}]+;?$/.test(t) && !/=>/.test(t)) return "css";
  if (/^(def|class|import|from|print)\s/.test(t)) return "python";
  return "javascript";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
