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
  IqV2,
  IqV2Category,
} from "@protege/types";
import { IQV2_LEVEL_BANDS } from "@protege/types";

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
  iqV2: IqV2 | null;
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
  dailyIq, recentGains, streak, clusters, pillars, iqV2,
}: Props) {
  // Filter today's gains
  const today = new Date().toISOString().slice(0, 10);
  const todaysGains = recentGains.filter((g) => g.ts.startsWith(today));

  // Compute real streak stats
  const activeDays = dailyIq.filter((d) => d.codeIq > 0).length;

  return (
    <div className="dash">
      {iqV2 ? (
        <IqV2Card iqV2={iqV2} streak={streak} activeDays={activeDays} />
      ) : (
        <LevelCard
          codeIq={codeIq}
          maxIq={maxIq}
          streak={streak}
          activeDays={activeDays}
        />
      )}

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
      {view === "tree" ? (
        <SkillTreeView concepts={concepts} onSwitchToMap={() => setView("map")} />
      ) : (
        <SkillConstellation
          concepts={concepts}
          onBackToTree={() => setView("tree")}
        />
      )}
    </div>
  );
}

/* ==========================================================
   IqV2 card — the headline Code IQ with six category bars.

   One number = arithmetic mean of the six categories (Craft, Range,
   Velocity, Debug, Quality, Independence), each 0-1000. The headline
   moves only when all categories move — you cannot fake staff level
   with a 950 Craft and a 0 Debug.

   Pending categories (Independence, until signal collection ships)
   show with a dashed bar and are excluded from the mean.
   ========================================================== */

/* ----- Static metadata for the "show me the math" panel.
   Every category lists (a) the question it answers, (b) the signals
   it consumes with keys matching `category.inputs`, (c) the raw
   formula in plain English, and (d) its level curve.
   Keep in lockstep with apps/backend/src/iqV2.ts — if a formula
   changes there, update the string here so the UI never lies. */
interface CatMeta {
  question: string;
  signals: Array<{ key: string; label: string; hint?: string }>;
  formula: string[];
  levelCurve: string;
  maxScore: number;
}
const CATEGORY_META: Record<IqV2Category["id"], CatMeta> = {
  craft: {
    question: "Can you write clean, correct code yourself?",
    signals: [
      { key: "authoredConcepts", label: "Practiced concepts", hint: "timesUsed ≥ 2" },
      { key: "demonstratedConcepts", label: "Demonstrated across ≥ 3 files" },
      { key: "raw", label: "Raw score" },
    ],
    formula: [
      "Σ(authorship × difficulty × min(1, distinctFiles / 3) × mastery × 12)",
      "authorship = 0.7 placeholder until keystroke + paste telemetry lands",
    ],
    levelCurve: "sigmoid((raw − 120) / 200) × 1000 — 60 raw → 100 IQ, 150 → 500, 300 → 820",
    maxScore: 1000,
  },
  range: {
    question: "How many domains can you actually work in?",
    signals: [
      { key: "liveDomains", label: "Live domains", hint: "≥ 3 concepts + progress ≥ 0.2" },
      { key: "paradigmsUsed", label: "Paradigms used", hint: "react · functional · async · types" },
      { key: "synergyPairs", label: "Active synergy pairs" },
      { key: "oneTrickPenalty", label: "One-trick penalty" },
      { key: "raw", label: "Raw score" },
    ],
    formula: [
      "rawRange = liveDomains × 60",
      "  + paradigmsUsed × 40",
      "  + synergyPairs × 30",
      "  + max(0, liveDomains − 1) × 40   // language-practiced proxy",
      "  − oneTrickPenalty",
    ],
    levelCurve: "linear up to 600, compressed above (raw − 600) × 0.5",
    maxScore: 1000,
  },
  velocity: {
    question: "How fast can you ship working code?",
    signals: [
      { key: "featuresCompleted", label: "Features shipped", hint: "days with ≥ 3 gains" },
      { key: "activeMinutes30d", label: "Active coding minutes (30d)" },
      { key: "newConceptsPerWeek", label: "New concepts / week (4w avg)" },
      { key: "raw", label: "Raw score" },
    ],
    formula: [
      "rawVelocity = featuresCompleted × 25",
      "  + min(200, activeMinutes30d / 30)",
      "  + min(80, newConceptsPerWeek × 16)",
      "  + levelUpsPerWeek × 40",
    ],
    levelCurve: "1000 × (1 − exp(−raw / 250)) — 100 → 330, 300 → 700, 700 → 940",
    maxScore: 1000,
  },
  debug: {
    question: "Can you find and fix root causes?",
    signals: [
      { key: "bugsAuthoredFixed", label: "Bugs authored-fixed", hint: "errorCount dropped after your edit" },
      { key: "recentFixes", label: "Fixes in last 14 days" },
      { key: "simplificationEvents", label: "Simplification events" },
      { key: "raw", label: "Raw score" },
    ],
    formula: [
      "rawDebug = bugsAuthoredFixed × 4",
      "  + recentFixes × 4",
      "  + max(0, 60 − diagnosticLatencyMin) × 2",
      "  + simplificationEvents × 6",
    ],
    levelCurve: "linear to 400, sigmoid above: 400 + 600 × sigmoid((raw − 600) / 200)",
    maxScore: 1000,
  },
  quality: {
    question: "Does your code last?",
    signals: [
      { key: "cleanSaveRate", label: "Clean save rate", hint: "saves with 0 new flags" },
      { key: "bugDensity", label: "Bug density", hint: "fix-gains / 100 concepts" },
      { key: "typeStrictness", label: "Type strictness" },
      { key: "raw", label: "Raw score" },
    ],
    formula: [
      "rawQuality = cleanSaveRate × 200",
      "  + max(0, 100 − bugDensity × 30)",
      "  + typeStrictness × 100",
      "  + testsAuthored × 8 + testCoverageAuthored × 150",
      "  − recurringBugCount × 12",
    ],
    levelCurve: "sigmoid centered at 350 with 180 slope",
    maxScore: 1000,
  },
  independence: {
    question: "Are you getting better, or is the AI doing it?",
    signals: [
      { key: "authorshipRatio30d", label: "Authorship ratio (30d)", hint: "typed chars / total new chars" },
      { key: "aiExplainabilityRate", label: "AI explainability rate", hint: "% of AI code you modify within 10 min" },
      { key: "noAssistFeaturesCompleted", label: "Features shipped without AI" },
    ],
    formula: [
      "rawIndependence = authorshipRatio30d × 500",
      "  + aiExplainabilityRate × 150",
      "  + noAssistFeaturesCompleted × 20",
      "  + aiCorrectionsAuthored × 8",
    ],
    levelCurve: "direct — no curve. What you see is what your authorship is.",
    maxScore: 1000,
  },
};

function IqV2Card({
  iqV2,
  streak,
  activeDays,
}: {
  iqV2: IqV2;
  streak: StreakInfo;
  activeDays: number;
}) {
  const [hoveredId, setHoveredId] = React.useState<IqV2Category["id"] | null>(
    null
  );
  const [expandedId, setExpandedId] = React.useState<IqV2Category["id"] | null>(
    null
  );
  const [ladderOpen, setLadderOpen] = React.useState(false);
  const categories: IqV2Category[] = [
    iqV2.craft,
    iqV2.range,
    iqV2.velocity,
    iqV2.debug,
    iqV2.quality,
    iqV2.independence,
  ];
  const hovered = hoveredId
    ? categories.find((c) => c.id === hoveredId) ?? null
    : null;

  // Overall ring progress — what fraction of the way to 1000 are you?
  const overallPct = Math.min(1, iqV2.codeIq / 1000);

  // When hovering a category, the ring shows that category's own progress
  // so the orbit becomes an interactive lens into each pillar.
  const ringPct = hovered && !hovered.pending
    ? Math.min(1, hovered.score / 1000)
    : overallPct;
  const ringLabel = hovered ? hovered.label : iqV2.level.label;
  const ringSub = hovered
    ? hovered.pending
      ? "awaiting signal data"
      : `${hovered.score} / 1000`
    : iqV2.level.next
      ? `${iqV2.level.toNext} iq to ${iqV2.level.next}`
      : "you are Legend";

  // Ring geometry
  const r = 38;
  const c = 2 * Math.PI * r;
  const dash = c * ringPct;
  const gap = c - dash;

  // Orbiting "pulse" dot — the single signature detail.
  const pulseA = ringPct * Math.PI * 2 - Math.PI / 2;
  const pulseX = 50 + Math.cos(pulseA) * r;
  const pulseY = 50 + Math.sin(pulseA) * r;

  // Tick marks per level threshold, so the ring reads like an instrument.
  const ringTicks = [80, 180, 350, 550, 720, 860, 950].map((at) => ({
    at,
    frac: at / 1000,
  }));

  return (
    <div
      className="dash-card iqv2-card has-cinema-bg"
      style={{ ["--bg-img" as never]: `url(${bgCometRider})` }}
    >
      <div className="iqv2-headline">
        <div className="iqv2-orbit">
          <svg viewBox="0 0 100 100" className="iqv2-ring" aria-hidden>
            <defs>
              <linearGradient id="iqV2RingGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#BDDBFF" />
                <stop offset="60%" stopColor="#4A9EFF" />
                <stop offset="100%" stopColor="#1E63C8" />
              </linearGradient>
              <filter id="iqV2RingGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.07)"
              strokeWidth="5"
            />
            {ringTicks.map((t, i) => {
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
              stroke="url(#iqV2RingGrad)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${gap}`}
              transform="rotate(-90 50 50)"
              filter="url(#iqV2RingGlow)"
              className="iqv2-ring-fill"
            />
            <g className="iqv2-ring-pulse">
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
            <text
              x="50"
              y="48"
              textAnchor="middle"
              dominantBaseline="central"
              className="iqv2-ring-num"
            >
              {hovered && !hovered.pending ? hovered.score : iqV2.codeIq}
            </text>
            <text
              x="50"
              y="62"
              textAnchor="middle"
              dominantBaseline="central"
              className="iqv2-ring-max"
            >
              / 1000
            </text>
          </svg>
        </div>

        <div className="iqv2-meta">
          <div className="iqv2-level">{ringLabel}</div>
          <div className="iqv2-level-sub-row">
            <div className="iqv2-level-sub microcaps">{ringSub}</div>
            {!hovered && (
              <button
                type="button"
                className={`iqv2-ladder-toggle ${ladderOpen ? "open" : ""}`}
                onClick={() => setLadderOpen((o) => !o)}
                aria-expanded={ladderOpen}
              >
                <span>{ladderOpen ? "hide levels" : "all levels"}</span>
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M3 4.5l3 3 3-3" />
                </svg>
              </button>
            )}
          </div>
          <div className="iqv2-explain">
            {hovered
              ? hovered.explanation
              : `mean of ${
                  categories.filter((c) => !c.pending).length
                } categories · hover to preview · click a bar to see the math`}
          </div>
        </div>
      </div>

      {ladderOpen && <IqV2Ladder currentIq={iqV2.codeIq} currentLevelId={iqV2.level.id} />}

      <div className="iqv2-bars">
        {categories.map((cat) => (
          <React.Fragment key={cat.id}>
            <IqV2Bar
              cat={cat}
              hovered={hoveredId === cat.id}
              expanded={expandedId === cat.id}
              onEnter={() => setHoveredId(cat.id)}
              onLeave={() => setHoveredId(null)}
              onToggle={() =>
                setExpandedId((id) => (id === cat.id ? null : cat.id))
              }
            />
            {expandedId === cat.id && <IqV2Explain cat={cat} />}
          </React.Fragment>
        ))}
      </div>

      <div className="iqv2-foot">
        <TrendStat label="Streak" value={`${streak.current}d`} />
        <TrendStat label="Longest" value={`${streak.longest}d`} />
        <TrendStat label="Active days" value={activeDays} />
      </div>
    </div>
  );
}

function IqV2Bar({
  cat,
  hovered,
  expanded,
  onEnter,
  onLeave,
  onToggle,
}: {
  cat: IqV2Category;
  hovered: boolean;
  expanded: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onToggle: () => void;
}) {
  const pct = Math.max(0, Math.min(100, cat.score / 10));
  return (
    <button
      className={`iqv2-bar-row ${cat.pending ? "pending" : ""} ${hovered ? "hovered" : ""} ${expanded ? "expanded" : ""}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={() => !cat.pending && onToggle()}
      aria-label={`${cat.label}: ${cat.score} of 1000`}
      aria-expanded={expanded}
      title={cat.pending ? "Awaiting signal data" : "Click to see the math"}
    >
      <span className="iqv2-bar-label microcaps">{cat.label}</span>
      <span className="iqv2-bar-track">
        <span
          className="iqv2-bar-fill"
          style={{ width: cat.pending ? "0%" : `${pct}%` }}
        />
      </span>
      <span className="iqv2-bar-score">
        {cat.pending ? "—" : cat.score}
      </span>
      <span className="iqv2-bar-chevron" aria-hidden>
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </span>
    </button>
  );
}

/** Level ladder — shows all eight tiers (Curious → Legend) with the
 *  user's exact distance to each one. Collapsed by default, toggled
 *  by the "all levels" button under the headline level label.
 *
 *  Rows render three states:
 *    reached  — past tier, faded, marked "reached"
 *    current  — where you are, highlighted, shows progress bar inside
 *    locked   — future tier, shows "X IQ to reach" */
function IqV2Ladder({
  currentIq,
  currentLevelId,
}: {
  currentIq: number;
  currentLevelId: string;
}) {
  const currentIdx = IQV2_LEVEL_BANDS.findIndex((b) => b.id === currentLevelId);
  return (
    <div className="iqv2-ladder" role="region" aria-label="All engineering levels">
      <div className="iqv2-ladder-head microcaps">
        Engineering Levels · 0 → 1000
      </div>
      <div className="iqv2-ladder-rows">
        {IQV2_LEVEL_BANDS.map((band, i) => {
          const isCurrent = i === currentIdx;
          const isReached = i < currentIdx;
          const isLocked = i > currentIdx;
          const gap = isLocked ? band.min - currentIq : 0;
          // progress inside the current band
          const pct = isCurrent
            ? Math.max(
                0,
                Math.min(
                  100,
                  ((currentIq - band.min) / Math.max(1, band.max - band.min)) * 100
                )
              )
            : isReached
              ? 100
              : 0;
          return (
            <div
              key={band.id}
              className={`iqv2-ladder-row ${isCurrent ? "current" : ""} ${isReached ? "reached" : ""} ${isLocked ? "locked" : ""}`}
            >
              <span className="iqv2-ladder-marker" aria-hidden>
                {isReached ? "✓" : isCurrent ? "●" : "○"}
              </span>
              <span className="iqv2-ladder-name">{band.label}</span>
              <span className="iqv2-ladder-range microcaps">
                {band.min}–{band.max}
              </span>
              <span className="iqv2-ladder-bar">
                <span
                  className="iqv2-ladder-bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="iqv2-ladder-status">
                {isReached ? "reached" : isCurrent ? "you are here" : `+${gap} iq`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="iqv2-ladder-foot microcaps">
        Each tier is exponentially harder to reach — curves are sigmoid /
        log inside every category. Staff-level means all six pillars above ~700.
      </div>
    </div>
  );
}

/** Explainer panel — opens under a clicked bar and shows the question,
 *  signals (with their current raw values from `cat.inputs`), the
 *  formula in plain English, and the level curve.
 *
 *  These strings stay in lockstep with the backend math in
 *  apps/backend/src/iqV2.ts. If a formula changes there, the string
 *  here must change too — don't let the UI lie about how the score
 *  was computed. */
function IqV2Explain({ cat }: { cat: IqV2Category }) {
  const meta = CATEGORY_META[cat.id];
  return (
    <div className="iqv2-explain-panel" role="region" aria-label={`${cat.label} breakdown`}>
      <div className="iqv2-ex-question">{meta.question}</div>

      <div className="iqv2-ex-block">
        <div className="iqv2-ex-h microcaps">Signals we track</div>
        <div className="iqv2-ex-signals">
          {meta.signals.map((s) => {
            const value = cat.inputs[s.key];
            const hasValue = value !== undefined && value !== null;
            return (
              <div key={s.key} className="iqv2-ex-signal">
                <span className="iqv2-ex-signal-label">
                  {s.label}
                  {s.hint && <span className="iqv2-ex-signal-hint"> — {s.hint}</span>}
                </span>
                <span className="iqv2-ex-signal-val">
                  {hasValue ? String(value) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="iqv2-ex-block">
        <div className="iqv2-ex-h microcaps">Formula</div>
        <pre className="iqv2-ex-formula">
          {meta.formula.join("\n")}
        </pre>
      </div>

      <div className="iqv2-ex-block">
        <div className="iqv2-ex-h microcaps">Level curve</div>
        <div className="iqv2-ex-curve">{meta.levelCurve}</div>
      </div>

      {cat.pending && (
        <div className="iqv2-ex-pending">
          This category is pending — signal collection (keystroke / paste /
          AI-accept) ships next. Currently excluded from the headline average.
        </div>
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

