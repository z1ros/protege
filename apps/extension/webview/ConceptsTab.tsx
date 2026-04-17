import React, { useState } from "react";
import type {
  ClusterSummary,
  ConceptRow,
  DailyIqPoint,
  GainEvent,
  IqPillars,
  MilestoneSummary,
  Recommendation,
  StreakInfo,
} from "@protege/types";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconStar, IconCheck, IconPlus } from "./icons.js";
import { ConceptsDashboard } from "./ConceptsDashboard.js";

interface Props {
  codeIq: number;
  maxIq: number;
  bonusIq: number;
  totalConcepts: number;
  ruleCount: number;
  concepts: ConceptRow[];
  clusters: ClusterSummary[];
  recentGains: GainEvent[];
  streak: StreakInfo;
  dailyIq: DailyIqPoint[];
  milestones: MilestoneSummary[];
  recommendations: Recommendation[];
  pillars: IqPillars | null;
}

const LEVEL_LABEL: Record<string, string> = {
  expert: "Expert",
  competent: "Competent",
  functional: "Functional",
  familiar: "Familiar",
};

type View = "overview" | "concepts" | "milestones" | "gains";

export function ConceptsTab({
  codeIq,
  maxIq,
  bonusIq,
  totalConcepts,
  ruleCount,
  concepts,
  clusters,
  recentGains,
  streak,
  dailyIq,
  milestones,
  recommendations,
  pillars,
}: Props) {
  const [view, setView] = useState<View>("overview");
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);

  const visibleConcepts = clusterFilter
    ? concepts.filter((c) => c.cluster === clusterFilter)
    : concepts;

  const pctOfCeiling = Math.min(100, (codeIq / maxIq) * 100);
  const unlockedCount = milestones.filter((m) => m.unlocked).length;

  return (
    <div className="concepts">
      <div className="concepts-views">
        <button
          className={`cv-tab ${view === "overview" ? "active" : ""}`}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        <button
          className={`cv-tab ${view === "concepts" ? "active" : ""}`}
          onClick={() => setView("concepts")}
        >
          Concepts
        </button>
        <button
          className={`cv-tab ${view === "milestones" ? "active" : ""}`}
          onClick={() => setView("milestones")}
        >
          Milestones
        </button>
        <button
          className={`cv-tab ${view === "gains" ? "active" : ""}`}
          onClick={() => setView("gains")}
        >
          Gains
        </button>
      </div>

      {view === "overview" && (
        <ConceptsDashboard
          codeIq={codeIq}
          maxIq={maxIq}
          totalConcepts={totalConcepts}
          ruleCount={ruleCount}
          concepts={concepts}
          dailyIq={dailyIq}
          recentGains={recentGains}
          streak={streak}
          clusters={clusters}
          pillars={pillars}
        />
      )}

      {view === "concepts" && (
        <ConceptsList
          concepts={visibleConcepts}
          clusterFilter={clusterFilter}
          onClearFilter={() => setClusterFilter(null)}
        />
      )}

      {view === "milestones" && <MilestonesView milestones={milestones} />}

      {view === "gains" && <GainsView gains={recentGains} />}
    </div>
  );
}

function HeroStat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub: string;
}) {
  return (
    <div className="hero-stat">
      <div className="hero-stat-value">
        <span className="serif-num">{value}</span>
        {unit && <span className="hero-stat-unit">{unit}</span>}
      </div>
      <div className="hero-stat-label microcaps">{label}</div>
      <div className="hero-stat-sub">{sub}</div>
    </div>
  );
}

function Sparkline({ points }: { points: DailyIqPoint[] }) {
  const width = 240;
  const height = 40;
  const pad = 2;
  const vals = points.map((p) => p.codeIq);
  const max = Math.max(1, ...vals);
  const min = Math.min(...vals);
  const range = Math.max(1, max - min);
  const n = points.length;
  const dx = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const pts = points.map((p, i) => {
    const x = pad + i * dx;
    const y = height - pad - ((p.codeIq - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathD = `M ${pts.join(" L ")}`;
  const areaD = `${pathD} L ${(pad + (n - 1) * dx).toFixed(1)},${height - pad} L ${pad},${height - pad} Z`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width="100%">
      <defs>
        <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(74, 158, 255, 0.35)" />
          <stop offset="100%" stopColor="rgba(74, 158, 255, 0)" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#sparkFill)" />
      <path
        d={pathD}
        fill="none"
        stroke="rgba(74, 158, 255, 0.9)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RecommendationsBlock({ recs }: { recs: Recommendation[] }) {
  return (
    <div className="recs">
      <div className="recs-label">Next to learn</div>
      <div className="recs-list">
        {recs.map((r) => (
          <div key={r.concept} className="rec-row">
            <div className="rec-top">
              <span className="rec-concept">{r.concept}</span>
              <span className="rec-weight">w {r.weight.toFixed(1)}</span>
            </div>
            <div className="rec-reason">{r.reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClustersView({
  clusters,
  onPick,
}: {
  clusters: ClusterSummary[];
  onPick: (cluster: string) => void;
}) {
  const anyTouched = clusters.some((c) => c.concepts > 0);
  if (!anyTouched) {
    return (
      <div className="concepts-empty">
        <CinematicPlate
          image="blueHorizon"
          caption="HORIZON · UNTOUCHED"
          ratio="4:3"
          intensity={0.55}
          headline={
            <>
              Save a file<br />
              to start <span className="accent">earning IQ</span>
            </>
          }
        />
        <div className="empty-sub">
          Protege detects concepts in your code when you save (Cmd+S).
          Each new concept adds weighted IQ.
        </div>
      </div>
    );
  }
  return (
    <div className="cluster-grid">
      {clusters.map((cl) => (
        <button
          key={cl.cluster}
          className={`cluster-card ${cl.concepts === 0 ? "empty" : ""}`}
          onClick={() => cl.concepts > 0 && onPick(cl.cluster)}
          disabled={cl.concepts === 0}
        >
          <div className="cluster-top">
            <span className="cluster-label">{cl.label}</span>
            <span className="cluster-iq">{cl.iq}</span>
          </div>
          <div className="cluster-bar">
            <div
              className="cluster-bar-fill"
              style={{ width: `${Math.round(cl.progress * 100)}%` }}
            />
          </div>
          <div className="cluster-meta">
            {cl.concepts} / {cl.total} concepts
          </div>
        </button>
      ))}
    </div>
  );
}

function ConceptsList({
  concepts,
  clusterFilter,
  onClearFilter,
}: {
  concepts: ConceptRow[];
  clusterFilter: string | null;
  onClearFilter: () => void;
}) {
  if (concepts.length === 0) {
    return (
      <div className="concepts-empty">
        <div className="empty-sub">No concepts here yet.</div>
      </div>
    );
  }
  return (
    <div className="concepts-list">
      <div className="concepts-list-head">
        <span className="concepts-list-label">
          {clusterFilter ? `Filtered: ${clusterFilter}` : "All concepts"}
        </span>
        {clusterFilter && (
          <button className="link-btn" onClick={onClearFilter}>
            clear
          </button>
        )}
      </div>
      {concepts.map((c) => (
        <div key={c.name} className="concept-row">
          <div className="concept-head">
            <span className="concept-name">{c.name}</span>
            <span className={`concept-level lvl-${c.level}`}>
              {LEVEL_LABEL[c.level]}
            </span>
          </div>
          <div className="concept-bar">
            <div
              className="concept-bar-fill"
              style={{ width: `${Math.round(c.mastery * 100)}%` }}
            />
          </div>
          <div className="concept-meta">
            <span>
              <strong>{c.timesUsed}</strong> use{c.timesUsed === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>
              <strong>{c.distinctFiles}</strong> file
              {c.distinctFiles === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>weight {c.weight.toFixed(1)}</span>
            <span>·</span>
            <span className="concept-iq">
              +{Math.round(c.iqContribution)} IQ
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function MilestonesView({ milestones }: { milestones: MilestoneSummary[] }) {
  const unlocked = milestones.filter((m) => m.unlocked);
  const locked = milestones.filter((m) => !m.unlocked);
  return (
    <div className="milestones-wrap">
      {unlocked.length > 0 && (
        <>
          <div className="concepts-list-label">Unlocked ({unlocked.length})</div>
          <div className="milestones-list">
            {unlocked.map((m) => (
              <div key={m.id} className="milestone-row unlocked">
                <span className="milestone-icon"><IconStar size={13} strokeWidth={2.2} /></span>
                <div className="milestone-body">
                  <div className="milestone-title">{m.title}</div>
                  <div className="milestone-desc">{m.description}</div>
                </div>
                <span className="milestone-bonus">+{m.bonusIq}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {locked.length > 0 && (
        <>
          <div className="concepts-list-label">Locked ({locked.length})</div>
          <div className="milestones-list">
            {locked.map((m) => (
              <div key={m.id} className="milestone-row locked">
                <span className="milestone-icon">○</span>
                <div className="milestone-body">
                  <div className="milestone-title">{m.title}</div>
                  <div className="milestone-desc">{m.description}</div>
                </div>
                <span className="milestone-bonus">+{m.bonusIq}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GainsView({ gains }: { gains: GainEvent[] }) {
  if (gains.length === 0) {
    return (
      <div className="concepts-empty">
        <div className="empty-sub">
          No recent gains yet. Save a file to earn IQ.
        </div>
      </div>
    );
  }
  return (
    <div className="gains-list">
      {gains.map((g, i) => (
        <div key={`${g.ts}-${i}`} className={`gain-row gain-${g.kind ?? "concept"}`}>
          <span className="gain-delta">
            <span className="gain-icon">
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
          <div className="gain-body">
            <div className="gain-concept">{g.concept}</div>
            <div className="gain-meta">
              {g.cluster} · {g.file} · {relativeTime(g.ts)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs)) return "";
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
