import React from "react";
import type { Iq3PillarScore } from "@protege/types";

const PILLAR_LABEL: Record<string, string> = {
  reading: "Reading",
  writing: "Writing",
  debugging: "Debugging",
  testing: "Testing",
  maintainability: "Maintainability",
  aiLiteracy: "AI Literacy",
};

const PILLAR_DESCRIPTION: Record<string, string> = {
  reading:
    "How well you read and understand existing code and systems. Tracking unfamiliar codebases, recognizing patterns, mapping data flow, asking precise questions.",
  writing:
    "How efficiently you write and ship working code. Translating intent into syntax, scaffolding features quickly, and getting to a runnable state on the first try.",
  debugging:
    "Debugging skill. Forming testable hypotheses, isolating root causes, reading stack traces and logs, narrowing in instead of guessing.",
  testing:
    "Testing rigor. Writing meaningful tests before shipping, covering edge cases, validating assumptions, and catching regressions early.",
  maintainability:
    "Code quality and long-term maintenance. Naming, refactoring, readable structure, deleting dead code, leaving the codebase better than you found it.",
  aiLiteracy:
    "Working effectively with AI assistants. Writing clear prompts, validating AI output instead of trusting it, and knowing when to delegate vs. verify by hand.",
};

export function PillarBar({
  pillar,
  data,
  floorMark,
}: {
  pillar: string;
  data: Iq3PillarScore | undefined;
  floorMark?: number;
}) {
  // Defensive render — earlier shape mismatches (pillar IDs renamed in
  // types but old keys returned by the deployed backend) caused the
  // entire profile overlay to silently blank because PillarBar threw on
  // `data.pending` when data was undefined. Render an explicit
  // unavailable state instead so the rest of the dashboard survives.
  if (!data) {
    return (
      <div className="iq3-pillar iq3-pillar--pending">
        <div className="iq3-pillar-label">
          <span className="iq3-pillar-name">{PILLAR_LABEL[pillar] ?? pillar}</span>
        </div>
        <div className="iq3-pillar-pending">data unavailable</div>
      </div>
    );
  }
  const label = PILLAR_LABEL[pillar] ?? pillar;
  const description = PILLAR_DESCRIPTION[pillar];
  // `?` info marker. Uses the native `title` attribute so the tooltip
  // works without a positioning library or extra portals — VS Code
  // webviews honor it. `aria-label` makes the marker discoverable to
  // screen readers; `tabIndex={0}` lets keyboard users focus it (the
  // browser surfaces the title as a tooltip on focus).
  // `?` marker + custom tooltip popup. The tooltip sits in the same
  // wrapper as the icon so a single `:hover` (or `:focus-within` for
  // keyboard users) reveals it. We deliberately don't set the native
  // `title` attribute — it would race the styled popup and produce a
  // duplicate ugly browser tooltip.
  const helpIcon = description ? (
    <span className="iq3-pillar-help-wrap">
      <span
        className="iq3-pillar-help"
        role="img"
        aria-label={`${label}: ${description}`}
        tabIndex={0}
      >
        ?
      </span>
      <span className="iq3-pillar-help-tip" role="tooltip">
        {description}
      </span>
    </span>
  ) : null;
  if (data.pending) {
    return (
      <div className="iq3-pillar iq3-pillar--pending">
        <div className="iq3-pillar-label">
          <span className="iq3-pillar-name">
            {label}
            {helpIcon}
          </span>
        </div>
        <div className="iq3-pillar-pending">awaiting evidence</div>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, (data.score / 1000) * 100));
  return (
    <div className="iq3-pillar">
      <div className="iq3-pillar-label">
        <span className="iq3-pillar-name">
          {label}
          {helpIcon}
        </span>{" "}
        <span>
          {data.score} ± {data.ciHalfWidth}
        </span>
      </div>
      <div className="iq3-pillar-track">
        <div className="iq3-pillar-fill" style={{ width: `${pct}%` }} />
        {floorMark !== undefined ? (
          <div
            className="iq3-pillar-floor"
            style={{ left: `${(floorMark / 1000) * 100}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}
