import React, { useEffect, useState } from "react";
import { vscode, onHostMessage } from "./vscode.js";

/**
 * Live Tab — JARVIS mission control.
 *
 * Shows toggles for all JARVIS features, current file analysis,
 * and quick actions. The user controls what appears in their editor
 * from this single panel.
 */

interface ModelStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
  downloadProgress: number;
}

interface Props {
  fileName: string | null;
  liveReviewOn: boolean;
  onToggleLiveReview: () => void;
  modelStatus: ModelStatus;
}

interface AnalysisItem {
  type: "warn" | "info" | "perf";
  message: string;
  line: number;
}

type AiBackend = "on-device" | "haiku" | "sonnet" | "auto";

interface LastCall {
  backend: "on-device" | "haiku" | "sonnet";
  atMs: number;
  durationMs: number;
  ok: boolean;
  fallback?: {
    requested: "on-device" | "haiku" | "sonnet" | "auto";
    reason: string;
  };
}

const BACKEND_LABEL: Record<LastCall["backend"], string> = {
  "on-device": "Qwen 1.5B (on-device)",
  haiku: "Claude Haiku 4.5",
  sonnet: "Claude Sonnet 4.5",
};

export function LiveTab({ fileName, liveReviewOn, onToggleLiveReview, modelStatus }: Props) {
  const [inlineErrors, setInlineErrors] = useState(true);
  const [didYouKnow, setDidYouKnow] = useState(true);
  // "Teaching Annotations" toggle removed — feature not yet implemented.
  const [aiBackend, setAiBackend] = useState<AiBackend>("auto");
  const [lastCall, setLastCall] = useState<LastCall | null>(null);
  const [now, setNow] = useState(Date.now());

  // Subscribe to host pushes for backend state + live call events so the
  // Live tab (a) hydrates on mount from persisted globalState and (b)
  // reflects every aiQuery() call as it happens.
  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "ai/backend") {
        setAiBackend(msg.backend);
      } else if (msg.type === "ai/lastCall") {
        setLastCall({
          backend: msg.backend,
          atMs: msg.atMs,
          durationMs: msg.durationMs,
          ok: msg.ok,
          fallback: msg.fallback,
        });
      }
    });
    return off;
  }, []);

  // Keep the "X seconds ago" text fresh — cheap, one interval per tab.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);

  const modelReady = modelStatus.ready;
  const modelDownloading = modelStatus.loading && !modelStatus.ready;
  const downloadProgress = modelStatus.downloadProgress;
  const modelError = modelStatus.error;

  const shortName = fileName
    ? fileName.split(/[\\/]/).pop() ?? fileName
    : null;

  const handleBackendChange = (backend: AiBackend) => {
    setAiBackend(backend);
    vscode.postMessage({ type: "ai/setBackend", backend });

    // If switching to on-device and model isn't downloaded, trigger download
    if ((backend === "on-device" || backend === "auto") && !modelReady && !modelStatus.loading) {
      vscode.postMessage({ type: "ai/downloadModel" });
    }
  };

  return (
    <div className="live-tab">
      {/* ---- AI Backend ---- */}
      <div className="live-section">
        <div className="live-section-label microcaps">AI Engine</div>
        <div className="live-ai-selector">
          <AiOption
            id="auto"
            label="Auto"
            description="On-device if ready, cloud fallback"
            active={aiBackend === "auto"}
            onClick={() => handleBackendChange("auto")}
            badge="recommended"
          />
          <AiOption
            id="on-device"
            label="On-Device"
            description="Qwen 1.5B · free · instant · offline"
            active={aiBackend === "on-device"}
            onClick={() => handleBackendChange("on-device")}
            badge={modelReady ? "ready" : modelDownloading ? "downloading" : "~1.1 GB download"}
          />
          <AiOption
            id="haiku"
            label="Haiku 4.5"
            description="Claude · fast · cloud · ~$0.15/mo"
            active={aiBackend === "haiku"}
            onClick={() => handleBackendChange("haiku")}
          />
          <AiOption
            id="sonnet"
            label="Sonnet 4.5"
            description="Claude · best quality · cloud · ~$1.80/mo"
            active={aiBackend === "sonnet"}
            onClick={() => handleBackendChange("sonnet")}
          />
        </div>
        {modelDownloading && !modelReady && (
          <div className="live-download-bar">
            <div className="live-download-label microcaps">
              {downloadProgress >= 100
                ? "Loading model…"
                : `Downloading Qwen 1.5B… ${downloadProgress}%`}
            </div>
            <div className="live-download-track">
              <div
                className="live-download-fill"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        )}
        {modelError && !modelReady && !modelDownloading && (
          <div className="live-download-bar">
            <div className="live-download-label microcaps" style={{ color: "#e06c75" }}>
              On-device failed: {modelError}
            </div>
            <button
              className="live-action-btn"
              style={{ marginTop: 8 }}
              onClick={() => vscode.postMessage({ type: "ai/downloadModel" })}
            >
              <span className="live-action-label">Retry</span>
            </button>
          </div>
        )}

        {/* Live "last call" chip — proves which backend actually ran.
            When a fallback happened (user wanted on-device but we went to
            cloud), the chip turns AMBER + shows the reason, so it never
            lies about what just executed. */}
        {lastCall && (
          <div
            className={`live-lastcall ${lastCall.backend === "on-device" ? "ondevice" : "cloud"} ${lastCall.ok ? "" : "failed"} ${lastCall.fallback ? "fallback" : ""}`}
            title={
              lastCall.fallback
                ? `Requested ${lastCall.fallback.requested} but routed to ${BACKEND_LABEL[lastCall.backend]}: ${lastCall.fallback.reason}`
                : `Last aiQuery() routed to ${BACKEND_LABEL[lastCall.backend]}`
            }
          >
            <span className="live-lastcall-dot" />
            <span className="live-lastcall-label microcaps">Last call</span>
            <span className="live-lastcall-backend">{BACKEND_LABEL[lastCall.backend]}</span>
            <span className="live-lastcall-sep">·</span>
            <span className="live-lastcall-time">{lastCall.durationMs}ms</span>
            <span className="live-lastcall-sep">·</span>
            <span className="live-lastcall-ago">{formatAgo(now - lastCall.atMs)}</span>
            {!lastCall.ok && <span className="live-lastcall-warn">failed</span>}
            {lastCall.fallback && (
              <span className="live-lastcall-fallback">
                fallback · {lastCall.fallback.reason}
              </span>
            )}
          </div>
        )}
        {/* When saved backend needs on-device but model is still loading,
            say so explicitly — so silence doesn't look like Claude is used. */}
        {(aiBackend === "on-device" || aiBackend === "auto") && modelDownloading && (
          <div className="live-lastcall ondevice" style={{ marginTop: 6 }}>
            <span className="live-lastcall-dot" style={{ animation: "pulse 1.2s ease-in-out infinite" }} />
            <span className="live-lastcall-label microcaps">Loading on-device model…</span>
            <span className="live-lastcall-time">{downloadProgress}%</span>
          </div>
        )}
      </div>

      {/* ---- Current file ---- */}
      <div className="live-section">
        <div className="live-section-label microcaps">Current file</div>
        <div className="live-file-card">
          {shortName ? (
            <>
              <span className="live-file-dot" />
              <span className="live-file-name">{shortName}</span>
            </>
          ) : (
            <span className="live-file-empty">No file open</span>
          )}
        </div>
      </div>

      {/* ---- JARVIS Controls ---- */}
      <div className="live-section">
        <div className="live-section-label microcaps">Editor Intelligence</div>
        <div className="live-controls">
          <ControlRow
            icon="$(eye)"
            label="Live Review"
            description="Analyze code as you type — blue underlines on issues"
            active={liveReviewOn}
            onToggle={onToggleLiveReview}
          />
          <ControlRow
            icon="$(lightbulb)"
            label="Inline Error Hints"
            description="Plain-English explanations at end of error lines"
            active={inlineErrors}
            onToggle={() => {
              const next = !inlineErrors;
              setInlineErrors(next);
              vscode.postMessage({ type: "feature/toggle", feature: "inlineErrors", enabled: next });
            }}
          />
          <ControlRow
            icon="$(mortar-board)"
            label="Did You Know?"
            description="Proactive teaching tips during natural pauses"
            active={didYouKnow}
            onToggle={() => {
              const next = !didYouKnow;
              setDidYouKnow(next);
              vscode.postMessage({ type: "feature/toggle", feature: "didYouKnow", enabled: next });
            }}
          />
        </div>
      </div>

      {/* ---- Quick Actions ---- */}
      <div className="live-section">
        <div className="live-section-label microcaps">Quick Actions</div>
        <div className="live-actions">
          <ActionButton
            icon="$(book)"
            label="Teach symbol at cursor"
            shortcut="Cmd+K T"
            command="protege.teachThis"
          />
          <ActionButton
            icon="$(search)"
            label="Explain selection"
            shortcut="Cmd+K E"
            command="protege.explainSelection"
          />
          <ActionButton
            icon="$(warning)"
            label="Show weak spots"
            shortcut="Cmd+K W"
            command="protege.weakSpots"
          />
          <ActionButton
            icon="$(beaker)"
            label="Quiz me"
            shortcut="Cmd+K Q"
            command="protege.quizMe"
          />
          <ActionButton
            icon="$(file)"
            label="Summarize this file"
            command="protege.summarizeFile"
          />
        </div>
      </div>

      {/* ---- Keyboard shortcuts ---- */}
      <div className="live-section">
        <div className="live-section-label microcaps">Keyboard Shortcuts</div>
        <div className="live-shortcuts">
          <ShortcutRow keys="Cmd+K T" action="Teach symbol at cursor" />
          <ShortcutRow keys="Cmd+K E" action="Explain selected code" />
          <ShortcutRow keys="Cmd+K W" action="Show weak spots" />
          <ShortcutRow keys="Cmd+K Q" action="Quiz me on this file" />
          <ShortcutRow keys="Cmd+Shift+L" action="Toggle Protege panel" />
        </div>
      </div>

      <div className="live-footer microcaps">
        Protege JARVIS · all features work without the chat panel
      </div>
    </div>
  );
}

function ControlRow({
  icon,
  label,
  description,
  active,
  onToggle,
}: {
  icon: string;
  label: string;
  description: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`live-control-row ${active ? "active" : ""}`}>
      <div className="live-control-info">
        <div className="live-control-label">{label}</div>
        <div className="live-control-desc">{description}</div>
      </div>
      <button
        className={`live-toggle ${active ? "on" : ""}`}
        onClick={onToggle}
        aria-pressed={active}
      >
        <span className="live-toggle-thumb" />
      </button>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  shortcut,
  command,
  onClick,
}: {
  icon: string;
  label: string;
  shortcut?: string;
  command?: string;
  onClick?: () => void;
}) {
  const handleClick = () => {
    if (onClick) {
      onClick();
    }
    // We can't directly call vscode.commands from webview,
    // but we can send a message to the host to execute it
    if (command) {
      vscode.postMessage({ type: "openExternal", url: `command:${command}` });
    }
  };

  return (
    <button className="live-action-btn" onClick={handleClick}>
      <span className="live-action-label">{label}</span>
      {shortcut && <span className="live-action-shortcut microcaps">{shortcut}</span>}
    </button>
  );
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="live-shortcut-row">
      <kbd className="live-kbd">{keys}</kbd>
      <span className="live-shortcut-action">{action}</span>
    </div>
  );
}

function AiOption({
  id,
  label,
  description,
  active,
  onClick,
  badge,
}: {
  id: string;
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      className={`live-ai-option ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <div className="live-ai-radio">
        <div className={`live-ai-dot ${active ? "on" : ""}`} />
      </div>
      <div className="live-ai-info">
        <div className="live-ai-label">{label}</div>
        <div className="live-ai-desc">{description}</div>
      </div>
      {badge && (
        <span className={`live-ai-badge ${badge === "ready" ? "badge-ready" : badge === "downloading" ? "badge-loading" : ""}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

function formatAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
