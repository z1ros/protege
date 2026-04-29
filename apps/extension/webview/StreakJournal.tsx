import React, { useLayoutEffect, useRef, useEffect, useMemo, useState } from "react";
import type { DailyIqPoint } from "@protege/types";

/* ================================================================
   Types
   ================================================================ */

interface DayEntry {
  date: string;
  active: boolean;
  iqGained: number;
  streak: number;
}

interface StreakReward {
  days: number;
  label: string;
  unlocked: boolean;
}

interface Props {
  currentStreak: number;
  longestStreak: number;
  /** Real cumulative-IQ-per-day data from MeResponse (Supabase-backed
   *  via apps/backend/src/store.ts). Up to 30 days. Older days outside
   *  this window render as inactive (0 IQ) cells in the heatmap. */
  dailyIq: DailyIqPoint[];
}

/**
 * Tooltip state stores the hovered *cell's* rectangle inside the heatmap
 * wrap. The final tooltip position is computed by a layout-effect (see
 * below) that measures the rendered tooltip and clamps/flips it against
 * the wrap's edges — so the tooltip always stays visible no matter how
 * narrow the sidebar is or which day-cell is hovered.
 */
interface TooltipState {
  day: DayEntry;
  cellLeft: number;
  cellTop: number;
  cellWidth: number;
  cellHeight: number;
}

interface TooltipPosition {
  left: number;
  top: number;
  flipped: boolean; // true = placed below the cell instead of above
}

/* ================================================================
   Mock data (unchanged — same deterministic seed)
   ================================================================ */

/**
 * Build the heatmap's 365-day array from real `dailyIq` data.
 *
 * The backend stores cumulative `codeIq` per day (last 30 days). We
 * convert to per-day IQ DELTAS (today − yesterday), then pad the rest
 * of the year with 0 so the heatmap geometry stays the same. Streak
 * counters are recomputed from the deltas so they stay in sync with
 * the activity pattern shown.
 */
function buildHeatmapData(dailyIq: DailyIqPoint[]): DayEntry[] {
  // Sort ascending so cumulative deltas come out positive.
  const sorted = [...dailyIq].sort((a, b) => a.date.localeCompare(b.date));
  const deltaByDate = new Map<string, number>();
  let prev = 0;
  for (const point of sorted) {
    const delta = Math.max(0, Math.round(point.codeIq - prev));
    deltaByDate.set(point.date, delta);
    prev = point.codeIq;
  }

  const days: DayEntry[] = [];
  const today = new Date();
  let streak = 0;
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const delta = deltaByDate.get(dateStr) ?? 0;
    const active = delta > 0;
    if (active) {
      streak++;
      days.push({
        date: dateStr,
        active: true,
        iqGained: delta,
        streak,
      });
    } else {
      streak = 0;
      days.push({
        date: dateStr,
        active: false,
        iqGained: 0,
        streak: 0,
      });
    }
  }
  return days;
}

/**
 * Streak milestones — pure day counts. The previous list carried fake
 * "rewards" ("Priority queue", "Free month", "30% off") that implied
 * monetary or feature unlocks Protege doesn't actually grant. Removed
 * to avoid promising things the product doesn't deliver. Pure
 * day-count badges remain — that's what the streak actually is.
 */
const STREAK_REWARDS: Omit<StreakReward, "unlocked">[] = [
  { days: 7,   label: "First week" },
  { days: 14,  label: "Fortnight" },
  { days: 30,  label: "One month" },
  { days: 60,  label: "Two months" },
  { days: 90,  label: "Quarter" },
  { days: 180, label: "Half year" },
  { days: 270, label: "Three quarters" },
  { days: 365, label: "One year" },
];

/* ================================================================
   Helpers
   ================================================================ */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtFull(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** GitHub-style 5-level intensity scale. */
function intensity(iq: number): number {
  if (iq === 0) return 0;
  if (iq <= 2) return 1;
  if (iq <= 5) return 2;
  if (iq <= 8) return 3;
  return 4;
}

/* ================================================================
   Component
   ================================================================ */

export function StreakJournal({ currentStreak, longestStreak, dailyIq }: Props) {
  // Real heatmap data, recomputed when `dailyIq` changes (incoming
  // iq/update broadcasts after a save → backend → MeResponse refresh).
  const heatmapDays = useMemo(() => buildHeatmapData(dailyIq), [dailyIq]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [tooltipPos, setTooltipPos] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const heatmapRef = useRef<HTMLDivElement>(null);

  /**
   * After the tooltip commits with new content, measure it and place it
   * such that it (a) prefers to sit ABOVE the cell, flipping BELOW when
   * there's not enough room above, and (b) stays inside the heatmap
   * wrap horizontally — clamping to the edges on tight sidebars.
   *
   * Runs in useLayoutEffect so positioning happens synchronously before
   * paint, avoiding a one-frame flash of the tooltip at a stale position.
   */
  useLayoutEffect(() => {
    if (!tooltip) {
      setTooltipPos(null);
      return;
    }
    const el = tooltipRef.current;
    const wrap = heatmapRef.current;
    if (!el || !wrap) return;

    const wrapW = wrap.offsetWidth;
    const wrapH = wrap.offsetHeight;
    const ttW = el.offsetWidth;
    const ttH = el.offsetHeight;
    const PAD = 6;
    const GAP = 8;

    const cellCenterX = tooltip.cellLeft + tooltip.cellWidth / 2;

    // Horizontal: center on the cell, then clamp inside the wrap
    let left = cellCenterX - ttW / 2;
    if (left + ttW > wrapW - PAD) left = wrapW - ttW - PAD;
    if (left < PAD) left = PAD;

    // Vertical: above by default; flip below if no room
    let top = tooltip.cellTop - ttH - GAP;
    let flipped = false;
    if (top < PAD) {
      flipped = true;
      top = tooltip.cellTop + tooltip.cellHeight + GAP;
      if (top + ttH > wrapH - PAD) top = wrapH - ttH - PAD;
    }

    setTooltipPos({ left, top, flipped });
  }, [tooltip]);

  // Scroll to most recent week on mount
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, []);

  // Weeks + month labels for heatmap (re-derived from real heatmapDays).
  const { weeks, monthLabels } = useMemo(() => {
    const ws: DayEntry[][] = [];
    let cur: DayEntry[] = [];
    if (heatmapDays.length === 0) return { weeks: ws, monthLabels: [] };
    const first = new Date(heatmapDays[0].date + "T00:00:00");
    for (let i = 0; i < first.getDay(); i++)
      cur.push({ date: "", active: false, iqGained: 0, streak: 0 });
    for (const day of heatmapDays) {
      cur.push(day);
      if (cur.length === 7) { ws.push(cur); cur = []; }
    }
    if (cur.length) ws.push(cur);

    const ml: { label: string; weekIdx: number }[] = [];
    let last = -1;
    ws.forEach((w, wi) => {
      for (const d of w) {
        if (!d.date) continue;
        const m = new Date(d.date + "T00:00:00").getMonth();
        if (m !== last) { ml.push({ label: MONTHS[m], weekIdx: wi }); last = m; }
        break;
      }
    });
    return { weeks: ws, monthLabels: ml };
  }, [heatmapDays]);

  const totalActive = useMemo(
    () => heatmapDays.filter((d) => d.active).length,
    [heatmapDays]
  );
  // "IQ earned" / "Avg per day" stats removed 2026-04-23 — the
  // Code IQ term is retired across the app, so showing "+388 IQ
  // earned" was leftover terminology. The remaining streak stats
  // (Longest + Active days) describe the streak itself, not IQ.

  // Mark rewards unlocked based on longest streak (real value from
  // backend: `streak.longest` ← Supabase via store.ts).
  const rewards = STREAK_REWARDS.map((r) => ({
    ...r,
    unlocked: longestStreak >= r.days,
  }));
  const nextReward = rewards.find(r => !r.unlocked);
  const nextRewardProgress = nextReward ? Math.min(1, currentStreak / nextReward.days) : 1;

  // Narrative line below the hero number — single clean sentence.
  const heroCaption = (() => {
    if (currentStreak === 0) return "Commit a change today to start a new streak.";
    if (currentStreak >= longestStreak && longestStreak > 0) return "New personal record";
    if (longestStreak - currentStreak <= 3 && longestStreak > 0) {
      const diff = longestStreak - currentStreak;
      return `${diff} ${diff === 1 ? "day" : "days"} until a new personal best`;
    }
    if (nextReward) {
      const diff = nextReward.days - currentStreak;
      return `${diff} ${diff === 1 ? "day" : "days"} until ${nextReward.label.toLowerCase()}`;
    }
    return `You've unlocked every milestone — legendary.`;
  })();

  return (
    <div className="streak-journal">
      {/* ============ HERO — giant number + flame + narrative ============ */}
      <section className="sj-hero">
        <div className="sj-hero-glyph">
          <StreakGlyph />
        </div>
        <div className="sj-hero-number-wrap">
          <div className="sj-hero-number">{currentStreak}</div>
          <div className="sj-hero-unit">day streak</div>
        </div>
        <div className="sj-hero-caption">{heroCaption}</div>

        {/* Mini stat row — 2 streak-focused metrics now (was 4; the
            IQ-flavored stats came out with the rest of the Code IQ
            terminology removal). */}
        <div className="sj-hero-stats">
          <div className="sj-mini-stat">
            <div className="sj-mini-stat-value">{longestStreak}</div>
            <div className="sj-mini-stat-label">Longest</div>
          </div>
          <div className="sj-mini-stat">
            <div className="sj-mini-stat-value">{totalActive}</div>
            <div className="sj-mini-stat-label">Active days</div>
          </div>
        </div>
      </section>

      {/* ============ ACTIVITY — GitHub-grade heatmap ============ */}
      <section className="sj-activity">
        <header className="sj-section-head">
          <h3>Activity</h3>
          <span className="sj-section-sub">last 365 days</span>
        </header>
        <div className="sj-heatmap" ref={heatmapRef}>
          <div className="sj-day-labels">
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          <div className="sj-heatmap-scroll" ref={scrollRef}>
            <div
              className="sj-month-row"
              style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }}
            >
              {monthLabels.map((m, i) => (
                <span
                  key={i}
                  className="sj-month-label"
                  style={{ gridColumnStart: m.weekIdx + 1 }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className="sj-heatmap-grid">
              {weeks.map((week, wi) => (
                <div key={wi} className="sj-week">
                  {week.map((day, di) => {
                    const hasData = !!day.date;
                    const lvl = intensity(day.iqGained);
                    return (
                      <div
                        key={di}
                        className={`sj-day sj-day-lvl-${lvl} ${hasData ? "" : "sj-day-pad"}`}
                        onMouseEnter={(e) => {
                          if (!hasData) return;
                          const cell = e.currentTarget.getBoundingClientRect();
                          const wrap = e.currentTarget.closest(".sj-heatmap");
                          if (!wrap) return;
                          const wrapRect = wrap.getBoundingClientRect();
                          setTooltip({
                            day,
                            cellLeft: cell.left - wrapRect.left,
                            cellTop: cell.top - wrapRect.top,
                            cellWidth: cell.width,
                            cellHeight: cell.height,
                          });
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {tooltip && (
            <div
              ref={tooltipRef}
              className={`sj-heat-tooltip ${tooltipPos?.flipped ? "sj-tt-below" : ""}`}
              style={{
                left: tooltipPos?.left ?? 0,
                top: tooltipPos?.top ?? 0,
                // Hide the tooltip for the one frame between "content
                // committed" and "layout effect measured + positioned it"
                // so users never see it flash at a stale position.
                visibility: tooltipPos ? "visible" : "hidden",
              }}
            >
              <div className="sj-tt-date">{fmtFull(tooltip.day.date)}</div>
              {tooltip.day.active ? (
                <div className="sj-tt-stats">
                  {tooltip.day.streak > 1 ? (
                    <span>day {tooltip.day.streak} of streak</span>
                  ) : (
                    <span>Active</span>
                  )}
                </div>
              ) : (
                <div className="sj-tt-rest">Rest day</div>
              )}
            </div>
          )}
        </div>
        <footer className="sj-heat-legend">
          <span>Less</span>
          <span className="sj-day sj-day-lvl-0" />
          <span className="sj-day sj-day-lvl-1" />
          <span className="sj-day sj-day-lvl-2" />
          <span className="sj-day sj-day-lvl-3" />
          <span className="sj-day sj-day-lvl-4" />
          <span>More</span>
        </footer>
      </section>

      {/* ============ REWARDS — horizontal milestone track ============ */}
      <section className="sj-rewards-section">
        <header className="sj-section-head">
          <h3>Milestones</h3>
          {nextReward && (
            <span className="sj-section-sub">
              {currentStreak} / {nextReward.days} to {nextReward.label.toLowerCase()}
            </span>
          )}
        </header>

        {/* Progress rail — thin electric-blue line with ticked milestones.
            Fill width uses a piecewise-linear mapping so the bar reliably
            lands on the current tile position, not a microscopic sliver
            from straight `streak / 365 * 100`. Each milestone tile sits at
            its grid-cell center; fill tracks linearly between them. */}
        <div className="sj-track">
          <div className="sj-track-rail" />
          <div
            className="sj-track-fill"
            style={{ width: `${computeTrackFill(currentStreak, rewards)}%` }}
          />
          <div className="sj-track-tiles">
            {(() => {
              // The "next target" is the first milestone the user has not
              // yet hit with their current streak (and hasn't unlocked
              // historically). It's the only tile that gets the electric
              // accent — everything else stays in the white scale so the
              // eye lands on what's actually next.
              const nextTargetIdx = rewards.findIndex(
                (r) => !r.unlocked && currentStreak < r.days
              );
              return rewards.map((r, i) => {
                const reached = currentStreak >= r.days;
                const isNext = i === nextTargetIdx;
                return (
                  <div
                    key={r.days}
                    className={[
                      "sj-tile",
                      r.unlocked && "unlocked",
                      reached && "reached",
                      isNext && "next",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="sj-tile-node">
                      {r.unlocked ? (
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 8.5l3 3 7-7" />
                        </svg>
                      ) : (
                        <span className="sj-tile-days">{r.days}</span>
                      )}
                    </div>
                    <div className="sj-tile-meta">
                      <div className="sj-tile-label">{r.label}</div>
                      <div className="sj-tile-prize">
                        {r.days} {r.days === 1 ? "day" : "days"}
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Piecewise-linear progress-bar fill percentage that tracks the tile
 * positions instead of the absolute 0..365 day span. Each tile sits at
 * its grid-cell center `(i + 0.5) / N`; between tiles the fill advances
 * proportionally to how far along `currentStreak` is within the segment.
 */
function computeTrackFill(currentStreak: number, rewards: StreakReward[]): number {
  const N = rewards.length;
  if (N === 0 || currentStreak <= 0) return 0;
  const tilePos = (i: number) => ((i + 0.5) / N) * 100;

  let lastReached = -1;
  for (let i = 0; i < N; i++) if (currentStreak >= rewards[i].days) lastReached = i;

  if (lastReached >= N - 1) return 100;
  if (lastReached < 0) {
    // Pre-first-milestone: ramp from 0% to tile-0 center.
    const t = Math.min(1, currentStreak / rewards[0].days);
    return t * tilePos(0);
  }
  const start = rewards[lastReached].days;
  const end = rewards[lastReached + 1].days;
  const t = Math.min(1, Math.max(0, (currentStreak - start) / (end - start)));
  return tilePos(lastReached) + t * (tilePos(lastReached + 1) - tilePos(lastReached));
}

/**
 * Streak glyph — thin lightning bolt in electric blue with a soft halo.
 * Replaces the previous flame (too "emoji" in feel). Same slot in the
 * hero layout; CSS animation keyframe name is unchanged so styles stay
 * in sync. Colors match the Orbit brand: no warm tones, pure electric.
 */
function StreakGlyph() {
  return (
    <svg viewBox="0 0 64 64" width="68" height="68" aria-hidden="true">
      <defs>
        <linearGradient id="sj-bolt" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"  stopColor="#c9dcff" />
          <stop offset="55%" stopColor="#82b7ff" />
          <stop offset="100%" stopColor="#4a9eff" />
        </linearGradient>
        <radialGradient id="sj-bolt-halo" cx="50%" cy="50%" r="55%">
          <stop offset="0%"  stopColor="#4a9eff" stopOpacity="0.28" />
          <stop offset="70%" stopColor="#4a9eff" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#4a9eff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Soft electric halo behind the bolt */}
      <circle cx="32" cy="32" r="30" fill="url(#sj-bolt-halo)" />
      {/* Lightning bolt — classic zap silhouette, centered */}
      <path
        d="M36 4 L14 34 L28 34 L24 60 L50 28 L34 28 L40 4 Z"
        fill="url(#sj-bolt)"
      />
      {/* Bright core stroke to give it a cut-glass edge */}
      <path
        d="M36 4 L14 34 L28 34 L24 60 L50 28 L34 28 L40 4 Z"
        fill="none"
        stroke="#ffffff"
        strokeWidth="0.8"
        strokeLinejoin="round"
        opacity="0.45"
      />
    </svg>
  );
}
