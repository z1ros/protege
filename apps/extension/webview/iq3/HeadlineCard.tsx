import React from "react";
import type { Iq3Headline } from "@protege/types";

const RANK_LABEL: Record<string, string> = {
  learner: "Learner",
  junior: "Junior",
  mid: "Mid",
  senior: "Senior",
};

export function HeadlineCard({ h }: { h: Iq3Headline }) {
  const rank = RANK_LABEL[h.rank.rank] ?? h.rank.rank;
  const cap = h.rank.floorViolation
    ? ` (capped: ${h.rank.floorViolation.pillar} below floor)`
    : "";
  return (
    <div className="iq3-headline-card">
      <div className="iq3-headline-score">
        {h.score}
        <span className="iq3-ci">± {h.ciHalfWidth}</span>
      </div>
      <div className="iq3-rank">
        {rank}
        {cap}
      </div>
      <div className="iq3-confidence">
        {Math.round(h.confidence * 100)}% confident · {h.maturity}
      </div>
    </div>
  );
}
