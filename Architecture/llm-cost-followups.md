# LLM Cost Redesign — Follow-ups

Logged 2026-04-26. Audit conducted on `analytics-real-time-learning` branch.

## Problem statement

The product treats the LLM as the default compute layer instead of the last resort. Several passive features fire LLM calls on ambient triggers (timers, file opens, pastes) with no content-hash cache, no per-feature budget, and prompts that ask the model to describe things that are structurally derivable from AST + import graph.

Per-user cost projection if all passive features stay on:
- Live Review idle health timer alone: ~$4/day per user
- File Open Greeter: ~$0.30/day
- Vibe Brief: ~$0.40/day
- Architecture Tour: ~$0.05–0.10 per tour click
- Pattern Spotter: ~$0.02/day (gates currently hold)
- Project Map summaries: ~$0.10/day for active map users

The good pattern (3-tier cache → LLM fallback) already exists in [aiExplain.ts:91-114](../apps/extension/src/ai/aiExplain.ts#L91-L114) and [aiGenerateTip](../apps/extension/src/ai/aiExplain.ts#L174). It just hasn't propagated.

---

## Tier 1 — Critical (target: this week)

### 1.1 Live Review health timer — replace LLM scan with render-only refresh

**Location:** [liveReview.ts:367-373](../apps/extension/src/review/liveReview.ts#L367-L373)

**Current behavior:** Every 12s while Live Review is on, sets `pendingChangeSize = Infinity` and calls `runReview(editor)` — forces a full LLM scan even when content hasn't changed. Idle user with file open ≈ ~$4/day.

**Why the timer exists at all:** Comment at [liveReview.ts:85-87](../apps/extension/src/review/liveReview.ts#L85-L87) — paired with `findingGate.ts`'s 8s `LINE_EDIT_WINDOW_MS`, the timer's job is post-paste recovery. After an edit suppresses findings, the timer re-renders so they reappear once the gate clears.

**Fix:** The gate is a render-time filter. The suggestion set is in-memory in `suggestionsByUri`. Re-rendering doesn't need a fresh LLM call.

```ts
// Replace the body of healthTimer with:
healthTimer = setInterval(() => {
  const editor = vscode.window.activeTextEditor;
  if (editor && active) {
    refreshAllSurfaces(); // extracted helper that calls inlay/codelens/decoration refreshers
  }
}, HEALTH_CHECK_MS);
```

Extract `refreshAllSurfaces()` from the existing `notifyLiveReviewOn()` body and call it from both places.

**Effort:** ~1 hour. **Savings:** highest in the codebase.

**Even better follow-up:** replace the interval with a one-shot `setTimeout(refreshAllSurfaces, LINE_EDIT_WINDOW_MS + 1000)` scheduled after each edit. No idle ticks at all. Bigger refactor, defer.

---

### 1.2 File Open Greeter — heuristic-first

**Location:** [fileOpenGreeter.ts:355, 397](../apps/extension/src/hints/fileOpenGreeter.ts#L355)

**Current behavior:** Two LLM call paths (`runUnownedGreeting`, `runOverview`). Each sends 150–200 lines + complex instruction template per file open. ~700–1200 input tokens per call.

**Fix:** Build a deterministic greeting first, fall back to LLM only when confidence < 0.7.

Heuristic inputs:
- Filename (parsed for role: `auth`, `router`, `controller`, `view`, etc.)
- Top 5 imports
- Exported symbol names (AST extract)
- First comment block
- Ownership % (already available via `getOwnership`)
- Line count, complexity score (cyclomatic / nesting depth)

Output template: *"Auth router. Exports `validateSession` + `refreshToken`. You typed 60% — solid here."*

LLM fallback only for files with novel structure where heuristic confidence is low.

Per-URI lifetime dedup (line 263) and 24h unowned cooldown (line 252) stay as-is.

**Effort:** ~2 days. **Savings:** ~80% of greeter tokens.

---

### 1.3 Vibe Brief — split prompt + content-hash cache

**Location:** [vibeBrief.ts:430](../apps/extension/src/hints/vibeBrief.ts#L430)

**Current behavior:** Every paste ≥10 lines or ≥150 chars fires one LLM call asking for "what it does + one gotcha." No cache. ~600–1000 input tokens per paste.

**Fix:**
1. Split the two-section output into two stages.
2. **"What it does"** (line 1) → AST symbol extraction + import scan, deterministic. Free.
3. **"One thing to know"** (line 2) → still LLM, but the prompt is tighter (~150 input tokens vs 1000) because the AST summary is the context, not the raw code.
4. Content-hash cache on the pasted region: SHA1 → output. Re-pasting same code = cache hit. Hash key includes language + line count to avoid collisions.

**Effort:** ~3 days (need a small AST summarizer module).

**Savings:** ~70% per call + compounding cache hits.

---

## Tier 2 — High priority (target: this month)

### 2.1 Architecture Tour — sequential narration + cheap tier + cache

**Location:** [architectureTour.ts:317-358](../apps/extension/src/teaching/architectureTour.ts#L317-L358)

**Current behavior:** `Promise.all` over up to 5 tour stops, all firing premium-tier LLM calls in parallel on tour start. ~$0.05–0.10 per tour click.

**Fix:**
- Narrate stop N+1 only when user advances past stop N. Most users abandon before stop 5; saves ~60% on average.
- Drop `kind: "teach"` (premium) → `kind: "scan"` (cheap). Narration quality differs minimally between gpt-4.1 and gpt-4.1-mini for "explain this file in 2 sentences."
- Cache narrations per file content-hash so the same file in two tours = one call.

**Effort:** ~1 day. **Savings:** ~70% per tour, plus cache compounding.

---

### 2.2 Pattern Spotter — event-driven trigger or fold into shared scan

**Location:** [patternSpotter.ts:70-132](../apps/extension/src/detection/patternSpotter.ts#L70-L132)

**Current behavior:** `setInterval(30s)` polling timer. Strict gates today (≥30 edits, ≥60s idle, ≥15min cooldown, 24h per-concept dedup). Cost is small today (~1 pitch/hour) but the **timer-based trigger model is fragile** — any future loosening of gates bursts cost.

**Fix (option A, smaller):** Replace `setInterval` with event-driven trigger. Subscribe to the concept-detection pipeline; fire `maybeFire` when a meaningful concept is detected in user's edit, not on a clock.

**Fix (option B, architectural):** Fold into a shared scan coordinator. Vibe Brief, Pattern Spotter, File Open Greeter, Project Map summaries all want "what's interesting about this code." One call, multiple consumers.

Option B is the right long-term answer but is ~1 week of design work. Do option A first, then migrate to B once shared scan exists.

**Effort:** A = 1 day, B = 1 week. **Savings:** moderate today, large reduction in future blast radius.

---

### 2.3 Project Map file summaries — heuristic-first (shares code with 1.2)

**Location:** [projectMap.ts:232](../apps/extension/src/workspace/projectMap.ts#L232)

**Current behavior:** When user clicks a file in Map tab, sends 200 lines + prompt → 2-sentence summary. ~700 tokens per click. 24h cache by file-hash, but cold-start on a fresh repo = N files × 700 tokens.

**Fix:** Same heuristic-first treatment as File Open Greeter (1.2). Imports + exports + first comment cover ~80% of summaries. LLM fallback only for low-confidence cases.

Should share the heuristic module with the greeter — single source of truth for "describe this file structurally."

**Effort:** ~1 day after 1.2 lands (mostly reuse). **Savings:** ~70% on map summary cost.

---

## Tier 3 — Already correct, do not touch

| Feature | Why it's fine |
|---------|---------------|
| **AI Explain Error** | 3-tier cache (memory → 50 regex templates → LLM). 85% of unique errors handled before LLM. Use as the reference design. |
| **Concept Tips** (`aiGenerateTip`) | Backend Supabase batch endpoint with cross-user cache. Generated once globally per `(language, concept)`. Per-user marginal cost ≈ $0. |
| **Struggle Chip** | LLM only on user click. Chip surface is driven by free heuristic signals (error_persists, struggle_cluster, build_fail_loop, stare_pause). |
| **Teach Concept dispatch** | User-pulled (command click). |
| **Inline Errors quick-fix** | User-pulled (CodeAction click). |

---

## Cross-cutting infra (do alongside Tier 1)

### Infra A — Per-feature LLM budget envelope

**Today:** [aiBackend.ts](../apps/extension/src/ai/aiBackend.ts) has `consumeAutoBudget` for `kind: scan` but it's global, not per-feature. One misbehaving feature can drain the whole hourly budget.

**Fix:** Per-feature buckets with hard caps. Surface remaining budget in dev mode (Live Review status bar already shows scan state — extend it). When a feature's budget is exhausted, fall back to last cached output instead of silently dropping the call.

**Config-driven:**
```ts
const FEATURE_BUDGETS = {
  patternSpotter:     { calls: 4,  window: "1h",  tier: "cheap" },
  vibeBrief:          { calls: 12, window: "1h",  tier: "cheap" },
  fileOpenGreeter:    { calls: 8,  window: "1h",  tier: "cheap" },
  architectureTour:   { calls: 3,  window: "1d",  tier: "cheap" },
  projectMapSummary:  { calls: 30, window: "1d",  tier: "cheap" },
  // user-pulled features have no budget (uncapped)
} as const;
```

**Effort:** ~2 days. **Savings:** future-proofing — caps the worst case before it becomes a bill.

---

### Infra B — Shared content-hash cache for "describe this code" prompts

**Use case:** Vibe Brief, File Open Greeter, Project Map summaries, Architecture Tour all describe code regions that don't change between calls.

**Fix:** Single shared module: `aiDescribeCache(content: string, kind: "file" | "paste" | "snippet"): Promise<string>`. SHA1 the input, key the LLM output, persist to globalState. Re-render = cache hit.

**Effort:** ~1 day. **Savings:** compounding across Tier 1 + 2 features. Especially valuable for users who reopen the same files repeatedly.

---

## Two-week shipping plan

| Day | Item | Effort |
|-----|------|--------|
| 1 | Live Review health timer fix (1.1) | 1 hour |
| 1–2 | Per-feature budget infra (A) | 2 days |
| 2 | Shared content-hash cache (B) | 1 day |
| 3–4 | File Open Greeter heuristic-first (1.2) | 2 days |
| 5–7 | Vibe Brief split prompt + AST module (1.3) | 3 days |
| 8 | Architecture Tour sequential + cheap tier (2.1) | 1 day |
| 9 | Project Map summaries heuristic (2.2, reuses 1.2) | 1 day |
| 10 | Pattern Spotter event-driven trigger (2.3 option A) | 1 day |

**Outcome:** ~70% reduction in passive LLM cost per active user, zero user-visible regression. Pattern Spotter option B (shared scan coordinator) deferred to next sprint.

---

## CEO talking points

1. **The problem is not what the product does — it's how it was wired.** The good cache pattern (AI Explain) already exists in our codebase; it just didn't propagate to other features.
2. **Two of the five named features are already well-designed** (AI Explain, Concept Tips). One is genuinely user-pulled and fine (Struggle Chip).
3. **The two structural offenders are File Open Greeter and Vibe Brief** — they pay full LLM cost for outputs that are 70–80% derivable from AST + ownership data.
4. **Live Review's idle health timer alone costs more than every other feature combined.** That's the headline.
5. **Tier 1 = ~6 days of engineering. After it ships, per-user LLM cost drops by ~70%.** Without it, the unit economics don't work at scale.
