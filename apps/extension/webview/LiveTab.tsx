import React, { useEffect, useMemo, useState } from "react";
import { vscode, onHostMessage } from "./vscode.js";
import type { QuotaSnapshot } from "@protege/types";

/**
 * Live Tab — JARVIS mission control.
 *
 * Shows toggles for all JARVIS features, current file analysis,
 * and quick actions. The user controls what appears in their editor
 * from this single panel.
 */

interface Props {
  fileName: string | null;
  liveReviewOn: boolean;
  onToggleLiveReview: () => void;
}

interface LastCall {
  backend: "cloud";
  atMs: number;
  durationMs: number;
  ok: boolean;
  fallback?: {
    requested: "cloud";
    reason: string;
  };
}

// The actual model is decided by the backend's env (OPENAI_CHEAP_MODEL
// for scans, premium model for chat/teach).
const CLOUD_LABEL = "Cloud (provider configured server-side)";

export function LiveTab({
  fileName,
  liveReviewOn,
  onToggleLiveReview,
}: Props) {
  const [inlineErrors, setInlineErrors] = useState(true);
  const [didYouKnow, setDidYouKnow] = useState(true);
  const [lastCall, setLastCall] = useState<LastCall | null>(null);
  const [now, setNow] = useState(Date.now());
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  // Subscribe to host pushes for live call events + quota snapshots.
  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "ai/lastCall") {
        // Any non-cloud legacy backend value (haiku/sonnet/on-device)
        // collapses to "cloud" — only one path runs now.
        setLastCall({
          backend: "cloud",
          atMs: msg.atMs,
          durationMs: msg.durationMs,
          ok: msg.ok,
          fallback: msg.fallback
            ? { requested: "cloud", reason: msg.fallback.reason }
            : undefined,
        });
      } else if (msg.type === "ai/lastCallCleared") {
        setLastCall(null);
      } else if (msg.type === "quota/snapshot") {
        setQuota(msg.snapshot);
      }
    });
    vscode.postMessage({ type: "quota/get" });
    return off;
  }, []);

  // Refresh quota every 60s while the Live tab is mounted.
  useEffect(() => {
    const id = setInterval(() => {
      vscode.postMessage({ type: "quota/get" });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Keep the "X seconds ago" text fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);

  const shortName = fileName
    ? fileName.split(/[\\/]/).pop() ?? fileName
    : null;

  return (
    <div className="live-tab">
      {/* ---- Last call chip — proves the cloud round-trip just ran ---- */}
      {lastCall && (
        <div className="live-section">
          <div
            className={`live-lastcall cloud ${lastCall.ok ? "" : "failed"} ${lastCall.fallback ? "fallback" : ""}`}
            title={`Last aiQuery() routed to ${CLOUD_LABEL}`}
          >
            <span className="live-lastcall-dot" />
            <span className="live-lastcall-label microcaps">Last call</span>
            <span className="live-lastcall-backend">{CLOUD_LABEL}</span>
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
        </div>
      )}

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

/** Compact format for big token counts. 1234 → "1.2k", 1234567 → "1.2M".
 *  Used by the Tokens row in the usage panel — raw numbers like
 *  "1,234,567 / 2,000,000" are unreadable; "1.2M / 2M" is glanceable.
 *
 *  Defensive: coerces non-finite inputs (undefined, NaN, null) to 0.
 *  Without this guard a stale backend that didn't run migration 005
 *  could send `tokens.used = undefined` and the UI would render
 *  "NaNM / 2M" — exactly what happened on first deploy 2026-05-02. */
function formatTokens(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

// All per-route quota rows (chat_messages, voice_minutes, tool_calls)
// removed 2026-05-02 in favor of one unified Tokens row. The token
// budget is the single user-facing limit — same number drives display
// AND enforcement. Server still tracks chat_messages / voice_minutes /
// tool_calls / total_usd_estimate in user_quotas for analytics.
const QUOTA_ROW_LABELS: Array<{
  key: keyof QuotaSnapshot["usage"];
  label: string;
  hint: string;
  unit?: string;
}> = [];

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

  // cost / costPct removed 2026-05-02 — the $ row was replaced by the
  // Tokens row, calibrated to the same $3/day budget. Backend keeps
  // total_usd_estimate for analytics; not user-facing anymore.

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
        {/* Token row — added 2026-05-02. The user-facing daily budget,
            replacing the old "Estimated $ today" row. Limit is
            calibrated against the backend's $/day cap so when the bar
            fills, you've used your daily allotment. Compact format
            (k/M) since the numbers are big. Older backends without
            migration 005 return undefined — we just don't render. */}
        {quota?.usage.tokens && (() => {
          const t = quota.usage.tokens;
          const pct = t.limit > 0 ? Math.min(100, (t.used / t.limit) * 100) : 0;
          const isFull = t.limit > 0 && t.used >= t.limit;
          const isWarn = !isFull && pct >= 80;
          const cls = `quota-row${isFull ? " quota-row-full" : isWarn ? " quota-row-warn" : ""}`;
          return (
            <div
              className={cls}
              title={`Daily token budget across all LLM calls. Resets at 00:00 UTC. Input: ${formatTokens(t.prompt)} · Output: ${formatTokens(t.completion)}.`}
            >
              <div className="quota-row-head">
                <span className="quota-row-label">Tokens used</span>
                <span className="quota-row-counts">
                  {formatTokens(t.used)}
                  <span className="quota-row-counts-sep"> / </span>
                  {formatTokens(t.limit)}
                </span>
              </div>
              <div className="quota-row-bar-track">
                <div className="quota-row-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })()}
      </div>

      {/* "Estimated $ today" row removed 2026-05-02 — replaced by the
          Tokens row above (limit calibrated to ~$3/day). Backend still
          tracks total_usd_estimate in Supabase for analytics, just not
          surfaced to users (tokens are the user-facing budget). */}
    </div>
  );
}
