import React, { useMemo } from "react";
import type {
  IndependenceDayPoint,
  IndependenceLanguageRow,
  IndependenceTrendPayload,
} from "@protege/types";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ECHO_PALETTE, prefersReducedMotion } from "./colors.js";

export interface IndependenceTrendProps {
  data: IndependenceTrendPayload | null;
  loading: boolean;
}

// Stacked-area palette. Typed=green (user ownership), AI=indigo-purple
// (the assistant's contribution), paste=gray (neutral/provenance-light).
// Kept intentionally close to the Coastline + Hero accents so the rest of
// the dashboard reads as a single visual family.
const TYPED_COLOR = ECHO_PALETTE.success; // #7ee787
const AI_COLOR = ECHO_PALETTE.purple; // #bc8cff
const PASTE_COLOR = ECHO_PALETTE.gray; // #6e7681

// Keep fills solid enough that small deltas still read visually, without
// letting the bottom layer's color bleed through and inflate perceived size.
const TYPED_FILL = "rgba(126, 231, 135, 0.42)";
const AI_FILL = "rgba(188, 140, 255, 0.42)";
const PASTE_FILL = "rgba(110, 118, 129, 0.55)";

/**
 * W14 Independence Trend. Replaces the old Code Origin donut. Three
 * sub-components stacked in one widget:
 *   1. Hero number — Manual% for the window + trend arrow vs prior window
 *   2. Daily composition stacked-area chart — typed / AI / pasted chars
 *   3. Depth metrics — edit-after-accept chip + per-language accept rates
 *
 * W1 Hero still owns the static "Manual %" tile — this widget adds the
 * trajectory dimension the hero can't show.
 */
export function IndependenceTrend({
  data,
  loading,
}: IndependenceTrendProps): JSX.Element {
  return (
    <section className="echo-widget echo-independence" data-widget="W14">
      <header className="echo-widget-head">
        <h2>Independence trend</h2>
      </header>
      <div className="echo-widget-body">
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <IndependenceBody data={data} />
        ) : (
          <div className="echo-widget-empty">
            Start writing or accepting code to see your trajectory.
          </div>
        )}
      </div>
    </section>
  );
}

function IndependenceBody({
  data,
}: {
  data: IndependenceTrendPayload;
}): JSX.Element {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  return (
    <div className="echo-independence-body">
      <HeroHeadline manualPct={data.manualPct} />
      <DailyCompositionChart days={data.days} reducedMotion={reduced} />
    </div>
  );
}

/* ========== Hero headline ========== */

function HeroHeadline({ manualPct }: { manualPct: number }): JSX.Element {
  const pct = Math.round(manualPct * 100);
  return (
    <div className="echo-independence-hero">
      <div className="echo-independence-hero-main">
        <div className="echo-independence-hero-value">{pct}%</div>
        <div className="echo-independence-hero-label">manually typed</div>
      </div>
    </div>
  );
}

/**
 * Render the trend arrow. Copy rules:
 *   positive → "↗ +Xpts vs last wk"
 *   negative → "↘ −Xpts vs last wk"
 *   |delta| < 2pt → "→ steady"
 */
function TrendChip({ trend }: { trend: number | null }): JSX.Element {
  if (trend === null) {
    return (
      <span className="echo-independence-trend muted">no prior data</span>
    );
  }
  const pts = Math.round(trend * 100);
  if (Math.abs(pts) < 2) {
    return (
      <span className="echo-independence-trend neutral">→ steady</span>
    );
  }
  if (pts > 0) {
    return (
      <span className="echo-independence-trend good">
        ↗ +{pts}pts vs last wk
      </span>
    );
  }
  return (
    <span className="echo-independence-trend bad">
      ↘ −{Math.abs(pts)}pts vs last wk
    </span>
  );
}

/* ========== Daily composition area chart ========== */

interface DayRow {
  label: string;
  typed: number;
  ai: number;
  paste: number;
}

function DailyCompositionChart({
  days,
  reducedMotion,
}: {
  days: IndependenceDayPoint[];
  reducedMotion: boolean;
}): JSX.Element {
  const rows: DayRow[] = days.map((d) => ({
    label: d.label,
    typed: d.typedChars,
    ai: d.aiChars,
    paste: d.pastedChars,
  }));

  return (
    <div className="echo-independence-chart">
      <div className="echo-independence-chart-title">Daily composition</div>
      <ResponsiveContainer width="100%" height="100%" minHeight={180}>
        <BarChart
          data={rows}
          margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
          barCategoryGap="22%"
        >
          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="label"
            stroke={ECHO_PALETTE.muted}
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke={ECHO_PALETTE.muted}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={formatAxisChars}
          />
          <Tooltip
            content={<CompositionTooltip />}
            cursor={{ fill: "rgba(88,166,255,0.08)" }}
          />
          <Bar
            dataKey="typed"
            stackId="1"
            fill={TYPED_COLOR}
            fillOpacity={0.85}
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="ai"
            stackId="1"
            fill={AI_COLOR}
            fillOpacity={0.85}
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="paste"
            stackId="1"
            fill={PASTE_COLOR}
            fillOpacity={0.85}
            isAnimationActive={!reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="echo-independence-legend">
        <LegendSwatch color={TYPED_COLOR} label="Typed" />
        <LegendSwatch color={AI_COLOR} label="AI accepted" />
        <LegendSwatch color={PASTE_COLOR} label="Pasted" />
      </div>
    </div>
  );
}

function LegendSwatch({
  color,
  label,
}: {
  color: string;
  label: string;
}): JSX.Element {
  return (
    <span className="echo-independence-legend-item">
      <span
        className="echo-independence-legend-dot"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

interface CompositionTooltipPayload {
  payload?: DayRow;
}

function CompositionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: CompositionTooltipPayload[];
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const total = row.typed + row.ai + row.paste;
  return (
    <div className="echo-independence-tooltip">
      <div className="echo-independence-tooltip-head">{row.label}</div>
      <ul>
        <li>
          <span
            className="echo-independence-legend-dot"
            style={{ background: TYPED_COLOR }}
          />
          Typed: {formatChars(row.typed)}
        </li>
        <li>
          <span
            className="echo-independence-legend-dot"
            style={{ background: AI_COLOR }}
          />
          AI: {formatChars(row.ai)}
        </li>
        <li>
          <span
            className="echo-independence-legend-dot"
            style={{ background: PASTE_COLOR }}
          />
          Pasted: {formatChars(row.paste)}
        </li>
      </ul>
      <div className="echo-independence-tooltip-total">
        Total: {formatChars(total)}
      </div>
    </div>
  );
}

/* ========== Depth cards ========== */

function EditAfterAcceptCard({
  rate,
  trend,
  undoAfterAccept,
}: {
  rate: number | null;
  trend: number | null;
  undoAfterAccept: number;
}): JSX.Element {
  if (rate === null) {
    return (
      <div className="echo-independence-card">
        <div className="echo-independence-card-title">Edit-after-accept</div>
        <div className="echo-independence-card-value muted">—</div>
        <div className="echo-independence-card-hint muted">
          No AI suggestions accepted yet in this window.
        </div>
      </div>
    );
  }

  const pct = Math.round(rate * 100);
  const interpretation = interpretEditAfterAccept(trend);
  const arrowCls = arrowClassFor(trend);
  const pts = trend !== null ? Math.round(trend * 100) : null;
  const arrowText = (() => {
    if (trend === null) return "no prior data";
    if (pts === null) return "no prior data";
    if (Math.abs(pts) < 2) return "→ steady";
    if (pts > 0) return `↗ +${pts}pts`;
    return `↘ −${Math.abs(pts)}pts`;
  })();

  return (
    <div className="echo-independence-card">
      <div className="echo-independence-card-title">Edit-after-accept</div>
      <div className="echo-independence-card-row">
        <div className="echo-independence-card-value">{pct}%</div>
        <span className={`echo-independence-card-trend ${arrowCls}`}>
          {arrowText}
        </span>
      </div>
      <div className="echo-independence-card-hint">{interpretation}</div>
      {undoAfterAccept > 0 ? (
        <div className="echo-independence-card-hint subtle">
          {undoAfterAccept} undo
          {undoAfterAccept === 1 ? "" : "s"} within 10s of an accept
        </div>
      ) : null}
    </div>
  );
}

/** Rising edit-after-accept = reviewing more (good). Falling = skimming. */
function interpretEditAfterAccept(trend: number | null): string {
  if (trend === null) return "consistent review";
  const pts = Math.round(trend * 100);
  if (Math.abs(pts) < 2) return "consistent review";
  if (pts > 0) return "reviewing AI suggestions more";
  return "reading AI less carefully";
}

function arrowClassFor(trend: number | null): string {
  if (trend === null) return "muted";
  const pts = Math.round(trend * 100);
  if (Math.abs(pts) < 2) return "neutral";
  // Rising edit-after-accept = user is editing AI output more, i.e.
  // reviewing carefully. That's a good signal.
  return pts > 0 ? "good" : "bad";
}

function LanguageBreakdownCard({
  rows,
}: {
  rows: IndependenceLanguageRow[];
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="echo-independence-card">
        <div className="echo-independence-card-title">
          Accept rate by language
        </div>
        <div className="echo-independence-card-value muted">—</div>
        <div className="echo-independence-card-hint muted">
          No language data yet.
        </div>
      </div>
    );
  }
  return (
    <div className="echo-independence-card">
      <div className="echo-independence-card-title">
        Accept rate by language
      </div>
      <ul className="echo-independence-langs">
        {rows.map((row) => {
          const pct = Math.round(row.acceptRate * 100);
          const lowSample = row.sample < 50;
          return (
            <li key={row.language} className="echo-independence-lang-row">
              <span className="echo-independence-lang-name">
                {prettyLang(row.language)}
              </span>
              <span className="echo-independence-lang-pct">{pct}%</span>
              {lowSample ? (
                <span className="echo-independence-lang-badge">low data</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ========== Formatting helpers ========== */

function formatChars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatAxisChars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  // Avoid the duplicate-label problem (1500 + 2000 both rounding to "2k").
  // Show a decimal for sub-10k values so neighboring ticks stay distinct.
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Capitalize + map common languages to their conventional display names. */
function prettyLang(raw: string): string {
  const s = raw.trim();
  switch (s) {
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    case "go":
      return "Go";
    case "java":
      return "Java";
    case "ruby":
      return "Ruby";
    case "php":
      return "PHP";
    case "csharp":
      return "C#";
    case "cpp":
      return "C++";
    case "c":
      return "C";
    case "swift":
      return "Swift";
    case "kotlin":
      return "Kotlin";
    case "scala":
      return "Scala";
    case "json":
      return "JSON";
    case "markdown":
      return "Markdown";
    case "yaml":
      return "YAML";
    case "css":
      return "CSS";
    case "html":
      return "HTML";
    case "shell":
      return "Shell";
    case "sql":
      return "SQL";
    default:
      return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
  }
}
