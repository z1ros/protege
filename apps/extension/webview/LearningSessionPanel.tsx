import React, { useEffect, useRef, useState } from "react";
import { vscode } from "./vscode.js";
import type {
  LearningSession,
  LearningSessionTrace,
  LearningStep,
  LearningTraceEvent,
} from "@protege/types";

/**
 * Learning Mode panel.
 *
 * Takes over the sidebar content when a learning session is active.
 * The host (`learningMode.ts`) is the single source of truth — this
 * component is fully controlled. Every action (done / hint / show /
 * stop) posts a message; the host mutates session state and broadcasts
 * `learning/state` back, which re-renders the panel.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ Learning session · add a filter         │   header + ✕ close
 *   │ file.tsx · 4 steps · ~4 min             │
 *   ├─────────────────────────────────────────┤
 *   │ ▸ Step 2 · Render a 3-option dropdown  │   CURRENT step expanded
 *   │   What to do: …                         │
 *   │   [ ✿ Hint ] [ ✓ I'm done ] [ ↗ Show ] │
 *   │   inline validation note (if any)       │
 *   ├─────────────────────────────────────────┤
 *   │ ✓ Step 1 · Add a filter state variable │   PASSED, collapsed
 *   │ ○ Step 3 · …                            │   FUTURE
 *   │ ○ Step 4 · …                            │
 *   └─────────────────────────────────────────┘
 *
 * Why a panel overlay and not a whole new tab: Learning Mode is
 * session-scoped — when it ends, the sidebar reverts. A tab would
 * leave an empty "LEARN" entry behind when not in use.
 */

export function LearningSessionPanel({
  session,
  devTrace,
  onClose,
}: {
  session: LearningSession;
  devTrace?: LearningSessionTrace | null;
  onClose: () => void;
}) {
  const currentRef = useRef<HTMLDivElement | null>(null);
  const [devOpen, setDevOpen] = useState(false);

  // Scroll the current step into view whenever the index advances.
  useEffect(() => {
    if (currentRef.current) {
      currentRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [session.currentStepIndex]);

  const totalSteps = session.plan.steps.length;
  const passedCount = session.plan.steps.filter(
    (s) => s.status === "passed"
  ).length;
  const isPlanningPhase =
    session.plan.steps.length === 1 && session.plan.steps[0].id === "planning";

  return (
    <div className="learn-panel">
      <header className="learn-header">
        <div className="learn-header-main">
          <span className="learn-title microcaps">Learning session</span>
          <span className="learn-goal">{session.goal}</span>
        </div>
        {devTrace && (
          <button
            className={`learn-dev-toggle${devOpen ? " learn-dev-toggle--open" : ""}`}
            onClick={() => setDevOpen((v) => !v)}
            title="Inspect the raw Haiku plan and validator verdicts for this session"
          >
            Dev
          </button>
        )}
        <button
          className="learn-close-btn"
          onClick={onClose}
          title="End session"
          aria-label="End session"
        >
          ×
        </button>
      </header>

      <div className="learn-subtitle microcaps">
        {isPlanningPhase ? (
          <>planning…</>
        ) : (
          <>
            {session.path} · {totalSteps} {totalSteps === 1 ? "step" : "steps"}{" "}
            · ~{session.plan.estimatedMinutes || 4} min · {passedCount}/
            {totalSteps} done
          </>
        )}
      </div>

      <div className="learn-steps">
        {session.plan.steps.map((step, idx) => (
          <StepRow
            key={step.id}
            ref={idx === session.currentStepIndex ? currentRef : undefined}
            step={step}
            index={idx}
            isCurrent={idx === session.currentStepIndex}
            validating={session.validating && idx === session.currentStepIndex}
          />
        ))}
      </div>

      <div className="learn-footer microcaps">
        ⌘↵ to mark done · hover a step to review feedback
      </div>

      {devTrace && devOpen && <LearningDevDrawer trace={devTrace} />}
    </div>
  );
}

/** Dev drawer — read-only inspector for the raw Haiku plan + every
 *  validator verdict for the current session. Gated behind the
 *  `protege.learning.devLogging` setting (host side); if disabled,
 *  `devTrace` is null and the drawer never mounts. */
function LearningDevDrawer({ trace }: { trace: LearningSessionTrace }) {
  const validations = trace.events.filter(
    (e): e is Extract<LearningTraceEvent, { kind: "validation" }> =>
      e.kind === "validation"
  );
  const reveals = trace.events.filter(
    (e) => e.kind === "hint-revealed" || e.kind === "show-revealed"
  );
  const copyAll = () => {
    navigator.clipboard
      .writeText(JSON.stringify(trace, null, 2))
      .catch(() => {});
  };
  return (
    <div className="learn-dev-drawer">
      <div className="learn-dev-header">
        <span className="microcaps">Dev · session trace</span>
        <button className="learn-dev-copy" onClick={copyAll}>
          Copy trace
        </button>
      </div>

      <div className="learn-dev-section">
        <div className="learn-dev-section-title microcaps">plan</div>
        <pre className="learn-dev-code">
          {JSON.stringify(trace.plan, null, 2)}
        </pre>
      </div>

      {validations.length > 0 && (
        <div className="learn-dev-section">
          <div className="learn-dev-section-title microcaps">
            validator verdicts ({validations.length})
          </div>
          {validations.map((v, i) => (
            <div className="learn-dev-verdict" key={i}>
              <div className="learn-dev-verdict-head microcaps">
                stepId={v.stepId} · attempt={v.attempt} · {v.verdict.status}
                {" · "}
                {v.elapsedMs}ms
              </div>
              <pre className="learn-dev-code">
                {JSON.stringify(v.verdict, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {reveals.length > 0 && (
        <div className="learn-dev-section">
          <div className="learn-dev-section-title microcaps">
            reveals ({reveals.length})
          </div>
          <ul className="learn-dev-reveals">
            {reveals.map((r, i) => (
              <li key={i}>
                {r.kind === "hint-revealed" ? "hint" : "show"} · {r.stepId}
              </li>
            ))}
          </ul>
        </div>
      )}

      {trace.truncated && (
        <div className="learn-dev-truncated microcaps">
          trace was trimmed to fit storage cap — older events dropped
        </div>
      )}
    </div>
  );
}

// ---- Step row ----

interface StepRowProps {
  step: LearningStep;
  index: number;
  isCurrent: boolean;
  validating: boolean;
}

const StepRow = React.forwardRef<HTMLDivElement, StepRowProps>(function StepRow(
  { step, index, isCurrent, validating },
  ref
) {
  const glyph = statusGlyph(step);
  const classes = [
    "learn-step",
    `learn-step-${step.status}`,
    isCurrent ? "learn-step-current" : "",
    validating ? "learn-step-validating" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stepNumber = index + 1;

  return (
    <div className={classes} ref={ref}>
      <div className="learn-step-head">
        <span className={`learn-step-glyph glyph-${step.status}`}>
          {glyph}
        </span>
        <span className="learn-step-number microcaps">Step {stepNumber}</span>
        <span className="learn-step-title">{step.title}</span>
      </div>

      {isCurrent && (
        <div className="learn-step-body">
          {step.whyItMatters && (
            <div className="learn-step-why">
              <span className="learn-step-why-label microcaps">why</span>
              <span>{step.whyItMatters}</span>
            </div>
          )}
          <div className="learn-step-what">{step.whatToDo}</div>
          <div className="learn-step-criteria microcaps">
            Success when: {step.successCriteria}
          </div>

          {step.hintRevealed && step.hint && (
            <div className="learn-step-hint">
              <span className="learn-step-hint-label microcaps">hint</span>
              <span>{step.hint}</span>
            </div>
          )}

          {step.lastNote && (
            <div
              className={`learn-step-feedback feedback-${step.status}`}
              role="status"
              aria-live="polite"
            >
              <span className="learn-step-feedback-label microcaps">
                {feedbackLabel(step.status)}
              </span>
              <span>{step.lastNote}</span>
              {step.lastHintFromValidator && (
                <span className="learn-step-feedback-hint">
                  {step.lastHintFromValidator}
                </span>
              )}
              {step.lastBonus && (
                <span className="learn-step-feedback-bonus">
                  +  {step.lastBonus}
                </span>
              )}
            </div>
          )}

          <div className="learn-step-actions">
            <button
              className="learn-btn primary"
              disabled={validating}
              onClick={() => vscode.postMessage({ type: "learning/done" })}
            >
              {validating ? "Validating…" : "✓ I'm done"}
            </button>
            <button
              className="learn-btn"
              disabled={validating || step.hintRevealed}
              onClick={() => vscode.postMessage({ type: "learning/hint" })}
              title={step.hintRevealed ? "Hint already shown" : "Reveal a nudge"}
            >
              ✿ Hint
            </button>
            {step.referenceSnippet && (
              <button
                className="learn-btn learn-btn-muted"
                disabled={validating}
                onClick={() => vscode.postMessage({ type: "learning/show" })}
                title="Reveal a reference snippet and skip to the next step"
              >
                ↗ Show me
              </button>
            )}
          </div>
        </div>
      )}

      {!isCurrent && step.lastNote && step.status !== "passed" && (
        <div
          className={`learn-step-collapsed-note feedback-${step.status}`}
          title={step.lastNote}
        >
          {feedbackLabel(step.status)} · {step.lastNote}
        </div>
      )}
    </div>
  );
});

function statusGlyph(step: LearningStep): string {
  switch (step.status) {
    case "passed":
      return "✓"; // ✓
    case "partial":
      return "◐"; // ◐
    case "failed":
      return "✗"; // ✗
    case "off-track":
      return "↺"; // ↺
    case "shown":
      return "↗"; // ↗
    case "current":
      return "▸"; // ▸
    case "pending":
    default:
      return "○"; // ○
  }
}

function feedbackLabel(status: LearningStep["status"]): string {
  switch (status) {
    case "passed":
      return "pass";
    case "partial":
      return "partial";
    case "failed":
      return "not yet";
    case "off-track":
      return "off-track";
    case "shown":
      return "shown";
    default:
      return "";
  }
}
