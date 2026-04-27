import React, { useMemo } from "react";
import type { LinesWrittenPayload } from "@protege/types";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface LinesWrittenProps {
  data: LinesWrittenPayload | null;
  loading: boolean;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shortLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()}`;
}

export function LinesWritten({ data, loading }: LinesWrittenProps): JSX.Element {
  return (
    <section className="echo-widget echo-lines" data-widget="W8">
      <header className="echo-widget-head">
        <h2>Lines written</h2>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data && data.days.length > 0 ? (
          <LinesBody data={data} />
        ) : (
          <div className="echo-widget-empty">
            No save diffs yet — write a line and it'll show up here.
          </div>
        )}
      </div>
    </section>
  );
}

interface LinesRow {
  date: string;
  label: string;
  added: number;
  removed: number;
}

function LinesBody({ data }: { data: LinesWrittenPayload }): JSX.Element {
  const rows: LinesRow[] = useMemo(
    () =>
      data.days.map((d) => ({
        date: d.date,
        label: shortLabel(d.date),
        added: d.linesAdded,
        removed: -d.linesRemoved,
      })),
    [data.days]
  );

  const any = rows.some((r) => r.added !== 0 || r.removed !== 0);
  const bigLabel = data.biggestDay
    ? shortLabel(data.biggestDay.date)
    : null;

  return (
    <div className="echo-lines-body">
      <div className="echo-lines-top">
        <div className="echo-lines-cumulative">
          <span className="echo-lines-cumulative-value">
            {data.cumulativeNet >= 0 ? `+${data.cumulativeNet}` : `${data.cumulativeNet}`}
          </span>
          <span className="echo-lines-cumulative-label">net lines</span>
        </div>
        {data.biggestDay && data.biggestDay.linesAdded > 0 ? (
          <div className="echo-lines-callout">
            Biggest writing day: <strong>{bigLabel}</strong> · +
            {data.biggestDay.linesAdded}
          </div>
        ) : null}
      </div>
      {any ? (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 4, left: -12 }} stackOffset="sign">
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--echo-muted)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            />
            <YAxis
              tick={{ fill: "var(--echo-muted)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              width={32}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.22)" />
            <Tooltip content={<LinesTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <Bar dataKey="added" stackId="lines" isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.date} fill="#7ee787" />
              ))}
            </Bar>
            <Bar dataKey="removed" stackId="lines" isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.date} fill="#f85149" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="echo-lines-empty-chart">
          No edits in this window — the chart fills once you save a diff.
        </div>
      )}
    </div>
  );
}

interface TooltipItem {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string;
}

function LinesTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string | number;
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const added = Number(
    payload.find((p) => p.dataKey === "added")?.value ?? 0
  );
  const removedNeg = Number(
    payload.find((p) => p.dataKey === "removed")?.value ?? 0
  );
  const removed = Math.abs(removedNeg);
  return (
    <div className="echo-lines-tooltip">
      <div className="echo-lines-tooltip-date">{String(label ?? "")}</div>
      <div className="echo-lines-tooltip-row">
        <span className="swatch added" />
        +{added}
      </div>
      <div className="echo-lines-tooltip-row">
        <span className="swatch removed" />−{removed}
      </div>
      <div className="echo-lines-tooltip-row net">
        net {added - removed >= 0 ? `+${added - removed}` : `${added - removed}`}
      </div>
    </div>
  );
}
