# Pre-PR Bug-Fix Summary — `code-iq-research`

**Date:** 2026-05-11
**Branch:** `code-iq-research`
**Trigger:** multi-agent code review (security / reliability / cost / build) before opening PR
**Outcome:** 17 issues fixed in working tree; typecheck + tests green; ready to split into two PRs

---

## CRITICAL (8) — would have shipped broken or unsafe

### 1. EchoEvent discriminant collision broke typecheck
- **Where:** `packages/types/src/index.ts:1227` introduced a second `keystroke_batch` variant in the `EchoEvent` union with a different shape (`{file, chars}`) than the legacy variant (`{file, language, keystrokes, durationMs, charsTyped?}`).
- **Effect:** TS narrowing failed in `apps/extension/src/echo/eventStream.ts:75-80` and `storeDiff.ts:265`. Backend typecheck failed.
- **Fix:** renamed iq3 variant tag to `keystroke_burst`. Updated all 131 persona call sites + `iq3Hook` matcher OR clause.
- **Files:** `packages/types/src/index.ts`, `apps/backend/src/iq3/__personas__/v2-streams-A,B/index.ts`, `apps/backend/src/iq3/ingest/iq3Hook.ts`.

### 2. iq3 migration in wrong directory — tables never created in prod
- **Where:** `Architecture/migration-006-iq3-tables.sql` lived outside `apps/backend/migrations/`, so the runner skipped it. Also numbered `006`, colliding with `006_chat_sessions.sql`. Contained a stray `≈` character at EOF that breaks `psql`.
- **Effect:** in prod, every iq3 query would 500 because `iq3_user_state` / `iq3_self_ratings` / etc. don't exist.
- **Fix:** moved to `apps/backend/migrations/007_iq3_tables.sql`, stripped `≈`, deleted old file.

### 3. RLS disabled on all iq3 tables
- **Where:** original migration commented out `enable row level security` "for later when auth lands."
- **Effect:** anon-key holders (the extension ships one) could read/write every user's HMM state and self-ratings — by-design private behavioral fingerprint.
- **Fix:** enabled RLS on all 5 iq3 tables; revoked from `public, anon, authenticated`; granted to `service_role` only. Mirrors the chat_sessions pattern from migration 006.
- **File:** `apps/backend/migrations/007_iq3_tables.sql`.

### 4. Chat-sessions IDOR
- **Where:** `apps/backend/src/routes/chatHistory.ts:137-148` used `chat_sessions.upsert({...user_id: caller}, {onConflict: "id", ignoreDuplicates: true})` without checking existing-row ownership. `chat_messages.upsert({onConflict: "id"})` further allowed message overwrites by id-guess.
- **Effect:** attacker with a victim's `sessionId` could (a) attach attacker-authored messages to a victim-owned session row, and (b) overwrite a victim's message content by guessing message ids.
- **Fix:** added ownership pre-check (returns 403 if session belongs to a different user) and switched `chat_messages.upsert` → `.insert()` with idempotent `23505` handling.
- **File:** `apps/backend/src/routes/chatHistory.ts`.

### 5. `setInterval` leaked across extension reloads
- **Where:** `apps/extension/src/extension.ts:69` imported `disposeChatHistory` but never registered it. The hourly hydrate interval from `chatHistory.ts:43` survived reloads → accumulating timers + cloud GETs.
- **Fix:** pushed `vscode.Disposable(disposeChatHistory)` into `context.subscriptions` inside `initChatHistory`. Made `disposeChatHistory` idempotent.
- **File:** `apps/extension/src/chat/chatHistory.ts`.

### 6. `/iq/taxonomy` sync `readFileSync` on every unauth GET (DoS vector)
- **Where:** `apps/backend/src/iq3/routes/iq.ts:24-36` parsed two JSON files on every request, bypassing the cache in `taxonomyService.ts`.
- **Effect:** trivial DoS on an unauthenticated route.
- **Fix:** added `loadTaxonomy()` + `loadFieldTags()` cached accessors in `taxonomyService.ts`; rewrote the route to use them. First request pays the parse; subsequent requests return cached objects.
- **Files:** `apps/backend/src/iq3/taxonomyService.ts`, `apps/backend/src/iq3/routes/iq.ts`.

### 7. globalState race dropped chat messages on rapid send
- **Where:** `appendMessage` (`chatHistory.ts`) + `noteMessageAppended` (`chatSessions.ts`) both did unsynchronized read-modify-write on `globalState`. Back-to-back user→assistant appends both read the same pre-state → second write clobbered the first.
- **Fix:** introduced a per-module `writeQueue: Promise<void>` and serialized the read-modify-write inside the queued task (read happens *inside* the queue, not before it).
- **Files:** `apps/extension/src/chat/chatHistory.ts`, `apps/extension/src/chat/chatSessions.ts`.

### 8. `clearHistory` race resurrected just-deleted rows
- **Where:** `hydrateFromCloud` did DELETE-retry then immediate GET. Supabase eventual consistency could return the freshly-deleted rows from a stale read replica → cleared messages re-appeared in local cache.
- **Fix:** record `clearedAt: ISO` watermark in globalState on every clear. Hydrate filters cloud rows where `createdAt <= clearedAt`. Survives restarts.
- **File:** `apps/extension/src/chat/chatHistory.ts`.

---

## HIGH (9) — cost / reliability / hygiene

### 9. `/iq/me` polled every 30s — 95% of branch egress cost
- **Where:** `apps/extension/src/iq3/realtimeBridge.ts:18`.
- **Effect:** projected 115GB/mo egress at 1k DAU; `/iq/me` cold-read also re-`save`d initial state.
- **Fix:** `POLL_INTERVAL_MS` 30 s → 300 s. Dashboard replays last-known on mount, so UX unchanged.

### 10. realtimeBridge raw `fetch` bypassed 401 silent refresh
- **Where:** `realtimeBridge.ts:72-75` used raw `fetch` with manual `authHeaders()`.
- **Effect:** stale token wedged the dashboard in a permanent error state until manual `protege.refreshIQ`.
- **Fix:** switched to `authedFetch`. Treat `NotAuthenticatedError` as `signed-out`, not as a network blip.

### 11. `chatRunner` had no tool-call cap
- **Where:** `apps/extension/src/chat/chatRunner.ts:67` documented "no cap by user request."
- **Effect:** misbehaving tool-call chain could burn quota indefinitely.
- **Fix:** added `RUNAWAY_LIMIT = 200` (deliberately high — no legitimate request approaches it) as a safety net. Heartbeat log at every 25 rounds preserved.

### 12. `LIKELIHOODS.find()` was O(n) per event
- **Where:** `apps/backend/src/iq3/hmm.ts:59` — linear scan over 119 entries per event per trait.
- **Fix:** added `LIKELIHOOD_INDEX: Map<"${matchKey}::${trait}", entry>` in `likelihoods.ts`. O(1) lookup.

### 13. `userContexts` Map never evicted (OOM at scale)
- **Where:** `apps/backend/src/iq3/ingest/iq3Hook.ts:765`.
- **Effect:** projected ~800 MB RAM at 1k DAU. Also: throwing matcher poisoned the rolling-event buffer permanently because `recent.push` ran before the throw.
- **Fix:** LRU cap at 10k entries with recency-refresh on access. Per-matcher try/catch around `m(e, ctx)` so one buggy matcher cannot stall the pipeline.

### 14. `exerciseEngine` fired LLM verdict per keystroke
- **Where:** `apps/extension/src/teaching/exerciseEngine.ts:140-146` — `setTimeout(check, 1000)` on every `onDidChangeTextDocument` with no debounce reset.
- **Fix:** clear prior timer on each keystroke → trailing-edge debounce. Exactly one LLM call 1 s after the user stops typing.

### 15. No rate limit on `/chat-sessions` + `/chat-history`
- **Where:** routes had only auth gating, unlike `/echo/events` which already had a per-user limiter.
- **Fix:** extracted `apps/backend/src/middleware/rateLimit.ts` (`createRateLimiter` sliding window + bucket-sweep). Applied: 120 writes/min on `/chat-history`, 60 writes/min on `/chat-sessions` mutations. Reads unlimited.

### 16. `.lesson-sessions.json` dev runtime files committed
- **Where:** `apps/backend/.lesson-sessions.json` + `apps/extension/.lesson-sessions.json` tracked + mutated by dev runs.
- **Fix:** `git rm --cached` both, added pattern to `.gitignore`.

### 17. JSON fallback stores corrupted on concurrent writes + iq3 matcher buffer poisoning
- **Where:** `feedback.ts`, `selfRating.ts`, `persistence.ts` did read-modify-write on JSON fallback files with no mutex. Concurrent writes lost data and could corrupt the file mid-flush.
- **Fix:** new `apps/backend/src/iq3/jsonStore.ts` with `withJsonStoreLock` / `appendJsonRecord` / `upsertJsonRecord` — per-path serialized queue. All three sites switched over. Folded the matcher try/catch from item 13 here too.

---

## Verification

```
pnpm -r typecheck → 3/3 packages PASS
pnpm -r test      → 347/347 tests PASS (backend 308 + extension 39)
```

## Still outstanding (not blockers; track as follow-ups)

- Per-event `repo.save()` upsert in `iq3Hook.ts` — should batch / debounce. Highest remaining cost item even after the poll-interval bump.
- No dedicated test coverage for the new IDOR guard, taxonomy cache, race serialization, JSON-store mutex, LRU eviction, rate limiter — add `chatHistory.test.ts` + targeted unit tests.
- Sequential `DELETE /chat-sessions/<id>` calls in `webviewHost.ts:832` clear-all path — should `Promise.all`.
- 31k LOC bundled = unreviewable single PR. Recommended split: **PR 1 chat-sessions** (~2.5k LOC) + **PR 2 code-iq-v3** (stacked, ~28k LOC).

## Cross-reference

Full review reports: `TEST-REVIEW.md` (test-coverage audit, separate scope) and the multi-agent branch review previously generated at `/tmp/review-{backend-security,extension-reliability,cost-audit,build-tests}.md` + `/tmp/REVIEW-SUMMARY.md`.
