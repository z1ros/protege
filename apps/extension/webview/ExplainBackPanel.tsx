import React, { useEffect, useRef, useState } from "react";
import { vscode } from "./vscode.js";
import type { ExplainBackSession } from "@protege/types";

/**
 * Explain-Back (B1) overlay panel.
 *
 * Sits on top of the tab content when an explain-back session is
 * active. Layout:
 *   ┌─────────────────────────────────┐
 *   │ Explain-back · file.ts          │
 *   │ [×]                             │
 *   ├─────────────────────────────────┤
 *   │  <selected code, read-only>     │
 *   ├─────────────────────────────────┤
 *   │  round history (scrollable)     │
 *   │  · You said: ...                │
 *   │  · Protege: ✓ ... · ⚠ ...      │
 *   ├─────────────────────────────────┤
 *   │  <textarea: your explanation>   │
 *   │  [Submit]                       │
 *   └─────────────────────────────────┘
 *
 * The panel is a "controlled" surface — host state drives everything.
 * We only own the pending-input text; on submit we send it to the host
 * and wait for the state update to echo back.
 */

export function ExplainBackPanel({
  session,
  onClose,
}: {
  session: ExplainBackSession;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const historyRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll history + refocus the input after each round settles
  // so the user can keep typing without clicking back in.
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
    if (!session.grading) textareaRef.current?.focus();
  }, [session.rounds.length, session.grading]);

  const submit = () => {
    const text = input.trim();
    if (!text || session.grading) return;
    vscode.postMessage({ type: "explainBack/submit", explanation: text });
    setInput("");
  };

  const latestRound =
    session.rounds.length > 0
      ? session.rounds[session.rounds.length - 1]
      : null;
  const isDone = latestRound?.grade?.done === true;
  const reachedCap =
    session.rounds.length >= session.maxRounds && !session.grading;

  return (
    <div className="eb-panel">
      <header className="eb-header">
        <div className="eb-header-main">
          <span className="eb-title microcaps">Explain-back</span>
          <span className="eb-path">{session.path}</span>
        </div>
        <button
          className="eb-close-btn"
          onClick={onClose}
          title="End session"
        >
          ×
        </button>
      </header>

      <div className="eb-code-block">
        <pre>
          <code>{session.code}</code>
        </pre>
      </div>

      <div className="eb-subtitle microcaps">
        {isDone
          ? "Solid. Here's what clicked ↓"
          : session.rounds.length === 0
          ? "In your own words — what does this code do?"
          : "Try again or refine — what did you miss?"}
      </div>

      <div className="eb-history" ref={historyRef}>
        {session.rounds.map((round, idx) => (
          <div key={idx} className="eb-round">
            <div className="eb-you">
              <span className="eb-who microcaps">You</span>
              <span className="eb-said">{round.explanation}</span>
            </div>
            <div className="eb-protege">
              <span className="eb-who microcaps">Protege</span>
              {round.grade ? (
                <div className="eb-grade">
                  <div className="eb-grade-row eb-got-right">
                    <span className="eb-grade-icon">✓</span>
                    <span>{round.grade.got_right}</span>
                  </div>
                  {round.grade.missed && (
                    <div className="eb-grade-row eb-missed">
                      <span className="eb-grade-icon">⚠</span>
                      <span>{round.grade.missed}</span>
                    </div>
                  )}
                  <div className="eb-grade-row eb-follow-up">
                    <span className="eb-grade-icon">?</span>
                    <span>{round.grade.follow_up}</span>
                  </div>
                </div>
              ) : (
                <span className="typing">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {!isDone && !reachedCap && (
        <div className="eb-input">
          <textarea
            ref={textareaRef}
            className="eb-textarea"
            placeholder={
              session.rounds.length === 0
                ? "Start with what it does at a high level, then the key details…"
                : "Address the gap Protege flagged, or answer the follow-up…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits; plain Enter inserts a newline so
              // multi-sentence explanations aren't accidentally sent.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            rows={4}
            disabled={session.grading}
          />
          <div className="eb-actions">
            <span className="eb-hint microcaps">
              round {session.rounds.length + 1}/{session.maxRounds} · ⌘↵ to submit
            </span>
            <button
              className="eb-submit-btn primary"
              onClick={submit}
              disabled={session.grading || !input.trim()}
            >
              {session.grading ? "Grading…" : "Submit"}
            </button>
          </div>
        </div>
      )}

      {(isDone || reachedCap) && (
        <div className="eb-footer-actions">
          <button className="eb-submit-btn" onClick={onClose}>
            {isDone ? "Got it" : "End session"}
          </button>
        </div>
      )}
    </div>
  );
}
