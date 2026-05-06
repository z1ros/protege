import React, { useState } from "react";
import type { Iq3FieldId } from "@protege/types";

/**
 * 5-question onboarding probes — Task 24
 *
 * Shown in place of the IQ dashboard while the user is fresh
 * (`maturity === "cold"` AND `confidence < 0.2`). Each probe records a
 * matchKey (`onboarding.*=...`) which the backend forwards to
 * `applyMatchKeys` as future-extensible evidence; the field probe also
 * forwards the chosen field through `applySelfDeclaration` at weight 0.2
 * — that's the load-bearing signal for Phase A. A "Skip" affordance
 * exits the flow with whatever has been collected so the user is never
 * trapped.
 */

interface Probe {
  id: string;
  prompt: string;
  options: { id: string; text: string }[];
  matchKeys: Record<string, string[]>;
}

const PROBES: Probe[] = [
  {
    id: "p1-reading",
    prompt: "Which of these has a bug?",
    options: [
      { id: "a", text: "const sum = arr.reduce((a,b)=>a+b, 0);" },
      { id: "b", text: "const sum = arr.reduce((a,b)=>a+b);" },
      { id: "c", text: "Both work the same way." },
    ],
    matchKeys: {
      a: ["onboarding.reading=correct"],
      b: ["onboarding.reading=correct"],
      c: ["onboarding.reading=incorrect"],
    },
  },
  {
    id: "p2-decomposition",
    prompt: "You need to add CSV import. How would you split it?",
    options: [
      { id: "a", text: "One function: parse + validate + insert." },
      { id: "b", text: "Two: parse-and-validate, insert." },
      { id: "c", text: "Three+: parse, validate, transform, insert." },
      { id: "d", text: "Use a CSV library and add validation around it." },
    ],
    matchKeys: {
      a: ["onboarding.decomp=monolithic"],
      b: ["onboarding.decomp=ok"],
      c: ["onboarding.decomp=structured"],
      d: ["onboarding.decomp=pragmatic"],
    },
  },
  {
    id: "p3-ai-judgment",
    prompt:
      "AI suggests:\n  try { return (await fetch(url).then(r=>r.json())).results[0].name; }\n  catch (e) { return null; }\nWould you accept as-is?",
    options: [
      { id: "a", text: "Yes, looks fine." },
      { id: "b", text: "No — silent catch swallows errors; at least log." },
      { id: "c", text: "No — .results[0] could be undefined; need to check." },
      { id: "d", text: "No — both: defensive checking + meaningful error handling." },
    ],
    matchKeys: {
      a: ["onboarding.ai=accept_unsafe"],
      b: ["onboarding.ai=catches_logging"],
      c: ["onboarding.ai=catches_undefined"],
      d: ["onboarding.ai=catches_both"],
    },
  },
  {
    id: "p4-verification",
    prompt: "You wrote `removeDuplicates(arr)`. What do you test first?",
    options: [
      { id: "a", text: "Happy path: [1,2,2,3]." },
      { id: "b", text: "Edge cases: empty, all-dup, no-dup, mixed types." },
      { id: "c", text: "Performance: 1M items." },
      { id: "d", text: "Edges first, then happy path, perf last." },
    ],
    matchKeys: {
      a: ["onboarding.verif=happy_only"],
      b: ["onboarding.verif=edges_first"],
      c: ["onboarding.verif=perf_first"],
      d: ["onboarding.verif=edges_then_rest"],
    },
  },
  {
    id: "p5-field",
    prompt: "When you code, you mostly write…",
    options: [
      { id: "web", text: "Frontend / web pages." },
      { id: "ml", text: "Data / ML / notebooks." },
      { id: "sec", text: "Security / pentest." },
      { id: "devOps", text: "Infra / deploy / monitoring." },
      { id: "mobile", text: "Mobile (iOS/Android)." },
      { id: "systems", text: "Systems / low-level." },
      { id: "embedded", text: "Embedded / firmware." },
      { id: "game", text: "Games / graphics." },
      { id: "generalist", text: "A mix of several." },
    ],
    matchKeys: Object.fromEntries(
      [
        "web",
        "ml",
        "sec",
        "devOps",
        "mobile",
        "systems",
        "embedded",
        "game",
        "generalist",
      ].map((f) => [f, [`onboarding.field=${f}`]]),
    ),
  },
];

export function OnboardingProbes({
  onComplete,
}: {
  onComplete: (selfDeclaredField: Iq3FieldId, matchKeys: string[]) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [collected, setCollected] = useState<string[]>([]);
  const [field, setField] = useState<Iq3FieldId>("generalist");

  if (idx >= PROBES.length) return null;

  const probe = PROBES[idx];
  return (
    <div className="iq3-onboarding">
      <div className="iq3-onboarding-step">
        {idx + 1} / {PROBES.length}
      </div>
      <div className="iq3-onboarding-prompt">{probe.prompt}</div>
      <div className="iq3-onboarding-options">
        {probe.options.map((opt) => (
          <button
            key={opt.id}
            className="iq3-onboarding-opt"
            onClick={() => {
              const next = [...collected, ...probe.matchKeys[opt.id]];
              setCollected(next);
              const isField = probe.id === "p5-field";
              const newField = isField ? (opt.id as Iq3FieldId) : field;
              if (isField) setField(newField);
              if (idx + 1 >= PROBES.length) {
                onComplete(newField, next);
              } else {
                setIdx(idx + 1);
              }
            }}
          >
            {opt.text}
          </button>
        ))}
      </div>
      <button
        className="iq3-onboarding-skip"
        onClick={() => onComplete(field, collected)}
      >
        Skip
      </button>
    </div>
  );
}
