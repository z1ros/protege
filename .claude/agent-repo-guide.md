# Agent Repo Guide — Protege

**Project owner and principal architect:** Yurii Tovarnytskyi (GitHub `@z1ros`).
Protege is his project; he founded the repository, set its architecture, and authored the majority of the codebase. Direct product and architectural questions to him.

**Who this guide is for:** spawned subagents, contractors, and teammates working in this repo. Read this first. It is deliberately terse — links to deeper docs at the bottom.

**What Protege is:** an AI coding mentor that lives inside VS Code. It watches the user code, detects the concepts they use, tracks their behavior over time, and teaches on demand. It ships as a VS Code extension + a Hono backend + a shared types package.

**Status:** extension version 0.1.7, published to the VS Code Marketplace under publisher `protege-ai`. Backend deployed on Railway, Postgres on Supabase.

**Repo root:** `/Users/Yura/Documents/GitHub/protege`

For the full authorship and contribution record, see [CONTRIBUTION-HISTORY.md](../CONTRIBUTION-HISTORY.md).

---

## 1. Top-level layout

pnpm monorepo, three workspaces:

```
apps/
  backend/            Hono API server. JSON-file store + Supabase Postgres.
  extension/          VS Code extension (Node) + React sidebar webview (Vite).
packages/
  types/              Shared TS types. ESM-only. Main = src/index.ts (no build).
Architecture/
  full-architecture.md      System doc. Mixes current state and aspiration.
  llm-cost-followups.md     Known per-user cost risks and their fixes.
  supabase-schema.sql       Postgres schema.
Vision/                     Product direction docs.
scripts/                    Git hook installer, TEAM_OVERRIDE build guard.
.claude/                    Claude Code config, agent prompts, this guide.
```

Root `package.json` has `dev:backend`, `dev:extension`, `build`, `typecheck`. Run individual packages with `pnpm --filter @protege/<name> <script>`.

---

## 2. Extension (`apps/extension`)

### Entry point
`src/extension.ts` — `activate(context)` wires every subsystem. Scan this file first when you need to know whether something is actually wired up. Subsystems follow an `initX(context, ...)` / `registerX(context, ...)` pattern, and each returns disposables pushed onto `context.subscriptions`.

### Source layout

Source is organized into feature folders under `apps/extension/src/`. **This structure is the result of an April 2026 reorganization — older docs and comments referencing flat paths like `src/analyzer.ts` are stale.**

| Folder | Files | What lives there |
|---|---|---|
| `review/` | 13 | Scan tiers and code review: `analyzer.ts` (local AST, no API call), `liveReview.ts`, `findingGate.ts`, decorations |
| `teaching/` | 12 | Learning Mode, lesson sessions, micro-step teaching |
| `hints/` | 15 | Inline hint surfaces, hover tips, CodeLens |
| `echo/` | 16 | Behavior-observation subsystem (see §4) |
| `chat/` | 6 | Mentor chat panel plumbing |
| `watcher/` | 8 | Event bus + triggers + dispatcher for unprompted nudges |
| `voice/` | 7 | Wake word, STT/TTS client, voice session state |
| `concepts/` | 6 | Concept detection and taxonomy mapping |
| `detection/` | 7 | Language/framework detection |
| `intent/` | 7 | Intent classification for user turns |
| `user/` | 8 | `protegeClient.ts` (`BACKEND_URL`, `getUserId`), `auth.ts` (`authHeaders`) |
| `ai/` | 5 | `tools.ts` — client-side tool definitions |
| `commands/` | 8 | Command-palette handlers |
| `walk/` | 3 | Guided code walkthrough |
| `workspace/` | 3 | `workspaceIndex.ts` (regex import graph), `projectMap.ts` (AI file summaries) |
| `notes/`, `settings/` | 1 each | Notes surface, settings surface |

Top-level files: `extension.ts` (entry), `panel.ts` + `launcher.ts` (sidebar webview lifecycle), `log.ts` (the `Protege` OutputChannel — **use this, not `console.log`**, which only shows in Developer Tools), `devMode.ts`, `iqV2.ts`.

### Webview (React, Vite)
Sources in `apps/extension/webview/`. Main panel = `App.tsx`; separate Echo dashboard under `webview/echo/`. Vite dev server runs on :5173; in dev the HTML swaps to `http://localhost:5173/...` for HMR (see `vite.config.mts` comments). Build output: `dist/webview/` (+ `dist/webview/echo/`).

### Build
- Extension: `tsup` bundles `src/extension.ts` → `dist/extension.js` (CJS, node18). `noExternal: [/^@protege\//]` — the types package is inlined because it ships as raw ESM TypeScript.
- Run `pnpm build:ext` **from `apps/extension/`**, not from the monorepo root.
- The production build **refuses to run** when `teamOverride.local.ts` sets `TEAM_OVERRIDE = "local"`. This is a deliberate guard against shipping a dev backend URL to the marketplace. For a local dev build, bypass with:
  `pnpm exec cross-env NODE_ENV=development tsup`
- Every `vscode.commands.registerCommand(...)` needs a matching entry in `package.json` under `contributes.commands`, or it won't appear in the palette and VS Code won't activate on it.

### Import rule (important)
All local imports use `.js` extensions even though the sources are `.ts`. This matches TS ESM resolution. `import { x } from "./foo"` will fail typecheck.

---

## 3. Backend (`apps/backend`)

### Entry point
`src/index.ts` — Hono app, CORS, error handler, routes mounted under prefixes. Port from `PORT` env var, default 8787.

### Routes (`src/routes/`)

| Prefix | File | Purpose |
|---|---|---|
| `/chat` | `chat.ts`, `chatHistory.ts` | Mentor chat + history |
| `/analyze` | `analyze.ts` | File analysis |
| `/concept-used` | `concept.ts`, `conceptTips.ts` | Concept recording and tips |
| `/me` | `me.ts` | User snapshot (IQ, streaks) |
| `/tts`, `/stt` | `tts.ts` | Voice synthesis / transcription |
| `/voice` | `voice.ts` | Voice pipeline |
| `/memory` | `memory.ts` | LLM memory |
| `/notes` | `notes.ts` | User notes |
| `/preferences` | `preferences.ts` | User prefs |
| `/classify` | `classify.ts` | Intent classification |
| `/verify` | `verify.ts` | Verification surface |
| `/walk` | `walk.ts` | Guided walkthrough |
| `/echo` | `echo.ts` | Behavior dashboard (see §4) |
| `/test` | `test.ts` | Smoke/diagnostic |

### Supporting modules
`llm.ts` (provider routing + cost model), `openai.ts`, `anthropicFallback.ts`, `quotas.ts` (daily token cap), `embeddings.ts`, `kokoro.ts` (on-device TTS), `lessons.ts` + `lessons-fallback-plans.ts`, `memoryReconciler.ts`, `milestones.ts`, `iqV2.ts`, `aiTools.ts` (server-side tool defs), `voicePostProcess.ts`, `supabase.ts`, `store.ts`.

### Store
`src/store.ts` — JSON-file-backed persistence at `.protege-store.json`, created in `process.cwd()`. The `StoreShape` interface lists every table. `load()` caches at module scope; `save()` writes the whole file. All mutators are async.

Adding a persistence table: add the field to `StoreShape`, add hydration in `load()`, add a default in the fresh-store block, add read/write exports.

### Migrations
`apps/backend/migrations/` — numbered SQL, applied against Supabase:
`001_idempotency_and_atomic_authorship`, `002_concept_tips`, `003_beta_sync_tables`, `004_revoke_anon_legacy_tables`, `005_token_tracking`.

### Env
`apps/backend/.env.example` — copy to `.env`. Needs `ANTHROPIC_API_KEY`. Optional: `OPENAI_API_KEY` (STT), plus Supabase keys.

---

## 4. Echo subsystem (behavior dashboard)

A large cross-cutting feature: the extension observes coding behavior, the backend aggregates it, the webview renders widgets.

### Extension side (`apps/extension/src/echo/`)
- `batcher.ts` — queues `EchoEvent` in memory, flushes to `/echo/events` every 2 min. Survives restart via `globalState`. `getBatcher()!.onPush(cb)` subscribes to every push (used by Event Stream + commit watcher).
- Event producers: `sessionTracker.ts`, `lineDiffer.ts`, `cohortTracker.ts`, `pasteClassifier.ts`, `gitCommitWatcher.ts`, `conceptAnalyzer.ts`, `workspaceConceptScanner.ts`.
- `eventStream.ts` — diagnostic OutputChannel `"Protege Echo Events"`.
- `storeDiff.ts` — diagnostic: prompts for minutes, fetches `/echo/debug/recent`, prints to the `"Protege Echo Store Diff"` channel.
- `panel.ts`, `dashboardView.tsx`, `storyModeView.tsx` — dashboard webview shell.
- `widgets/` — one React component per widget.
- `index.ts` — `initEcho(context, userId, log)` wires all of the above.

### Backend side (`apps/backend/src/echo/`)
- `widgets/wN_*.ts` — one aggregator per widget, each exporting `assembleXPayload(userId, windowStart, windowEnd)`.
- `jobs.ts` — nightly rollup, cohort survival, archetype classifier.
- `util/shared.ts` — helpers (`dateKey`, etc.).

### Event flow
1. An extension subsystem emits an `EchoEvent` → `getBatcher().push(event)`.
2. The batcher POSTs to `/echo/events` in chunks. The handler in `routes/echo.ts` validates, appends to the `echoEvents` table, and triggers **side effects** on known types (authorship bumps, cohort rows, commit enrichment, concept encounters) — see the per-type blocks in that loop.
3. Widget aggregators read store rows and return payloads via `GET /echo/dashboard`.

### Event types
The `EchoEvent` union lives in `packages/types/src/index.ts`. All events carry `type` + `ts`. Common: `keystroke_batch`, `line_diff`, `concept_encountered`, `file_snapshot`, `ai_suggestion_accepted`, `paste_classified`, `session_tick`, `session_boundary`, `commit_detected`.

### Debug
- `GET /echo/debug/recent?since=<ms>&userId=<id>` — rows changed since a timestamp (used by the Store Diff Inspector command).
- Live stream: run `Protege: Show Echo Event Stream` from the palette.

---

## 5. Shared types (`packages/types`)

No build step. Other packages import `@protege/types`, which resolves to `packages/types/src/index.ts` directly as ESM TypeScript. The extension's tsup config sets `noExternal: [/^@protege\//]` to inline it into the CJS bundle.

`src/index.ts` re-exports everything. Sub-files: `concepts.ts` (concept taxonomy), `lineDiff.ts` (pure line-diff helper, extracted so extension and backend tests share it).

---

## 6. Running the repo

```bash
# From repo root:
pnpm install               # once — also installs git hooks and pre-downloads Kokoro TTS
pnpm dev:backend           # Hono on :8787 with tsx watch
pnpm dev:extension         # parallel tsup --watch + vite on :5173
pnpm -r typecheck          # every workspace
pnpm -r build              # production build
```

Re-run `pnpm install` after every `git pull` to keep git hooks in sync. Extension live-reload needs both `dev:extension` processes running; then launch via F5 (VS Code extension host) or by packaging.

---

## 7. Tests

Backend only. Framework: **vitest 2.x**. Test files sit alongside sources as `*.test.ts`. Config: `apps/backend/vitest.config.ts` — `include: ["src/**/*.test.ts"]`, `environment: node`.

### Running
```bash
pnpm --filter @protege/backend test         # one-shot
pnpm --filter @protege/backend test:watch   # watch

# From apps/backend:
pnpm vitest run src/echo/isoWeek.test.ts    # single file
pnpm vitest run -t "archetype"              # by name pattern
pnpm vitest run <path> --reporter=verbose   # verbose
```

### Existing suite — 14 files, 172 tests, ~1s

| File | Proves |
|---|---|
| `src/store.test.ts` | Store load/save/mutator behavior |
| `src/quotas.test.ts` | Daily token cap enforcement |
| `src/middleware/auth.test.ts` | Auth middleware |
| `src/chat/historyTrim.test.ts` | Conversation-history trimming for long sessions |
| `src/routes/chat.gap.test.ts` | Chat gap handling |
| `src/routes/analyze.test.ts` | Analyze route |
| `src/routes/echo.test.ts` | `sanitizeLanguage`, `isSafeWorkspacePath`, `isSafeBatchFilePath` |
| `src/echo/lineDiff.test.ts` | `computeLineDiff` — counts, rewrite fingerprints, blank lines, swaps |
| `src/echo/computeAuthorshipRatio.test.ts` | `computeAuthorshipRatio` — 0/0→null, NaN→null, 7+3→0.7 |
| `src/echo/isoWeek.test.ts` | ISO-week math incl. year-boundary edges |
| `src/echo/conceptAuthoredFlag.test.ts` | `setConceptAuthoredFlag` stickiness |
| `src/echo/sync.test.ts` | Echo sync |
| `src/echo/widgets/w15_conceptsCovered.test.ts` | `bucketFor` — sticky flag wins, 0.5 threshold |
| `src/echo/widgets/w2_polar.test.ts` | `archetypeForPeak` — every hour band and boundary |

### Adding a test
Drop `foo.test.ts` next to `foo.ts`; vitest picks it up.

```ts
import { describe, it, expect } from "vitest";
import { myFn } from "./myModule.js";   // note the .js — ESM TS rule, see §2

describe("myFn", () => {
  it("does the thing", () => {
    expect(myFn(1)).toBe(2);
  });
});
```

### Store isolation pattern
The store is JSON-file-backed at `process.cwd() + "/.protege-store.json"` with a module-level cache, so tests touching it must isolate:

```ts
beforeEach(async () => {
  vi.resetModules();                 // drop the cached store module
  origCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "protege-test-"));
  process.chdir(tmpDir);
});
afterEach(() => { process.chdir(origCwd); });

const store = await import("../store.js");   // dynamic, so it captures tmpDir
```

### Pure-function tests (preferred)
Put new logic in its own exported function and test that directly. Existing examples: `computeLineDiff` (`packages/types/src/lineDiff.ts`), `computeAuthorshipRatio` (`store.ts`), `bucketFor` (`w15_conceptsCovered.ts`). If the target is module-private, adding `export` is a behavior-preserving change and fine to do in a test PR.

### The extension has no tests
No vitest config in `apps/extension`. For pure extension logic worth testing, either extract it into `packages/types/` and test from the backend, or set up vitest there (copy `apps/backend/vitest.config.ts` + add the `vitest` devDep).

### Before committing
```bash
pnpm --filter @protege/backend test && pnpm -r typecheck
```

---

## 8. Gotchas

- **ESM `.js` on imports.** Sources are `.ts` but local imports must end in `.js`. tsc, tsup, and vitest all agree on this.
- **Log through `log.ts`.** Protege uses a custom `Protege` OutputChannel. `console.log` only surfaces in Developer Tools, not the Output panel.
- **`TEAM_OVERRIDE` must never ship.** `teamOverride.local.ts` points the extension at a local backend. Three guards exist (`scripts/check-team-override.sh`, a build-time refusal, a pre-commit hook). Don't defeat them; use the `NODE_ENV=development` bypass in §2 for local builds.
- **tsup `noExternal`.** `@protege/types` is inlined because it ships raw TS-ESM. New shared workspace packages need the same treatment in `apps/extension/tsup.config.ts`.
- **Store stickiness invariants.** A concept's `hasBeenAuthored` is append-only true; `firstAuthoredAt` is set once and never overwritten. `setConceptAuthoredFlag` is the ONLY writer — don't mutate `concepts[].hasBeenAuthored` anywhere else.
- **Rate limits.** `routes/echo.ts` enforces per-user windows on `/events`, `/commits`, `/repo-scan`. Copy `checkRateLimit` rather than bypassing it in new endpoints.
- **`process.cwd()` matters.** The store file resolves against cwd at the first `load()`. Running the backend from a different directory gives you a different store.
- **Commands need two places.** Registration in code *and* an entry in `contributes.commands`.
- **Dual IQ engines.** `store.ts` holds IQ v1; `iqV2.ts` holds v2 (six pillars: Craft, Range, Velocity, Debug, Quality, Independence). Both run in parallel during the transition and can drift. Editing IQ math means checking both.
- **Paused teaching surfaces are intentional.** `FindingCodeLensProvider` is instantiated but never registered, and the `inlineErrors` / `peekTeach` / `didYouKnow` / `inlineLessonComment` imports in `extension.ts` are commented out. They're pending redesign, not bugs — don't "fix" them.
- **Skill taxonomy is webview-only.** `apps/extension/webview/skills-taxonomy.json` (260KB, 1000+ concepts) is bundled into the webview, not synced from the backend. Changes need a rebuild, not a backend restart.
- **OAITurn in, Anthropic out.** `/chat` accepts the OpenAI-compatible `OAITurn` shape from `packages/types` and translates to Anthropic internally, keeping a provider swap cheap. Don't send Anthropic-shaped messages to `/chat`.
- **Prompt caching is on.** `/chat` and `/analyze` mark the system prompt and tool defs with `cache_control: ephemeral`. Editing those strings invalidates the cache.
- **Tool names are mirrored.** The chat flow exposes `read_file`, `list_files`, `grep`, `show_code`, `highlight_code`, `clear_highlights`, `edit_file`, `teach_step`, `remember`, `forget` — defined in `apps/extension/src/ai/tools.ts` and mirrored in `apps/backend/src/aiTools.ts`. Adding one means updating both. `create_file` was deliberately removed.
- **Smart-routing budget.** Target is ~5–10 Anthropic calls/hour, versus 50–100 naive. The watcher has a budget plus suppression (3 dismissals → mute). Don't add polling loops that defeat it.
- **Known cost risk.** The Live Review idle timer is documented in `Architecture/llm-cost-followups.md` as roughly $4/idle user/day if left unoptimized.
- **Voice brevity is voice-only.** Short replies, the `max_tokens` cap, and `trimForVoice` apply to voice modes only. Chat stays long-form.
- **No emojis in UI copy.** Use words, SVGs, or color shifts.

---

## 9. When to read what

| You're doing... | Read first |
|---|---|
| Adding a backend route | `apps/backend/src/index.ts` + an existing `routes/*.ts` |
| Adding a store table | `apps/backend/src/store.ts` (hydration + shape) |
| Adding an Echo event type | `packages/types/src/index.ts` (EchoEvent union) + the `routes/echo.ts` side-effect loop |
| Adding an Echo widget | `apps/backend/src/echo/widgets/w*.ts` (aggregation) + `apps/extension/src/echo/widgets/*.tsx` (rendering) |
| Adding an extension command | `apps/extension/src/extension.ts` + `package.json` `contributes.commands` |
| Adding a webview | `apps/extension/vite.config.mts` `rollupOptions.input` + `apps/extension/webview/` |
| Touching LLM cost or quotas | `apps/backend/src/llm.ts`, `quotas.ts`, `Architecture/llm-cost-followups.md` |
| Big-picture system | `Architecture/full-architecture.md` (long, partly aspirational) |
| Who built what / project history | `CONTRIBUTION-HISTORY.md` |
| Publishing the extension | `apps/extension/PUBLISHING.md` |

---

## 10. Don't-do-this list

- Don't add comments that explain what the code does. Names already do that.
- Don't add backwards-compat shims for code that's less than a day old.
- Don't introduce new dependencies without checking whether something already in the tree covers it.
- Don't edit `.protege-store.json` by hand — it's a cache. Delete it for a fresh state.
- Don't use `--no-verify` on commits.
- Don't push without the owner asking.
