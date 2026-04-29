import React from "react";
import type {
  GainEvent,
  MilestoneSummary,
  StreakInfo,
} from "@protege/types";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconStar, IconCheck, IconPlus } from "./icons.js";
import { vscode } from "./vscode.js";

/**
 * Profile page — merged with Settings.
 *
 * The top half is "who you are" (profile hero, stats, journey, recent wins).
 * The bottom half is "how Protege behaves" (the preferences that used to
 * live in a separate Settings overlay). Combined here because the user
 * asked to reduce header icons and keep everything in one place.
 */

interface Props {
  userName: string;
  avatarUrl?: string | null;
  memberSince: string;
  codeIq: number;
  maxIq: number;
  totalConcepts: number;
  ruleCount: number;
  streak: StreakInfo;
  milestones: MilestoneSummary[];
  recentGains: GainEvent[];
}

export function ProfilePage({
  userName,
  memberSince,
  codeIq,
  totalConcepts,
  ruleCount,
  streak,
  milestones,
  recentGains,
}: Props) {
  const unlocked = milestones.filter((m) => m.unlocked);
  const bonusIq = unlocked.reduce((s, m) => s + m.bonusIq, 0);

  return (
    <div className="page profile-page">
      <CinematicPlate
        image="galaxySky"
        caption={`MEMBER SINCE · ${memberSince.toUpperCase()}`}
        ratio="16:9"
        intensity={0.55}
      >
        <div className="profile-hero-over">
          <div className="microcaps">Your profile</div>
          <div className="profile-name serif">{userName}</div>
          <div className="profile-iq">
            <span className="serif-num">{codeIq}</span>
            <span className="profile-iq-label microcaps">Progress</span>
          </div>
        </div>
      </CinematicPlate>

      <div className="hero-stats profile-stats">
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{streak.current}</span>
            <span className="hero-stat-unit">d</span>
          </div>
          <div className="hero-stat-label microcaps">Streak</div>
          <div className="hero-stat-sub">best {streak.longest}d</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{totalConcepts}</span>
            <span className="hero-stat-unit">/{ruleCount}</span>
          </div>
          <div className="hero-stat-label microcaps">Concepts</div>
          <div className="hero-stat-sub">mastered</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{unlocked.length}</span>
            <span className="hero-stat-unit">/{milestones.length}</span>
          </div>
          <div className="hero-stat-label microcaps">Milestones</div>
          <div className="hero-stat-sub">+{bonusIq} bonus IQ</div>
        </div>
      </div>

      {/* Plan moved up here (was below Recent wins). User-facing
          billing state belongs above the activity log so it's visible
          without scrolling. */}
      <PlanSection />

      {/* "Your journey" milestone list removed — it surfaced "+50 IQ"
          deltas tied to the legacy Code IQ system, which we're not
          shipping. Re-add only if/when those rewards have a real meaning
          again. */}

      {recentGains.length > 0 && (
        <section className="profile-section">
          <div className="section-label microcaps">Recent wins</div>
          <div className="recent-wins">
            {recentGains.slice(0, 5).map((g, i) => (
              <div key={`${g.ts}-${i}`} className={`win-row win-${g.kind ?? "concept"}`}>
                <span className="win-delta">
                  <span className="win-icon">
                    {g.kind === "milestone" ? (
                      <IconStar size={10} strokeWidth={2.2} />
                    ) : g.kind === "fix" ? (
                      <IconCheck size={10} strokeWidth={2.6} />
                    ) : (
                      <IconPlus size={10} strokeWidth={2.6} />
                    )}
                  </span>
                  {g.deltaIq}
                </span>
                <span className="win-concept">{g.concept}</span>
                <span className="win-file">{g.file}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Preferences section retired 2026-04-29 — Reduce motion was
          the only remaining toggle and the user prefers a single
          unified animation policy. localStorage key still honored
          on read so prior users who toggled it on stay quiet, but
          there's no longer a UI to flip it. */}

      <section className="profile-section profile-actions">
        <button
          className="ghost-btn"
          onClick={() => {
            vscode.postMessage({ type: "auth/logout" });
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}

/* ==========================================================
   Daily limits — usage bars only.

   Paid tier / "Free Trial" framing intentionally stripped (was
   premature: no billing wired, no Stripe, no real plans). The
   surface now exists to give the user visibility into how much
   they're using each capability per UTC day so we can pick real
   limits informed by actual behavior. Add the upgrade CTA back
   when billing lands and the numbers below stop being stub data.
   ========================================================== */

const STUB_USAGE = {
  // TODO(billing): replace with real values from MeResponse /
  // backend usage counters keyed on (userId, utcDate). For now
  // these are placeholders so the layout shows something while
  // we tune the daily caps in code.
  chatMessagesUsed: 32,
  chatMessagesLimit: 50,
  toolCallsUsed: 3,
  toolCallsLimit: 5,
  voiceMinutesUsed: 6,
  voiceMinutesLimit: 10,
};

/**
 * Daily-limits section — three bars, one per metered surface.
 * No price, no plan name, no upgrade CTA. The bars exist so the
 * user (and we) can see how the caps land in practice.
 */
function PlanSection() {
  const u = STUB_USAGE;

  return (
    <section className="profile-section">
      <div className="section-label microcaps">Daily limits</div>
      <div className="plan-card">
        <div className="plan-card-glow" aria-hidden />

        <div className="plan-card-head">
          <div className="plan-card-title">
            <span className="plan-card-name">Usage today</span>
          </div>
          <p className="plan-card-tagline">
            Counts reset at 00:00 UTC. These caps keep the assistant
            responsive without burning through budget.
          </p>
        </div>

        <div className="plan-card-usage">
          <PlanUsage
            label="Chat messages"
            used={u.chatMessagesUsed}
            limit={u.chatMessagesLimit}
          />
          <PlanUsage
            label="Tool calls"
            used={u.toolCallsUsed}
            limit={u.toolCallsLimit}
          />
          <PlanUsage
            label="Voice minutes"
            used={u.voiceMinutesUsed}
            limit={u.voiceMinutesLimit}
          />
        </div>
      </div>
    </section>
  );
}

function PlanUsage({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  return (
    <div className="profile-plan-usage">
      <div className="profile-plan-usage-head">
        <span className="profile-plan-usage-label">{label}</span>
        <span className="profile-plan-usage-count">
          {used} / {limit}
        </span>
      </div>
      <div className="profile-plan-usage-bar">
        <div
          className="profile-plan-usage-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
