import React from "react";
import { vscode } from "./vscode.js";
import type { TourState } from "@protege/types";

/**
 * SessionStrip — the compact progress bar for an active Architecture
 * Tour. Renders just below the main tab header, above the tab content,
 * visible on every tab so the user doesn't lose the tour when they
 * switch to Chat mid-walk.
 *
 * Shape:
 *   Codebase tour · 2/5 · apps/.../liveReview.ts · Next · Stop
 *
 * Clicking Next broadcasts `tour/next`; Stop broadcasts `tour/stop`.
 * Host is the single source of truth — this component just reflects
 * whatever `tour/state` comes in.
 */

export function SessionStrip({ tour }: { tour: TourState | null }) {
  if (!tour) return null;

  const current = tour.steps[tour.currentIndex];
  if (!current) return null;

  const step = tour.currentIndex + 1;
  const total = tour.steps.length;
  const isLast = tour.currentIndex === total - 1;
  const narrating = current.narration === null;

  return (
    <div className="session-strip">
      <div className="session-strip-main">
        <span className="session-strip-label microcaps">
          {labelForIntent(tour.intent)} · {step}/{total}
        </span>
        <span className="session-strip-path" title={current.path}>
          {shortPath(current.path)}
        </span>
      </div>
      <div className="session-strip-narration">
        {narrating ? (
          <span className="typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>
        ) : (
          current.narration
        )}
      </div>
      <div className="session-strip-actions">
        <button
          className="session-strip-btn primary"
          onClick={() => vscode.postMessage({ type: "tour/next" })}
        >
          {isLast ? "Finish" : "Next stop →"}
        </button>
        <button
          className="session-strip-btn"
          onClick={() => vscode.postMessage({ type: "tour/stop" })}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function labelForIntent(intent: string): string {
  if (intent === "codebase") return "Codebase tour";
  // Forward-compatible with future intents ("auth-flow", "around file").
  return intent.replace(/-/g, " ") + " tour";
}

function shortPath(p: string, max = 40): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  const tail = parts.slice(-2).join("/");
  return `…/${tail}`;
}
