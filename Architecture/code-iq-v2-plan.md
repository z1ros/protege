# Code IQ v2 — The Engineer's Benchmark

> **One number. Six categories. No hand-waving.**
>
> `Code IQ = round((Craft + Range + Velocity + Debug + Quality + Independence) / 6)`
>
> Each category is 0–1000 with a calibrated curve that matches what a
> real staff engineer would agree with. Current system gives a 10-min
> user 296 IQ; v2 gives the same user ~60 IQ — and every point of that
> 60 is defensible.

---

## 1. The shape

**Code IQ is the arithmetic mean of six category scores, each 0–1000.**

```ts
codeIQ = Math.round(
  (craft + range + velocity + debug + quality + independence) / 6
);
```

That's it. The top-level number is a true average, not a capped sum. Each
category has its own story, its own signals, its own level curve. The user
can look at any one of them and ask "am I actually at this level?" — and
the answer has to be yes.

Why average and not sum? Because a sum creates the "one big TSX file = 300
IQ" problem — the score balloons when you happen to trip many signals at
once. An average forces *every* category to move before the headline moves.
You can't fake being a 700 IQ engineer by being 1000 in Craft and 0 in
everything else — you'd only score 167.

### Calibration — what each number means

This is the table that keeps us honest. v2 targets this distribution:

| Level | Description | Typical IQ | Years |
|---|---|---|---|
| **Curious** | First week of coding | 30–80 | 0 |
| **Learning** | First serious project | 80–180 | 0–1 |
| **Junior** | Shipping real features | 180–350 | 1–2 |
| **Mid** | Trusted with modules | 350–550 | 2–4 |
| **Senior** | Owns systems | 550–720 | 5–8 |
| **Staff** | Sets patterns across teams | 720–860 | 8–12 |
| **Principal** | Reshapes how others build | 860–950 | 12+ |
| **Legend** | Industry-defining work | 950–1000 | Rare |

A staff engineer reading this table should nod. That's the bar.

---

## 2. The six categories

Each category has: (a) the *question* it answers, (b) the *signals* it
uses, (c) the *formula*, (d) the *level curve*. All scored 0–1000.

### 2.1 Craft — *"Can you write clean, correct code yourself?"*

The headline measure of manual ability.

**Signals**
- `authoredConcepts` — concepts detected in code with authorship ratio ≥ 0.6 (you typed most of it)
- `demonstratedConcepts` — authoredConcepts used in ≥3 distinct files (pattern, not accident)
- `complexityHandled` — max cyclomatic complexity / nesting depth in code you authored
- `readabilityScore` — naming quality, consistent formatting, no dead code (scored per save)

**Formula**

```
rawCraft =
  Σ (concept.authorshipWeight × concept.difficulty × min(1, distinctFiles / 3))
  + complexityHandled × 2
  + readabilityScore × 0.5
```

**Level curve** — sigmoid so top tiers are exponentially harder:

```
craft = 1000 × sigmoid((rawCraft − 120) / 200)
```

Concretely: raw 60 → 100 IQ, raw 150 → 500 IQ, raw 300 → 820 IQ, raw 500 → 970 IQ.

### 2.2 Range — *"How many domains can you actually work in?"*

Breadth — but authentic, not sampled.

**Signals**
- `liveDomains` — clusters (React / Async / Types / etc.) where Craft ≥ 200 locally
- `languagesPracticed` — languages where you've authored ≥500 lines over ≥3 files
- `paradigmsUsed` — OOP, functional, reactive, procedural (detected from patterns across files)

**Formula**

```
rawRange =
  liveDomains × 60
  + languagesPracticed × 80
  + paradigmsUsed × 40
  + synergyPairs × 30          // e.g. React+TS, Async+Errors (both sides active)
  − oneTrickPenalty × 80       // >80% of concepts in one cluster
```

**Level curve**: linear up to 600, compressed above.

```
range = rawRange ≤ 600 ? rawRange : 600 + (rawRange − 600) × 0.5   // capped 1000
```

A full-stack polymath (5 domains, 3 languages, both paradigms) naturally
lands ~680. Going above requires genuinely broad specialization.

### 2.3 Velocity — *"How fast can you ship working code?"*

Not "how fast you type". How fast you *finish*.

**Signals**
- `featuresCompleted` — distinct multi-file changesets that end with zero diagnostics + passing tests (if tests exist)
- `timeToGreen` — avg minutes from "first edit on a feature" to "no errors, tests pass"
- `activeCodingMinutes30d` — real typing time, not wall clock
- `reworkRatio` — code rewritten within 48h / code authored (lower is better, up to a point)

**Formula**

```
rawVelocity =
  featuresCompleted × 25
  + min(200, activeCodingMinutes30d / 30)
  + (60 − clamp(timeToGreenAvg, 5, 120)) × 3
  − reworkRatio × 200          // penalty, but allow some normal rework
```

**Level curve**: logarithmic — shipping your 10th feature matters more than
your 100th.

```
velocity = 1000 × (1 − exp(−rawVelocity / 250))
```

Raw 100 → 330 IQ, raw 300 → 700 IQ, raw 700 → 940 IQ.

### 2.4 Debug — *"Can you find and fix root causes?"*

The single most undervalued skill. Mid engineers write. Senior engineers
debug.

**Signals**
- `bugsAuthoredFixed` — diagnostic that appeared in code you authored, then disappeared, with the fix *also* authored by you
- `rootCauseRatio` — fixes that don't produce a regression within 7 days (suggests root cause, not symptom patch)
- `tsErrorClearanceRate` — TS errors resolved per hour of active coding while errors were present
- `diagnosticLatency` — median time from error appearing to error disappearing (only on files you're actively editing)
- `simplificationEvents` — commits where LOC dropped AND cyclomatic dropped AND no new bugs appeared

**Formula**

```
rawDebug =
  bugsAuthoredFixed × 4
  + rootCauseRatio × 200             // 0-1 → 0-200
  + tsErrorClearanceRate × 30        // errors/hour
  + max(0, 60 − diagnosticLatencyMin) × 2
  + simplificationEvents × 6
```

**Level curve**: linear to 400, sigmoid above.

```
debug = rawDebug ≤ 400
  ? rawDebug × 1.0
  : 400 + 600 × sigmoid((rawDebug − 600) / 200)
```

### 2.5 Quality — *"Does your code last?"*

Tests, cleanliness, low bug density, zero recurring bugs.

**Signals**
- `testsAuthored` — test files/blocks authored by you (AST detection of test frameworks)
- `testCoverageAuthored` — lines of your code that are covered by tests you wrote
- `cleanSaveRate` — % of saves with zero diagnostics
- `bugDensity` — findings per 100 LOC of your authored code
- `recurringBugCount` — same bug appearing >1 time in 14 days (bad sign)
- `typeStrictness` — % of TS concepts with explicit types vs `any`/implicit

**Formula**

```
rawQuality =
  testsAuthored × 8
  + testCoverageAuthored × 150      // 0-1 → 0-150
  + cleanSaveRate × 200
  + max(0, 100 − bugDensity × 30)
  + typeStrictness × 100
  − recurringBugCount × 12
```

**Level curve**: sigmoid centered at 400.

```
quality = 1000 × sigmoid((rawQuality − 350) / 180)
```

### 2.6 Independence — *"Are you actually getting better, or is the AI doing it?"*

The new signal that makes Protege honest.

**Signals**
- `authorshipRatio30d` — manually typed chars / total new chars in last 30 days
- `aiExplainabilityRate` — when AI-generated code appears in a file you save, do you *modify* it within 10 min? (suggests comprehension, not blind accept)
- `noAssistFeaturesCompleted` — features completed with authorshipRatio ≥ 0.85
- `aiCorrectionsAuthored` — bugs introduced by AI-accepted code that you later authored-fixed

**Formula**

```
rawIndependence =
  authorshipRatio30d × 500           // dominant signal, 0-1 → 0-500
  + aiExplainabilityRate × 150
  + noAssistFeaturesCompleted × 20
  + aiCorrectionsAuthored × 8
```

**Level curve**: linear, no sigmoid — we *want* this to be a brutally
honest direct measure.

```
independence = min(1000, rawIndependence)
```

This is the category that most users will initially score lowest on. That's
the point. Showing Independence = 180 alongside Craft = 450 tells them
"you *can* write it, but mostly you don't". That's actionable.

---

## 3. Why this makes sense to a staff engineer

Walk through the thought experiment: a principal engineer looks at Code IQ
= 820 and asks "does this person know what they're doing?"

- **Craft ≥ 700** — they can write things cleanly, manually.
- **Range ≥ 600** — they've genuinely worked across a few domains.
- **Velocity ≥ 700** — they ship, not just experiment.
- **Debug ≥ 750** — they fix root causes, not symptoms.
- **Quality ≥ 700** — their code has tests and holds up.
- **Independence ≥ 700** — they use AI as a tool, not a crutch.

If all six are above 700, averaging to 820, that *is* a staff engineer by
any reasonable definition. The average enforces consistency — you can't be
staff-level with a 200 in Debug.

Conversely, a 10-min demo user with one TSX file:
- Craft ~60 (few authored, no repeated use)
- Range ~80 (one domain sampled)
- Velocity ~10 (one save, no completion signal)
- Debug ~0 (no bugs fixed)
- Quality ~120 (clean save, low bug density, no tests)
- Independence ~50 (most code was typed in demo, but authorship low)

**Average: ~53 IQ.** That's the correct number. It says "welcome, you've
shown up, you've done almost nothing".

---

## 4. Signals we need to collect (content-blind)

All signals are *counts and distances*, never content. This is a
privacy-preserving design.

### 4.1 From the editor (rolling 10-sec aggregates)

- `charsTyped` — normal keystroke events, `text.length ≤ 3`
- `charsDeleted`
- `charsPasted` — inserts > 40 chars or clipboard paste events
- `aiAccepted` — completions accepted (Copilot/Cursor hooks where available, inferred otherwise)
- `activeMs` — any window with a keystroke
- `fileId`, `language`

### 4.2 Derived per save

- `authorshipRatio(file, region)` — typed chars / total new chars in a region, via signal walk-back
- `conceptsDetected` (existing AST work)
- `conceptAuthorship` — per concept, classified `human | ai-assisted | ai-copy | pasted`
- `diagnostics` — before/after counts, per-line attribution

### 4.3 Derived per session/day

- `activeMinutes` — sum of active 10-sec windows, ≥15 min to count a day as "active"
- `featuresCompleted` — heuristic: burst of saves across multiple files ending in zero diagnostics + >5 min pause
- `timeToGreen` — per feature, first-edit to last-error-cleared

---

## 5. Implementation phases

Each phase ships independently, each moves the headline toward correctness.

### Phase 0 — Plumbing (2 days)
- Add `IqV2Snapshot` type, parallel to v1 — don't break v1 yet
- Add `/debug/iq-v2` endpoint returning both v1 and v2 numbers side-by-side
- Feature flag: `protege.useIqV2` (default off)

### Phase 1 — Signal collection (5 days)
- `keystrokeTracker.ts` — content-blind, rolling aggregates
- `pasteDetector.ts`
- `aiCompletionSniffer.ts`
- Backend: persist `signals[]` per user
- **Don't score yet. Just collect for a week.** Validate the telemetry before trusting it.

### Phase 2 — Authorship attribution (3 days)
- Walk-back algorithm: per detected concept, classify insert type
- Populate `conceptAuthorship` on every save
- Display authorship ratio chip in the header — instant honesty

### Phase 3 — Craft + Independence (4 days)
- Ship these two first — they depend only on authorship
- Craft replaces v1 Depth
- Independence is new
- Composite IQ is still v1 internally; dashboard shows "v2 preview"

### Phase 4 — Range, Velocity, Debug, Quality (7 days)
- Range (3 days — needs multi-language concept detection)
- Velocity (2 days — needs "feature" heuristic)
- Debug (1 day — existing diagnostic attribution)
- Quality (1 day — existing test detection)

### Phase 5 — Switchover (2 days)
- Flip `useIqV2` default to true
- Migrate users: show "v1 legacy" in grey, v2 is headline
- Milestones moved to Badges tab, zero IQ contribution
- Announce recalibration transparently

### Phase 6 — Calibration tuning (ongoing)
- Track distribution of user scores across cohorts
- If beginners average 180 instead of target 60, tune the sigmoid centers
- If seniors ceiling at 600 instead of 750, tune the raw coefficients
- Goal: internal team members' scores match their self-assessment within ±50

---

## 6. Dashboard surface

The Code IQ tab's Overview becomes:

```
┌──────────────────────────────────────┐
│     820                              │   ← headline
│     Staff Engineer                   │   ← level band
│     +12 this week                    │   ← weekly delta
│                                      │
│  Craft       ████████████░  780     │
│  Range       ██████████░░░  720     │   ← six bars
│  Velocity    █████████████  850     │     same order always
│  Debug       ████████████░  790     │
│  Quality     ██████████░░░  740     │
│  Independence █████████░░░  680     │
└──────────────────────────────────────┘
```

Clicking any bar expands to show the raw signals + formula. No mystery.
Every IQ point is traceable to a specific signal.

Beside the 820, a small "hover to see breakdown" tooltip:
> *820 = mean of six categories, each 0–1000. Lowest: Independence 680 —
> 34% of your code in the last 30 days was AI-accepted. Typing more of it
> yourself would lift this.*

That's the pitch. Every number is honest, actionable, and *defensible to a
staff engineer*.

---

## 7. Three questions, three answers

1. **"Why six categories, not five?"**
   Five pillars had a nice pentagon. But Independence deserves its own
   category — it's the single most-asked question in modern hiring, and
   folding it into Craft would hide it. Six bars visualize fine (hexagonal
   radar or just a stacked list).

2. **"Why average, not weighted average?"**
   Weights become political. "Craft should be worth 2× Quality" is a
   debate with no answer. Equal weighting says: a great engineer is
   balanced. A 950 Craft / 100 Debug person is not a great engineer —
   they're a great *writer* — and the average (525) correctly reflects
   that.

3. **"What prevents gaming?"**
   Authorship signals are content-blind but *rhythm-aware*. Random
   keystroke generation has a telltale flat distribution; real typing has
   characteristic burst-rest patterns. Pasting 500 lines then moving the
   cursor doesn't count as authorship. AI completion detection uses
   large-insert + short-latency heuristics. None of it is perfect, but
   collectively it's hard to fool without literally typing real code.
