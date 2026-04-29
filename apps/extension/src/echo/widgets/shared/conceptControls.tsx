import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConceptKnownStatus,
  ConceptLanguageCount,
} from "@protege/types";

/**
 * Shared primitives used by W15 (Concepts Covered) and W17 (Repo Concepts):
 *
 *   - `LanguagePicker`          — accessible dropdown in the widget header.
 *   - `statusBadgeGlyph` /
 *     `statusLabel` /
 *     `cycleStatus`             — unset → known → not_known → unset helpers.
 *
 * W15 and W17 share the same UserPreference.echoConceptLanguage key, so
 * selecting a language in either widget filters both simultaneously. The
 * component is controlled — parents own the selected value and publish
 * changes via `onSelect` (null means "All languages").
 */

export function statusBadgeGlyph(status: ConceptKnownStatus): string {
  switch (status) {
    case "known":
      return "✓";
    case "not_known":
      return "✗";
    case "unset":
    default:
      return "?";
  }
}

export function statusLabel(status: ConceptKnownStatus): string {
  switch (status) {
    case "known":
      return "known";
    case "not_known":
      return "not known";
    case "unset":
    default:
      return "unset";
  }
}

export function cycleStatus(current: ConceptKnownStatus): ConceptKnownStatus {
  if (current === "unset") return "known";
  if (current === "known") return "not_known";
  return "unset";
}

export interface LanguagePickerProps {
  languages: ConceptLanguageCount[];
  selected: string | null;
  onSelect: (language: string | null) => void;
}

const LANG_DISPLAY: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TSX",
  javascript: "JavaScript",
  javascriptreact: "JSX",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  ruby: "Ruby",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  swift: "Swift",
  kotlin: "Kotlin",
  scala: "Scala",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  shell: "Shell",
  shellscript: "Shell",
  other: "Other",
};

export function formatLanguageLabel(language: string | null): string {
  if (language === null) return "Unknown";
  return LANG_DISPLAY[language] ?? language;
}

export function LanguagePicker({
  languages,
  selected,
  onSelect,
}: LanguagePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const totalCount = useMemo(
    () => languages.reduce((acc, l) => acc + l.count, 0),
    [languages]
  );

  // Options: "All languages (N)" prepended to the per-language buckets.
  const options = useMemo(() => {
    const list: Array<{ key: string; value: string | null; label: string; count: number }> = [
      { key: "__all__", value: null, label: "All languages", count: totalCount },
    ];
    for (const entry of languages) {
      list.push({
        key: entry.language ?? "__null__",
        value: entry.language,
        label: formatLanguageLabel(entry.language),
        count: entry.count,
      });
    }
    return list;
  }, [languages, totalCount]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDocMouse = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When opening, seed focus on the currently selected option so arrow keys
  // feel natural.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === selected);
    setFocusIndex(idx >= 0 ? idx : 0);
  }, [open, options, selected]);

  // Trigger label derivation:
  //   - null          → "All languages"
  //   - known option  → option's display name (e.g. "TypeScript")
  //   - unknown value → the raw string, never "Unknown"
  const currentLabel = useMemo(() => {
    if (selected === null) return "All languages";
    const match = options.find((o) => o.value === selected);
    if (match) return match.label;
    return selected;
  }, [selected, options]);

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[focusIndex];
      if (opt) {
        onSelect(opt.value);
        setOpen(false);
      }
    }
  };

  return (
    <div className="echo-lang-picker" ref={rootRef}>
      <button
        type="button"
        className={`echo-lang-picker-btn ${open ? "open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="echo-lang-picker-globe"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a13 13 0 010 18" />
          <path d="M12 3a13 13 0 000 18" />
        </svg>
        <span className="echo-lang-picker-label">{currentLabel}</span>
        <svg
          className="echo-lang-picker-caret"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <ul
          className="echo-lang-picker-menu"
          role="listbox"
          tabIndex={0}
          onKeyDown={onListKey}
          ref={(el) => {
            // Auto-focus the list when it opens so Enter / Arrow keys work
            // without first tabbing into it. Scoped to the effect-equivalent
            // here so re-renders don't keep stealing focus.
            if (el && document.activeElement !== el) el.focus();
          }}
        >
          {options.map((opt, idx) => {
            const active = opt.value === selected;
            const focused = idx === focusIndex;
            return (
              <li
                key={opt.key}
                role="option"
                aria-selected={active}
                className={`echo-lang-picker-option ${active ? "active" : ""} ${
                  focused ? "focused" : ""
                }`}
                onMouseEnter={() => setFocusIndex(idx)}
                onClick={() => {
                  onSelect(opt.value);
                  setOpen(false);
                }}
              >
                <span className="echo-lang-picker-option-label">{opt.label}</span>
                <span className="echo-lang-picker-option-count">{opt.count}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
