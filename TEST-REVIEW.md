# Test Suite Review — Senior Engineer Pass

**Date:** 2026-05-11
**Scope:** apps/backend + apps/extension
**Suite size:** 37 test files, 347 tests, **all green**, runs in <2s end-to-end
**Reviewer mode:** read-only audit, no code changes

---

## TL;DR

The suite is **healthier than it looks at first glance** — 30 backend + 7 extension test files, deterministic, fast, no `.skip`/`.only`, no real network or DB I/O leaking in. Quality of the existing tests is generally **strong**: contract-style assertions, proper teardown, fake timers used correctly.

The real problem is **coverage breadth, not test quality**. Multiple HIGH-risk surfaces are entirely untested:
- Money/cost path: `llm.ts` cost math, `routes/chat.ts` main streaming endpoint, `routes/tts.ts`, `routes/voice.ts`
- Persistence: `supabase.ts` (~1300 LOC, 30+ DB mutations, zero tests)
- Memory mutations: `memoryReconciler.ts`
- AI tool routing: `aiTools.ts`, `anthropicFallback.ts`
- Several routes that mutate state (`preferences`, `verify`, `notes`, `memory`, `me`)

Reliability concerns are minor and fixable. Effectiveness concerns center on the two oldest test files (`quotas.test.ts`, `store.test.ts`) which have known gaps in their own source coverage.

---

## 1. Reliability — Are tests deterministic and trustworthy?

**Verdict: PASS, minor cleanup.**

What I checked and what I found:

| Anti-pattern | Result |
|---|---|
| `.skip` / `.only` / `todo` left in code | None found |
| Real network calls (`fetch`, `http.request`) | None found |
| Real DB connections (`new Pool`, `createClient` without mock) | None — Supabase mocked, store uses tmp dirs |
| Real `setTimeout`/`setInterval` outside fake-timer scopes | Only intentional microtask flushes in `routes/analyze.test.ts:144-145` and `rollups.test.ts` (vscode setTimeout-window — documented in comments) |
| Order-dependent tests / shared module state | `store.test.ts` uses `vi.resetModules()` per test — proper isolation |
| Hidden side effects (writes to repo root, cwd pollution) | `store.test.ts` does `process.chdir(tmpDir)` and restores — clean |
| Snapshot overuse | None — assertions are explicit |

Notes:
- `routes/analyze.test.ts:144-145` uses two raw `setTimeout(r, 0)` awaits to flush microtasks; commented as intentional. Fine, but a helper `flushMicrotasks()` would document intent.
- Several tests rely on Hono test client + module-level mocks. Pattern is consistent — good.

---

## 2. Effectiveness — Do assertions catch real regressions?

**Verdict: MOSTLY YES. Two legacy files have soft spots.**

### Strong (keep as model)
- `store.test.ts` — Contract-style: A (concurrent serialization), B (batch flush count), C (per-user cap isolation). Spies on real `fs.writeFile` to verify actual I/O batching. These tests *will* catch regressions.
- `routes/echo.test.ts` (32 tests) — Exercises actual HTTP surface.
- `iq3/__personas__/v2.test.ts` — Deterministic snapshot of an entire scoring pipeline across archetypes. High signal.
- `middleware/auth.test.ts` (19 tests) — Auth boundary properly covered.
- `iq3/fieldClassification*.test.ts` — 38 + 7 tests including a "contested fixtures" suite that's intentionally informational (logs expected vs got). Mature.

### Soft (need extension)

**`quotas.test.ts`** — Solid mock harness but:
- 2 of 9 exports untested: `getQuotaProbeStatus()`, `probeQuotaTable()` (5 status branches, RLS errors, migration-error path)
- `addCostUsd(..., tokens)` token branch not exercised
- `PROTEGE_QUOTAS` gate flag bypass path not tested
- No invalid `QuotaKind` rejection test

**`store.test.ts`** — Core contracts are excellent. But 6 of 12 exports skipped at this file's level (some now covered by sibling test files):
- `computeAuthorshipRatio()` — now covered in `echo/computeAuthorshipRatio.test.ts` ✓
- `isoWeek()` — now covered in `echo/isoWeek.test.ts` ✓
- `getStreak()`, `touchFile()`, `echoBootstrapIfNeeded()` idempotency — still untested
- Per-user cap edge case "cap-1 rows + 1 added → exactly 1 evicted" not asserted

---

## 3. Currency — Do tests track the code?

**Verdict: CURRENT.**

- `iqV2.ts` logs `[iqV2] DEPRECATED — migrate callers to iq3. v2 will be removed in the next release.` during `conceptAuthoredFlag.test.ts` and `persistence.test.ts`. **Verified mid-migration, not orphaned:** `computeIqV2` is still called in `store.ts:1721`, returned via `routes/me.ts:72`, and consumed by the extension webview (`ConceptsDashboard.tsx`, `App.tsx`, `ConceptsTab.tsx`). The `@deprecated` header at `iqV2.ts:15-20` explicitly states the file is kept "for one release cycle so existing webview code can read v2-shaped pillars while migration completes." Log noise is intentional and one-shot (guarded by `_iqV2Warned` at `iqV2.ts:22`). **Action:** track the iq3 migration to completion; do not delete `iqV2.ts` until webview + `store.ts` + `routes/me.ts` callers are gone.
- Recent commits (`chore(types): remove deprecated chat/getFullHistory`, `chore(extension): initialize chat sessions on activation`) — no orphan tests reference removed APIs. Clean.
- No `xit`/`xdescribe` markers — nobody is parking failing tests.

---

## 4. Coverage gaps — What's missing, ranked

### P0 — Ship-blocker / risk to money or data

| File | Why P0 | Suggested test |
|---|---|---|
| `apps/backend/src/llm.ts` | Provider routing + **cost calculation**. Wrong math → bill spikes. | Unit: mock OpenAI/Anthropic SDKs, assert cost = tokens × price_per_token for each model, assert fallback path on provider error |
| `apps/backend/src/routes/chat.ts` | Main streaming endpoint, quota enforcement mid-stream, tool execution cost deduction. `chat.gap.test.ts` exists but only covers the **gap-detection** sub-flow. | Integration: Hono test client + mock LLM + mock quotas; assert quota-exhausted aborts stream cleanly, cost is deducted post-tool, malformed tool args don't crash |
| `apps/backend/src/middleware/quota.ts` | Quota interceptor — bypass = free dollars. Day-boundary reset math. | Unit: `enforceQuotaInline` + `enforceCostCapOnly` with frozen clock at 23:59:59, 00:00:00, 00:00:01 UTC; assert reset only at midnight UTC, not local |
| `apps/backend/src/supabase.ts` | ~30 DB mutation helpers, zero tests. Idempotency, retry behavior, RLS error handling all unverified. | Contract tests against a real Supabase test schema OR a tested mock layer; assert UPSERTs are idempotent under retry |
| `apps/backend/src/memoryReconciler.ts` | Decides ADD/UPDATE/DELETE on user memory. Bug = silent corruption + wrong AI context. | Unit: feed reconciler synthetic before/after states, assert decision matrix |
| `apps/extension/src/intent/classifier.ts` | Routes user message → task shape. Wrong route = wrong command fires. Tier fallback (LLM → regex) is security-relevant. | Unit: cache hit/miss/TTL expiry, tier fallback cascade, confidence threshold flips |
| `apps/extension/src/watcher/dispatcher.ts` + `budget.ts` | Nudge gating, suppression, TrustBudget. Bugs = spam users or burn budget. | Unit: state-machine inputs → expected dispatch decision, budget depletion edge cases |

### P1 — Core logic, silent-failure risk

| File | Why P1 |
|---|---|
| `apps/backend/src/routes/voice.ts`, `routes/tts.ts` | Untested. Audio encoding + cost-per-second. Mock TTS provider; assert error paths. |
| `apps/backend/src/routes/verify.ts` | Auth-adjacent verification flow. |
| `apps/backend/src/routes/preferences.ts` | Mutation endpoint — voice + channel preferences. |
| `apps/backend/src/lessons.ts` | `planLesson`, `validateStepReply`, `isCleanMasteryPass`, `classifyFirstMessageLLM` — mastery detection. Wrong pass = user stuck. |
| `apps/backend/src/embeddings.ts` | `embed()`, `embedMany()`, similarity math. Silent failures → bad semantic search. |
| `apps/backend/src/aiTools.ts`, `anthropicFallback.ts` | Tool routing + fallback. Untested. |
| `apps/backend/src/echo/widgets/w1_hero, w10_rewritten, w11_commits, w12_saveTape, w14_independence, w16_conceptsMomentum, w17_repoConcepts, w5_heatmap, w8_lines` | 9 of 11 widgets untested. Widget math feeds the user dashboard — wrong aggregation = wrong analytics shown to users. Pattern: w2_polar + w15_conceptsCovered are model tests; mirror them. |
| `apps/extension/src/concepts/astDetector.ts` | AST walk for concept detection. Bugs = false positives in learner model. Pure logic, easy to test with toy TS sources. |
| `apps/extension/src/commands/compare.ts, fixIt.ts, explainSelection.ts, quizMe.ts, summarizeFile.ts, weakSpots.ts` | Prompt assembly + response parsing — extract these as pure functions and test independently of vscode.diff UI. |
| `apps/extension/src/chat/chatRunner.ts`, `chatHistory.ts`, `responseRouter.ts` | Chat lifecycle is partially tested (`chatSessions.test.ts`, `shouldSpeak.sim.test.ts`); fill the gaps. |

### P2 — Defer

| File | Note |
|---|---|
| `routes/me.ts, memory.ts, notes.ts, concept.ts, conceptTips.ts, classify.ts, walk.ts` | Mostly thin CRUD over Supabase; cover once `supabase.ts` has a tested layer underneath. |
| `kokoro.ts`, `openai.ts` | SDK wrappers — low risk once `llm.ts` is tested. |
| `milestones.ts` | Analytics-adjacent; low blast radius. |
| `iqV2.ts` | **Do not test, do not delete yet** — mid-migration to `iq3/`, kept for webview compatibility. Remove after webview + `store.ts` + `routes/me.ts` callers migrate. |
| `voicePostProcess.ts`, `lessons-fallback-plans.ts` | Test if/when they grow logic. |
| Extension `teaching/`, `review/`, `user/`, `workspace/` | UI-coupled. Defer unless an e2e harness lands. |

---

## 5. Specific findings — file:line refs

- `apps/backend/src/quotas.test.ts` — add tests for `probeQuotaTable()` (5 status branches) and `getQuotaProbeStatus()`. Source: `quotas.ts`.
- `apps/backend/src/store.test.ts:contract-C` — add edge case: cap-1 rows + 1 added → exactly 1 evicted (currently asserts "doesn't affect other users" but not the eviction count itself).
- ~~`apps/backend/src/routes/analyze.test.ts:144-145` — extract `flushMicrotasks()` helper.~~ **Already exists** as `flushAsyncWrites()` at lines 143-146. No-op.
- ~~`apps/backend/src/iqV2.ts` — confirm zero callers, then remove.~~ **Verified live caller graph:** `store.ts:1721`, `routes/me.ts:72`, extension webview. Mid-migration per file-level `@deprecated` doc. Do not delete. Track iq3 migration progress instead.
- `apps/backend/src/routes/chat.ts` — `chat.gap.test.ts` covers gap detection only. Add a full streaming integration test for the main `POST /chat` path.

---

## 6. Recommended order of work

1. **Week 1 — money & data integrity:** `llm.ts` cost tests, `routes/chat.ts` streaming integration, `middleware/quota.ts` UTC reset boundary, `memoryReconciler.ts`.
2. **Week 2 — persistence layer:** `supabase.ts` — pick a strategy (test schema vs contract layer) and cover the 30+ mutations. This unlocks tests for `routes/me, memory, notes, preferences, verify`.
3. **Week 3 — extension P0:** `intent/classifier.ts`, `watcher/dispatcher.ts` + `budget.ts`, `concepts/astDetector.ts`.
4. **Week 4 — widget math & command prompt builders:** 9 untested echo widgets; refactor command files to extract pure functions then test.
5. **Ongoing:** close the quota/store gaps from §2 (`probeQuotaTable` branches, eviction-count edge). Track iq3 migration so `iqV2.ts` can be removed when its caller graph empties.

---

## 7. CI hardening (not yet in place)

- Add `pnpm -r test` to a pre-push hook or CI workflow if not already (saw `.github/` but didn't open the workflow — confirm).
- Coverage thresholds: don't enforce yet — would block work. Track coverage trend, gate at 60% on the P0 files once they have tests.
- Flake watch: re-run the suite 50× in CI weekly; current suite is fast enough (<2s) that this is cheap.

---

**Bottom line:** existing tests are good. The work is breadth, not quality. Prioritize the cost path and persistence layer first — those are the surfaces where a silent bug costs real dollars or corrupts user data.
