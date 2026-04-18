import type { HighlighterCore } from "shiki/core";
import { orbitTheme } from "./orbit-theme";

/**
 * Lazy, singleton Shiki highlighter for the chat webview.
 *
 * We use the *core* entry + explicit lang imports (not the `shiki` default
 * export) so Vite only emits chunks for langs we actually need — otherwise
 * the bundle fans out into 300+ files covering every grammar Shiki ships.
 *
 * We also use the JavaScript regex engine instead of Oniguruma WASM:
 *   • no ~600 KB WASM blob
 *   • smaller bundle, synchronous regex
 *   • covers all the grammars in the list below; complex grammars
 *     (emacs-lisp, wolfram, etc.) that need oniguruma are not in scope.
 */

let loader: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!loader) {
    loader = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
        ]);
      return createHighlighterCore({
        themes: [orbitTheme],
        langs: [
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/jsx"),
          import("@shikijs/langs/tsx"),
          import("@shikijs/langs/python"),
          import("@shikijs/langs/css"),
          import("@shikijs/langs/scss"),
          import("@shikijs/langs/html"),
          import("@shikijs/langs/xml"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/yaml"),
          import("@shikijs/langs/bash"),
          import("@shikijs/langs/shellscript"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/langs/sql"),
          import("@shikijs/langs/go"),
          import("@shikijs/langs/rust"),
          import("@shikijs/langs/java"),
          import("@shikijs/langs/cpp"),
          import("@shikijs/langs/c"),
          import("@shikijs/langs/csharp"),
          import("@shikijs/langs/php"),
          import("@shikijs/langs/ruby"),
          import("@shikijs/langs/swift"),
          import("@shikijs/langs/kotlin"),
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return loader;
}

const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  kt: "kotlin",
  rb: "ruby",
  "c++": "cpp",
  "c#": "csharp",
  htm: "html",
  svg: "xml",
};

export function normalizeLang(raw: string): string {
  const l = (raw ?? "").toLowerCase().trim();
  if (!l) return "text";
  return ALIASES[l] ?? l;
}

/**
 * Highlight code and return the *inner* HTML (contents of <code>...</code>).
 * Unknown langs silently degrade to plain escaped text.
 */
export async function highlightInner(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const normalized = normalizeLang(lang);
  const loaded = hl.getLoadedLanguages();
  const useLang = loaded.includes(normalized as never) ? normalized : "text";
  try {
    const full = hl.codeToHtml(code, { lang: useLang, theme: "protege-orbit" });
    const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(full);
    return match?.[1] ?? escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Shape-based guess for unlabelled inline `code` spans.
 * Mirrors the heuristic the old regex highlighter used.
 */
export function guessInlineLang(text: string): string {
  const t = text.trim();
  if (!t) return "text";
  if (/^<\/?\w[\w-]*/.test(t)) return "jsx";
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
