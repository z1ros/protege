import React, { useState } from "react";
import type { CommitStoriesPayload, CommitStoryCard } from "@protege/types";

export interface CommitStoriesProps {
  data: CommitStoriesPayload | null;
  loading: boolean;
  onOpenFile?: (file: string) => void;
}

function firstLine(message: string, limit = 60): string {
  const line = (message ?? "").split(/\r?\n/)[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function relativeTs(iso: string): string {
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

export function CommitStories({
  data,
  loading,
  onOpenFile,
}: CommitStoriesProps): JSX.Element {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

  const cards = data?.cards ?? [];
  const visibleCards = cards.slice(0, 5);

  return (
    <section className="echo-widget echo-commits" data-widget="W11">
      <header className="echo-widget-head">
        <h2>Commit stories</h2>
        <span className="echo-widget-tag">W11</span>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : visibleCards.length > 0 ? (
          <ul className="echo-commits-list">
            {visibleCards.map((card) => {
              const expanded = expandedSha === card.sha;
              return (
                <li
                  key={card.sha}
                  className={`echo-commit-card ${expanded ? "expanded" : ""}`}
                >
                  <button
                    type="button"
                    className="echo-commit-head"
                    onClick={() =>
                      setExpandedSha(expanded ? null : card.sha)
                    }
                    aria-expanded={expanded}
                  >
                    <span className="echo-commit-sha">{card.shortSha}</span>
                    <span className="echo-commit-msg" title={card.message}>
                      {firstLine(card.message)}
                    </span>
                    <span className="echo-commit-ts">{relativeTs(card.ts)}</span>
                  </button>
                  <div className="echo-commit-stats" aria-label="commit stats">
                    <MiniStat label="min" value={card.activeMinutes} kind="time" />
                    <MiniStat label="undo" value={card.undoCount} kind="undo" />
                    <MiniStat label="paste" value={card.pasteCount} kind="paste" />
                    <MiniStat label="AI" value={card.aiAcceptCount} kind="ai" />
                  </div>
                  {expanded ? (
                    <CommitDetail card={card} onOpenFile={onOpenFile} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="echo-widget-empty">No commits yet in this window.</div>
        )}
      </div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  kind,
}: {
  label: string;
  value: number;
  kind: "time" | "undo" | "paste" | "ai";
}): JSX.Element {
  return (
    <span className={`echo-commit-stat echo-commit-stat-${kind}`} title={label}>
      <span className="echo-commit-stat-value">{value}</span>
      <span className="echo-commit-stat-label">{label}</span>
    </span>
  );
}

function CommitDetail({
  card,
  onOpenFile,
}: {
  card: CommitStoryCard;
  onOpenFile?: (file: string) => void;
}): JSX.Element {
  return (
    <div className="echo-commit-detail">
      <div className="echo-commit-detail-row">
        <span className="echo-commit-detail-label">Peak focus</span>
        <span>
          {card.peakFocusMin} min
          {card.peakFocusMin === 0 ? " (no uninterrupted stretch)" : ""}
        </span>
      </div>
      {card.message.includes("\n") ? (
        <pre className="echo-commit-detail-message">{card.message}</pre>
      ) : null}
      {card.filesTouched.length > 0 ? (
        <div className="echo-commit-detail-files">
          <span className="echo-commit-detail-label">
            Files ({card.filesTouched.length})
          </span>
          <ul>
            {card.filesTouched.slice(0, 12).map((file) => (
              <li key={file}>
                {onOpenFile ? (
                  <button
                    type="button"
                    className="echo-commit-file-link"
                    onClick={() => onOpenFile(file)}
                  >
                    {file}
                  </button>
                ) : (
                  <span>{file}</span>
                )}
              </li>
            ))}
            {card.filesTouched.length > 12 ? (
              <li className="echo-commit-file-more">
                +{card.filesTouched.length - 12} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
