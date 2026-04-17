import React from "react";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconCheck, IconMinus } from "./icons.js";

interface Props {
  plan: "trial" | "premium";
  trialDaysLeft: number;
  chatMessagesUsed: number;
  chatMessagesLimit: number;
  toolCallsUsed: number;
  toolCallsLimit: number;
  voiceMinutesUsed: number;
  voiceMinutesLimit: number;
}

interface Feature {
  label: string;
  trial: boolean | string;
  premium: boolean | string;
}

const FEATURES: Feature[] = [
  { label: "AI chat (Sonnet 4.5)",   trial: "50 / day",        premium: "Unlimited" },
  { label: "Voice mode (Kokoro)",    trial: "10 min / day",     premium: "Unlimited" },
  { label: "Code analysis + scan",   trial: "5 / day",         premium: "Unlimited" },
  { label: "Concept tracking & IQ",  trial: true,               premium: true },
  { label: "Skill map + dashboard",  trial: true,               premium: true },
  { label: "Unprompted nudges",      trial: "3 / day",         premium: "Unlimited" },
  { label: "Memory & context",       trial: "7-day window",    premium: "Permanent" },
  { label: "Priority model (Opus)",  trial: false,              premium: true },
  { label: "Custom personas",        trial: false,              premium: true },
  { label: "Early access features",  trial: false,              premium: true },
];

export function SubscriptionPage({
  plan,
  trialDaysLeft,
  chatMessagesUsed,
  chatMessagesLimit,
  toolCallsUsed,
  toolCallsLimit,
  voiceMinutesUsed,
  voiceMinutesLimit,
}: Props) {
  const messagePct = Math.min(100, (chatMessagesUsed / chatMessagesLimit) * 100);
  const toolPct = Math.min(100, (toolCallsUsed / toolCallsLimit) * 100);
  const voicePct = Math.min(100, (voiceMinutesUsed / voiceMinutesLimit) * 100);
  const isTrial = plan === "trial";

  return (
    <div className="page subscription-page">
      <CinematicPlate
        image="cometHigh"
        caption="YOUR PLAN"
        ratio="16:9"
        intensity={0.55}
      >
        <div className="sub-hero-over">
          <div className="microcaps">Current plan</div>
          <div className="sub-plan serif">
            {isTrial ? "Free Trial" : "Premium"}
          </div>
          <div className="sub-plan-sub microcaps">
            {isTrial
              ? `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} remaining`
              : "unlimited · all features"}
          </div>
        </div>
      </CinematicPlate>

      {/* ---- Usage bars ---- */}
      <section className="settings-section">
        <div className="section-label microcaps">
          {isTrial ? "Trial usage today" : "Usage this month"}
        </div>
        <div className="section-card">
          <UsageRow
            label="Chat messages"
            used={chatMessagesUsed}
            limit={chatMessagesLimit}
            pct={messagePct}
            unlimited={!isTrial}
          />
          <UsageRow
            label="Tool calls"
            used={toolCallsUsed}
            limit={toolCallsLimit}
            pct={toolPct}
            unlimited={!isTrial}
          />
          <UsageRow
            label="Voice minutes"
            used={voiceMinutesUsed}
            limit={voiceMinutesLimit}
            pct={voicePct}
            unlimited={!isTrial}
          />
          <div className="usage-row">
            <div className="usage-head">
              <div className="setting-row-label">Concepts tracked</div>
              <div className="microcaps">unlimited</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Compare plans ---- */}
      <section className="settings-section">
        <div className="section-label microcaps">Compare plans</div>
        <div className="plan-compare">
          <PlanCard
            name="Trial"
            price="$0"
            sub="3 days"
            current={isTrial}
          />
          <PlanCard
            name="Premium"
            price="$25"
            sub="per month"
            current={!isTrial}
            highlight
          />
        </div>
      </section>

      {/* ---- Feature comparison table ---- */}
      <section className="settings-section">
        <div className="section-label microcaps">Feature breakdown</div>
        <div className="section-card feature-table">
          <div className="ft-header">
            <div className="ft-feature">Feature</div>
            <div className="ft-col microcaps">Trial</div>
            <div className="ft-col microcaps">Premium</div>
          </div>
          {FEATURES.map((f) => (
            <div key={f.label} className="ft-row">
              <div className="ft-feature">{f.label}</div>
              <FeatureCell value={f.trial} />
              <FeatureCell value={f.premium} highlight />
            </div>
          ))}
        </div>
      </section>

      {isTrial && (
        <button className="upgrade-btn">
          Upgrade to Premium — $25/mo <span className="arrow">→</span>
        </button>
      )}

      {isTrial && (
        <div className="sub-footnote microcaps">
          Cancel anytime · no commitment · all features instantly
        </div>
      )}
    </div>
  );
}

function UsageRow({
  label,
  used,
  limit,
  pct,
  unlimited,
}: {
  label: string;
  used: number;
  limit: number;
  pct: number;
  unlimited: boolean;
}) {
  return (
    <div className="usage-row">
      <div className="usage-head">
        <div className="setting-row-label">{label}</div>
        <div className="microcaps">
          {unlimited ? `${used} · unlimited` : `${used} / ${limit}`}
        </div>
      </div>
      {!unlimited && (
        <div className="usage-bar">
          <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function PlanCard({
  name,
  price,
  sub,
  current,
  highlight,
}: {
  name: string;
  price: string;
  sub: string;
  current?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`plan-card ${highlight ? "highlight" : ""} ${current ? "current" : ""}`}
    >
      <div className="plan-name serif">{name}</div>
      <div className="plan-price">
        <span className="serif-num">{price}</span>
        <span className="plan-price-sub microcaps">{sub}</span>
      </div>
      {current && <div className="plan-current microcaps">Current</div>}
    </div>
  );
}

function FeatureCell({
  value,
  highlight,
}: {
  value: boolean | string;
  highlight?: boolean;
}) {
  if (typeof value === "string") {
    return (
      <div className={`ft-col ft-val ${highlight ? "ft-highlight" : ""}`}>
        {value}
      </div>
    );
  }
  return (
    <div className={`ft-col ft-val ${highlight ? "ft-highlight" : ""}`}>
      {value ? (
        <IconCheck size={12} strokeWidth={2.8} />
      ) : (
        <IconMinus size={12} strokeWidth={2.4} />
      )}
    </div>
  );
}
