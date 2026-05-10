# Iq3 Persona Harness

Behavioral verification for the Code IQ pipeline. Encodes "what good
looks like" as deterministic synthetic developers, runs them through
the full pipeline (matchers → HMM → field vector → pillars → rank →
composite headline), and asserts the team's ground truth.

## Why

Unit tests verify the math. They do NOT answer the only question that
matters for a proficiency metric: **"Does a person who behaves like a
Senior Web Developer actually score Senior?"**

Personas answer that. Each persona file declares:

- A field signal seed (repo deps + file extensions + concept counts)
- A deterministic event stream (50–300 events of typical activity)
- The team's ground-truth expectation (rank, field, score range,
  optional per-pillar bounds)

The runner is pure (no I/O, no time, no Supabase). The same persona
emits the same stream and produces the same headline every run, so
regressions are caught immediately.

## How to add a persona

1. Drop a new file: `apps/backend/src/iq3/__personas__/myPersona.ts`
2. Export a `Persona` matching the shape in `runPersona.ts`
3. Import + push into `PERSONAS` in `personas.test.ts`
4. `pnpm test src/iq3/__personas__` — fail-fast feedback

That's it. No other wiring.

## Persona shape

```ts
export const myPersona: Persona = {
  id: "persona:myPersona",
  description: "What this archetype represents",

  field: {
    repoSignals: { /* deps + extensions */ },
    conceptCounts: { /* concept:foo → count */ },
    selfDeclared: "web", // optional
  },

  events: () => [/* deterministic EchoEvent[] */],

  expect: {
    rank: "junior",          // OR uncappedRank for senior gaps
    dominantField: "web",    // optional
    headlineRange: [200, 480],
    confidenceMin: 0.3,      // optional
    maturity: "cold",        // optional
    pillarRanges: {          // optional, partial
      diagnostics: [550, 1000],
    },
  },
};
```

## Known gaps the harness has surfaced

These are real product issues — fix them and re-tighten the persona
expectations afterward.

### 1. Diagnostics traits have no producer

The Diagnostics pillar (5 traits: hypothesisDriven, errorResolutionFast,
fixNotBandAid, testsAfterError, readsStackTrace) is fed by matchKeys
like `error_appeared.then.edits_in_error_neighborhood.count<=3.then.error_cleared`.

**No event producer in the extension emits the underlying
`error_appeared` / `error_cleared` events.** So the Diagnostics pillar
stays at the neutral 500 for everyone. Combined with the senior pillar
floor (580), this makes senior rank unreachable for most users today.

`seniorMlEng` and `seniorWebExpert` use `uncappedRank` to assert the
pre-floor pipeline behavior is correct.

### 2. ML cohort is harshest on Diagnostics gap

ML field weights Diagnostics at 1.2 (the highest of any pillar in any
field). With Diagnostics stuck at 500, an otherwise-senior ML user
lands ~720 — exactly at the senior cutoff. Even pre-floor, this
persona caps at "mid". Web users (Diagnostics weight 1.0) clear the
cutoff comfortably.

### 3. Cold-start field tie-break

When the field vector is uniform (no signal), `dominantField()` returns
the first FIELD_ID in declaration order ("web"). Personas with no
field signal (`learnerGeneralist`) leave `dominantField` unasserted
rather than locking in this quirk.

## When to update the harness

- **A new pillar / trait / matcher ships** → add at least one persona
  whose stream exercises it.
- **A field's pillar weights change** → re-run; tighten ranges if a
  rank flips unexpectedly.
- **Calibration tuning (sigmoid slope, score band cutoffs)** → re-run;
  the persona ranges encode the team's calibration intent.
- **A real user's actual rank disagrees with their on-screen rank** →
  reverse-engineer the disagreement into a new persona so the test
  fails until the system gets it right.
