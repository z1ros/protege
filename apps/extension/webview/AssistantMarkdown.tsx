import React, { useCallback, useEffect, useRef, useState } from "react";
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

/** Hook: asynchronously highlight `code`. While pending, returns null. */
function useHighlighted(code: string, lang: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    let cancelled = false;
    highlightInner(code, lang).then((inner) => {
      if (cancelled || token !== tokenRef.current) return;
      setHtml(inner);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return html;
}

function InlineCode({ text, lang }: { text: string; lang: string }) {
  const html = useHighlighted(text, lang);
  if (html === null) {
    return <code className="md-code-inline">{text}</code>;
  }
  return (
    <code
      className="md-code-inline"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const trimmed = code.replace(/\n$/, "");
  const html = useHighlighted(trimmed, lang || "text");

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
      <pre className="md-pre">
        {html === null ? (
          <code className={`md-code-block ${lang ? `language-${lang}` : ""}`}>
            {trimmed}
          </code>
        ) : (
          <code
            className={`md-code-block ${lang ? `language-${lang}` : ""}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </pre>
    </div>
  );
}
