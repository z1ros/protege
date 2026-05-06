import React, { useState } from "react";

/**
 * Periodic self-rating prompt — Task 25.
 *
 * Asks the user to score their seniority on the codebase 1-10 with an
 * optional one-sentence note. The host relays the answer to
 * `POST /iq/self-rating` (Task 17), which feeds the HMM as a
 * declarative-evidence event.
 *
 * Cooldown is enforced webview-side via `localStorage` so we don't
 * round-trip the host on every render. 90 days matches Phase A's
 * "quarterly nudge" cadence — short enough to catch level changes,
 * long enough to avoid pestering. Both Submit and Skip mark the
 * prompt as shown, so dismissing buys the same cooldown as answering.
 */

const STORAGE_KEY = "iq3.selfRating.lastShownAt";
const COOLDOWN_DAYS = 90;

export function SelfRatingPrompt({
  onSubmit,
  onSkip,
}: {
  onSubmit: (rating: number, note?: string) => void;
  onSkip: () => void;
}) {
  const [rating, setRating] = useState<number>(5);
  const [note, setNote] = useState("");
  return (
    <div className="iq3-selfrate">
      <div className="iq3-selfrate-prompt">
        Rate your seniority on this codebase (1 = beginner, 10 = senior).
      </div>
      <div className="iq3-selfrate-buttons">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
          <button
            key={n}
            className={`iq3-selfrate-btn ${rating === n ? "iq3-selfrate-btn--sel" : ""}`}
            onClick={() => setRating(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <textarea
        className="iq3-selfrate-note"
        placeholder="(optional) one sentence on why"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="iq3-selfrate-actions">
        <button onClick={() => onSubmit(rating, note || undefined)}>Submit</button>
        <button onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}

/** Returns true if we should show the prompt now. Guarded against
 *  webview hosts that don't expose `localStorage` — better to skip
 *  than to crash the dashboard. */
export function shouldShowSelfRating(): boolean {
  try {
    const last = Number(localStorage.getItem(STORAGE_KEY) ?? 0);
    const days = (Date.now() - last) / (1000 * 60 * 60 * 24);
    return days >= COOLDOWN_DAYS;
  } catch {
    return false;
  }
}

export function markSelfRatingShown() {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // No localStorage — accept that we'll re-prompt next session.
  }
}
