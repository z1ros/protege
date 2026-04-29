import React, { useState } from "react";
import type { LessonStateSnapshot } from "@protege/types";

/**
 * Lesson banner — concept + step counter + step summary + a
 * collapsible roadmap of the full plan. Read-only in v1 (no skip /
 * back / restart). Updates per turn off the `lesson/state` broadcast.
 */
export function LessonBanner({
  state,
}: {
  state: LessonStateSnapshot | null;
}) {
  const [planOpen, setPlanOpen] = useState(false);

  if (!state) return null;
  if (state.phase === "DONE") return null;

  // FLOW mode (no plan) → totalSteps = 0, stepNumber holds the turn count.
  // Show "Turn N" so the user sees progress without a fake "of M".
  // Legacy plan-walk mode → "Step N of M".
  const isFlowMode = state.phase !== "PROBE" && state.totalSteps === 0;
  const stepLabel =
    state.phase === "PROBE"
      ? "Level check"
      : isFlowMode
        ? `Turn ${state.stepNumber}`
        : `Step ${state.stepNumber} of ${state.totalSteps}`;
  const typeLabel =
    state.phase === "PROBE" ? "PROBE" : (state.currentStepType ?? "");
  const summary =
    state.phase === "PROBE"
      ? "checking your level"
      : (state.currentStepSummary ?? prettyType(typeLabel));

  return (
    <div className="lesson-banner" role="status" aria-live="polite">
      <div className="lesson-banner-row">
        <span className="lesson-banner-concept">
          Lesson · <strong>{state.concept}</strong>
        </span>
        <span className="lesson-banner-progress">{stepLabel}</span>
      </div>
      <div className="lesson-banner-summary">{summary}</div>
      {state.plan.length > 0 && (
        <button
          type="button"
          className="lesson-banner-toggle"
          onClick={() => setPlanOpen((v) => !v)}
          aria-expanded={planOpen}
        >
          {planOpen ? "▾" : "▸"} all {state.plan.length} steps
        </button>
      )}
      {planOpen && state.plan.length > 0 && (
        <ol className="lesson-banner-plan">
          {state.plan.map((s, i) => {
            const stepNum = i + 1;
            const isCurrent = stepNum === state.stepNumber;
            const isDone = stepNum < state.stepNumber;
            return (
              <li
                key={i}
                className={`lesson-banner-plan-item ${
                  isCurrent
                    ? "lesson-banner-plan-item--current"
                    : isDone
                      ? "lesson-banner-plan-item--done"
                      : "lesson-banner-plan-item--future"
                }`}
              >
                <span className="lesson-banner-plan-marker">
                  {isDone ? "✓" : isCurrent ? "▸" : "·"}
                </span>
                <span className="lesson-banner-plan-num">{stepNum}.</span>
                <span className="lesson-banner-plan-summary">{s.summary}</span>
                <span className="lesson-banner-plan-type">
                  {prettyType(s.type)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function prettyType(type: string): string {
  switch (type) {
    case "PROBE":
      return "checking your level";
    case "EXPLAIN-ATOM":
      return "explain";
    case "SHOW-CODE":
      return "example";
    case "DO-IT-NOW":
      return "add code";
    case "TASK-SOLO":
      return "your turn";
    case "REVIEW":
      return "review";
    case "WHY-ANSWER":
      return "answering";
    case "CLOSE":
      return "wrap";
    default:
      return type.toLowerCase().replace(/-/g, " ");
  }
}
