import React, { useRef, useEffect, useState, useMemo } from "react";

/* ================================================================
   Types
   ================================================================ */

interface DayEntry {
  date: string;
  active: boolean;
  iqGained: number;
  conceptsUsed: number;
  topConcept?: string;
  filesEdited: number;
  streak: number;
}

interface StreakReward {
  days: number;
  label: string;
  reward: string;
  unlocked: boolean;
}

interface Props {
  currentStreak: number;
  longestStreak: number;
}

/* ================================================================
   Mock data
   ================================================================ */

const CONCEPTS = [
  "async/await", "React hooks", "closures", "destructuring",
  "template literals", "optional chaining", "map/filter/reduce",
  "error handling", "TS generics", "promises", "arrow functions",
  "spread operator", "module imports", "null coalescing",
  "type guards", "iterators", "proxy/reflect", "decorators",
];

function generateMockData(): DayEntry[] {
  const days: DayEntry[] = [];
  const today = new Date();
  // Seed a deterministic random so the heatmap doesn't re-shuffle on every render
  let seed = 42;
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return (seed - 1) / 2147483646; };

  let streak = 0;
  for (let i = 179; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const dow = d.getDay();
    const recency = Math.max(0, 1 - i / 180);
    const weekday = dow > 0 && dow < 6 ? 0.25 : 0;
    const active = rand() < 0.3 + recency * 0.4 + weekday;

    if (active) {
      streak++;
      days.push({
        date: dateStr, active: true,
        iqGained: Math.floor(rand() * 9 + 1),
        conceptsUsed: Math.floor(rand() * 5 + 1),
        topConcept: CONCEPTS[Math.floor(rand() * CONCEPTS.length)],
        filesEdited: Math.floor(rand() * 7 + 1),
        streak,
      });
    } else {
      streak = 0;
      days.push({
        date: dateStr, active: false,
        iqGained: 0, conceptsUsed: 0, filesEdited: 0, streak: 0,
      });
    }
  }
  return days;
}

const MOCK_DATA = generateMockData();

const STREAK_REWARDS: StreakReward[] = [
  { days: 7,  label: "7-day streak",  reward: "Badge: First Week", unlocked: false },
  { days: 14, label: "14-day streak", reward: "Priority voice queue", unlocked: false },
  { days: 30, label: "30-day streak", reward: "10% off next month", unlocked: false },
  { days: 60, label: "60-day streak", reward: "20% off next month", unlocked: false },
  { days: 90, label: "90-day streak", reward: "Free month", unlocked: false },
];

/* ================================================================
   Helpers
   ================================================================ */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["S","M","T","W","T","F","S"];

function fmt(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function fmtRelative(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return DOW[d.getDay()] + ", " + fmt(dateStr);
  return fmt(dateStr);
}

function intensity(iq: number) {
  if (iq === 0) return "day-empty";
  if (iq <= 2)  return "day-low";
  if (iq <= 5)  return "day-med";
  return "day-high";
}

/* ================================================================
   Component
   ================================================================ */

export function StreakJournal({ currentStreak, longestStreak }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, []);

  // Weeks for heatmap
  const { weeks, monthLabels } = useMemo(() => {
    const ws: DayEntry[][] = [];
    let cur: DayEntry[] = [];
    const first = new Date(MOCK_DATA[0].date + "T00:00:00");
    for (let i = 0; i < first.getDay(); i++)
      cur.push({ date: "", active: false, iqGained: 0, conceptsUsed: 0, filesEdited: 0, streak: 0 });
    for (const day of MOCK_DATA) {
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
  }, []);

  const recentActive = MOCK_DATA.filter(d => d.active).slice(-10).reverse();
  const totalActive = MOCK_DATA.filter(d => d.active).length;
  const totalIq = MOCK_DATA.reduce((s, d) => s + d.iqGained, 0);
  const avgIqPerDay = totalActive > 0 ? (totalIq / totalActive).toFixed(1) : "0";

  // Streak rewards — mark unlocked based on longest streak
  const rewards = STREAK_REWARDS.map(r => ({
    ...r,
    unlocked: longestStreak >= r.days,
  }));
  const nextReward = rewards.find(r => !r.unlocked);
  const nextRewardProgress = nextReward ? Math.min(1, currentStreak / nextReward.days) : 1;

  return (
    <div className="streak-journal">
      {/* ---- Next reward banner ---- */}
      {nextReward && (
        <div className="sj-reward-banner">
          <div className="sj-reward-banner-top">
            <span className="sj-reward-banner-label">Next reward</span>
            <span className="sj-reward-banner-target">{nextReward.label}</span>
          </div>
          <div className="sj-reward-banner-bar">
            <div
              className="sj-reward-banner-fill"
              style={{ width: `${nextRewardProgress * 100}%` }}
            />
          </div>
          <div className="sj-reward-banner-bottom">
            <span className="sj-reward-banner-progress">
              {currentStreak} / {nextReward.days} days
            </span>
            <span className="sj-reward-banner-prize">{nextReward.reward}</span>
          </div>
        </div>
      )}

      {/* ---- Hero stats ---- */}
      <div className="sj-hero">
        <div className="sj-stat">
          <span className="sj-stat-value sj-fire">{currentStreak}</span>
          <span className="sj-stat-label">current</span>
        </div>
        <div className="sj-stat">
          <span className="sj-stat-value">{longestStreak}</span>
          <span className="sj-stat-label">longest</span>
        </div>
        <div className="sj-stat">
          <span className="sj-stat-value">{totalActive}</span>
          <span className="sj-stat-label">days</span>
        </div>
        <div className="sj-stat">
          <span className="sj-stat-value">+{totalIq}</span>
          <span className="sj-stat-label">IQ earned</span>
        </div>
        <div className="sj-stat">
          <span className="sj-stat-value">{avgIqPerDay}</span>
          <span className="sj-stat-label">avg/day</span>
        </div>
      </div>

      {/* ---- Heatmap (GitHub-style, full width) ---- */}
      <div className="sj-heatmap-full">
        <div className="sj-heatmap-header">
          <span className="sj-section-label" style={{ marginBottom: 0 }}>Activity</span>
        </div>
        <div className="sj-heatmap-body">
          <div className="sj-day-labels">
            {DOW.map((l, i) => (
              <span key={i} className="sj-day-label">{i % 2 === 1 ? l : ""}</span>
            ))}
          </div>
          <div className="sj-heatmap-scroll" ref={scrollRef}>
            <div className="sj-month-row">
              {monthLabels.map((m, i) => (
                <span key={i} className="sj-month-label" style={{ gridColumnStart: m.weekIdx + 1 }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="sj-heatmap-grid">
              {weeks.map((week, wi) => (
                <div key={wi} className="sj-week">
                  {week.map((day, di) => {
                    const hasData = day.date && day.active;
                    return (
                      <div
                        key={di}
                        className={`sj-day ${day.date ? intensity(day.iqGained) : "day-pad"}`}
                        onMouseEnter={(e) => {
                          if (!day.date) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const wrap = e.currentTarget.closest(".sj-heatmap-full");
                          if (!wrap) return;
                          const wrapRect = wrap.getBoundingClientRect();
                          const tooltip = wrap.querySelector(".sj-heat-tooltip") as HTMLElement;
                          if (!tooltip) return;
                          tooltip.style.display = "block";
                          tooltip.style.left = `${rect.left - wrapRect.left + rect.width / 2}px`;
                          tooltip.style.top = `${rect.top - wrapRect.top - 6}px`;
                          tooltip.innerHTML = hasData
                            ? `<strong>${fmt(day.date)}</strong><br/>+${day.iqGained} IQ · ${day.conceptsUsed} concepts · ${day.filesEdited} files`
                            : `<strong>${fmt(day.date)}</strong><br/>Rest day`;
                        }}
                        onMouseLeave={() => {
                          const wrap = document.querySelector(".sj-heat-tooltip") as HTMLElement;
                          if (wrap) wrap.style.display = "none";
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="sj-heat-tooltip" style={{ display: "none" }} />
      </div>

      {/* ---- Rewards ladder ---- */}
      <div className="sj-section-label">Streak rewards</div>
      <div className="sj-rewards">
        {rewards.map((r) => (
          <div key={r.days} className={`sj-reward-row ${r.unlocked ? "unlocked" : ""}`}>
            <div className={`sj-reward-dot ${r.unlocked ? "done" : ""}`}>
              {r.unlocked ? (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8.5l3 3 7-7" />
                </svg>
              ) : (
                <span className="sj-reward-dot-num">{r.days}</span>
              )}
            </div>
            <div className="sj-reward-info">
              <div className="sj-reward-label">{r.label}</div>
              <div className="sj-reward-prize">{r.reward}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ---- Journal list ---- */}
      <div className="sj-section-label">Recent activity</div>
      <div className="sj-journal">
        {recentActive.map((day) => (
          <div
            key={day.date}
            className={`sj-entry ${expandedDay === day.date ? "expanded" : ""}`}
            onClick={() => setExpandedDay(expandedDay === day.date ? null : day.date)}
          >
            <div className="sj-entry-date">
              <span className="sj-entry-day">{fmtRelative(day.date)}</span>
              <div className="sj-entry-right">
                <span className="sj-entry-iq">+{day.iqGained}</span>
                {day.streak >= 3 && (
                  <span className="sj-entry-streak">{day.streak}d</span>
                )}
              </div>
            </div>
            {expandedDay === day.date && (
              <div className="sj-entry-detail">
                <div className="sj-entry-stats">
                  <span>{day.conceptsUsed} concept{day.conceptsUsed !== 1 ? "s" : ""}</span>
                  <span className="sj-entry-dot" />
                  <span>{day.filesEdited} file{day.filesEdited !== 1 ? "s" : ""}</span>
                  {day.topConcept && (
                    <>
                      <span className="sj-entry-dot" />
                      <span className="sj-entry-concept">{day.topConcept}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
