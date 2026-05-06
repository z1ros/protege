import React, { useEffect, useState } from "react";
import type {
  GainEvent,
  QuotaSnapshot,
  StreakInfo,
} from "@protege/types";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconStar, IconCheck, IconPlus } from "./icons.js";
import { vscode, onHostMessage } from "./vscode.js";
import { IqDashboard } from "./iq3/IqDashboard.js";

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
  recentGains: GainEvent[];
}

export function ProfilePage({
  userName,
  memberSince,
  totalConcepts,
  ruleCount,
  streak,
  recentGains,
}: Props) {
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
          {/* "Progress" IQ display removed 2026-05-01 — the number never
              tracked accurately, so showing it as a headline metric was
              misleading. Streak / Concepts / Milestones below remain as
              the real progress signals. */}
        </div>
      </CinematicPlate>

      {/* Iq3 dashboard (Task 23) — headline score, field vector, and
          per-pillar bars. Replaces the legacy Code IQ headline that used
          to live in the hero. Subscribes to `iq/headline` broadcasts the
          extension fans out every 30s from `/iq/me`. */}
      <IqDashboard />

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
      </div>

      {/* Plan moved up here (was below Recent wins). User-facing
          billing state belongs above the activity log so it's visible
          without scrolling. */}
      <PlanSection />

      {/* "Your journey" milestone list removed — it surfaced "+50 IQ"
          deltas tied to the legacy Code IQ system, which we're not
          shipping. Re-add only if/when those rewards have a real meaning
          again. */}

      {recentGains.length > 0 && (() => {
        // Collapse identical consecutive wins. The backend emits a fresh
        // GainEvent per save, so a user who saves four times after each
        // edit gets four "Fixed 1 issue · pa.tsx" rows that look like
        // duplicates because (concept, file) match. We dedup at render
        // time keyed on `(kind, concept, file)`, summing deltaIq across
        // the merged events and showing a multiplier badge when count > 1.
        // No backend change — the underlying gain log is preserved.
        type WinRow = {
          kind: GainEvent["kind"] | "concept";
          concept: string;
          file: string;
          deltaIq: number;
          count: number;
          ts: string;
        };
        const collapsed: WinRow[] = [];
        for (const g of recentGains) {
          const kind = g.kind ?? "concept";
          const last = collapsed[collapsed.length - 1];
          if (
            last &&
            last.kind === kind &&
            last.concept === g.concept &&
            last.file === g.file
          ) {
            last.deltaIq += g.deltaIq;
            last.count += 1;
            continue;
          }
          collapsed.push({
            kind,
            concept: g.concept,
            file: g.file,
            deltaIq: g.deltaIq,
            count: 1,
            ts: g.ts,
          });
        }
        const rows = collapsed.slice(0, 5);
        return (
          <section className="profile-section">
            <div className="section-label microcaps">Recent wins</div>
            <div className="recent-wins">
              {rows.map((g, i) => (
                <div
                  key={`${g.ts}-${i}`}
                  className={`win-row win-${g.kind ?? "concept"}`}
                >
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
                  <span className="win-concept">
                    {g.concept}
                    {g.count > 1 && (
                      <span
                        className="win-count"
                        title={`${g.count} saves merged`}
                      >
                        ×{g.count}
                      </span>
                    )}
                  </span>
                  <span className="win-file">{g.file}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

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

/** Default limits — used as a placeholder ONLY while the real
 *  `quota/snapshot` from the host is in flight. The instant we hear
 *  back from `GET /me/quota` these get overwritten with live values.
 *  Kept in sync with `USER_FACING_LIMITS` in apps/backend/src/quotas.ts. */
const DEFAULT_USAGE = {
  // Per-route fields kept for backwards compat with the engagement
  // chart (voice vs chat split below). Limits no longer surfaced.
  chatMessagesUsed: 0,
  chatMessagesLimit: 100,
  voiceMinutesUsed: 0,
  voiceMinutesLimit: 25,
  // Single user-facing budget (2026-05-02). 2M tokens/day calibrated
  // against ~$3 of gpt-5 traffic.
  tokensUsed: 0,
  tokensLimit: 2_000_000,
};

/**
 * Daily-limits section — three bars, one per metered surface.
 *
 * Subscribes to `quota/snapshot` messages from the host (broadcast on
 * any quota mutation) and re-requests `quota/get` on mount. So the
 * panel stays live across the day without polling: scans, chats, tool
 * uses, and voice all push fresh snapshots as they happen.
 */
function PlanSection() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "quota/snapshot") {
        setQuota(msg.snapshot);
      }
    });
    // Re-request on mount in case this section mounted after the
    // initial host push fired (user landed on a different overlay
    // first, then opened Profile).
    vscode.postMessage({ type: "quota/get" });
    return off;
  }, []);

  // Live values when available; placeholder zeros + correct limits when
  // the snapshot hasn't arrived yet. Never falls back to fake "32 / 50"
  // — that was the old stub.
  const u = quota
    ? {
        chatMessagesUsed: quota.usage.chat_messages.used,
        chatMessagesLimit: quota.usage.chat_messages.limit,
        voiceMinutesUsed: quota.usage.voice_minutes.used,
        voiceMinutesLimit: quota.usage.voice_minutes.limit,
        chatMinutesUsed: quota.usage.chat_minutes?.used ?? 0,
        tokensUsed: quota.usage.tokens?.used ?? 0,
        tokensLimit: quota.usage.tokens?.limit ?? 2_000_000,
      }
    : { ...DEFAULT_USAGE, chatMinutesUsed: 0 };

  // Voice vs chat engagement split for the "how do I spend time with
  // Protege" line at the bottom of the panel. Skip the line entirely
  // when there's no engagement yet (avoids "0% / 0%").
  const totalEngagementMin = u.voiceMinutesUsed + u.chatMinutesUsed;
  const voicePct =
    totalEngagementMin > 0
      ? Math.round((u.voiceMinutesUsed / totalEngagementMin) * 100)
      : 0;
  const chatPct = totalEngagementMin > 0 ? 100 - voicePct : 0;

  return (
    <section className="profile-section">
      <div className="section-label microcaps">Daily limits</div>
      <div className="plan-card">
        <div className="plan-card-glow" aria-hidden />

        <div className="plan-card-head">
          <div className="plan-card-title">
            <span className="plan-card-name">Usage today</span>
            <QuotaStatusDot meta={quota?.meta} />
          </div>
          <p className="plan-card-tagline">
            Counts reset at 00:00 UTC. These caps keep the assistant
            responsive without burning through budget.
          </p>
        </div>

        <div className="plan-card-usage">
          {/* All per-route rows (chat messages / voice minutes / tool
              calls) retired 2026-05-02 in favor of one unified Tokens
              row. Single budget, single enforcement signal. */}
          <PlanUsage
            label="Tokens used"
            used={u.tokensUsed}
            limit={u.tokensLimit}
            compact
          />
        </div>

        {/* Engagement split — voice vs chat. Display-only (no cap),
            sourced from the same per-user table. Helps the user see at
            a glance whether they're a "talk to Protege" or "type to
            Protege" person; useful for product analytics too. */}
        {totalEngagementMin > 0 && (
          <div className="profile-plan-engagement">
            <div className="profile-plan-engagement-stats">
              <span className="profile-plan-engagement-stat">
                <span className="profile-plan-engagement-icon profile-plan-engagement-icon-voice" />
                Voice {u.voiceMinutesUsed.toFixed(1)} min
              </span>
              <span className="profile-plan-engagement-stat">
                <span className="profile-plan-engagement-icon profile-plan-engagement-icon-chat" />
                Chat {u.chatMinutesUsed.toFixed(1)} min
              </span>
            </div>
            <div
              className="profile-plan-engagement-bar"
              title={`Voice ${voicePct}% · Chat ${chatPct}%`}
              aria-label={`Voice ${voicePct} percent, chat ${chatPct} percent`}
            >
              <div
                className="profile-plan-engagement-voice"
                style={{ width: `${voicePct}%` }}
              />
              <div
                className="profile-plan-engagement-chat"
                style={{ width: `${chatPct}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanUsage({
  label,
  used,
  limit,
  unit,
  decimals,
  compact,
}: {
  label: string;
  used: number;
  limit: number;
  /** Optional unit suffix shown after the count (e.g. "min" for voice). */
  unit?: string;
  /** When set, the `used` value renders with this many decimals.
   *  Default: integer rendering. Use 1 for fractional minutes. */
  decimals?: number;
  /** When true, format used + limit as compact "1.2k / 2M" — for the
   *  Tokens row where raw integers (1,234,567) are unreadable. */
  compact?: boolean;
}) {
  const safeUsed =
    typeof used !== "number" || !Number.isFinite(used) || used < 0 ? 0 : used;
  const safeLimit =
    typeof limit !== "number" || !Number.isFinite(limit) || limit < 0
      ? 0
      : limit;
  const pct =
    safeLimit > 0 ? Math.max(0, Math.min(100, (safeUsed / safeLimit) * 100)) : 0;
  const fmt = (n: number): string => {
    if (compact) {
      if (n < 1000) return Math.floor(n).toString();
      if (n < 1_000_000)
        return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
      return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
    }
    return typeof decimals === "number"
      ? n.toFixed(decimals)
      : Math.floor(n).toString();
  };
  return (
    <div className="profile-plan-usage">
      <div className="profile-plan-usage-head">
        <span className="profile-plan-usage-label">{label}</span>
        <span className="profile-plan-usage-count">
          {fmt(safeUsed)} / {fmt(safeLimit)}
          {unit ? ` ${unit}` : ""}
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

/**
 * Tiny health indicator next to the "Usage today" title. Tells the user
 * whether the counters they're staring at are real or whether the
 * backend isn't actually persisting (no Supabase, no table, etc.).
 *
 * Tooltip carries the precise probe state so a misconfigured beta
 * deployment is one hover away from "ah, table missing — run the SQL."
 */
function QuotaStatusDot({
  meta,
}: {
  meta: NonNullable<QuotaSnapshot["meta"]> | undefined;
}) {
  if (!meta) {
    return (
      <span
        className="quota-status-dot quota-status-dot-unknown"
        title="Quota subsystem health — waiting for first response from /me/quota"
        aria-label="Quota status: unknown"
      />
    );
  }
  const isConnected = meta.probe === "connected";
  const cls = isConnected
    ? "quota-status-dot quota-status-dot-ok"
    : "quota-status-dot quota-status-dot-warn";
  const tip = (() => {
    switch (meta.probe) {
      case "connected":
        return meta.enforced
          ? "Connected · enforcement ON · counters are real"
          : "Connected · enforcement OFF (PROTEGE_QUOTAS=on to enable gating). Counters still persist for telemetry.";
      case "no-supabase":
        return "Supabase not configured server-side — counters won't persist. Ask backend op to set SUPABASE_URL + SUPABASE_SERVICE_KEY.";
      case "table-missing":
        return "Supabase reachable but `user_quotas` table is missing. Run the SQL migration in beta-quotas.md.";
      case "error":
        return `Probe error: ${meta.probeDetail ?? "unknown"}`;
      case "unknown":
      default:
        return "Probe hasn't run yet (very early activation).";
    }
  })();
  return <span className={cls} title={tip} aria-label={`Quota status: ${meta.probe}`} />;
}
