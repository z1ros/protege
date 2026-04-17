import React, { useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
              return (
                <code
                  className="md-code-inline"
                  dangerouslySetInnerHTML={{ __html: highlightCode(text, lang) }}
                />
              );
            }
            return <>{children}</>;
          },
          pre: ({ children }) => {
            // Extract language and text from the nested <code> element
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

/** Pick a grammar for unlabelled inline `code` spans based on shape. */
function guessInlineLang(text: string): string {
  const t = text.trim();
  if (!t) return "";
  // HTML-ish tags: <li>, <div className="..."/>
  if (/^<\/?\w[\w-]*/.test(t)) return "jsx";
  // CSS property: "display: flex;" or "--electric-rgb: 255,0,0"
  if (/^[-\w]+\s*:\s*[^;{}]+;?$/.test(t) && !/=>/.test(t)) return "css";
  // Python-ish
  if (/^(def|class|import|from|print)\s/.test(t)) return "python";
  // Default to JS — covers { id: ... }, arrow fns, ||, ?., etc.
  return "js";
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) return extractText(node.props.children);
  return String(node ?? "");
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [code]);

  // Basic keyword highlighting
  const highlighted = highlightCode(code.replace(/\n$/, ""), lang);

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
        <code
          className={`md-code-block ${lang ? `language-${lang}` : ""}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

/* ================================================================
   Syntax highlighter — "Protege Dark" theme (One Dark Pro inspired).
   Zero dependencies. Regex-based with slot protection so tokens
   don't get double-highlighted. Covers JS/TS/JSX/TSX, Python, CSS,
   HTML/XML, and a generic fallback.
   ================================================================ */

// ---- Keywords by language ----
const KW_JS = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|super|class|extends|implements|import|export|from|default|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|void|delete|static|get|set|interface|type|enum|namespace|declare|abstract|readonly|as|satisfies)\b/g;
const KW_BOOL_JS = /\b(true|false|null|undefined|NaN|Infinity)\b/g;
const KW_PY = /\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|async|await|lambda|pass|and|or|not|in|is|del|global|nonlocal|assert|print)\b/g;
const KW_BOOL_PY = /\b(True|False|None)\b/g;
const KW_CSS = /\b(background|color|display|flex|grid|margin|padding|border|font|position|width|height|top|left|right|bottom|z-index|overflow|transition|animation|transform|opacity|none|auto|inherit|solid|absolute|relative|fixed|sticky|content|align|justify|gap)\b/g;

// ---- Built-in globals ----
const BUILTINS_JS = /\b(console|window|document|Math|JSON|Promise|Array|Object|String|Number|Boolean|Map|Set|Error|RegExp|Date|Symbol|Proxy|Reflect|WeakMap|WeakSet|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|fetch|Response|Request|URL|URLSearchParams)\b/g;
const BUILTINS_PY = /\b(len|range|print|str|int|float|list|dict|tuple|set|type|isinstance|hasattr|getattr|setattr|enumerate|zip|map|filter|sorted|reversed|any|all|super|property|staticmethod|classmethod|open|input)\b/g;

// ---- Types (capitalized identifiers that look like classes/types) ----
const TYPES = /\b([A-Z][a-zA-Z0-9]*(?:&lt;\w+(?:,\s*\w+)*&gt;)?)\b/g;

// ---- Function calls ----
const FUNC_CALLS = /\b([a-zA-Z_]\w*)\s*(?=\()/g;

// ---- HTML/JSX ----
const HTML_TAGS = /(&lt;\/?)([\w-]+)/g;
const HTML_ATTRS = /\b([\w-]+)(=)/g;

// ---- Operators ----
const OPERATORS = /(=&gt;|===|!==|==|!=|&lt;=|&gt;=|&amp;&amp;|\|\||\.\.\.|\?\.|[+\-*/%]=?|&lt;|&gt;|\?|:(?!=))/g;

// ---- Primitives ----
const STRINGS = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
const COMMENTS_SINGLE = /(\/\/.*$|#.*$)/gm;
const COMMENTS_MULTI = /(\/\*[\s\S]*?\*\/)/g;
const NUMBERS = /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi;

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slot-based highlighter: protect high-priority tokens first, then
 *  apply lower-priority patterns without clobbering earlier matches. */
function highlightCode(code: string, lang: string): string {
  let html = esc(code);
  const slots: string[] = [];
  const slot = (s: string) => {
    slots.push(s);
    return `\x00${slots.length - 1}\x00`;
  };

  // 1. Comments (highest priority)
  html = html.replace(COMMENTS_MULTI, (m) => slot(`<span class="hl-comment">${m}</span>`));
  html = html.replace(COMMENTS_SINGLE, (m) => slot(`<span class="hl-comment">${m}</span>`));

  // 2. Strings
  html = html.replace(STRINGS, (m) => slot(`<span class="hl-string">${m}</span>`));

  // 3. Numbers
  html = html.replace(NUMBERS, (_, n) => slot(`<span class="hl-number">${n}</span>`));

  // 4. Language-specific patterns
  const l = lang.toLowerCase();
  const isJS = ["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(l);
  const isPy = ["py", "python"].includes(l);
  const isCSS = ["css", "scss", "less"].includes(l);
  const isHTML = ["html", "xml", "svg", "jsx", "tsx"].includes(l);

  if (isJS || (!isPy && !isCSS && !isHTML)) {
    // Booleans/null
    html = html.replace(KW_BOOL_JS, (m) => slot(`<span class="hl-builtin">${m}</span>`));
    // Built-ins
    html = html.replace(BUILTINS_JS, (m) => slot(`<span class="hl-builtin">${m}</span>`));
    // Function calls (before keywords so "function" keyword isn't eaten)
    html = html.replace(FUNC_CALLS, (_, name) => slot(`<span class="hl-func">${name}</span>`));
    // Keywords
    html = html.replace(KW_JS, (_, kw) => slot(`<span class="hl-keyword">${kw}</span>`));
    // Types (PascalCase)
    html = html.replace(TYPES, (_, t) => slot(`<span class="hl-type">${t}</span>`));
    // Operators
    html = html.replace(OPERATORS, (m) => slot(`<span class="hl-op">${m}</span>`));
  } else if (isPy) {
    html = html.replace(KW_BOOL_PY, (m) => slot(`<span class="hl-builtin">${m}</span>`));
    html = html.replace(BUILTINS_PY, (m) => slot(`<span class="hl-builtin">${m}</span>`));
    html = html.replace(FUNC_CALLS, (_, name) => slot(`<span class="hl-func">${name}</span>`));
    html = html.replace(KW_PY, (_, kw) => slot(`<span class="hl-keyword">${kw}</span>`));
    html = html.replace(TYPES, (_, t) => slot(`<span class="hl-type">${t}</span>`));
  } else if (isCSS) {
    html = html.replace(KW_CSS, (_, kw) => slot(`<span class="hl-keyword">${kw}</span>`));
    html = html.replace(NUMBERS, (_, n) => slot(`<span class="hl-number">${n}</span>`));
  }

  if (isHTML) {
    html = html.replace(HTML_TAGS, (_, prefix, tag) =>
      `${prefix}${slot(`<span class="hl-tag">${tag}</span>`)}`
    );
    html = html.replace(HTML_ATTRS, (_, name, eq) =>
      `${slot(`<span class="hl-attr">${name}</span>`)}${eq}`
    );
  }

  // Restore all slots
  html = html.replace(/\x00(\d+)\x00/g, (_, i) => slots[Number(i)]);

  return html;
}
