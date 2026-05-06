import React, { useEffect, useState } from "react";
import type { Iq3Headline } from "@protege/types";
import { PILLAR_FLOOR_FALLBACK, PILLAR_IDS } from "@protege/types";
import { HeadlineCard } from "./HeadlineCard.js";
import { PillarBar } from "./PillarBar.js";
import { FieldVector } from "./FieldVector.js";

/**
 * IQ dashboard — Phase A surface for the Iq3 HMM.
 *
 * Subscribes to `iq/headline` host→webview broadcasts (extension polls
 * `/iq/me` every 30s and forwards). Renders four blocks:
 *
 *   1. HeadlineCard   — score + CI half-width + rank + maturity
 *   2. FieldVector    — sorted stacked bar over field probability
 *   3. PillarBar × N  — per-pillar score with rank-floor mark
 *   4. Floor note     — explanation when senior is gated by a floor
 *
 * Accepts both `{ type: "iq/headline" }` and `{ channel: "iq/headline" }`
 * envelope shapes so the consumer is robust to either broadcast style
 * (Task 22 settled on `type`, but keeping the channel branch costs
 * nothing and removes a coupling point).
 */
export function IqDashboard() {
  const [headline, setHeadline] = useState<Iq3Headline | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as
        | { type?: string; channel?: string; payload?: unknown }
        | undefined;
      if (!msg) return;
      if (msg.type === "iq/headline" || msg.channel === "iq/headline") {
        setHeadline(msg.payload as Iq3Headline);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!headline) {
    return <div className="iq3-dashboard-empty">Loading IQ…</div>;
  }
  const floor = PILLAR_FLOOR_FALLBACK[headline.rank.uncappedRank];
  return (
    <div className="iq3-dashboard">
      <HeadlineCard h={headline} />
      <FieldVector v={headline.field} />
      <div className="iq3-pillars">
        {PILLAR_IDS.map((p) => (
          <PillarBar
            key={p}
            pillar={p}
            data={headline.pillars[p]}
            floorMark={floor}
          />
        ))}
      </div>
      {headline.rank.floorViolation ? (
        <div className="iq3-floor-note">
          {`Senior gated by ${headline.rank.floorViolation.pillar} floor (${headline.rank.floorViolation.score} < ${headline.rank.floorViolation.floor}). Lift it to advance.`}
        </div>
      ) : null}
    </div>
  );
}
