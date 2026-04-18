import React from "react";
import { vscode } from "./vscode.js";

/**
 * TipDetailOverlay — the full Protege-styled card that appears when the
 * user clicks a "Protege · <title> · Open →" CodeLens above a line.
 *
 * This is the one place we fully own the popup: glass surface, gradient
 * brand accent, our fonts, our colors. Dismisses on X click or Esc.
 */

export interface TipDetail {
  title: string;
  body: string;
  kind: "bug" | "perf" | "tip" | "warn" | "info";
  ruleId: string;
  currentLine?: string;
  fix?: string;
  lang?: string;
  uri: string;
  line: number;
}

const ACCENT: Record<TipDetail["kind"], { hex: string; label: string }> = {
  bug:   { hex: "#ff8fa8", label: "Bug" },
  perf:  { hex: "#ffd280", label: "Perf" },
  tip:   { hex: "#9eccff", label: "Insight" },
  warn:  { hex: "#ffb86b", label: "Warn" },
  info:  { hex: "#c8d4ea", label: "Info" },
};

interface Props {
  tip: TipDetail;
  onClose: () => void;
}

export function TipDetailOverlay({ tip, onClose }: Props) {
  const accent = ACCENT[tip.kind];

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const applyFix = () => {
    if (!tip.fix) return;
    vscode.postMessage({
      type: "openExternal",
      url:
        "command:protege.applyReviewFix?" +
        encodeURIComponent(
          JSON.stringify({ uri: tip.uri, line: tip.line, fix: tip.fix })
        ),
    });
    onClose();
  };

  const teachMe = () => {
    vscode.postMessage({
      type: "openExternal",
      url:
        "command:protege.teachConcept?" +
        encodeURIComponent(JSON.stringify([tip.ruleId])),
    });
    onClose();
  };

  return (
    <div className="tip-overlay-backdrop" onClick={onClose}>
      <div
        className="tip-overlay-card"
        onClick={(e) => e.stopPropagation()}
        style={
          {
            ["--tip-accent" as string]: accent.hex,
          } as React.CSSProperties
        }
      >
        {/* ---- Header ---- */}
        <div className="tip-overlay-header">
          <div className="tip-overlay-brand">
            <svg
              className="tip-overlay-logo"
              viewBox="0 0 32 32"
              width="18"
              height="18"
              aria-hidden
            >
              <circle
                cx="16"
                cy="16"
                r="10.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="23.42" cy="8.58" r="2.9" fill="currentColor" />
            </svg>
            <span className="tip-overlay-brand-text">Protege</span>
          </div>
          <span className="tip-overlay-chip">{accent.label}</span>
          <button
            className="tip-overlay-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>

        {/* ---- Title ---- */}
        <div className="tip-overlay-title">{tip.title}</div>

        {/* ---- Body ---- */}
        <div className="tip-overlay-body">{tip.body}</div>

        {/* ---- Before / After ---- */}
        {(tip.currentLine || tip.fix) && (
          <div className="tip-overlay-diff">
            {tip.currentLine && (
              <div className="tip-overlay-code tip-overlay-code-before">
                <div className="tip-overlay-code-label microcaps">Current</div>
                <pre>
                  <code>{tip.currentLine}</code>
                </pre>
              </div>
            )}
            {tip.fix && (
              <>
                <div className="tip-overlay-arrow" aria-hidden>
                  ↓
                </div>
                <div className="tip-overlay-code tip-overlay-code-after">
                  <div className="tip-overlay-code-label microcaps">Suggested</div>
                  <pre>
                    <code>{tip.fix.trim()}</code>
                  </pre>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---- Actions ---- */}
        <div className="tip-overlay-actions">
          {tip.fix && (
            <button
              className="tip-overlay-btn tip-overlay-btn-primary"
              onClick={applyFix}
            >
              Apply fix
            </button>
          )}
          <button className="tip-overlay-btn" onClick={teachMe}>
            Teach me
          </button>
          <button className="tip-overlay-btn tip-overlay-btn-ghost" onClick={onClose}>
            Dismiss
          </button>
        </div>

        {/* ---- Footer rule-id chip ---- */}
        <div className="tip-overlay-footer microcaps">
          <span className="tip-overlay-rule">{tip.ruleId}</span>
          <span className="tip-overlay-footer-sep">·</span>
          <span>line {tip.line + 1}</span>
        </div>
      </div>
    </div>
  );
}
