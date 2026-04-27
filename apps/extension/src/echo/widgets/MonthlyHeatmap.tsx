import React, { useMemo } from "react";
import type { MonthlyHeatmapCell, MonthlyHeatmapPayload } from "@protege/types";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { prefersReducedMotion } from "./colors.js";

/**
 * W5 30-day activity — v5 swap. Filename, exported component name, and
 * prop shape are held stable per the plan; only the body viz changed
 * from a CSS-grid heatmap to a Recharts bar chart. Zero-minute days
 * render as a 2px baseline bar so the day is never visually missing.
 */

export interface MonthlyHeatmapProps {
  data: MonthlyHeatmapPayload | null;
  loading: boolean;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const BASELINE_MINUTES = 0.0001; // recharts needs a non-zero value to render

interface BarRow {
  date: string;
  /** DD label for the X axis. */
  dayLabel: string;
  /** Raw active minutes — used both for Y axis and the tooltip. */
  activeMinutes: number;
  /** Value recharts renders — either activeMinutes or a thin baseline sentinel. */
  renderValue: number;
  filesTouched: number;
}

function formatMinutes(min: number): string {
  if (min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatFullDate(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function MonthlyHeatmap({
  data,
  loading,
}: MonthlyHeatmapProps): JSX.Element {
  return (
    <section className="echo-widget echo-heatmap" data-widget="W5">
      <header className="echo-widget-head">
        <h2>30-day activity</h2>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data && data.cells.length > 0 ? (
          <HeatmapChart data={data} />
        ) : (
          <div className="echo-widget-empty">
            No days logged yet. Code for a minute and your 30-day window
            fills in.
          </div>
        )}
      </div>
    </section>
  );
}

function HeatmapChart({ data }: { data: MonthlyHeatmapPayload }): JSX.Element {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const rows = useMemo<BarRow[]>(
    () =>
      data.cells.map((cell) => ({
        date: cell.date,
        dayLabel: cell.date.slice(-2),
        activeMinutes: cell.activeMinutes,
        renderValue:
          cell.activeMinutes > 0 ? cell.activeMinutes : BASELINE_MINUTES,
        filesTouched: cell.filesTouched,
      })),
    [data.cells]
  );

  const maxValue = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.activeMinutes), 0),
    [rows]
  );

  return (
    <div className="echo-heatmap-chart-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={rows}
          margin={{ top: 8, right: 10, bottom: 4, left: -14 }}
          barCategoryGap={2}
        >
          <CartesianGrid
            stroke="rgba(255,255,255,0.04)"
            vertical={false}
          />
          <XAxis
            dataKey="dayLabel"
            tick={{ fill: "var(--echo-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "var(--echo-muted)", fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
            width={36}
            domain={[0, maxValue > 0 ? "dataMax" : 10]}
            tickFormatter={(v: number) => {
              if (v <= 0) return "0m";
              if (v >= 60) return `${Math.round(v / 60)}h`;
              return `${Math.round(v)}m`;
            }}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={<HeatmapTooltip />}
          />
          <Bar
            dataKey="renderValue"
            fill="var(--echo-accent)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={!reduced}
            animationDuration={reduced ? 0 : 400}
            minPointSize={2}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadItem {
  payload?: BarRow;
}

function HeatmapTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  if (!row) return null;
  const parts: string[] = [formatFullDate(row.date)];
  if (row.activeMinutes > 0) {
    parts.push(formatMinutes(row.activeMinutes));
  } else {
    parts.push("no activity");
  }
  if (row.filesTouched > 0) {
    parts.push(
      `${row.filesTouched} file${row.filesTouched === 1 ? "" : "s"}`
    );
  }
  return (
    <div className="echo-heatmap-tooltip">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="echo-heatmap-tooltip-sep"> · </span> : null}
          <span>{p}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
