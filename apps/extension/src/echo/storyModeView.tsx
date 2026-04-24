import React from "react";
import type { StoryModeTeaserPayload } from "@protege/types";

export interface StoryModeViewProps {
  data: StoryModeTeaserPayload;
  onBack: () => void;
  onToggleNotify: (enabled: boolean) => void;
}

export function StoryModeView({
  data,
  onBack,
  onToggleNotify,
}: StoryModeViewProps): JSX.Element {
  return (
    <div className="echo-story">
      <div className="echo-toolbar">
        <button type="button" className="echo-story-back" onClick={onBack}>
          &larr; Dashboard
        </button>
      </div>
      <div className="echo-story-teaser">
        <div className="echo-story-illustration" aria-hidden="true">
          <svg width="120" height="120" viewBox="0 0 120 120" role="presentation">
            <defs>
              <radialGradient id="storyGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#58a6ff" stopOpacity="0.65" />
                <stop offset="70%" stopColor="#58a6ff" stopOpacity="0.1" />
                <stop offset="100%" stopColor="#58a6ff" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="60" cy="60" r="56" fill="url(#storyGlow)" />
            <g stroke="#58a6ff" strokeLinecap="round" strokeWidth="2" fill="none">
              <path d="M30 82 L50 70 L62 78 L78 56 L90 62" opacity="0.65" />
              <path d="M30 64 L44 52 L60 60 L76 42 L90 48" opacity="0.4" />
            </g>
            <circle cx="50" cy="70" r="2.5" fill="#7ee787" />
            <circle cx="78" cy="56" r="2.5" fill="#bc8cff" />
            <circle cx="90" cy="62" r="2.5" fill="#f0b84a" />
          </svg>
        </div>
        <h1>Monthly Story Mode</h1>
        <p>
          A month-in-review of how you grew. Scrollytelling cards, shareable
          scenes. Dropping soon.
        </p>
        <label className="echo-story-notify">
          <input
            type="checkbox"
            checked={!!data.notify}
            onChange={(e) => onToggleNotify(e.target.checked)}
          />
          Notify me when it&rsquo;s ready
        </label>
      </div>
    </div>
  );
}
