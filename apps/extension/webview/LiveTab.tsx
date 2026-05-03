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

/* ==========================================================
   Advanced surface catalog — every Protege editor surface in
   one inventory. Read-only for now; the `?` tooltip explains
   each surface in plain English. Future: wire `featureFlag` to
   the existing `gated()` plumbing so each row can be toggled.
   Stays inline in this file (vs. its own module) so the diff
   for adding/removing surfaces is one edit.
   Internal-only — gated on `MeResponse.internal` server-side.
   ========================================================== */

type SurfaceCategory =
  | "CodeLens"
  | "Inline decoration"
  | "Hover action"
  | "Save-time check"
  | "Live Review"
  | "Hint"
  | "Watcher trigger"
  | "Teaching surface"
  | "Auto-suggestion"
  | "Status bar"
  | "Voice"
  | "Other";

interface AdvancedSurface {
  id: string;
  label: string;
  category: SurfaceCategory;
  description: string;
  sourceFile: string;
  featureFlag?: string;
  status: "active" | "paused" | "experimental";
}

const SURFACE_CATEGORY_ORDER: SurfaceCategory[] = [
  "CodeLens",
  "Inline decoration",
  "Hover action",
  "Save-time check",
  "Live Review",
  "Hint",
  "Watcher trigger",
  "Teaching surface",
  "Auto-suggestion",
  "Status bar",
  "Voice",
  "Other",
];

const ADVANCED_SURFACES: AdvancedSurface[] = [
  { id: "highlight-codelens", label: "Highlight CodeLens", category: "CodeLens",
    description: "Renders 'Apply fix · Teach me · Dismiss' actions above lines the AI highlights during chat conversations.",
    sourceFile: "apps/extension/src/ai/tools.ts", status: "active" },
  { id: "didyouknow-codelens", label: "Did You Know CodeLens", category: "CodeLens",
    description: "Shows teaching tip preview above lines with new concepts, triggered at natural pauses (idle, file switch, save).",
    sourceFile: "apps/extension/src/hints/didYouKnow.ts", featureFlag: "teaching.didYouKnow", status: "active" },
  { id: "ghost-mentor-codelens", label: "Ghost Mentor Lens", category: "CodeLens",
    description: "Floating AI coaching lens above the cursor line when a high-confidence teachable moment is detected (800ms debounce).",
    sourceFile: "apps/extension/src/hints/ghostMentor.ts", featureFlag: "teaching.ghostMentor", status: "active" },
  { id: "struggle-chip-codelens", label: "Struggle Chip Lens", category: "CodeLens",
    description: "Shows 'Stuck here? Hint' above lines where friction is detected; click fetches a 2-sentence hint tailored to the code.",
    sourceFile: "apps/extension/src/hints/struggleChip.ts", featureFlag: "teaching.struggleChip", status: "active" },
  { id: "aiblocks-codelens", label: "AI Block Lens", category: "CodeLens",
    description: "Marks unreviewed auto-inserted code blocks with 'AI block · N lines · Teach me this block' action above the region.",
    sourceFile: "apps/extension/src/hints/aiBlocks.ts", featureFlag: "aiBlocks.enabled", status: "active" },

  { id: "underline-whisper", label: "Underline Whisper", category: "Inline decoration",
    description: "Thin Protege-blue underline on teachable tokens; hover reveals a one-line tip, 'Learn' opens inline peek.",
    sourceFile: "apps/extension/src/hints/underlineWhisper.ts", featureFlag: "codeReview.underlineWhispers", status: "active" },
  { id: "error-line-highlight", label: "Error Line Highlight", category: "Inline decoration",
    description: "Subtle white background wash on any line containing a diagnostic (TypeScript, ESLint, or Protege).",
    sourceFile: "apps/extension/src/review/errorLineHighlight.ts", featureFlag: "codeReview.errorLineHighlight", status: "active" },
  { id: "aiblock-wash", label: "AI Block Wash", category: "Inline decoration",
    description: "Subtle blue line background + left-edge stripe on unreviewed auto-inserted code regions.",
    sourceFile: "apps/extension/src/hints/aiBlocks.ts", featureFlag: "aiBlocks.enabled", status: "active" },
  { id: "misconception-flag", label: "Misconception Flag", category: "Inline decoration",
    description: "Amber-bordered line decoration on code matching specific wrong mental models (e.g., await in .map, .sort mutation).",
    sourceFile: "apps/extension/src/concepts/misconceptions.ts", featureFlag: "misconceptions.enabled", status: "active" },
  { id: "concept-trail-dot", label: "Concept Trail Dot", category: "Inline decoration",
    description: "Blue gutter dot on the first line where a new concept appears in the current session.",
    sourceFile: "apps/extension/src/concepts/conceptTrail.ts", featureFlag: "recap.conceptTrail", status: "active" },
  { id: "teaching-highlight", label: "Teaching Highlight", category: "Inline decoration",
    description: "Background highlight on code lines the AI points at during active lessons.",
    sourceFile: "apps/extension/src/ai/tools.ts", status: "active" },

  { id: "whisper-hover", label: "Whisper Hover", category: "Hover action",
    description: "Hover tooltip on Underline Whisper tokens showing a one-line tip with 'Learn' link to full teaching.",
    sourceFile: "apps/extension/src/hints/underlineWhisper.ts", featureFlag: "codeReview.underlineWhispers", status: "active" },
  { id: "ghost-mentor-hover", label: "Ghost Mentor Peek", category: "Hover action",
    description: "Inline peek decoration when clicking the Ghost Mentor lens headline, showing full teaching content.",
    sourceFile: "apps/extension/src/hints/ghostMentor.ts", featureFlag: "teaching.ghostMentor", status: "active" },
  { id: "misconception-hover", label: "Misconception Hover", category: "Hover action",
    description: "Hover on amber-flagged lines showing the wrong belief, correct mental model, and Quiz/Show fix/Dismiss actions.",
    sourceFile: "apps/extension/src/concepts/misconceptions.ts", featureFlag: "misconceptions.enabled", status: "active" },
  { id: "concept-trail-hover", label: "Concept Trail Hover", category: "Hover action",
    description: "Markdown card popup on blue gutter dots showing concept name and 'Learn more' link.",
    sourceFile: "apps/extension/src/concepts/conceptTrail.ts", featureFlag: "recap.conceptTrail", status: "active" },
  { id: "struggle-chip-hover", label: "Struggle Chip Hint", category: "Hover action",
    description: "Inline hover showing a 2-sentence AI-generated hint specific to the detected friction and code context.",
    sourceFile: "apps/extension/src/hints/struggleChip.ts", featureFlag: "teaching.struggleChip", status: "active" },

  { id: "live-review-analyzer", label: "Live Review Scan", category: "Save-time check",
    description: "Real-time analyzer firing 3 seconds after typing stops, detecting defects and surfacing them as blue underlines.",
    sourceFile: "apps/extension/src/review/liveReview.ts", featureFlag: "codeReview.liveReview", status: "active" },
  { id: "save-recap-toast", label: "Save Recap Toast", category: "Save-time check",
    description: "Brief 4-second status-bar toast summarizing concepts newly detected in a file after save.",
    sourceFile: "apps/extension/src/detection/saveRecap.ts", featureFlag: "recap.saveRecap", status: "active" },
  { id: "finding-diagnostics", label: "Finding Diagnostics", category: "Save-time check",
    description: "Native VS Code diagnostics collection for Live Review findings, making them appear in the Problems panel.",
    sourceFile: "apps/extension/src/review/findingDiagnostics.ts", featureFlag: "codeReview.liveReview", status: "active" },

  { id: "live-review-underline", label: "Live Review Underline", category: "Live Review",
    description: "Blue underline under code identified as problematic by the continuous analyzer.",
    sourceFile: "apps/extension/src/review/liveReview.ts", featureFlag: "codeReview.liveReview", status: "active" },
  { id: "live-review-hover", label: "Live Review Hover", category: "Live Review",
    description: "Rich hover popup on a finding showing issue description, reason, and Apply fix / Teach me / Dismiss buttons.",
    sourceFile: "apps/extension/src/review/liveReview.ts", featureFlag: "codeReview.liveReview", status: "active" },

  { id: "didyouknow-tip", label: "Did You Know Tip", category: "Hint",
    description: "MarkdownString popover revealing full concept tip text with 'Learn more' and 'Dismiss' actions.",
    sourceFile: "apps/extension/src/hints/didYouKnow.ts", featureFlag: "teaching.didYouKnow", status: "active" },

  { id: "error-persists", label: "Error Persists", category: "Watcher trigger",
    description: "Nudge fired when an error has been present on the same line for over 10 seconds without being nudged in the last 60s.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "struggle-cluster", label: "Struggle Cluster", category: "Watcher trigger",
    description: "Nudge detected when the user performs 5+ undo actions within a 20-second window.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "stare-pause", label: "Stare Pause", category: "Watcher trigger",
    description: "Nudge when the cursor has not moved for 90+ seconds on a file with errors or substantial content.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "build-fail-loop", label: "Build Fail Loop", category: "Watcher trigger",
    description: "Nudge triggered after 3+ consecutive file saves that each contained errors.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "flow-detected", label: "Flow Detected", category: "Watcher trigger",
    description: "Positive nudge fired when 5+ clean (error-free) saves occur within a 3-minute window.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "late-night-marathon", label: "Late Night Marathon", category: "Watcher trigger",
    description: "Nudge after 11 PM if the user has made 20+ saves over 90+ minutes, encouraging a break.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "win-detected", label: "Win Detected", category: "Watcher trigger",
    description: "Event-driven nudge fired when an error is cleared or a test passes.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "concept-breakthrough", label: "Concept Breakthrough", category: "Watcher trigger",
    description: "Event-driven nudge fired when the user demonstrates mastery of a new concept.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "risky-edit", label: "Risky Edit", category: "Watcher trigger",
    description: "Event-driven nudge flagging auto-inserted code that may contain risky patterns.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },
  { id: "commit-risk", label: "Commit Risk", category: "Watcher trigger",
    description: "Event-driven nudge triggered when risky patterns are detected before a git commit.",
    sourceFile: "apps/extension/src/watcher/triggers.ts", status: "active" },

  { id: "teaching-thread", label: "Teaching Thread", category: "Teaching surface",
    description: "Coordinator that parks the cursor on a finding, plays voice narration, and surfaces Ghost Mentor actions.",
    sourceFile: "apps/extension/src/teaching/teachingThread.ts", status: "active" },
  { id: "teach-popup", label: "Teaching Popup", category: "Teaching surface",
    description: "Temporary hover anchor showing explanation when a teach reply arrives, with 'Teach me more' and 'Got it' buttons.",
    sourceFile: "apps/extension/src/teaching/teachPopup.ts", status: "active" },
  { id: "teaching-flow", label: "Teaching Flow", category: "Teaching surface",
    description: "Multi-step guided lesson delivering concept understanding through sequential chat messages, code highlights, and practice.",
    sourceFile: "apps/extension/src/teaching/teachingFlow.ts", status: "active" },
  { id: "explain-back", label: "Explain Back", category: "Teaching surface",
    description: "Reverse teaching session where the user explains selected code and Protege grades responses in rounds.",
    sourceFile: "apps/extension/src/teaching/explainBack.ts", status: "active" },
  { id: "architecture-tour", label: "Architecture Tour", category: "Teaching surface",
    description: "Guided 5-stop walk through the codebase with narration, file opens, and focal line highlights.",
    sourceFile: "apps/extension/src/teaching/architectureTour.ts", status: "active" },
  { id: "learning-mode", label: "Learning Mode", category: "Teaching surface",
    description: "Interactive mode where the user sets a goal, receives a step-by-step plan, and builds each step while Protege validates progress.",
    sourceFile: "apps/extension/src/teaching/learningMode.ts", featureFlag: "learning.enabled", status: "active" },
  { id: "exercise-engine", label: "Exercise Engine", category: "Teaching surface",
    description: "Practice environment with challenge description, starter code, and real-time validation feedback as the user codes.",
    sourceFile: "apps/extension/src/teaching/exerciseEngine.ts", status: "active" },

  { id: "highlight-code-tool", label: "Highlight Code Tool", category: "Auto-suggestion",
    description: "AI tool that paints line backgrounds during chat; triggered by Claude to draw attention to specific code.",
    sourceFile: "apps/extension/src/ai/tools.ts", status: "active" },
  { id: "show-code-tool", label: "Show Code Tool", category: "Auto-suggestion",
    description: "AI tool that flashes selected code regions to highlight during teaching moments.",
    sourceFile: "apps/extension/src/ai/tools.ts", status: "active" },

  { id: "status-bar-live", label: "Status Bar Live", category: "Status bar",
    description: "Right-aligned status bar item showing the Protege shield icon and streak count; click opens a quick-pick menu.",
    sourceFile: "apps/extension/src/review/statusBarLive.ts", featureFlag: "codeReview.statusBar", status: "active" },
  { id: "concept-at-cursor", label: "Concept at Cursor", category: "Status bar",
    description: "Right-aligned status bar item showing the concept on the current line and mastery percentage.",
    sourceFile: "apps/extension/src/review/statusBarLive.ts", featureFlag: "codeReview.statusBar", status: "active" },
  { id: "iq-gain-toast", label: "IQ Gain Toast", category: "Status bar",
    description: "Brief ephemeral toast on file save showing '+X IQ · Concept' when IQ increases.",
    sourceFile: "apps/extension/src/extension.ts", status: "active" },

  { id: "voice-state-chip", label: "Voice State Chip", category: "Voice",
    description: "Always-visible status bar item mirroring wake-listener state (off, idle, listening, thinking, speaking) with click to toggle.",
    sourceFile: "apps/extension/src/voice/voiceStatusBar.ts", status: "active" },
  { id: "wake-word-listener", label: "Wake Word Listener", category: "Voice",
    description: "Always-on ambient listener for the 'Protege' wake word; when detected, opens voice chat mode.",
    sourceFile: "apps/extension/src/voice/voiceCapture.ts", status: "active" },
  { id: "voice-explain-mode", label: "Voice Explain Mode", category: "Voice",
    description: "Text/voice/both toggle for the Ghost Mentor 'Explain' button; voice mode speaks the explanation instead of opening chat.",
    sourceFile: "apps/extension/src/extension.ts", status: "active" },

  { id: "selection-hover", label: "Selection Hover Popup", category: "Other",
    description: "Floating popup on code selection with Explain / Teach me / Why; also triggered by Cmd+K S.",
    sourceFile: "apps/extension/src/hints/selectionHover.ts", featureFlag: "selectionHover.enabled", status: "active" },
  { id: "predict-and-reveal", label: "Predict and Reveal", category: "Other",
    description: "Learning quiz mechanic where the user predicts code behavior, then reveals the answer with one-line reason.",
    sourceFile: "apps/extension/src/detection/predict.ts", featureFlag: "predict.enabled", status: "active" },
  { id: "inset-preview", label: "Inset Preview", category: "Other",
    description: "Experimental webview inset card between code lines showing finding details; opt-in via command palette.",
    sourceFile: "apps/extension/src/hints/insetExperiment.ts", status: "experimental" },
  { id: "ownership-inviter-chip", label: "Ownership Inviter Chip", category: "Other",
    description: "Status-bar nudge at natural breaks (post-save, post-commit, end-of-day) offering to review auto-inserted code.",
    sourceFile: "apps/extension/src/user/ownershipInviter.ts", status: "active" },
  { id: "smart-fix", label: "Smart Fix", category: "Other",
    description: "Routes a 'Fix' button click through the chat pipeline; Claude reads context and applies fixes with full tool access.",
    sourceFile: "apps/extension/src/review/smartFix.ts", featureFlag: "codeReview.smartFix", status: "active" },
];

interface Props {
  fileName: string | null;
  liveReviewOn: boolean;
  /** Server-side internal-team flag from `MeResponse.internal`. Gates the
   *  Advanced surfaces panel and any future dev-only UI. Non-internal
   *  users always receive false; even tampering this prop client-side
   *  reveals nothing of value (the catalog is local data, but other
   *  dev-only panels could hit gated endpoints). */
  internal: boolean;
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
  internal,
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
          {internal && <AdvancedSurfaces />}
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

/* ==========================================================
   Advanced surfaces — collapsible inventory at the bottom of
   Editor Intelligence. Read-only catalog of every surface
   Protege exposes in the editor. Hover the `?` for a plain-
   English description. Toggles will land later by wiring each
   row's `featureFlag` through the existing `gated()` helper.
   ========================================================== */
function AdvancedSurfaces() {
  const [open, setOpen] = useState(false);

  // Group + preserve declared order within each category.
  const grouped = useMemo(() => {
    const map = new Map<SurfaceCategory, AdvancedSurface[]>();
    for (const s of ADVANCED_SURFACES) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return SURFACE_CATEGORY_ORDER
      .filter((c) => map.has(c))
      .map((c) => ({ category: c, surfaces: map.get(c)! }));
  }, []);

  return (
    <div className={`live-advanced ${open ? "open" : ""}`}>
      <button
        className="live-advanced-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg
          className="live-advanced-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <div className="live-advanced-summary">
          <span>Advanced</span>
          <span className="live-advanced-count">
            {ADVANCED_SURFACES.length} surfaces · hover ? for details
          </span>
        </div>
      </button>
      {open && (
        <div className="live-advanced-body">
          {grouped.map(({ category, surfaces }) => (
            <div key={category} className="live-advanced-group">
              <div className="live-advanced-group-label">{category}</div>
              {surfaces.map((s) => (
                <SurfaceRow key={s.id} surface={s} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SurfaceRow({ surface }: { surface: AdvancedSurface }) {
  return (
    <div className="live-advanced-row">
      <span className="live-advanced-row-label">{surface.label}</span>
      {surface.status !== "active" && (
        <span className={`live-advanced-status ${surface.status}`}>
          {surface.status}
        </span>
      )}
      <span
        className="live-advanced-help"
        tabIndex={0}
        role="button"
        aria-label={`What does ${surface.label} do?`}
      >
        ?
        <span className="live-advanced-tooltip" role="tooltip">
          {surface.description}
          <span className="live-advanced-tooltip-source">
            {surface.featureFlag
              ? `protege.${surface.featureFlag} · ${surface.sourceFile}`
              : surface.sourceFile}
          </span>
        </span>
      </span>
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
