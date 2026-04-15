import React from "react";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconCheck, IconMinus } from "./icons.js";

interface Props {
  plan: "free" | "pro";
  chatMessagesUsed: number;
  chatMessagesLimit: number;
  toolCallsUsed: number;
  toolCallsLimit: number;
}

const FREE_FEATURES: Feature[] = [
  { label: "Chat mode", included: true },
  { label: "Voice mode", included: true },
  { label: "Concept tracking", included: true },
  { label: "200 chat messages / month", included: true },
  { label: "Unlimited tool calls", included: false },
  { label: "Memory retention", included: false },
  { label: "Priority model (Opus)", included: false },
];

const PRO_FEATURES: Feature[] = [
  { label: "Everything in Free", included: true },
  { label: "Unlimited chat messages", included: true },
  { label: "Unlimited tool calls", included: true },
  { label: "Permanent memory", included: true },
  { label: "Priority model (Opus)", included: true },
  { label: "Early access to new features", included: true },
];

interface Feature {
  label: string;
  included: boolean;
}

export function SubscriptionPage({
  plan,
  chatMessagesUsed,
  chatMessagesLimit,
  toolCallsUsed,
  toolCallsLimit,
}: Props) {
  const messagePct = Math.min(100, (chatMessagesUsed / chatMessagesLimit) * 100);
  const toolPct = Math.min(100, (toolCallsUsed / toolCallsLimit) * 100);

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
          <div className="sub-plan serif">{plan === "pro" ? "Pro" : "Free"}</div>
          <div className="sub-plan-sub microcaps">
            {plan === "pro" ? "unlimited · priority model" : "generous free tier"}
          </div>
        </div>
      </CinematicPlate>

      <section className="settings-section">
        <div className="section-label microcaps">Usage this month</div>
        <div className="section-card">
          <div className="usage-row">
            <div className="usage-head">
              <div className="setting-row-label">Chat messages</div>
              <div className="microcaps">
                {chatMessagesUsed} / {chatMessagesLimit}
              </div>
            </div>
            <div className="usage-bar">
              <div className="usage-bar-fill" style={{ width: `${messagePct}%` }} />
            </div>
          </div>

          <div className="usage-row">
            <div className="usage-head">
              <div className="setting-row-label">Tool calls</div>
              <div className="microcaps">
                {toolCallsUsed} / {toolCallsLimit}
              </div>
            </div>
            <div className="usage-bar">
              <div className="usage-bar-fill" style={{ width: `${toolPct}%` }} />
            </div>
          </div>

          <div className="usage-row">
            <div className="usage-head">
              <div className="setting-row-label">Concepts tracked</div>
              <div className="microcaps">unlimited</div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-label microcaps">Compare plans</div>
        <div className="plan-compare">
          <PlanCard
            name="Free"
            price="$0"
            sub="per month"
            features={FREE_FEATURES}
            current={plan === "free"}
          />
          <PlanCard
            name="Pro"
            price="$12"
            sub="per month"
            features={PRO_FEATURES}
            current={plan === "pro"}
            highlight
          />
        </div>
      </section>

      {plan === "free" && (
        <button className="upgrade-btn">
          Upgrade to Pro <span className="arrow">→</span>
        </button>
      )}
    </div>
  );
}

function PlanCard({
  name,
  price,
  sub,
  features,
  current,
  highlight,
}: {
  name: string;
  price: string;
  sub: string;
  features: Feature[];
  current?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`plan-card ${highlight ? "highlight" : ""} ${current ? "current" : ""}`}>
      <div className="plan-name serif">{name}</div>
      <div className="plan-price">
        <span className="serif-num">{price}</span>
        <span className="plan-price-sub microcaps">{sub}</span>
      </div>
      {current && <div className="plan-current microcaps">Current</div>}
      <ul className="plan-features">
        {features.map((f) => (
          <li
            key={f.label}
            className={f.included ? "plan-feature-on" : "plan-feature-off"}
          >
            <span className="plan-check">
              {f.included ? (
                <IconCheck size={11} strokeWidth={2.8} />
              ) : (
                <IconMinus size={11} strokeWidth={2.4} />
              )}
            </span>
            {f.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
