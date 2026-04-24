import React, { useState, useEffect } from "react";
import type {
  GainEvent,
  MilestoneSummary,
  StreakInfo,
} from "@protege/types";
import { CinematicPlate } from "./CinematicPlate.js";
import { IconStar, IconCheck, IconPlus } from "./icons.js";

/**
 * Profile page — merged with Settings.
 *
 * The top half is "who you are" (profile hero, stats, journey, recent wins).
 * The bottom half is "how Protege behaves" (the preferences that used to
 * live in a separate Settings overlay). Combined here because the user
 * asked to reduce header icons and keep everything in one place.
 */

interface Props {
  userName: string;
  avatarUrl?: string | null;
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

      {/* ==========================================================
          Preferences — what used to be the Settings overlay.
          Theme control is intentionally omitted here because it now
          lives as a direct toggle in the header.
          ========================================================== */}
      <PreferencesSections />

      <section className="profile-section profile-actions">
        <button className="ghost-btn" disabled>
          Edit profile
        </button>
        <button className="ghost-btn" disabled>
          Sign out
        </button>
      </section>

      <div className="settings-footnote microcaps">
        Protege v0.0.1 · your data stays local
      </div>
    </div>
  );
}

/* ==========================================================
   Preferences (formerly SettingsPage)
   ========================================================== */

function PreferencesSections() {
  const [reduceMotion, setReduceMotion] = useState(
    () => localStorage.getItem("protege:reduce-motion") === "1"
  );
  const [model, setModel] = useState("claude-sonnet-4-5");
  const [temperature, setTemperature] = useState(0.7);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voice, setVoice] = useState<"bella" | "michael">("bella");
  const [iqToasts, setIqToasts] = useState(true);
  const [nudgeVerbosity, setNudgeVerbosity] = useState<
    "quiet" | "normal" | "chatty"
  >("normal");

  // Reduce motion is the one preference that affects current-session CSS,
  // so we sync it to a data attribute on the document element.
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion ? "1" : "";
    localStorage.setItem("protege:reduce-motion", reduceMotion ? "1" : "0");
  }, [reduceMotion]);

  return (
    <>
      <Section label="Model">
        <Row label="Provider">
          <div className="row-value microcaps">Anthropic</div>
        </Row>
        <Row label="Model">
          <select
            className="select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
            <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
          </select>
        </Row>
        <Row label={`Temperature · ${temperature.toFixed(1)}`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="slider"
            style={{ ["--fill" as never]: `${temperature * 100}%` }}
          />
        </Row>
      </Section>

      <Section label="Voice">
        <Row label="Voice mode">
          <Toggle checked={voiceEnabled} onChange={setVoiceEnabled} />
        </Row>
        <Row label="Voice">
          <SegmentedControl
            value={voice}
            options={[
              { value: "bella", label: "Bella" },
              { value: "michael", label: "Michael" },
            ]}
            onChange={(v) => setVoice(v as typeof voice)}
          />
        </Row>
      </Section>

      <Section label="Appearance">
        <Row label="Reduce motion">
          <Toggle checked={reduceMotion} onChange={setReduceMotion} />
        </Row>
      </Section>

      <Section label="Notifications">
        <Row label="IQ gain toasts">
          <Toggle checked={iqToasts} onChange={setIqToasts} />
        </Row>
        <Row label="Nudge verbosity">
          <SegmentedControl
            value={nudgeVerbosity}
            options={[
              { value: "quiet", label: "Quiet" },
              { value: "normal", label: "Normal" },
              { value: "chatty", label: "Chatty" },
            ]}
            onChange={(v) => setNudgeVerbosity(v as typeof nudgeVerbosity)}
          />
        </Row>
      </Section>

    </>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="section-label microcaps">{label}</div>
      <div className="section-card">{children}</div>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-label">{label}</div>
      <div className="setting-row-value">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={`segmented-btn ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
