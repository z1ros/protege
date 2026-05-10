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
  // Only show the cap label when an actual demotion happened. The
  // floorViolation field is recorded any time a pillar is below the
  // computed rank's floor, but the rank logic only demotes seniors.
  // For non-senior tiers the violation is informational and should
  // not be presented as a cap.
  const wasCapped = h.rank.rank !== h.rank.uncappedRank;
  const cap = wasCapped && h.rank.floorViolation
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
    </div>
  );
}
