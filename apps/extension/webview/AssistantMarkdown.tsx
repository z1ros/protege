import React, { useCallback, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { guessInlineLang, highlightInner } from "./syntax/highlighter";

export function AssistantMarkdown({ content }: { content: string }) {
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
            const lang = /language-(\w+)/.exec(className)?.[1] ?? "";
            const text = extractText(codeEl?.props?.children ?? children);
            return <CodeBlock lang={lang} code={text} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) return extractText(node.props.children);
  return String(node ?? "");
}

function InlineCode({ text, lang }: { text: string; lang: string }) {
  // highlight.js is fully synchronous — no useEffect, no Promise, no
  // fallback flash. Memoize per (text, lang) so identical inline pills
  // (used a lot in chat) don't re-tokenize on every render.
  const html = useMemo(() => highlightInner(text, lang), [text, lang]);
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
  const html = useMemo(
    () => highlightInner(codeForHighlight, lang || "text"),
    [codeForHighlight, lang]
  );

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
