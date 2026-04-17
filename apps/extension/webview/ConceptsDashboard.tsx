import React, { useState, useRef, useEffect } from "react";
import { SkillConstellation } from "./SkillConstellation.js";
import { SkillTreeView } from "./SkillTreeView.js";
import type { ConceptRow } from "@protege/types";
// Cinematic backgrounds for the dashboard cards. Imported so Vite resolves
// them through its asset pipeline (PNG→WebP + hashing) — CSS url() relative
// paths break after asset conversion.
import bgCometRider from "./cinematic/comet-rider.webp";
import bgBlueHorizon from "./cinematic/blue-horizon.webp";
import bgStarlitFigure from "./cinematic/starlit-figure.webp";
import bgCycleBloom from "./cinematic/cycle-bloom.webp";
import bgGreenPlanet from "./cinematic/green-planet.webp";
import bgSunflowerGate from "./cinematic/sunflower-gate.webp";

/**
 * ConceptsDashboard — cinematic overview for the Concepts tab.
 *
 * ALL REAL DATA — zero mocks. Every card uses live data from the backend.
 * Cards that don't have enough data yet show honest "not enough data" states
 * instead of fake numbers.
 *
 * Order (narrow webview — everything stacks top → bottom):
 *
 *   1. LevelCard         — ring gauge + ticks + level + mini trend row
 *   2. TrajectoryCard    — IQ line chart, range selector (7/30/90/1Y/ALL/custom)
 *   3. TodayCard         — live strip of concepts earned today
 *   4. SkillSection      — SkillTreeView + SkillConstellation (canvas-based)
 *   5. MistakesCard      — single-row layout per mistake category
 *   6. RadarCard         — strengths pentagon with hover values
 *   7. PercentileCard    — peer comparison bars with "you" marker + peer avg
 */

import type {
  DailyIqPoint,
  GainEvent,
  StreakInfo,
  ClusterSummary,
  IqPillars,
} from "@protege/types";

interface Props {
  codeIq: number;
  maxIq: number;
  totalConcepts: number;
  ruleCount: number;
  concepts: import("@protege/types").ConceptRow[];
  dailyIq: DailyIqPoint[];
  recentGains: GainEvent[];
  streak: StreakInfo;
  clusters: ClusterSummary[];
  pillars: IqPillars | null;
}

/* ---------- mock data ---------- */

/**
 * Level system — 12 tiers, exponentially harder to reach.
 *
 * Bottom half is achievable in weeks (fast early wins = dopamine).
 * Top half takes months of consistent work. 950+ is near-impossible
 * — you'd need to master virtually every concept across every cluster.
 *
 * 1000 IQ = "Legend" — the GOAT. Displayed on the chart as a gold
 * threshold line so users always see what they're chasing.
 */
const LEVEL_THRESHOLDS = [
  { name: "Newcomer",      at: 0 },
  { name: "Novice",        at: 50 },
  { name: "Apprentice",    at: 120 },
  { name: "Practitioner",  at: 200 },
  { name: "Competent",     at: 300 },
  { name: "Proficient",    at: 420 },
  { name: "Advanced",      at: 550 },
  { name: "Expert",        at: 680 },
  { name: "Veteran",       at: 800 },
  { name: "Elite",         at: 900 },
  { name: "Grandmaster",   at: 960 },
  { name: "Legend",         at: 1000 },
];

/** Get the user's current level based on IQ */
function getLevelForIq(iq: number): { current: string; next: string | null; iqToNext: number } {
  let current = LEVEL_THRESHOLDS[0];
  for (const t of LEVEL_THRESHOLDS) {
    if (iq >= t.at) current = t;
    else break;
  }
  const idx = LEVEL_THRESHOLDS.indexOf(current);
  const next = idx < LEVEL_THRESHOLDS.length - 1 ? LEVEL_THRESHOLDS[idx + 1] : null;
  return {
    current: current.name,
    next: next?.name ?? null,
    iqToNext: next ? next.at - iq : 0,
  };
}

/* ==========================================================
   Trajectory — uses REAL dailyIq from the backend. No fake data.
   ========================================================== */

interface TrajPoint {
  date: string;
  dateFrom?: string;
  iq: number;
  event: string | null;
}

/** Convert real dailyIq from backend into TrajPoints with level-crossing events */
function dailyIqToTrajPoints(dailyIq: DailyIqPoint[]): TrajPoint[] {
  const points: TrajPoint[] = dailyIq.map((d) => ({
    date: d.date,
    iq: d.codeIq,
    event: null,
  }));

  // Inject level-crossing events
  for (let i = 1; i < points.length; i++) {
    for (const lvl of LEVEL_THRESHOLDS) {
      if (lvl.at > 0 && points[i - 1].iq < lvl.at && points[i].iq >= lvl.at) {
        points[i].event = lvl.name;
        break;
      }
    }
  }
  return points;
}

/** Bucket points to max N for chart rendering */
function bucketPoints(points: TrajPoint[], maxPts = 40): TrajPoint[] {
  if (points.length <= maxPts) return points;
  const bucketSize = Math.ceil(points.length / maxPts);
  const out: TrajPoint[] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const chunk = points.slice(i, i + bucketSize);
    const avg = Math.round(chunk.reduce((s, p) => s + p.iq, 0) / chunk.length);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const ev = chunk.find((p) => p.event)?.event ?? null;
    out.push({
      date: last.date,
      dateFrom: chunk.length > 1 ? first.date : undefined,
      iq: avg,
      event: ev,
    });
  }
  return out;
}

/* ALL MOCK DATA REMOVED — every card now uses real data from props,
   or shows "not enough data yet" when the backend hasn't produced enough. */

export function ConceptsDashboard({
  codeIq, maxIq, totalConcepts, ruleCount, concepts,
  dailyIq, recentGains, streak, clusters, pillars,
}: Props) {
  // Filter today's gains
  const today = new Date().toISOString().slice(0, 10);
  const todaysGains = recentGains.filter((g) => g.ts.startsWith(today));

  // Compute real streak stats
  const activeDays = dailyIq.filter((d) => d.codeIq > 0).length;

  return (
    <div className="dash">
      <LevelCard
        codeIq={codeIq}
        maxIq={maxIq}
        streak={streak}
        activeDays={activeDays}
      />

      {dailyIq.length >= 2 ? (
        <TrajectoryCardReal dailyIq={dailyIq} />
      ) : (
        <EmptyCard
          title="Trajectory"
          message="Save a few more files to see your IQ growth over time."
        />
      )}

      {todaysGains.length > 0 ? (
        <TodayCardReal gains={todaysGains} />
      ) : (
        <EmptyCard
          title="Today"
          message="No concepts earned yet today. Save a file to start."
        />
      )}

      <SkillSection concepts={concepts} />

      {pillars ? (
        <PillarsRadar pillars={pillars} />
      ) : (
        <EmptyCard
          title="Coding Skills"
          message="Save a file to light up your skill radar."
        />
      )}
    </div>
  );
}

/* ==========================================================
   Skill section — toggles between structured tree and canvas map
   ========================================================== */

function SkillSection({ concepts }: { concepts: ConceptRow[] }) {
  const [view, setView] = useState<"tree" | "map">("tree");
  return (
    <div
      className="dash-card skill-section has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgCycleBloom})` }}
    >
      <div className="dash-card-head">
        <div className="dash-card-title microcaps">Skills</div>
        <div className="skill-toggle" role="tablist" aria-label="Skill view">
          <button
            role="tab"
            aria-selected={view === "tree"}
            className={`skill-toggle-opt ${view === "tree" ? "active" : ""}`}
            onClick={() => setView("tree")}
          >
            Tree
          </button>
          <button
            role="tab"
            aria-selected={view === "map"}
            className={`skill-toggle-opt ${view === "map" ? "active" : ""}`}
            onClick={() => setView("map")}
          >
            Map
          </button>
        </div>
      </div>
      {view === "tree" ? (
        <SkillTreeView concepts={concepts} onSwitchToMap={() => setView("map")} />
      ) : (
        <SkillConstellation concepts={concepts} />
      )}
    </div>
  );
}

/* ==========================================================
   Empty state card — honest about missing data
   ========================================================== */

function EmptyCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="dash-card empty-dash-card">
      <div className="dash-card-title microcaps">{title}</div>
      <div className="empty-dash-message">{message}</div>
    </div>
  );
}

/* ==========================================================
   Level card — ring gauge with ticks + NUMBER INSIDE SVG (centered)
   ========================================================== */

function LevelCard({
  codeIq,
  maxIq,
  streak,
  activeDays,
}: {
  codeIq: number;
  maxIq: number;
  streak: StreakInfo;
  activeDays: number;
}) {
  const shownNum = codeIq;
  const shownMax = maxIq > 0 ? maxIq : 1000;
  const pct = Math.min(1, shownNum / shownMax);

  const r = 38;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  const gap = c - dash;

  const ticks = LEVEL_THRESHOLDS.filter((t) => t.at < shownMax && t.at > 0).map((t) => ({
    ...t,
    frac: t.at / shownMax,
  }));

  const pulseA = pct * Math.PI * 2 - Math.PI / 2;
  const pulseX = 50 + Math.cos(pulseA) * r;
  const pulseY = 50 + Math.sin(pulseA) * r;

  return (
    <div
      className="dash-card level-card has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgCometRider})` }}
    >
      <div className="level-left">
        <svg viewBox="0 0 100 100" className="level-ring" aria-hidden>
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#BDDBFF" />
              <stop offset="60%" stopColor="#4A9EFF" />
              <stop offset="100%" stopColor="#1E63C8" />
            </linearGradient>
            <filter id="ringGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
          {ticks.map((t, i) => {
            const a = t.frac * Math.PI * 2 - Math.PI / 2;
            const x1 = 50 + Math.cos(a) * (r - 4);
            const y1 = 50 + Math.sin(a) * (r - 4);
            const x2 = 50 + Math.cos(a) * (r + 4);
            const y2 = 50 + Math.sin(a) * (r + 4);
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="rgba(255,255,255,0.22)"
                strokeWidth="0.8"
                strokeLinecap="round"
              />
            );
          })}
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="url(#ringGrad)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${gap}`}
            transform="rotate(-90 50 50)"
            filter="url(#ringGlow)"
            className="level-ring-fill"
            style={{
              ["--ring-dash" as never]: `${dash}`,
              ["--ring-circ" as never]: `${c}`,
            }}
          />
          <g className="level-ring-pulse">
            <circle cx={pulseX} cy={pulseY} r="2.4" fill="currentColor" />
            <circle
              cx={pulseX}
              cy={pulseY}
              r="4"
              fill="none"
              stroke="rgba(158,204,255,0.5)"
              strokeWidth="0.8"
            />
          </g>
          {/* Number inside SVG for perfect optical centering */}
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            className="level-ring-num-svg"
          >
            {shownNum}
          </text>
        </svg>
      </div>
      <div className="level-body">
        {(() => {
          const lvl = getLevelForIq(shownNum);
          return (
            <>
              <div className="level-head">
                <div className="level-name">{lvl.current}</div>
                <div className="level-pill microcaps">{shownMax} max</div>
              </div>
              <div className="level-sub microcaps">
                {lvl.next
                  ? `${lvl.iqToNext} iq to ${lvl.next}`
                  : "you are Legend — the GOAT"}
              </div>
            </>
          );
        })()}
        <div className="level-trend">
          <TrendStat label="Streak" value={`${streak.current}d`} />
          <TrendStat label="Longest" value={`${streak.longest}d`} />
          <TrendStat label="Active days" value={activeDays} />
        </div>
      </div>
    </div>
  );
}

function TrendStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="trend-stat">
      <div className="trend-val">{value}</div>
      <div className="trend-label microcaps">{label}</div>
    </div>
  );
}

function MiniSpark({ values }: { values: number[] }) {
  const w = 80;
  const h = 24;
  const pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const dx = (w - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * dx;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = `M ${pts.join(" L ")}`;
  const area = `${d} L ${w - pad},${h - pad} L ${pad},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mini-spark" aria-hidden>
      <defs>
        <linearGradient id="msfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(74,158,255,0.5)" />
          <stop offset="100%" stopColor="rgba(74,158,255,0)" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#msfill)" />
      <path
        d={d}
        fill="none"
        stroke="rgba(158,204,255,0.95)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ==========================================================
   Trajectory card — interactive line chart with range selector + hover
   ========================================================== */


/* MonthSelect removed — no longer needed (no fake data to browse) */

/** Pick a "nice" step size for grid lines (rounds to 10/25/50/100/200/500…) */
function niceStep(range: number, targetLines: number): number {
  const raw = range / targetLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1.5) return mag;
  if (norm <= 3.5) return 2.5 * mag;
  if (norm <= 7.5) return 5 * mag;
  return 10 * mag;
}

/** Catmull-Rom → cubic bezier smooth path */
function smoothPath(xs: number[], ys: number[], tension = 0.3): string {
  if (xs.length < 2) return "";
  const pts = xs.map((x, i) => ({ x, y: ys[i] }));
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[Math.max(i - 2, 0)];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[Math.min(i + 1, pts.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/* ==========================================================
   REAL DATA COMPONENTS — no mocks, no fakes
   ========================================================== */

/** Trajectory chart using REAL dailyIq from the backend */
function TrajectoryCardReal({ dailyIq }: { dailyIq: DailyIqPoint[] }) {
  const points = bucketPoints(dailyIqToTrajPoints(dailyIq));
  const n = points.length;
  if (n < 2) return null;

  const W = 440;
  const H = 140;
  const PAD_L = 36;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const rawMax = Math.max(...points.map((p) => p.iq));
  const rawMin = Math.min(...points.map((p) => p.iq));
  const yPad = Math.max(10, (rawMax - rawMin) * 0.08);
  const maxIq = rawMax + yPad;
  const minIq = Math.max(0, rawMin - yPad);
  const iqRange = Math.max(1, maxIq - minIq);

  const px = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * plotW;
  const py = (iq: number) => PAD_T + plotH - ((iq - minIq) / iqRange) * plotH;
  const xs = points.map((_, i) => px(i));
  const ys = points.map((p) => py(p.iq));
  const linePath = smoothPath(xs, ys);
  const areaPath = `${linePath} L ${xs[n - 1].toFixed(1)} ${H - PAD_B} L ${xs[0].toFixed(1)} ${H - PAD_B} Z`;

  const thresholds = LEVEL_THRESHOLDS
    .filter((t) => t.at >= minIq && t.at <= maxIq && t.at > 0)
    .map((t) => ({ ...t, y: py(t.at) }))
    .filter((_, i, arr) => i === 0 || Math.abs(arr[i].y - arr[i - 1].y) > 12);

  const delta = points[n - 1].iq - points[0].iq;

  return (
    <div
      className="dash-card trajectory-card has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgBlueHorizon})` }}
    >
      <div className="dash-card-head">
        <div className="dash-card-title microcaps">
          Trajectory · <span className="dim">{n} days</span>
        </div>
        <div className="dash-card-note microcaps">
          {delta >= 0 ? "+" : ""}{delta} iq
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trajectory-svg">
        <defs>
          <linearGradient id="trajFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(var(--electric-rgb), 0.42)" />
            <stop offset="100%" stopColor="rgba(var(--electric-rgb), 0)" />
          </linearGradient>
        </defs>
        {thresholds.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y}
              stroke="rgba(var(--electric-rgb), 0.15)" strokeWidth="0.6" strokeDasharray="3 4" />
            <text x={W - PAD_R - 2} y={t.y - 3} textAnchor="end" className="traj-level-label">
              {t.name}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#trajFill)" />
        <path d={linePath} fill="none" stroke="rgba(var(--sky-rgb), 0.95)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="traj-line-animated" />
        {points.map((p, i) => p.event ? (
          <g key={i}>
            <circle cx={xs[i]} cy={ys[i]} r="3.5" fill="currentColor" />
            <circle cx={xs[i]} cy={ys[i]} r="6" fill="none" stroke="rgba(var(--sky-rgb), 0.4)" strokeWidth="0.8" />
          </g>
        ) : null)}
        <circle cx={xs[n - 1]} cy={ys[n - 1]} r="3" fill="currentColor" />
      </svg>
    </div>
  );
}

/** Today's gains — using REAL recentGains from the backend */
function TodayCardReal({ gains }: { gains: GainEvent[] }) {
  const totalDelta = gains.reduce((s, g) => s + g.deltaIq, 0);
  return (
    <div
      className="dash-card today-card has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgStarlitFigure})` }}
    >
      <div className="dash-card-head">
        <div className="dash-card-title microcaps">Today</div>
        <div className="today-total display-num">+{totalDelta}</div>
      </div>
      <div className="today-list">
        {gains.map((g) => (
          <div key={g.ts + g.concept} className="today-row">
            <span className="today-cluster microcaps">{g.cluster}</span>
            <span className="today-concept">{g.concept}</span>
            <span className="today-delta">+{g.deltaIq}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Coding skills radar — all five pillars, always a full pentagon.
 *
 *   Depth        — how deeply you know the skills you use
 *   Breadth      — diversity of domains you've touched
 *   Velocity     — speed of learning (new concepts per week)
 *   Consistency  — regularity of coding (streak + active days)
 *   Quality      — bug-free, fix-driven improvement
 *
 * This is the canonical measure of coding skill — each axis tells a
 * distinct story, and together they're the composite IQ. */
function PillarsRadar({ pillars }: { pillars: IqPillars }) {
  const axes = [
    { id: "depth", label: "Depth", score: pillars.depth.score, max: pillars.depth.max, delta: pillars.depth.delta, explanation: pillars.depth.explanation },
    { id: "breadth", label: "Breadth", score: pillars.breadth.score, max: pillars.breadth.max, delta: pillars.breadth.delta, explanation: pillars.breadth.explanation },
    { id: "velocity", label: "Velocity", score: pillars.velocity.score, max: pillars.velocity.max, delta: pillars.velocity.delta, explanation: pillars.velocity.explanation },
    { id: "consistency", label: "Consistency", score: pillars.consistency.score, max: pillars.consistency.max, delta: pillars.consistency.delta, explanation: pillars.consistency.explanation },
    { id: "quality", label: "Quality", score: pillars.quality.score, max: pillars.quality.max, delta: pillars.quality.delta, explanation: pillars.quality.explanation },
  ];

  const size = 260;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 78;
  const n = axes.length;

  const pointAt = (i: number, frac: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * radius * frac, cy + Math.sin(angle) * radius * frac] as const;
  };

  const rings = [0.2, 0.4, 0.6, 0.8, 1];
  const polyFor = (frac: number) =>
    axes.map((_, i) => pointAt(i, frac).map((v) => v.toFixed(1)).join(",")).join(" ");
  const valuePoly = axes
    .map((a, i) => {
      const frac = Math.max(0.02, Math.min(1, a.score / Math.max(1, a.max)));
      return pointAt(i, frac).map((v) => v.toFixed(1)).join(",");
    })
    .join(" ");

  const [hovered, setHovered] = React.useState<number | null>(null);
  const hoverAxis = hovered !== null ? axes[hovered] : null;

  return (
    <div
      className="dash-card radar-card has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgGreenPlanet})` }}
    >
      <div className="dash-card-head">
        <div className="dash-card-title microcaps">Coding Skills</div>
        <div className="dash-card-note microcaps">
          {hoverAxis ? hoverAxis.explanation : "five pillars · hover an axis"}
        </div>
      </div>
      <svg viewBox={`0 0 ${size} ${size}`} className="radar-svg" preserveAspectRatio="xMidYMid meet">
        {rings.map((f, i) => (
          <polygon
            key={i}
            points={polyFor(f)}
            fill="none"
            stroke="rgba(var(--text-rgb), 0.08)"
            strokeWidth="0.8"
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = pointAt(i, 1);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke="rgba(var(--text-rgb), 0.08)"
              strokeWidth="0.8"
            />
          );
        })}
        <polygon
          points={valuePoly}
          fill="rgba(var(--electric-rgb), 0.22)"
          stroke="rgba(var(--sky-rgb), 0.95)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="radar-polygon"
        />
        {axes.map((a, i) => {
          const frac = Math.max(0.02, Math.min(1, a.score / Math.max(1, a.max)));
          const [x, y] = pointAt(i, frac);
          const isHover = hovered === i;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={isHover ? 4 : 2.8}
              fill="currentColor"
              style={{ transition: "r 120ms ease" }}
            />
          );
        })}
        {axes.map((a, i) => {
          const [lx, ly] = pointAt(i, 1.3);
          const pct = Math.round((a.score / Math.max(1, a.max)) * 100);
          return (
            <g
              key={`l-${i}`}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer" }}
            >
              {/* Invisible hit area so labels + nearby axis are easy to hover */}
              <rect x={lx - 32} y={ly - 14} width="64" height="30" fill="transparent" />
              <text x={lx} y={ly} textAnchor="middle" className="radar-label">
                {a.label}
              </text>
              <text x={lx} y={ly + 11} textAnchor="middle" className="radar-value">
                {a.score}
                <tspan className="radar-value-max"> / {a.max}</tspan>
              </text>
              {a.delta !== 0 && (
                <text
                  x={lx}
                  y={ly + 22}
                  textAnchor="middle"
                  className={`radar-delta ${a.delta > 0 ? "up" : "down"}`}
                >
                  {a.delta > 0 ? "+" : ""}
                  {a.delta}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="radar-legend">
        {axes.map((a) => {
          const pct = Math.round((a.score / Math.max(1, a.max)) * 100);
          return (
            <div key={a.id} className="radar-legend-row">
              <span className="radar-legend-label microcaps">{a.label}</span>
              <span className="radar-legend-bar">
                <span
                  className="radar-legend-bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="radar-legend-pct">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
