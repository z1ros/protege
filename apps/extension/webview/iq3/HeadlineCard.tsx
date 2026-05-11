import React from "react";
import type { Iq3Headline } from "@protege/types";

const RANK_LABEL: Record<string, string> = {
  learner: "Learner",
  junior: "Junior",
  mid: "Mid",
  senior: "Senior",
};

export function HeadlineCard({ h }: { h: Iq3Headline }) {
  // Defensive: older backend deployments + cold-start payloads can ship
  // a headline with `rank` missing entirely. Throwing on `h.rank.rank`
  // here would unmount the entire dashboard — including HeadlineCard's
  // siblings — and leave the profile page blank with no error surface.
  const rankObj = h.rank ?? {
    rank: "junior",
    uncappedRank: "junior",
    floorViolation: null,
    dominantField: "generalist",
  };
  const rank = RANK_LABEL[rankObj.rank] ?? rankObj.rank ?? "—";
  // Only show the cap label when an actual demotion happened. The
  // floorViolation field is recorded any time a pillar is below the
  // computed rank's floor, but the rank logic only demotes seniors.
  // For non-senior tiers the violation is informational and should
  // not be presented as a cap.
  const wasCapped = rankObj.rank !== rankObj.uncappedRank;
  const cap = wasCapped && rankObj.floorViolation
    ? ` (capped: ${rankObj.floorViolation.pillar} below floor)`
    : "";
  return (
    <div className="iq3-headline-card">
      <div className="iq3-headline-score">
        {h.score ?? "—"}
        <span className="iq3-ci">± {h.ciHalfWidth ?? 0}</span>
      </div>
      <div className="iq3-rank">
        {rank}
        {cap}
      </div>
    </div>
  );
}
