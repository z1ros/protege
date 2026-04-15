import React from "react";
import type {
  GainEvent,
  MilestoneSummary,
  StreakInfo,
} from "@protege/types";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconStar, IconCheck, IconPlus } from "./icons.js";

interface Props {
  userName: string;
  memberSince: string;
  codeIq: number;
  maxIq: number;
  totalConcepts: number;
  ruleCount: number;
  streak: StreakInfo;
  milestones: MilestoneSummary[];
  recentGains: GainEvent[];
}

export function ProfilePage({
  userName,
  memberSince,
  codeIq,
  totalConcepts,
  ruleCount,
  streak,
  milestones,
  recentGains,
}: Props) {
  const unlocked = milestones.filter((m) => m.unlocked);
  const sortedUnlocked = [...unlocked].sort((a, b) => {
    const atA = a.unlockedAt ? Date.parse(a.unlockedAt) : 0;
    const atB = b.unlockedAt ? Date.parse(b.unlockedAt) : 0;
    return atB - atA;
  });
  const bonusIq = unlocked.reduce((s, m) => s + m.bonusIq, 0);

  return (
    <div className="page profile-page">
      <CinematicPlate
        image="galaxySky"
        caption={`MEMBER SINCE · ${memberSince.toUpperCase()}`}
        ratio="16:9"
        intensity={0.55}
      >
        <div className="profile-hero-over">
          <div className="microcaps">Your profile</div>
          <div className="profile-name serif">{userName}</div>
          <div className="profile-iq">
            <span className="serif-num">{codeIq}</span>
            <span className="profile-iq-label microcaps">Code IQ</span>
          </div>
        </div>
      </CinematicPlate>

      <div className="hero-stats profile-stats">
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{streak.current}</span>
            <span className="hero-stat-unit">d</span>
          </div>
          <div className="hero-stat-label microcaps">Streak</div>
          <div className="hero-stat-sub">best {streak.longest}d</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{totalConcepts}</span>
            <span className="hero-stat-unit">/{ruleCount}</span>
          </div>
          <div className="hero-stat-label microcaps">Concepts</div>
          <div className="hero-stat-sub">mastered</div>
        </div>
        <div className="hero-stat">
          <div className="hero-stat-value">
            <span className="serif-num">{unlocked.length}</span>
            <span className="hero-stat-unit">/{milestones.length}</span>
          </div>
          <div className="hero-stat-label microcaps">Milestones</div>
          <div className="hero-stat-sub">+{bonusIq} bonus IQ</div>
        </div>
      </div>

      {sortedUnlocked.length > 0 && (
        <section className="profile-section">
          <div className="section-label microcaps">Your journey</div>
          <div className="journey-list">
            {sortedUnlocked.slice(0, 8).map((m, i) => (
              <div key={m.id} className="journey-row">
                <div className="journey-dot" />
                <div className="journey-body">
                  <div className="journey-title">{m.title}</div>
                  <div className="journey-meta">
                    {m.unlockedAt
                      ? new Date(m.unlockedAt).toLocaleDateString()
                      : ""}
                    {" · +"}
                    {m.bonusIq} IQ
                  </div>
                </div>
                {i === 0 && <div className="journey-latest">LATEST</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {recentGains.length > 0 && (
        <section className="profile-section">
          <div className="section-label microcaps">Recent wins</div>
          <div className="recent-wins">
            {recentGains.slice(0, 5).map((g, i) => (
              <div key={`${g.ts}-${i}`} className={`win-row win-${g.kind ?? "concept"}`}>
                <span className="win-delta">
                  <span className="win-icon">
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
                <span className="win-concept">{g.concept}</span>
                <span className="win-file">{g.file}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="profile-section profile-actions">
        <button className="ghost-btn" disabled>
          Edit profile
        </button>
        <button className="ghost-btn" disabled>
          Sign out
        </button>
      </section>
    </div>
  );
}
