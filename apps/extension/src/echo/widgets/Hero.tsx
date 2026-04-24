import React from "react";
import type { HeroWidgetPayload } from "@protege/types";

export interface HeroProps {
  data: HeroWidgetPayload | null;
  loading: boolean;
}

function formatMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatInt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="echo-hero-stat">
      <div className="echo-hero-stat-value">{value}</div>
      <div className="echo-hero-stat-label">{label}</div>
      {hint ? <div className="echo-hero-stat-hint">{hint}</div> : null}
    </div>
  );
}

export function Hero({ data, loading }: HeroProps): JSX.Element {
  return (
    <section className="echo-widget echo-hero" data-widget="W1">
      <header className="echo-widget-head">
        <h2>Today at a glance</h2>
        <span className="echo-widget-tag">W1</span>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <HeroBody data={data} />
        ) : (
          <div className="echo-widget-empty">
            Nothing to echo yet — code a little, the dashboard comes alive.
          </div>
        )}
      </div>
    </section>
  );
}

function HeroBody({ data }: { data: HeroWidgetPayload }): JSX.Element {
  // When the window has no session activity, the authorship ratio is
  // suppressed server-side (manualPctHidden=true). Render an em dash so the
  // tile reads as "no data" rather than a misleading percentage.
  const manualPctLabel = data.manualPctHidden
    ? "—"
    : `${Math.round(data.manualPct * 100)}%`;
  return (
    <div className="echo-hero-body">
      <div className="echo-hero-stats">
        <Stat
          label="Time in Editor"
          value={formatMinutes(data.timeInEditor)}
          hint="time in editor"
        />
        <Stat
          label="Lines Written"
          value={formatInt(data.linesWritten)}
          hint="net added"
        />
        <Stat
          label="Concepts Mastered"
          value={formatInt(data.conceptsMastered)}
          hint="≥3 uses · ≥2 files"
        />
        <Stat
          label="Manual %"
          value={manualPctLabel}
          hint="typed vs AI-accepted"
        />
      </div>
    </div>
  );
}
