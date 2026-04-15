import React, { useState } from "react";
import { CinematicPlate } from "./CinematicPlate.js";

/**
 * Settings page — cinematic hero + grouped glass cards.
 *
 * For MVP the state is local-only; next pass we'll persist through
 * vscode.globalState via a settings/save message type. Everything here
 * renders the shape of the real feature so the design can be reviewed
 * in context before we wire it to storage.
 */
export function SettingsPage() {
  const [theme, setTheme] = useState<"auto" | "dark" | "light">("auto");
  const [reduceMotion, setReduceMotion] = useState(false);
  const [model, setModel] = useState("claude-sonnet-4-5");
  const [temperature, setTemperature] = useState(0.7);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voice, setVoice] = useState<"rachel" | "adam">("rachel");
  const [iqToasts, setIqToasts] = useState(true);
  const [nudgeVerbosity, setNudgeVerbosity] = useState<"quiet" | "normal" | "chatty">("normal");

  return (
    <div className="page settings-page">
      <CinematicPlate
        image="eclipseDawn"
        caption="SETTINGS · PROTEGE"
        ratio="16:9"
        intensity={0.5}
      >
        <div className="settings-hero-over">
          <div className="microcaps">Preferences</div>
          <div className="settings-headline serif">
            Tune your <span className="accent">mentor</span>.
          </div>
        </div>
      </CinematicPlate>

      <Section label="Appearance">
        <Row label="Theme">
          <SegmentedControl
            value={theme}
            options={[
              { value: "auto", label: "Auto" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={(v) => setTheme(v as typeof theme)}
          />
        </Row>
        <Row label="Reduce motion">
          <Toggle checked={reduceMotion} onChange={setReduceMotion} />
        </Row>
      </Section>

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
              { value: "rachel", label: "Rachel" },
              { value: "adam", label: "Adam" },
            ]}
            onChange={(v) => setVoice(v as typeof voice)}
          />
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

      <Section label="Data & privacy">
        <button className="ghost-btn full-row">Export memories</button>
        <button className="ghost-btn full-row">Clear all memories</button>
        <button className="ghost-btn danger full-row">Reset Code IQ</button>
      </Section>

      <div className="settings-footnote microcaps">
        Protege v0.0.1 · your data stays local
      </div>
    </div>
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
