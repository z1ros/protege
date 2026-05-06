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
            title={`${f}: ${(p * 100).toFixed(0)}%`}
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
            {f} {(p * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}
