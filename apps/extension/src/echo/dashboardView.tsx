import React from "react";
import type {
  ConceptKnownStatus,
  DashboardResponse,
  EchoWindow,
} from "@protege/types";
import { Hero } from "./widgets/Hero.js";
// PolarClock ("When you code") retired 2026-04-23 — the empty-state
// caption ("Keep Going · Code a few sessions to find your rhythm")
// dominated the panel for new users and the radial chart felt out
// of place next to the rest of the (rectangular) dashboard. File
// kept on disk if we ever want to revive it.
// import { PolarClock } from "./widgets/PolarClock.js";
import { MonthlyHeatmap } from "./widgets/MonthlyHeatmap.js";
import { IndependenceTrend } from "./widgets/IndependenceTrend.js";
import { ConceptsCovered } from "./widgets/ConceptsCovered.js";
import { RepoConcepts } from "./widgets/RepoConcepts.js";
import type { LiveScanState } from "./widgets/RepoConcepts.js";
import { ConceptsMomentum } from "./widgets/ConceptsMomentum.js";
import { LinesWritten } from "./widgets/LinesWritten.js";
// LineThatWontDie retired 2026-04-28 — the rewrite-counter widget felt
// like nagging more than insight ("rewritten 7× this window"). Kept
// on disk in case the rewrite-rate metric resurfaces in another form.
// import { LineThatWontDie } from "./widgets/LineThatWontDie.js";
import { CommitStories } from "./widgets/CommitStories.js";
// SaveTape (Recent saves) retired 2026-04-28 — the timeline of
// individual save events was high-volume / low-signal noise next to
// the higher-level Lines/Commits widgets. Widget file kept on disk in
// case it comes back as a drill-down.
// import { SaveTape } from "./widgets/SaveTape.js";
// StoryModeButton retired 2026-04-23 — the "Coming soon" placeholder
// card was just clutter on the dashboard. Widget file kept on disk
// in case Story Mode actually ships, but not rendered anywhere now.
// import { StoryModeButton } from "./widgets/StoryModeButton.js";

export interface DashboardViewProps {
  window: EchoWindow;
  data: DashboardResponse | null;
  loading: boolean;
  error: string | null;
  liveScan: LiveScanState | null;
  /** Unsaved concept-status edits keyed by concept name. Widgets merge
   *  these over each tile's `status` at render time so pills update
   *  optimistically without the dashboard reshuffling between clicks. */
  pendingStatus?: Record<string, ConceptKnownStatus>;
  onWindowChange: (window: EchoWindow) => void;
  onOpenStory: () => void;
  onToggleNotify: (enabled: boolean) => void;
  onOpenMoment: (file: string, line?: number, ts?: number) => void;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
  /** Commit every buffered mastery edit in one RPC. Host POSTs each and
   *  refetches the dashboard exactly once when the whole batch lands. */
  onSaveConceptStatuses?: () => void;
  /** Drop all buffered edits without committing. */
  onDiscardConceptStatuses?: () => void;
  onSetConceptLanguage: (language: string | null) => void;
  onRescanRepo: () => void;
}

const WINDOWS: EchoWindow[] = ["today", "week", "month"];

export function DashboardView({
  window,
  data,
  loading,
  error,
  liveScan,
  pendingStatus,
  onWindowChange,
  onOpenStory,
  onToggleNotify,
  onOpenMoment,
  onSetConceptStatus,
  onSaveConceptStatuses,
  onDiscardConceptStatuses,
  onSetConceptLanguage,
  onRescanRepo,
}: DashboardViewProps): JSX.Element {
  return (
    <div className="echo-dashboard">
      <div className="echo-toolbar">
        <div className="echo-window-picker" role="tablist">
          {WINDOWS.map((w) => (
            <button
              key={w}
              role="tab"
              className={`echo-window ${window === w ? "active" : ""}`}
              aria-selected={window === w}
              onClick={() => onWindowChange(w)}
            >
              {w[0].toUpperCase() + w.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="echo-error">Echo couldn&rsquo;t load: {error}</div>
      ) : null}

      {data?.historyDays != null ? (
        <div className="echo-history-chip" role="note">
          {data.historyDays === 0
            ? "No tracked activity yet — start coding to fill this in."
            : data.historyDays === 1
              ? "1 day of data so far — charts fill in as you code."
              : `${data.historyDays} days of data so far — charts fill in as you code.`}
        </div>
      ) : null}

      <div className="echo-grid">
        <Hero data={data?.hero ?? null} loading={loading} />

        <ConceptsCovered
          data={data?.conceptsCovered ?? null}
          loading={loading}
          pendingStatus={pendingStatus}
          onSetConceptStatus={onSetConceptStatus}
          onSaveConceptStatuses={onSaveConceptStatuses}
          onDiscardConceptStatuses={onDiscardConceptStatuses}
          onSetConceptLanguage={onSetConceptLanguage}
        />

        <RepoConcepts
          data={data?.repoConcepts ?? null}
          loading={loading}
          liveScan={liveScan}
          pendingStatus={pendingStatus}
          onSetConceptStatus={onSetConceptStatus}
          onSaveConceptStatuses={onSaveConceptStatuses}
          onDiscardConceptStatuses={onDiscardConceptStatuses}
          onSetConceptLanguage={onSetConceptLanguage}
          onRescanRepo={onRescanRepo}
        />

        <IndependenceTrend
          data={data?.independence ?? null}
          loading={loading}
        />

        <ConceptsMomentum
          data={data?.conceptsMomentum ?? null}
          loading={loading}
        />

        <MonthlyHeatmap data={data?.heatmap ?? null} loading={loading} />

        <LinesWritten data={data?.lines ?? null} loading={loading} />

        <CommitStories
          data={data?.commits ?? null}
          loading={loading}
          onOpenFile={(file) => onOpenMoment(file)}
        />
      </div>
    </div>
  );
}
