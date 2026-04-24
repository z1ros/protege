import React, { useMemo } from "react";
import type { ConceptsMomentumPayload } from "@protege/types";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ECHO_PALETTE, prefersReducedMotion } from "./colors.js";

export interface ConceptsMomentumProps {
  data: ConceptsMomentumPayload | null;
  loading: boolean;
}

/**
 * W16 Concepts Momentum. Recharts area chart of new concepts per bucket.
 * Daily buckets on the week/month windows; hourly buckets on Today so the
 * chart renders 24 visible points instead of a 1-2 dot line. Hover
 * tooltip lists the first five concept names per bucket plus an overflow
 * indicator.
 */
export function ConceptsMomentum({
  data,
  loading,
}: ConceptsMomentumProps): JSX.Element {
  const mode: "hourly" | "daily" = data?.mode ?? "daily";
  const emptyCopy =
    mode === "hourly"
      ? "No new concepts today yet."
      : "No new concepts yet. Open or write code to track your learning surface.";
  return (
    <section className="echo-widget echo-concepts-momentum" data-widget="W16">
      <header className="echo-widget-head">
        <h2>Concepts momentum</h2>
        <span className="echo-widget-tag">W16</span>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data && data.points.length > 0 ? (
          <MomentumBody data={data} />
        ) : (
          <div className="echo-widget-empty">{emptyCopy}</div>
        )}
      </div>
    </section>
  );
}

interface MomentumRow {
  bucket: string;
  count: number;
  sampleNames: string[];
  overflow: number;
  label: string;
}

function MomentumBody({ data }: { data: ConceptsMomentumPayload }): JSX.Element {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const rows: MomentumRow[] = data.points.map((p) => ({
    bucket: p.bucket,
    count: p.count,
    sampleNames: p.sampleNames,
    overflow: p.overflow,
    label: p.label,
  }));

  // Hourly mode prints 24 labels; showing all of them turns the axis into
  // noise. Render every third tick ("00:00", "03:00", …) and let Recharts
  // drop the rest. Daily mode stays unchanged.
  const xAxisProps =
    data.mode === "hourly"
      ? {
          interval: 2 as const,
          ticks: rows
            .filter((_, idx) => idx % 3 === 0)
            .map((r) => r.label),
        }
      : {};

  return (
    <div className="echo-momentum-chart">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart
          data={rows}
          margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
        >
          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="label"
            stroke={ECHO_PALETTE.muted}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            {...xAxisProps}
          />
          <YAxis
            allowDecimals={false}
            stroke={ECHO_PALETTE.muted}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={28}
          />
          <Tooltip content={<MomentumTooltip />} cursor={{ stroke: "rgba(88,166,255,0.25)" }} />
          <Area
            type="monotone"
            dataKey="count"
            stroke={ECHO_PALETTE.accent}
            strokeWidth={2}
            fill={ECHO_PALETTE.accentFill}
            activeDot={{ r: 4, fill: ECHO_PALETTE.accent }}
            isAnimationActive={!reduced}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface MomentumTooltipItem {
  payload?: MomentumRow;
}

function MomentumTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: MomentumTooltipItem[];
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="echo-momentum-tooltip">
      <div className="echo-momentum-tooltip-head">
        {row.label} · {row.count} new
      </div>
      {row.sampleNames.length === 0 ? (
        <div className="echo-momentum-tooltip-empty">No concepts this bucket.</div>
      ) : (
        <ul className="echo-momentum-tooltip-list">
          {row.sampleNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {row.overflow > 0 ? (
        <div className="echo-momentum-tooltip-more">
          +{row.overflow} more
        </div>
      ) : null}
    </div>
  );
}
