import React from "react";
import type { Iq3FieldVector } from "@protege/types";

const FIELD_COLORS: Record<string, string> = {
  web: "#3b82f6",
  ml: "#a855f7",
  dataEng: "#06b6d4",
  devOps: "#f97316",
  sec: "#dc2626",
  mobile: "#84cc16",
  systems: "#64748b",
  game: "#ec4899",
  embedded: "#737373",
  generalist: "#9ca3af",
};

// Human-readable labels. Field IDs are camelCase / lowercase tokens
// for the API, but the UI surfaces them in proper case so the legend
// reads like a domain name instead of a code identifier.
const FIELD_LABEL: Record<string, string> = {
  web: "Web",
  ml: "ML",
  dataEng: "Data Eng",
  devOps: "DevOps",
  sec: "Security",
  mobile: "Mobile",
  systems: "Systems",
  game: "Game Dev",
  embedded: "Embedded",
  generalist: "Generalist",
};

/** Minimum top-field weight to consider the vector "informative". Below
 *  this the distribution is too uniform to convey signal — most likely
 *  the user is new and the prior hasn't moved yet. The dashboard hides
 *  the bar entirely below this threshold (see IqDashboard.tsx). */
export const FIELD_VECTOR_MIN_SIGNAL = 0.2;

/** Returns the highest-weight field's probability. Used by the
 *  dashboard's gate. Returns 0 for nullish vectors so the dashboard
 *  hides the FieldVector + falls through to the "still learning"
 *  branch instead of throwing on Object.values(undefined). */
export function topFieldWeight(v: Iq3FieldVector | undefined | null): number {
  if (!v) return 0;
  let max = 0;
  for (const p of Object.values(v)) {
    if (typeof p === "number" && p > max) max = p;
  }
  return max;
}

export function FieldVector({ v }: { v: Iq3FieldVector }) {
  const entries = Object.entries(v).sort((a, b) => b[1] - a[1]);
  return (
    <div className="iq3-field-vector">
      <div className="iq3-field-bar">
        {entries.map(([f, p]) => (
          <div
            key={f}
            className="iq3-field-segment"
            style={{ width: `${p * 100}%`, background: FIELD_COLORS[f] ?? "#9ca3af" }}
            title={`${FIELD_LABEL[f] ?? f}: ${(p * 100).toFixed(0)}%`}
          />
        ))}
      </div>
      <div className="iq3-field-legend">
        {entries.slice(0, 3).map(([f, p]) => (
          <span key={f}>
            <span
              style={{ background: FIELD_COLORS[f] ?? "#9ca3af" }}
              className="iq3-field-swatch"
            />
            {FIELD_LABEL[f] ?? f} {(p * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}
