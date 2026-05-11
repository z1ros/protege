import React, { useEffect, useState } from "react";
import type { Iq3Headline } from "@protege/types";
import { PILLAR_FLOOR_FALLBACK, PILLAR_IDS } from "@protege/types";
import { HeadlineCard } from "./HeadlineCard.js";
import { PillarBar } from "./PillarBar.js";
import {
  FieldVector,
  FIELD_VECTOR_MIN_SIGNAL,
  topFieldWeight,
} from "./FieldVector.js";
import { OnboardingProbes } from "./OnboardingProbes.js";
import {
  SelfRatingPrompt,
  shouldShowSelfRating,
  markSelfRatingShown,
} from "./SelfRatingPrompt.js";
import { WeirdFeedbackPrompt } from "./WeirdFeedbackPrompt.js";
import { vscode } from "../vscode.js";

/**
 * Error boundary so a thrown render in any iq3 child (HeadlineCard,
 * FieldVector, PillarBar, OnboardingProbes, etc.) doesn't unmount the
 * entire ProfilePage. A schema-drifted backend response or a missing
 * field on the headline payload used to take the whole profile blank
 * with no error surface; this catches the throw and shows a benign
 * fallback inside the dashboard slot instead.
 */
class IqErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the webview console so a developer inspecting the
    // EDH window can still see the underlying throw, even though
    // the user-facing UI is shielded from it.
    console.error("[iq3] dashboard render threw:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="iq3-dashboard-empty">
          IQ unavailable — schema mismatch with backend. Reload to retry.
        </div>
      );
    }
    return this.props.children;
  }
}

export function IqDashboard() {
  return (
    <IqErrorBoundary>
      <IqDashboardInner />
    </IqErrorBoundary>
  );
}

/**
 * Back-compat: pillar IDs were renamed. The local-dev backend returns
 * the new keys, but the production deployment still ships the old
 * names. Map them in so the dashboard shows real data instead of
 * crashing on undefined access.
 */
const LEGACY_PILLAR_KEY_MAP: Record<string, string> = {
  comprehension: "reading",
  execution: "writing",
  diagnostics: "debugging",
  verification: "testing",
  stewardship: "maintainability",
  aiPartnership: "aiLiteracy",
};
function normalizePillars(
  pillars: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(pillars ?? {}) };
  for (const [legacy, current] of Object.entries(LEGACY_PILLAR_KEY_MAP)) {
    if (out[current] === undefined && out[legacy] !== undefined) {
      out[current] = out[legacy];
    }
  }
  return out;
}

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
function IqDashboardInner() {
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
    // Nudge the host for a fresh `/iq/me` so we don't sit on
    // "Loading IQ…" for up to 30s waiting for the next poll. The host
    // also replays its last cached headline on webview mount, so the
    // common reopen path hydrates synchronously; this ask covers the
    // first-mount-before-any-poll-succeeded case.
    try {
      vscode.postMessage({ type: "iq/refresh" });
    } catch {
      // Webview shell unavailable (storybook-style preview). Fine.
    }
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
  // Defensive: payloads from older backend deployments may omit `rank`
  // entirely. Use the same fallback as HeadlineCard so the floor mark
  // computation doesn't crash on undefined access.
  const uncappedRank = headline.rank?.uncappedRank ?? "junior";
  const floor = PILLAR_FLOOR_FALLBACK[uncappedRank];
  // Hide the FieldVector until at least one field has a real signal.
  // Below the threshold the bar is just a uniform-ish stripe that
  // doesn't carry information — and worse, it implies "the system
  // thinks you're equally everything," which is misleading. Once a
  // field crosses ~20% (typically after onboarding probes or ~20
  // tagged events), we've got something worth showing.
  // topFieldWeight is now nullish-safe — returns 0 for missing fields
  // so this gate falls through to the "still learning" branch.
  const showFieldVector =
    headline.field !== undefined &&
    topFieldWeight(headline.field) >= FIELD_VECTOR_MIN_SIGNAL;
  return (
    <div className="iq3-dashboard">
      <HeadlineCard h={headline} />
      {showFieldVector && headline.field ? (
        <FieldVector v={headline.field} />
      ) : (
        <div className="iq3-field-pending">
          <div className="iq3-field-pending-bar" aria-hidden="true" />
          <div className="iq3-field-pending-msg">
            We're still learning your style. Keep coding to see your domain
            breakdown!
          </div>
        </div>
      )}
      <div className="iq3-pillars">
        {(() => {
          const normalized = normalizePillars(
            headline.pillars as unknown as Record<string, unknown>,
          );
          return PILLAR_IDS.map((p) => {
            const data = (normalized[p] ??
              normalized[
                Object.entries(LEGACY_PILLAR_KEY_MAP).find(
                  ([, v]) => v === p,
                )?.[0] ?? p
              ]) as Iq3Headline["pillars"][typeof p] | undefined;
            if (!data) return null;
            return (
              <PillarBar key={p} pillar={p} data={data} floorMark={floor} />
            );
          });
        })()}
      </div>
      {headline.rank?.floorViolation &&
       headline.rank.uncappedRank === "senior" &&
       headline.rank.rank !== "senior" ? (
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
      <WeirdFeedbackPrompt />
    </div>
  );
}
