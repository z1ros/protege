import React, { useEffect, useMemo, useRef, useState } from "react";
import { vscode, onHostMessage } from "./vscode.js";
import type { QuotaSnapshot } from "@protege/types";

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

type AiBackend = "on-device" | "cloud" | "auto";

interface LastCall {
  backend: "on-device" | "cloud";
  atMs: number;
  durationMs: number;
  ok: boolean;
  fallback?: {
    requested: "on-device" | "cloud" | "auto";
    reason: string;
  };
}

// "cloud" means "send to backend, let it route." The actual model is
// decided by the backend's env (OPENAI_CHEAP_MODEL for scans, premium
// model for chat/teach). We don't know provider/model here without
// threading that through recordCall, so the label is generic.
const BACKEND_LABEL: Record<LastCall["backend"], string> = {
  "on-device": "Qwen 7B (on-device)",
  cloud: "Cloud (provider configured server-side)",
};

export function LiveTab({
  fileName,
  liveReviewOn,
  onToggleLiveReview,
  modelStatus,
}: Props) {
  const [inlineErrors, setInlineErrors] = useState(true);
  const [didYouKnow, setDidYouKnow] = useState(true);
  // "Teaching Annotations" toggle removed — feature not yet implemented.
  const [aiBackend, setAiBackend] = useState<AiBackend>("auto");
  const [lastCall, setLastCall] = useState<LastCall | null>(null);
  const [now, setNow] = useState(Date.now());
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  // Subscribe to host pushes for backend state + live call events so the
  // Live tab (a) hydrates on mount from persisted globalState and (b)
  // reflects every aiQuery() call as it happens.
  useEffect(() => {
    // Migration shim — two layers:
    //   1. Legacy values "haiku" / "sonnet" → "cloud" (kept so the
    //      LastCall chip can still render "this turn ran on cloud"
    //      truthfully when a server-routed Haiku call comes back).
    //   2. The visible AiBackend selector is temporarily restricted to
    //      "auto" only (cloud option hidden per 2026-04-30 user
    //      request). Coerce any persisted "cloud" / legacy value to
    //      "auto" before it reaches React state — otherwise the panel
    //      would show no active option since the Cloud card no longer
    //      renders.
    const migrateBackend = (
      b: "on-device" | "cloud" | "auto" | "haiku" | "sonnet"
    ): AiBackend => {
      if (b === "haiku" || b === "sonnet" || b === "cloud") return "auto";
      return b;
    };
    const migrateActual = (
      b: "on-device" | "cloud" | "haiku" | "sonnet"
    ): LastCall["backend"] => (b === "haiku" || b === "sonnet" ? "cloud" : b);

    const off = onHostMessage((msg) => {
      if (msg.type === "ai/backend") {
        const migrated = migrateBackend(msg.backend);
        setAiBackend(migrated);
        // If the host sent us a value we no longer surface (cloud /
        // haiku / sonnet), persist the migrated "auto" back so the
        // next mount doesn't have to migrate again. One-shot fix-up
        // per user the first time they open Live after the picker
        // simplification ships.
        if (msg.backend !== migrated) {
          vscode.postMessage({ type: "ai/setBackend", backend: migrated });
        }
      } else if (msg.type === "ai/lastCall") {
        setLastCall({
          backend: migrateActual(msg.backend),
          atMs: msg.atMs,
          durationMs: msg.durationMs,
          ok: msg.ok,
          fallback: msg.fallback
            ? {
                requested: migrateBackend(msg.fallback.requested),
                reason: msg.fallback.reason,
              }
            : undefined,
        });
      } else if (msg.type === "ai/lastCallCleared") {
        // User switched backend — drop the stale chip from the prior
        // backend so the UI doesn't keep showing "last call: Sonnet"
        // after the user picked On-Device.
        setLastCall(null);
      } else if (msg.type === "quota/snapshot") {
        // Today's per-route usage + cost. Push-driven from the host so
        // the panel updates after every quota-gated call without us
        // having to poll.
        setQuota(msg.snapshot);
      }
    });
    // Actively re-request the backend on mount. The host posts ai/backend
    // once on the webview's `ready` event — but if THIS tab mounts later
    // (the user opened Chat first, then switched to Live), that message
    // already fired and was lost. Without this re-request the React
    // state stays at the useState default ("auto") forever, which makes
    // the UI lie: it shows Smart Mix highlighted even when the persisted
    // value is "cloud", and clicking Smart Mix again is a no-op for
    // React state so no setBackend message goes out and the value never
    // actually persists.
    vscode.postMessage({ type: "ai/getBackend" });
    // Also request the quota snapshot so the "Today's usage" panel
    // hydrates on mount. Host listener will push fresh snapshots after
    // any subsequent quota-gated call.
    vscode.postMessage({ type: "quota/get" });
    return off;
  }, []);

  // Refresh quota every 60s while the Live tab is mounted. Cheap GET
  // backed by a 30s server-side cache window. Belt-and-suspenders for
  // 429 cases where the user wants to confirm the panel matches reality.
  useEffect(() => {
    const id = setInterval(() => {
      vscode.postMessage({ type: "quota/get" });
    }, 60_000);
    return () => clearInterval(id);
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

  // Auto-prefetch the on-device model when the Live tab opens. Now that
  // the engine selector hides Cloud, every user is on Smart Mix —
  // which uses Qwen 7B for live scans. Without an explicit "On-Device"
  // click users used to be the trigger, the download never fires and
  // the first scan stalls until the user notices and clicks something.
  // Kicking it off on mount means the model is downloaded and warmed
  // up the first time someone visits Live, so by the time they actually
  // type code the scan engine is ready.
  //
  // The `ai/downloadModel` host handler routes through
  // `initOnDeviceModel`, which is fully idempotent (no-ops if already
  // loading or already ready). So firing this whenever modelStatus
  // changes is safe — the host self-deduplicates.
  //
  // A ref guards against re-firing during the same mount even if the
  // status flips back and forth (e.g. a transient error then retry).
  const autoDownloadDispatchedRef = useRef(false);
  useEffect(() => {
    if (autoDownloadDispatchedRef.current) return;
    if (modelReady) return; // already loaded — nothing to do
    if (modelDownloading) return; // already in flight — host pushes progress
    if (modelError) return; // surfaced via the retry UI; don't auto-loop
    autoDownloadDispatchedRef.current = true;
    vscode.postMessage({ type: "ai/downloadModel" });
  }, [modelReady, modelDownloading, modelError]);

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

        {/* AI engine selector temporarily simplified to a single option
            (2026-04-30, user request): "remove cloud at all so it will
            be always mix". Hides:
              - the Max Plan Qwen↔Cloud quick switch
              - the standalone "On-Device" choice
              - the standalone "Cloud" choice
            Smart Mix stays as the only visible card and acts as a
            status indicator. The "auto" backend internally still uses
            on-device for cheap scans + cloud for premium refines, so
            no inference path is broken — the user just isn't asked to
            pick. To restore the full picker, revert this block.

            Migration: any user whose persisted preference was "cloud"
            (or legacy "haiku"/"sonnet") is coerced to "auto" in the
            useEffect above, so reopening the panel doesn't show an
            invalid selection. */}
        <div className="live-ai-selector">
          <AiOption
            id="auto"
            label="Smart Mix"
            description="Qwen 7B for live scans · cloud only when there's signal worth refining"
            active
            onClick={() => handleBackendChange("auto")}
            badge="active"
          />
        </div>
        {modelDownloading && !modelReady && (
          <div className="live-download-bar">
            <div className="live-download-label microcaps">
              {downloadProgress >= 100
                ? "Loading model…"
                : `Downloading Qwen 7B… ${downloadProgress}%`}
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
        {/* Manage on-device model — visible when model is loaded so the
            user can reclaim disk space. Removing falls back to cloud
            (Haiku) automatically; Live Review keeps working. */}
        {modelReady && (
          <div
            className="live-download-bar"
            style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}
          >
            <div
              className="live-download-label microcaps"
              style={{ flex: 1, color: "var(--vscode-descriptionForeground)" }}
            >
              On-device model loaded · ~4.7 GB on disk
            </div>
            <button
              className="live-action-btn"
              onClick={() => vscode.postMessage({ type: "ai/removeModel" })}
              title="Remove the cached Qwen 7B file. Live Review will route to cloud (Haiku) until you re-download."
            >
              <span className="live-action-label">Remove model</span>
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
            <span
              className="live-lastcall-ago"
              title={`exact: ${formatAbsTime(lastCall.atMs)}`}
            >
              {formatAgo(now - lastCall.atMs)}
            </span>
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

      {/* ---- Today's usage ---- */}
      <QuotaPanel quota={quota} now={now} />

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
  // Show minute+second for the first 5 minutes so the user can SEE
  // the timestamp ticking — formerly just "Xm ago", which froze for
  // 60s at a time and felt stuck (user reported "didn't update for
  // 25m ago"). The interval still ticks every 3s; this just gives
  // the rendered string sub-minute resolution to match.
  if (m < 5) {
    const remS = s - m * 60;
    return remS === 0 ? `${m}m ago` : `${m}m ${remS}s ago`;
  }
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  return remM === 0 ? `${h}h ago` : `${h}h ${remM}m ago`;
}

/** Absolute clock time of the last call — shown in the tooltip so the
 *  user can sanity-check a stale-feeling relative timestamp. */
function formatAbsTime(atMs: number): string {
  const d = new Date(atMs);
  return d.toLocaleTimeString();
}

/* ==========================================================
   Today's usage — quota panel.

   Shows the user where they stand against the daily caps so they
   can self-regulate before they hit a 429. Six route bars + a $
   pill, with a "resets in N" microcaps line. Renders even when
   the snapshot is null (placeholder zeros) so the panel doesn't
   pop in/out as the host fetches.
   ========================================================== */

interface QuotaPanelProps {
  quota: QuotaSnapshot | null;
  now: number;
}

const QUOTA_ROW_LABELS: Array<{
  key: keyof QuotaSnapshot["usage"];
  label: string;
  hint: string;
  unit?: string;
}> = [
  {
    key: "chat_messages",
    label: "Chat messages",
    hint: "Premium /chat turns — counts each message you send to Protege.",
  },
  {
    key: "tool_calls",
    label: "Tool calls",
    hint: "Each time the model uses a tool (read_file, edit_file, grep…) inside chat.",
  },
  {
    key: "voice_minutes",
    label: "Voice minutes",
    hint: "Combined text-to-speech + speech-to-text time.",
    unit: "min",
  },
];

function QuotaPanel({ quota, now }: QuotaPanelProps) {
  const resetIn = useMemo(() => {
    if (!quota) return "—";
    const ms = Math.max(0, quota.resetAt - now);
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }, [quota, now]);

  const cost = quota?.usage.cost;
  const costPct = cost && cost.limitUsd > 0 ? Math.min(100, (cost.used / cost.limitUsd) * 100) : 0;

  return (
    <div className="live-section">
      <div className="live-section-label microcaps">
        Today's usage{quota ? ` · resets in ${resetIn}` : ""}
      </div>

      <div className="quota-rows">
        {QUOTA_ROW_LABELS.map(({ key, label, hint, unit }) => {
          const cell = quota?.usage[key] as { used: number; limit: number } | undefined;
          const used = cell?.used ?? 0;
          const limit = cell?.limit ?? 0;
          const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
          const isFull = limit > 0 && used >= limit;
          const isWarn = !isFull && pct >= 80;
          const cls = `quota-row${isFull ? " quota-row-full" : isWarn ? " quota-row-warn" : ""}`;
          // Voice minutes are fractional (e.g. 6.4) — render with one
          // decimal. Counts are integers — render plain. The unit
          // suffix only renders for voice ("min").
          const usedDisplay =
            unit === "min" ? used.toFixed(1) : Math.floor(used).toString();
          const unitSuffix = unit ? ` ${unit}` : "";
          return (
            <div key={key} className={cls} title={hint}>
              <div className="quota-row-head">
                <span className="quota-row-label">{label}</span>
                <span className="quota-row-counts">
                  {usedDisplay}
                  <span className="quota-row-counts-sep"> / </span>
                  {limit || "—"}{unitSuffix}
                </span>
              </div>
              <div className="quota-row-bar-track">
                <div
                  className="quota-row-bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {cost && (
        <div
          className={`quota-cost-row${cost.used >= cost.limitUsd ? " quota-cost-row-full" : ""}`}
          title="Estimated $ spent today (token-derived). Soft signal, not a billing source of truth."
        >
          <span className="quota-cost-label microcaps">Estimated $ today</span>
          <span className="quota-cost-pill">
            ${cost.used.toFixed(3)}
            <span className="quota-cost-pill-sep"> / </span>${cost.limitUsd.toFixed(2)}
          </span>
          <div className="quota-cost-bar-track">
            <div className="quota-cost-bar-fill" style={{ width: `${costPct}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
