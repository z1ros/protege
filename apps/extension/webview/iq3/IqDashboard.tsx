import React, { useEffect, useState } from "react";
import type { Iq3Headline } from "@protege/types";
import { PILLAR_FLOOR_FALLBACK, PILLAR_IDS } from "@protege/types";
import { HeadlineCard } from "./HeadlineCard.js";
import { PillarBar } from "./PillarBar.js";
import { FieldVector } from "./FieldVector.js";
import { OnboardingProbes } from "./OnboardingProbes.js";
import {
  SelfRatingPrompt,
  shouldShowSelfRating,
  markSelfRatingShown,
} from "./SelfRatingPrompt.js";
import { vscode } from "../vscode.js";

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
  const [doneOnboarding, setDoneOnboarding] = useState(false);
  // Compute eligibility once at mount so the prompt doesn't blink in
  // and out as `localStorage` is read on each render.
  const [showRating, setShowRating] = useState(() => shouldShowSelfRating());

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
  // Cold + low-confidence users see the 5-question probe flow before
  // they ever see the dashboard. Once `doneOnboarding` flips, they
  // never re-enter this branch in the same webview session — the next
  // headline poll bumps confidence and maturity anyway.
  const isCold =
    headline.maturity === "cold" &&
    headline.confidence < 0.2 &&
    !doneOnboarding;
  if (isCold) {
    return (
      <OnboardingProbes
        onComplete={(field, matchKeys) => {
          try {
            vscode.postMessage({
              type: "iq/onboardingComplete",
              payload: { field, matchKeys },
            });
          } catch {
            // Webview <-> host bridge unavailable (running outside
            // VS Code, e.g. storybook-style preview). Swallow so the
            // user still gets to the dashboard.
          }
          setDoneOnboarding(true);
        }}
      />
    );
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
      {showRating && headline.maturity !== "cold" ? (
        <SelfRatingPrompt
          onSubmit={(rating, note) => {
            try {
              vscode.postMessage({
                type: "iq/selfRating",
                payload: { rating, note },
              });
            } catch {
              // Bridge unavailable — still mark shown so we honor the
              // cooldown rather than nag on every reload.
            }
            markSelfRatingShown();
            setShowRating(false);
          }}
          onSkip={() => {
            markSelfRatingShown();
            setShowRating(false);
          }}
        />
      ) : null}
    </div>
  );
}
