import React from "react";
import type { StoryModeTeaserPayload } from "@protege/types";

export interface StoryModeButtonProps {
  data: StoryModeTeaserPayload;
  onOpenStory: () => void;
  onToggleNotify: (enabled: boolean) => void;
}

export function StoryModeButton({
  data,
  onOpenStory,
  onToggleNotify,
}: StoryModeButtonProps): JSX.Element {
  return (
    <section className="echo-widget echo-storymode" data-widget="W13">
      <button
        type="button"
        className="echo-storymode-card"
        onClick={onOpenStory}
        aria-label="Open Story Mode teaser"
      >
        <div className="echo-storymode-card-inner">
          <div className="echo-storymode-card-title">Monthly Story Mode</div>
          <div className="echo-storymode-card-sub">Coming soon</div>
          <div className="echo-storymode-card-hint">
            A scrollytelling recap of how you grew. Click to preview.
          </div>
        </div>
      </button>
      <label className="echo-storymode-notify" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={!!data.notify}
          onChange={(e) => onToggleNotify(e.target.checked)}
        />
        <span>Notify me when it's ready</span>
      </label>
    </section>
  );
}
