import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  canonicalLang,
  ensureShiki,
  ensureLang,
  guessInlineLang,
  highlightToHtml,
  escapeHtml,
} from "./syntax/shikiHighlighter";
import { ensureTwoslash } from "./syntax/twoslashLoader";

const TWOSLASH_LANGS = new Set(["typescript", "tsx", "javascript", "jsx"]);

export function AssistantMarkdown({ content }: { content: string }) {
  // Pre-process the raw content so identifiers the AI quoted with '...'
  // or "..." become inline code pills — matching how backticks already
  // render. Protege is a code-mentor agent: nearly every quoted string
  // in its prose is a symbol, filename, flag, etc. Rendering them as
  // plain text with visible quotes (as we used to) made replies look
  // stilted vs. real mentor writing.
  const processed = useMemo(() => preprocessCodeQuotes(content), [content]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="md-h4">{children}</h4>,
          p: ({ children }) => <p className="md-p">{children}</p>,
          strong: ({ children }) => <strong className="md-strong">{children}</strong>,
          em: ({ children }) => <em className="md-em">{children}</em>,
          ul: ({ children }) => <ul className="md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="md-ol">{children}</ol>,
          li: ({ children }) => <li className="md-li">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="md-quote">{children}</blockquote>
          ),
          a: ({ href, children }) => (
            <a className="md-link" href={href}>
              {children}
            </a>
          ),
          hr: () => <hr className="md-hr" />,
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? "");
            const isBlock = !!match || (className ?? "").includes("language-");
            if (!isBlock) {
              const text = extractText(children);
              const lang = match?.[1] ?? guessInlineLang(text);
              return <InlineCode text={text} lang={lang} />;
            }
            return <>{children}</>;
          },
          pre: ({ children }) => {
            const codeEl = React.Children.toArray(children).find(
              (c): c is React.ReactElement =>
                React.isValidElement(c) && (c as React.ReactElement).type === "code"
            );
            const className = codeEl?.props?.className ?? "";
            const rawLang = /language-(\w+)/.exec(className)?.[1] ?? "";
            const text = extractText(codeEl?.props?.children ?? children);
            // Upgrade the fence language when the body contains JSX —
            // the AI frequently labels TSX snippets as plain "js" or
            // "javascript", which makes Shiki pick the non-JSX grammar
            // and leave component tags like `<Swiper` uncolored. Same
            // for inline react examples the AI writes during chat.
            const lang = upgradeLangForJsx(rawLang, text);
            return <CodeBlock lang={lang} code={text} />;
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

/* ==========================================================
   Quoted-identifier → inline-code preprocessor.

   Rewrites short code-shaped tokens wrapped in '...' or "..." into
   backtick-wrapped inline code, so the markdown renderer picks them
   up as code pills. Existing backtick spans, fenced code blocks, and
   inline code are left intact.

   Heuristic for "code-shaped":
   - No whitespace, no nested quotes/backticks.
   - Starts with one of: letter, underscore, $, @, ., <, /.
   - Body uses only: word chars, $, ., -, /, @, (), <>, :, #.
   - Length 1–40. Beyond 40 chars it's almost certainly prose quotation.

   Contractions like "don't", "it's" don't match because the char
   AFTER the opening quote would be a space or non-identifier token
   that terminates the match.

   This is intentionally conservative — false positives on natural
   English prose would look worse than false negatives. If the AI
   writes something like "'hello' world", it won't convert (space
   inside), preserving the quote.
   ========================================================== */
const CODE_QUOTE_RE =
  /(['"])([A-Za-z_$@.<\/][\w$.\-/@()<>:#]{0,39})\1/g;

function preprocessCodeQuotes(content: string): string {
  // Split on fenced code blocks so we DO NOT rewrite anything inside
  // triple-backtick code (the AI sometimes puts literal quoted idents
  // inside an example block — those should stay in the code verbatim).
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      // Odd indices are the fenced blocks (capturing-group halves of split).
      if (i % 2 === 1) return part;
      return rewriteQuotedCode(part);
    })
    .join("");
}

function rewriteQuotedCode(text: string): string {
  // Also protect existing inline code spans (`...`). We scan char-by-char
  // for runs outside backtick pairs and only rewrite those segments.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick === -1) {
      out += text.slice(i).replace(CODE_QUOTE_RE, (_m, _q, inner) => `\`${inner}\``);
      break;
    }
    // Rewrite the non-code segment before the backtick run.
    out += text.slice(i, tick).replace(CODE_QUOTE_RE, (_m, _q, inner) => `\`${inner}\``);
    // Find matching closing backtick (or end of string) and copy verbatim.
    const close = text.indexOf("`", tick + 1);
    if (close === -1) {
      out += text.slice(tick);
      break;
    }
    out += text.slice(tick, close + 1);
    i = close + 1;
  }
  return out;
}

/**
 * Bump a fence language up to its JSX/TSX variant when the body
 * contains React-shaped markup. Two signals:
 *   1. Capitalized tag like `<Swiper`, `<MyComp />` — React components.
 *   2. Standard HTML tag like `<div>`, `<ul>`, `</span>` — JSX inside JS.
 *
 * Only triggers for base JS/TS langs (or no lang at all) so we don't
 * clobber intentional labels like "html" or "xml" that also contain
 * angle brackets. Anything non-JS/TS passes through untouched.
 */
function upgradeLangForJsx(lang: string, code: string): string {
  const base = lang.toLowerCase();
  const upgradable =
    base === "" ||
    base === "js" ||
    base === "javascript" ||
    base === "ts" ||
    base === "typescript";
  if (!upgradable) return lang;

  // Strip line comments + fenced string contents before scanning so we
  // don't match `<ul>` that lives inside `// In your JSX, replace the
  // <ul> with:` — that's prose, not code.
  const stripped = code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "");

  const hasComponent = /<[A-Z][\w.]*(\s|\/|>|\n)/.test(stripped);
  const hasHtmlTag = /<\/?(?:div|span|p|ul|ol|li|button|input|form|a|img|section|header|footer|nav|main|article|h[1-6]|table|tr|td|th|tbody|thead|svg|path|circle|rect|label|select|option|textarea|pre|code)\b/.test(
    stripped
  );
  if (!hasComponent && !hasHtmlTag) return lang;

  // Prefer tsx when the body also has TS-only constructs; otherwise jsx.
  const looksTs =
    base === "ts" ||
    base === "typescript" ||
    /\b(interface|type\s+\w+\s*=|as\s+[A-Z]\w*|:\s*[A-Z]\w*(<|\[|\s*[,)]))/m.test(
      stripped
    );
  return looksTs ? "tsx" : "jsx";
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) return extractText(node.props.children);
  return String(node ?? "");
}

function InlineCode({ text, lang }: { text: string; lang: string }) {
  // Shiki init is async. First render shows plain-escaped text so the
  // pill appears instantly; once the highlighter resolves (or the grammar
  // lazy-loads), the effect below swaps in coloured HTML. Memoized per
  // (text, lang) to avoid re-tokenizing identical inline pills.
  const [html, setHtml] = useState<string>(() => escapeHtml(text));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureShiki();
      const canonical = canonicalLang(lang);
      if (canonical) await ensureLang(canonical);
      if (cancelled) return;
      const out = highlightToHtml(text, lang);
      if (out != null) setHtml(out);
    })();
    return () => { cancelled = true; };
  }, [text, lang]);
  return (
    <code
      className={`md-code-inline language-${lang}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(true);
  const trimmed = code.replace(/\n$/, "");
  // smartFix.ts (and similar "code window" prompts) bakes line numbers +
  // a `→` marker into every line of the fenced code. That prefix breaks
  // tokenizers — e.g. Prism's tsx grammar treats `<` as "less-than" when
  // preceded by digits, so JSX tags like <div> don't get a tag color.
  // Detect the pattern, split off the gutter, and feed Prism the clean
  // source so syntax highlighting works correctly.
  const { codeForHighlight, gutter } = useMemo(
    () => stripLineNumberGutter(trimmed),
    [trimmed]
  );
  // Shiki async-init path: show plain text instantly, swap to coloured
  // HTML once the highlighter + grammar are ready. Effect is keyed on
  // the clean code + lang so the Wrap toggle doesn't re-trigger a load.
  const [html, setHtml] = useState<string>(() => escapeHtml(codeForHighlight));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureShiki();
      const canonical = canonicalLang(lang || "text");
      if (canonical) await ensureLang(canonical);
      if (cancelled) return;
      // First paint — plain Shiki (fast, always works).
      const firstPass = highlightToHtml(codeForHighlight, lang || "text");
      if (firstPass != null) setHtml(firstPass);
      // Second paint — if the lang is TS/JS, kick off Twoslash and
      // re-highlight once the transformer is cached. Block becomes
      // "hover-aware" with real type tooltips + inline errors. No-op
      // for every other language.
      if (canonical && TWOSLASH_LANGS.has(canonical)) {
        const ts = await ensureTwoslash();
        if (cancelled || !ts) return;
        const enriched = highlightToHtml(codeForHighlight, lang || "text");
        if (enriched != null && enriched !== firstPass) setHtml(enriched);
      }
    })();
    return () => { cancelled = true; };
  }, [codeForHighlight, lang]);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  }, [code]);

  return (
    <div className="md-code-wrap">
      <div className="md-code-header">
        {lang && <span className="md-code-lang">{lang}</span>}
        <div className="md-code-actions">
          <button
            className={`md-code-wrap-toggle${wrap ? " is-on" : ""}`}
            onClick={() => setWrap((w) => !w)}
            title={wrap ? "Switch to horizontal scroll" : "Wrap long lines"}
            aria-pressed={wrap}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4h12" />
              <path d="M2 8h9a2.5 2.5 0 010 5H8l1.5-1.5M8 13l1.5 1.5" />
              <path d="M2 12h3" />
            </svg>
            <span>{wrap ? "Wrap" : "No wrap"}</span>
          </button>
          <button className="md-code-copy" onClick={handleCopy} title="Copy code">
            {copied ? (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8.5l3 3 7-7" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="5" width="8" height="8" rx="1.5" />
                <path d="M3 11V3.5A1.5 1.5 0 014.5 2H11" />
              </svg>
            )}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <pre className={`md-pre${wrap ? " md-pre--wrap" : ""}${gutter ? " md-pre--gutter" : ""}`}>
        {gutter && (
          <span className="md-code-gutter" aria-hidden="true">
            {gutter.map((g, i) => (
              <span key={i} className={`md-code-gutter-row${g.marked ? " is-marked" : ""}`}>
                <span className="md-code-gutter-num">{g.num}</span>
                <span className="md-code-gutter-arrow">{g.marked ? "→" : ""}</span>
              </span>
            ))}
          </span>
        )}
        <code
          className={`md-code-block ${lang ? `language-${lang}` : ""}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}

interface GutterRow { num: string; marked: boolean }

/**
 * Detect the `  N[→] code…` prefix pattern that smartFix.ts (and any
 * future "code window" prompt template) bakes into fenced code, and split
 * it into a gutter + clean source. If the input doesn't match the pattern
 * on most lines, return it unchanged — we don't want to strip legitimate
 * leading-digit code elsewhere. Threshold: 80% of non-empty lines must
 * match, so a single stray line doesn't disqualify the detection.
 */
function stripLineNumberGutter(code: string): {
  codeForHighlight: string;
  gutter: GutterRow[] | null;
} {
  const lines = code.split("\n");
  if (lines.length < 2) return { codeForHighlight: code, gutter: null };
  const prefixRe = /^(\s*)(\d+)([→ ])\s(.*)$/;
  let matches = 0;
  let nonEmpty = 0;
  const parsed: Array<{ num: string; marked: boolean; rest: string } | null> = [];
  for (const line of lines) {
    if (line.trim() === "") { parsed.push(null); continue; }
    nonEmpty++;
    const m = prefixRe.exec(line);
    if (m) {
      matches++;
      parsed.push({ num: m[2], marked: m[3] === "→", rest: m[4] });
    } else {
      parsed.push(null);
    }
  }
  if (nonEmpty === 0 || matches / nonEmpty < 0.8) {
    return { codeForHighlight: code, gutter: null };
  }
  const cleaned: string[] = [];
  const gutter: GutterRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parsed[i];
    if (p) {
      cleaned.push(p.rest);
      gutter.push({ num: p.num, marked: p.marked });
    } else {
      cleaned.push(lines[i]);
      gutter.push({ num: "", marked: false });
    }
  }
  return { codeForHighlight: cleaned.join("\n"), gutter };
}
