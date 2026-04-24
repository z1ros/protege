import React, { useMemo } from "react";
import type { LineThatWontDiePayload } from "@protege/types";
import { highlightInner } from "../../../webview/syntax/highlighter.js";

export interface LineThatWontDieProps {
  data: LineThatWontDiePayload | null;
  loading: boolean;
}

function shortPath(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

function relativeTimeSince(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, Date.now() - then);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function LineThatWontDie({
  data,
  loading,
}: LineThatWontDieProps): JSX.Element {
  // Skip entire render when empty — the widget is "glowing card or nothing".
  if (!loading && (!data || data.empty)) {
    return <></>;
  }

  const highlighted = useMemo(() => {
    if (!data || !data.content) return "";
    try {
      return highlightInner(data.content, data.language ?? "");
    } catch {
      return data.content;
    }
  }, [data]);

  return (
    <section className="echo-widget echo-rewrite" data-widget="W10">
      <header className="echo-widget-head">
        <h2>The line that won&rsquo;t die</h2>
        <span className="echo-widget-tag">W10</span>
      </header>
      <div className="echo-widget-body">
        {loading ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <div className="echo-rewrite-card">
            <div className="echo-rewrite-meta">
              <span className="echo-rewrite-path" title={data.filePath}>
                {shortPath(data.filePath)}
              </span>
              <span className="echo-rewrite-badge" aria-label="rewrite count">
                rewritten {data.rewriteCount}× this window
              </span>
            </div>
            <pre className="echo-rewrite-code">
              <code
                className={`hljs language-${data.language ?? "plaintext"}`}
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            </pre>
            <div className="echo-rewrite-foot">
              <span>Last touched {relativeTimeSince(data.lastRewriteAt)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
