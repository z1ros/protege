import React from "react";
import type { SaveTapeEntry, SaveTapePayload } from "@protege/types";

export interface SaveTapeProps {
  data: SaveTapePayload | null;
  loading: boolean;
  onOpenMoment?: (file: string, line?: number, ts?: number) => void;
}

/**
 * W12 Save Tape. Vertical feed of the most recent saves in the window,
 * newest first. Each row is a save plus its ±30s neighborhood summarized
 * as chips + badges. Clicking a row fires `echo_openMoment` to jump back
 * to that file at that timestamp.
 */
export function SaveTape({
  data,
  loading,
  onOpenMoment,
}: SaveTapeProps): JSX.Element {
  const entries = data?.entries ?? [];

  return (
    <section className="echo-widget echo-save-tape" data-widget="W12">
      <header className="echo-widget-head">
        <h2>Recent saves</h2>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : entries.length > 0 ? (
          <ul className="echo-save-tape-list">
            {entries.map((entry, idx) => (
              <SaveTapeRow
                key={`${entry.ts}-${entry.file}-${idx}`}
                entry={entry}
                onOpenMoment={onOpenMoment}
              />
            ))}
          </ul>
        ) : (
          <div className="echo-widget-empty">
            No saves yet. Save a file to start your tape.
          </div>
        )}
      </div>
    </section>
  );
}

function SaveTapeRow({
  entry,
  onOpenMoment,
}: {
  entry: SaveTapeEntry;
  onOpenMoment?: (file: string, line?: number, ts?: number) => void;
}): JSX.Element {
  const hasErrorsAdded = entry.errorsAdded > entry.errorsResolved;
  const hasErrorsResolved =
    entry.errorsResolved > entry.errorsAdded && entry.errorsResolved > 0;
  const hasAi = entry.aiAccepts > 0;
  const hasPaste = entry.pasted > 0;
  const tsMs = Date.parse(entry.ts);
  const safeTs = Number.isFinite(tsMs) ? tsMs : undefined;

  return (
    <li className="echo-save-tape-row-wrap">
      <button
        type="button"
        className="echo-save-tape-row"
        onClick={() => onOpenMoment?.(entry.file, 1, safeTs)}
        title={entry.file}
      >
        <span className="echo-save-tape-when">{entry.relative}</span>
        <span className="echo-save-tape-path">{entry.displayPath}</span>
        <span className="echo-save-tape-deltas">
          <span className="echo-save-tape-chip echo-save-tape-chip-added">
            +{entry.linesAdded}
          </span>
          <span className="echo-save-tape-chip echo-save-tape-chip-removed">
            −{entry.linesRemoved}
          </span>
        </span>
        {entry.language ? (
          <span className="echo-save-tape-lang">{entry.language}</span>
        ) : (
          <span className="echo-save-tape-lang echo-save-tape-lang-empty" />
        )}
        <span className="echo-save-tape-badges" aria-label="save context">
          {hasErrorsAdded ? (
            <span
              className="echo-save-tape-badge"
              title={`${entry.errorsAdded} new diagnostic${
                entry.errorsAdded === 1 ? "" : "s"
              }`}
            >
              🔴
            </span>
          ) : null}
          {hasErrorsResolved ? (
            <span
              className="echo-save-tape-badge"
              title={`${entry.errorsResolved} diagnostic${
                entry.errorsResolved === 1 ? "" : "s"
              } resolved`}
            >
              ✅
            </span>
          ) : null}
          {hasAi ? (
            <span
              className="echo-save-tape-badge"
              title={`${entry.aiAccepts} AI accept${
                entry.aiAccepts === 1 ? "" : "s"
              }`}
            >
              🤖
            </span>
          ) : null}
          {hasPaste ? (
            <span
              className="echo-save-tape-badge"
              title={`${entry.pasted} paste${entry.pasted === 1 ? "" : "s"}`}
            >
              📋
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
