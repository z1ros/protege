import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  transformerNotationDiff,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationErrorLevel,
  transformerMetaHighlight,
  transformerMetaWordHighlight,
} from "@shikijs/transformers";
import type { ShikiTransformer } from "shiki";
import { getTwoslashTransformerOrNull } from "./twoslashLoader";

/**
 * Syntax highlighter — **Shiki**, using VS Code's own TextMate grammars
 * and theme JSON. Picked over Prism for editor-level fidelity: scope-
 * based tokens paint function calls, variable declarations, property
 * names, generics — every token VS Code colours, Shiki colours too.
 *
 * The critical choice here is `createJavaScriptRegexEngine()` — the
 * earlier Shiki attempts in this repo failed because Shiki defaulted to
 * Oniguruma-WASM, which the webview's CSP blocked. The JS regex engine
 * ships since Shiki 1.x, is pure JS, and works inside the strict CSP
 * used by VS Code webviews. Trade-off: slightly slower tokenization for
 * exotic grammars, imperceptible for code snippets in chat.
 *
 * Init is async (grammars + theme are JSON loaded lazily). Once the
 * singleton resolves, `highlightToHtml` is synchronous — React
 * components can then re-render with the highlighted HTML.
 */

// Languages we currently register. Keep in sync with what the chat
// actually emits; each grammar is ~2–10 KB JSON so adding a lang is
// cheap. Order doesn't matter — Shiki resolves deps internally.
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  python: () => import("@shikijs/langs/python"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  bash: () => import("@shikijs/langs/bash"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  ruby: () => import("@shikijs/langs/ruby"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
};

// Aliases → canonical Shiki lang id. VS Code's own language ids
// (typescriptreact, javascriptreact) map through here, as do short
// markdown fence labels (js, ts, py).
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  typescriptreact: "tsx",
  javascriptreact: "jsx",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  shellscript: "bash",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  xml: "html",
  svg: "html",
  markup: "html",
  rs: "rust",
  kt: "kotlin",
  rb: "ruby",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
};

function resolveLang(lang: string): string | null {
  const normalized = (lang ?? "").toLowerCase().trim();
  if (!normalized || normalized === "text" || normalized === "plain" || normalized === "plaintext") {
    return null;
  }
  const canonical = LANG_ALIASES[normalized] ?? normalized;
  if (LANG_LOADERS[canonical]) return canonical;
  return null;
}

// Shape-based guess for unlabelled code — mirrors Prism's old heuristic.
export function guessInlineLang(text: string): string {
  const t = text.trim();
  if (!t) return "javascript";
  if (/^<\/?\w[\w-]*/.test(t)) return "html";
  if (/^[-\w]+\s*:\s*[^;{}]+;?$/.test(t) && !/=>/.test(t)) return "css";
  if (/^(def|class|import|from|print)\s/.test(t)) return "python";
  return "javascript";
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighter: HighlighterCore | null = null;

/**
 * Boot the singleton highlighter. Loads the One Dark Pro theme + a
 * starter set of langs. Safe to call many times — subsequent calls
 * reuse the in-flight (or already-resolved) promise. Call once at app
 * mount so the first rendered code block is painted immediately.
 */
export async function ensureShiki(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const [theme, ...langs] = await Promise.all([
      import("@shikijs/themes/one-dark-pro"),
      // Start with a small fast-path bundle; other langs load on demand
      // via `loadLang` below. These cover ~90% of chat snippets.
      LANG_LOADERS.tsx(),
      LANG_LOADERS.typescript(),
      LANG_LOADERS.javascript(),
      LANG_LOADERS.jsx(),
      LANG_LOADERS.html(),
      LANG_LOADERS.css(),
      LANG_LOADERS.python(),
      LANG_LOADERS.json(),
      LANG_LOADERS.bash(),
      LANG_LOADERS.markdown(),
    ]);
    const core = await createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [(theme as { default: unknown }).default as never],
      langs: langs.map((m) => (m as { default: unknown }).default as never),
    });
    highlighter = core;
    return core;
  })();
  return highlighterPromise;
}

const loadedLangs = new Set<string>([
  "tsx", "typescript", "javascript", "jsx", "html", "css",
  "python", "json", "bash", "markdown",
]);
const langLoadPromises = new Map<string, Promise<void>>();

/**
 * Ensure a grammar is registered. No-op if already loaded. Returns a
 * promise callers can await before calling `highlightToHtml`. Used by
 * the React components to lazy-register uncommon langs (swift, kotlin,
 * scss, etc.) on first sight without bloating the boot bundle.
 */
export async function ensureLang(lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  if (langLoadPromises.has(lang)) return langLoadPromises.get(lang)!;
  const loader = LANG_LOADERS[lang];
  if (!loader) return;
  const p = (async () => {
    const core = await ensureShiki();
    const mod = await loader();
    const grammar = (mod as { default: unknown }).default as never;
    await core.loadLanguage(grammar);
    loadedLangs.add(lang);
  })();
  langLoadPromises.set(lang, p);
  return p;
}

// Default transformer set — pure notation, no runtime cost beyond a
// regex pass over token lines. Gives us:
//   `// [!code ++]` / `[!code --]`  → diff +/- line backgrounds
//   `// [!code focus]`              → dim everything else
//   `// [!code highlight]`          → highlight a specific line
//   `// [!code error]` / `warning`  → inline error/warning squiggles
//   fence meta `{1-3,5}`            → highlight those lines
//   fence meta `/foo/`              → highlight matching words
// Free with Shiki; only cost is a ~5 KB transformer bundle.
const BASE_TRANSFORMERS: ShikiTransformer[] = [
  transformerNotationDiff({ matchAlgorithm: "v3" }),
  transformerNotationFocus({ matchAlgorithm: "v3" }),
  transformerNotationHighlight({ matchAlgorithm: "v3" }),
  transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
  transformerMetaHighlight(),
  transformerMetaWordHighlight(),
];

/**
 * Sync highlight — returns inline-styled HTML ready to drop into a
 * `<pre><code>` wrapper. Strips Shiki's outer `<pre><code>` so the
 * caller's chrome isn't double-nested. Returns `null` before the
 * singleton is ready so the caller can show a plain-text fallback and
 * re-render after `ensureShiki()` resolves.
 *
 * `meta` forwards the fence's info string (everything after the lang)
 * so `{1-3}` style line-range highlights and `/word/` word highlights
 * work without any extra plumbing.
 */
export function highlightToHtml(
  code: string,
  lang: string,
  meta?: string
): string | null {
  if (!highlighter) return null;
  const resolved = resolveLang(lang) ?? resolveLang(guessInlineLang(code));
  if (!resolved) return escapeHtml(code);
  if (!loadedLangs.has(resolved)) return null;
  const transformers = [...BASE_TRANSFORMERS];
  // Twoslash is additive and *sync-once-loaded*. If the loader has the
  // transformer cached (i.e. we already lazy-loaded it on a previous
  // block), plug it in now; otherwise skip and let the async path
  // (`highlightToHtmlAsync`) kick in after `ensureTwoslash`.
  if (resolved === "typescript" || resolved === "tsx" ||
      resolved === "javascript" || resolved === "jsx") {
    const ts = getTwoslashTransformerOrNull();
    if (ts) transformers.push(ts);
  }
  try {
    const full = highlighter.codeToHtml(code, {
      lang: resolved,
      theme: "one-dark-pro",
      meta: meta ? { __raw: meta } : undefined,
      transformers,
    });
    return unwrapShiki(full);
  } catch {
    // Twoslash is the only transformer that can throw on invalid TS
    // (missing imports, unresolved symbols). Fall back to the same
    // call without it so the block still paints with plain Shiki.
    try {
      const full = highlighter.codeToHtml(code, {
        lang: resolved,
        theme: "one-dark-pro",
        meta: meta ? { __raw: meta } : undefined,
        transformers: BASE_TRANSFORMERS,
      });
      return unwrapShiki(full);
    } catch {
      return escapeHtml(code);
    }
  }
}

// Shiki's output shape: `<pre ... style="..."><code>...</code></pre>`.
// Strip both wrappers so the inner `.line`/token spans land directly
// inside our own `<pre><code>` structure. Brittle on spec changes, but
// the shape has been stable across Shiki 1.x / 4.x.
function unwrapShiki(html: string): string {
  return html
    .replace(/^<pre\b[^>]*>/i, "")
    .replace(/<\/pre>\s*$/i, "")
    .replace(/^<code\b[^>]*>/i, "")
    .replace(/<\/code>\s*$/i, "");
}

/** True once the starter bundle is loaded and sync calls work. */
export function isShikiReady(): boolean {
  return highlighter !== null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Canonical lang for a raw label — exported so callers can preload
// the right grammar on first sight.
export function canonicalLang(lang: string): string | null {
  return resolveLang(lang);
}

/**
 * BlockNote highlighter adapter — same Shiki singleton + One Dark Pro
 * theme + grammars as chat, exposed under the API shape BlockNote
 * expects. Two reasons to wrap rather than return the raw highlighter:
 *
 *   1. BN calls `highlighter.loadLanguage(langString)` internally, but
 *      our `createHighlighterCore` instance can't resolve string lang
 *      ids — it expects a pre-imported grammar object. We intercept
 *      string calls here and route them through `ensureLang`, which
 *      knows our `LANG_LOADERS` dynamic-import map.
 *   2. Other methods (`getLoadedLanguages`, `codeToHast`, etc.) need
 *      `this`-binding to the underlying core; a Proxy with
 *      method-binding handles that without a manual surface dump.
 *
 * Result: notes code blocks paint with the exact same token colors as
 * chat code blocks, with no duplicate Shiki state.
 */
export async function createBnHighlighter(): Promise<HighlighterCore> {
  const inner = await ensureShiki();
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "loadLanguage") {
        return async (...langs: unknown[]): Promise<void> => {
          for (const lang of langs) {
            if (typeof lang === "string") {
              await ensureLang(lang);
            } else {
              // Grammar registration object — pass through unchanged.
              await (
                target.loadLanguage as (g: unknown) => Promise<void>
              )(lang);
            }
          }
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[
        prop
      ];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
