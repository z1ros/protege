import React from "react";
import type { Iq3PillarScore } from "@protege/types";

const PILLAR_LABEL: Record<string, string> = {
  comprehension: "Comprehension",
  execution: "Execution",
  diagnostics: "Diagnostics",
  verification: "Verification",
  stewardship: "Stewardship",
  aiPartnership: "AI Partnership",
};

export function PillarBar({
  pillar,
  data,
  floorMark,
}: {
  pillar: string;
  data: Iq3PillarScore;
  floorMark?: number;
}) {
  const label = PILLAR_LABEL[pillar] ?? pillar;
  if (data.pending) {
    return (
      <div className="iq3-pillar iq3-pillar--pending">
        <div className="iq3-pillar-label">{label}</div>
        <div className="iq3-pillar-pending">awaiting evidence</div>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, (data.score / 1000) * 100));
  return (
    <div className="iq3-pillar">
      <div className="iq3-pillar-label">
        {label}{" "}
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
