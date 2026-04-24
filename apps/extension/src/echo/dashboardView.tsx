import React from "react";
import type {
  ConceptKnownStatus,
  DashboardResponse,
  EchoWindow,
} from "@protege/types";
import { Hero } from "./widgets/Hero.js";
import { PolarClock } from "./widgets/PolarClock.js";
import { MonthlyHeatmap } from "./widgets/MonthlyHeatmap.js";
import { IndependenceTrend } from "./widgets/IndependenceTrend.js";
import { ConceptsCovered } from "./widgets/ConceptsCovered.js";
import { RepoConcepts } from "./widgets/RepoConcepts.js";
import type { LiveScanState } from "./widgets/RepoConcepts.js";
import { ConceptsMomentum } from "./widgets/ConceptsMomentum.js";
import { LinesWritten } from "./widgets/LinesWritten.js";
import { LineThatWontDie } from "./widgets/LineThatWontDie.js";
import { CommitStories } from "./widgets/CommitStories.js";
import { SaveTape } from "./widgets/SaveTape.js";
import { StoryModeButton } from "./widgets/StoryModeButton.js";

export interface DashboardViewProps {
  window: EchoWindow;
  data: DashboardResponse | null;
  loading: boolean;
  error: string | null;
  liveScan: LiveScanState | null;
  onWindowChange: (window: EchoWindow) => void;
  onOpenStory: () => void;
  onToggleNotify: (enabled: boolean) => void;
  onOpenMoment: (file: string, line?: number, ts?: number) => void;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
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
  onWindowChange,
  onOpenStory,
  onToggleNotify,
  onOpenMoment,
  onSetConceptStatus,
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
          onSetConceptStatus={onSetConceptStatus}
          onSetConceptLanguage={onSetConceptLanguage}
        />

        <RepoConcepts
          data={data?.repoConcepts ?? null}
          loading={loading}
          liveScan={liveScan}
          onSetConceptStatus={onSetConceptStatus}
          onSetConceptLanguage={onSetConceptLanguage}
          onRescanRepo={onRescanRepo}
        />

        <div className="echo-row echo-row-two">
          <PolarClock
            data={data?.polar ?? null}
            loading={loading}
            window={window}
          />
          <IndependenceTrend
            data={data?.independence ?? null}
            loading={loading}
          />
        </div>

        <ConceptsMomentum
          data={data?.conceptsMomentum ?? null}
          loading={loading}
        />

        <MonthlyHeatmap data={data?.heatmap ?? null} loading={loading} />

        <LinesWritten data={data?.lines ?? null} loading={loading} />

        <LineThatWontDie data={data?.rewrittenLine ?? null} loading={loading} />

        <div className="echo-row echo-row-two">
          <CommitStories
            data={data?.commits ?? null}
            loading={loading}
            onOpenFile={(file) => onOpenMoment(file)}
          />
          <SaveTape
            data={data?.saveTape ?? null}
            loading={loading}
            onOpenMoment={onOpenMoment}
          />
        </div>

        <StoryModeButton
          data={data?.storyMode ?? { notify: false, nextDrop: null }}
          onOpenStory={onOpenStory}
          onToggleNotify={onToggleNotify}
        />
      </div>
    </div>
  );
}
