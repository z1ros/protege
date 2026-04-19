import hljs from "highlight.js/lib/core";

// Pull in only the languages we use, keeps bundle lean (~25 KB core +
// ~3-8 KB per language). Adding a new language = one import + one
// `registerLanguage` call below.
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml"; // covers HTML + JSX/TSX markup
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import csharp from "highlight.js/lib/languages/csharp";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";

/**
 * Syntax highlighter — **highlight.js**, fully synchronous + offline.
 *
 * After three rounds of trying to make Shiki work in the VS Code webview
 * (custom theme scope-mismatch, JS regex engine silent fails, Oniguruma
 * WASM blocked by CSP), I pulled the plug. highlight.js is sync, has no
 * WASM, no async load, no CSP requirements beyond the standard nonce'd
 * script. It just works. Theme is provided by a CSS file (atom-one-dark)
 * imported in the webview entry; tokens get classes like `hljs-keyword`
 * etc., the CSS paints them.
 *
 * `highlightInner` returns a HTML string ready to drop into a
 * `dangerouslySetInnerHTML` — no `<pre>`/`<code>` wrappers, just the
 * inner span tree. Same shape the previous Shiki implementation returned,
 * so AssistantMarkdown's render path doesn't change.
 */

const LANG_REGISTRATIONS: Record<string, unknown> = {
  javascript,
  typescript,
  xml,
  css,
  scss,
  python,
  json,
  yaml,
  bash,
  markdown,
  sql,
  go,
  rust,
  java,
  cpp,
  c,
  csharp,
  php,
  ruby,
  swift,
  kotlin,
};

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  for (const [name, mod] of Object.entries(LANG_REGISTRATIONS)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hljs.registerLanguage(name, mod as any);
  }
  // Aliases — let JSX/TSX fall back to typescript so JSX still gets
  // tokens for keywords/strings/types even though attributes won't be
  // perfectly highlighted (closer to "JSX in a TS file").
  hljs.registerAliases(["js", "mjs", "cjs"], { languageName: "javascript" });
  hljs.registerAliases(["ts"], { languageName: "typescript" });
  hljs.registerAliases(["jsx"], { languageName: "javascript" });
  hljs.registerAliases(["tsx"], { languageName: "typescript" });
  hljs.registerAliases(["py"], { languageName: "python" });
  hljs.registerAliases(["sh", "zsh", "shell", "shellscript"], { languageName: "bash" });
  hljs.registerAliases(["yml"], { languageName: "yaml" });
  hljs.registerAliases(["md"], { languageName: "markdown" });
  hljs.registerAliases(["html", "svg", "htm"], { languageName: "xml" });
  hljs.registerAliases(["rs"], { languageName: "rust" });
  hljs.registerAliases(["kt"], { languageName: "kotlin" });
  hljs.registerAliases(["rb"], { languageName: "ruby" });
  hljs.registerAliases(["c++"], { languageName: "cpp" });
  hljs.registerAliases(["c#"], { languageName: "csharp" });
}

/**
 * Highlight `code` in `lang`. If lang is unknown / empty, falls back to
 * highlight.js auto-detection. Returns highlighted HTML (inner) — drop
 * straight into a `<code>` via `dangerouslySetInnerHTML`.
 */
export function highlightInner(code: string, lang: string): string {
  ensureRegistered();
  const normalized = (lang ?? "").toLowerCase().trim();
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
    }
    // Unknown lang → auto-detect from the registered set
    return hljs.highlightAuto(code, Object.keys(LANG_REGISTRATIONS)).value;
  } catch {
    // Catastrophic: just escape and return plain text
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
  if (/^<\/?\w[\w-]*/.test(t)) return "xml";
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
