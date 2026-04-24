# Agent Repo Guide — Protege

**Who this is for:** spawned subagents and teammates working on this repo. Read this first. It is deliberately terse — links to deeper docs at the bottom.

**Project:** Protege — an AI coding mentor that lives inside VS Code. Watches the user code, detects concepts they use, tracks behavior, teaches on-demand. Ships as an extension + a Hono backend + shared types.

**Repo root:** `/Users/bohdan/Documents/IT-Work/Projects/IT/Work/Protege Startup /protege` (note the trailing space after "Startup" — quote it in shell).

---

## 1. Top-level layout

pnpm monorepo, three workspaces:

```
apps/
  backend/            Hono API server. JSON-file store at .protege-store.json.
  extension/          VS Code extension (Node) + React sidebar webview (Vite).
packages/
  types/              Shared TS types. ESM-only. Main = src/index.ts (no build).
Architecture/
  full-architecture.md   1587-line system doc. Aspirational + current.
  supabase-schema.sql    Future Postgres schema (not yet used at runtime).
.claude/              Claude Code config, agent team prompts, this guide.
```

`package.json` (root) has `dev:backend`, `dev:extension`, `build`, `typecheck`. Run individual packages with `pnpm --filter @protege/<name> <script>`.

---

## 2. Extension (`apps/extension`)

### Entry point
`src/extension.ts` — `activate(context)` wires every subsystem. Scan this file first when you need to know if something is wired. Subsystems follow `initX(context, ...)` or `registerX(context, ...)` pattern and each returns disposables pushed onto `context.subscriptions`.

### Key subsystems (all in `apps/extension/src/`)
- `analyzer.ts` — local AST analysis (no API call).
- `watcher/` — event bus + triggers + dispatcher for unprompted nudges.
- `liveReview.ts`, `saveScan.ts`, `flowScan.ts` — different scan tiers.
- `statusBarLive.ts` — status bar.
- `panel.ts`, `webviewHost.ts`, `launcher.ts` — sidebar webview lifecycle.
- `commands/` — command-palette handlers.
- `echo/` — behavior-observation subsystem (see §4).
- `protegeClient.ts` — `BACKEND_URL` + `getUserId(context)`.
- `auth.ts` — `authHeaders(userId)` for outbound fetches.

### Webview (React, Vite)
Sources: `apps/extension/webview/`. Main panel = `App.tsx`; separate Echo dashboard under `webview/echo/`. Vite dev server on :5173; in dev, HTML swaps to `http://localhost:5173/...` for HMR (see `vite.config.mts` comments). Build output: `dist/webview/` (+ `dist/webview/echo/`).

### Build
- Extension: `tsup` bundles `src/extension.ts` → `dist/extension.js` (CJS, node18). `noExternal: [/^@protege\//]` — types package is inlined because it's ESM-TS-direct.
- Commands declared in `package.json` under `contributes.commands`. Every `vscode.commands.registerCommand(...)` call needs a matching entry there or it won't appear in the palette.

### Import rule (important)
All local imports use `.js` extensions even though sources are `.ts`. Matches TS ESM resolution. If you add `import { x } from "./foo"`, typecheck will scream.

---

## 3. Backend (`apps/backend`)

### Entry point
`src/index.ts` — Hono app, CORS, error handler, routes mounted under prefixes. Port from `PORT` env var, default 8787.

### Routes (mounted in `index.ts`)
| Prefix | File | Purpose |
|---|---|---|
| `/test` | `routes/test.ts` | Smoke/diagnostic |
| `/chat` | `routes/chat.ts` | Mentor chat |
| `/analyze` | `routes/analyze.ts` | File analysis |
| `/concept-used` | `routes/concept.ts` | Concept recording |
| `/me` | `routes/me.ts` | User snapshot (IQ, streaks, etc.) |
| `/tts`, `/stt` | `routes/tts.ts` | Voice |
| `/memory` | `routes/memory.ts` | LLM memory |
| `/voice` | `routes/voice.ts` | Voice pipeline |
| `/preferences` | `routes/preferences.ts` | User prefs |
| `/echo` | `routes/echo.ts` | Behavior dashboard (see §4) |

### Store
`src/store.ts` — JSON-file-backed persistence at `.protege-store.json` (created in `process.cwd()`). `StoreShape` interface at line ~292 lists every table. `load()` caches at module scope; `save()` writes the whole file. All mutators are async.

When adding a new persistence table: add field to `StoreShape`, add hydration in `load()`, add default in the fresh-store block, add read/write exports.

### Env
`apps/backend/.env.example` — copy to `.env`. Needs `ANTHROPIC_API_KEY`. Optional: `OPENAI_API_KEY` (STT), others.

---

## 4. Echo subsystem (behavior dashboard)

This is a large cross-cutting feature — extension observes coding behavior, backend aggregates, webview renders widgets.

### Extension side (`apps/extension/src/echo/`)
- `batcher.ts` — queues `EchoEvent` in memory, flushes to `/echo/events` every 2 min. Survives restart via `globalState`. `getBatcher()!.onPush(cb)` subscribes to every push (used by Event Stream + commit watcher).
- `sessionTracker.ts`, `lineDiffer.ts`, `cohortTracker.ts`, `pasteClassifier.ts`, `gitCommitWatcher.ts`, `conceptAnalyzer.ts`, `workspaceConceptScanner.ts` — event producers.
- `eventStream.ts` — diagnostic OutputChannel `"Protege Echo Events"`.
- `storeDiff.ts` — diagnostic: prompts for minutes, fetches `/echo/debug/recent`, prints to `"Protege Echo Store Diff"` channel.
- `panel.ts`, `dashboardView.tsx`, `storyModeView.tsx` — dashboard webview shell.
- `widgets/` — React widget components (one per widget).
- `index.ts` — `initEcho(context, userId, log)` wires all the above.

### Backend side (`apps/backend/src/echo/`)
- `widgets/wN_*.ts` — one aggregator per widget. Each exports `assembleXPayload(userId, windowStart, windowEnd)`. Read from store; return widget-specific payload.
- `jobs.ts` — nightly rollup, cohort survival, archetype classifier.
- `util/shared.ts` — tiny helpers (`dateKey`, etc.).

### Event flow
1. Extension subsystem emits `EchoEvent` → `getBatcher().push(event)`.
2. Batcher POSTs to `/echo/events` in chunks. Handler in `routes/echo.ts` validates, appends to `echoEvents` table, and triggers **side effects** on known types (authorship bumps, cohort rows, commit enrichment, concept encounters). See the per-type blocks in the loop there.
3. Widget aggregators read store rows and return payloads via `GET /echo/dashboard`.

### Event types
Defined in `packages/types/src/index.ts` around line 490 (`EchoEvent` union). All events have `type` + `ts`. Common types: `keystroke_batch`, `line_diff`, `concept_encountered`, `file_snapshot`, `ai_suggestion_accepted`, `paste_classified`, `session_tick`, `session_boundary`, `commit_detected`.

### Debug endpoints
- `GET /echo/debug/recent?since=<ms>&userId=<id>` — snapshot of rows changed since a timestamp. Used by the Store Diff Inspector command.
- Live event stream: run command `Protege: Show Echo Event Stream` in the palette.

---

## 5. Shared types (`packages/types`)

No build step. Other packages import `@protege/types` which resolves to `packages/types/src/index.ts` directly (ESM TS). Extension's tsup config has `noExternal: [/^@protege\//]` to inline it into the CJS bundle.

`src/index.ts` re-exports everything. Sub-files:
- `concepts.ts` — concept taxonomy.
- `lineDiff.ts` — pure line-diff helper (extracted so extension + backend tests share it).

When adding a new shared type, add it here and re-export from `index.ts`.

---

## 6. Running the repo

```bash
# From repo root:
pnpm install               # once
pnpm dev:backend           # starts Hono on :8787 with tsx watch
pnpm dev:extension         # parallel tsup --watch + vite on :5173
pnpm -r typecheck          # every workspace
pnpm -r build              # production build
```

Extension lives-reload requires both `dev:extension` processes running. Then launch the extension via F5 (VS Code's extension host) or by packaging.

---

## 7. Tests

Only the backend has tests today. Framework: **vitest 2.x**. Test files live alongside sources as `*.test.ts`. Config: `apps/backend/vitest.config.ts` — `include: ["src/**/*.test.ts"]`, `environment: node`.

### Running
```bash
# From repo root:
pnpm --filter @protege/backend test         # one-shot run
pnpm --filter @protege/backend test:watch   # watch mode

# From apps/backend:
pnpm test
pnpm test:watch

# Single file:
pnpm vitest run src/echo/isoWeek.test.ts

# By test-name pattern:
pnpm vitest run -t "archetype"

# Verbose output:
pnpm vitest run <path> --reporter=verbose
```

### Existing tests (82 total, ~400ms)
| File | Count | Proves |
|---|---|---|
| `src/echo/lineDiff.test.ts` | 7 | `computeLineDiff` — added/removed counts, rewrite fingerprints, blank-line handling, swap case |
| `src/echo/computeAuthorshipRatio.test.ts` | 9 | `computeAuthorshipRatio` — 0/0→null, NaN→null, 7+3→0.7 |
| `src/echo/isoWeek.test.ts` | 5 | ISO-week calc — year-boundary edges (2020 has W53, etc.) |
| `src/echo/conceptAuthoredFlag.test.ts` | 3 | `setConceptAuthoredFlag` sticky: once `true`, never flips back; `firstAuthoredAt` preserved |
| `src/echo/widgets/w15_conceptsCovered.test.ts` | 9 | `bucketFor` — sticky flag wins, 0.5 threshold, null→excluded |
| `src/echo/widgets/w2_polar.test.ts` | 17 | `archetypeForPeak` — every hour band + every boundary |
| `src/routes/echo.test.ts` | 32 | `sanitizeLanguage`, `isSafeWorkspacePath`, `isSafeBatchFilePath` |

### Adding a new test

Drop `foo.test.ts` next to `foo.ts`. Vitest picks it up automatically.

```ts
import { describe, it, expect } from "vitest";
import { myFn } from "./myModule.js";

describe("myFn", () => {
  it("does the thing", () => {
    expect(myFn(1)).toBe(2);
  });
});
```

Note the `.js` extension on the import — ESM TS rule (see §2).

### Store isolation pattern

The backend store is JSON-file-backed at `process.cwd() + "/.protege-store.json"` with a module-level cache. Tests that touch the store must isolate. Pattern used by `conceptAuthoredFlag.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, vi } from "vitest";

let origCwd: string;
let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();              // drop cached store module
  origCwd = process.cwd();
  tmpDir = await mkdtemp(join(tmpdir(), "protege-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
});

// inside the test: dynamically import so the fresh module captures tmpDir
const store = await import("../store.js");
```

### Pure-function tests (preferred)

When adding logic, put the pure math in its own exported function and test that directly. Examples already in tree: `computeLineDiff` (in `packages/types/src/lineDiff.ts`), `computeAuthorshipRatio` (in `store.ts`), `bucketFor` (in `w15_conceptsCovered.ts`).

If a target function is module-private, add `export` to it. This is a behavior-preserving change — safe to do in a test PR.

### Extension has no tests

No vitest config in `apps/extension` yet. If an extension module has pure logic worth testing, either (a) extract it into `packages/types/` and test from backend, or (b) set up vitest in the extension package (template: copy `apps/backend/vitest.config.ts` + add `vitest` devDep).

### Before committing
```bash
pnpm --filter @protege/backend test && pnpm -r typecheck
```

If both green, ship.

---

## 8. Gotchas

- **Repo path has a space.** Always quote `"/Users/.../Protege Startup /protege"` in shell commands.
- **ESM `.js` on imports.** Source is `.ts` but local imports must end in `.js`. TS resolves them; tsc/tsup/vitest all agree.
- **tsup `noExternal`.** `@protege/types` is inlined because it ships raw TS-ESM. If you add a new shared workspace package, update `apps/extension/tsup.config.ts` similarly.
- **Pre-existing typecheck errors.** As of this writing, `apps/extension` has 2 pre-existing errors in `src/teachingStep.ts` and `src/tools.ts` (missing `HighlightRegion` type). Don't try to "fix" them unless that's your task. Verify any new error you see is actually yours by running `git stash && pnpm --filter @protege/extension typecheck`.
- **Store stickiness invariants.** `hasBeenAuthored` on a concept is append-only true. `firstAuthoredAt` is set once, never overwritten. `setConceptAuthoredFlag` is the ONLY writer — don't mutate `concepts[].hasBeenAuthored` elsewhere.
- **Rate limits.** `routes/echo.ts` enforces per-user windows on `/events`, `/commits`, `/repo-scan`. Don't bypass in new endpoints — copy `checkRateLimit` if needed.
- **`process.cwd()` matters.** The store file resolves against cwd at first `load()`. Running the backend from a different directory = different store.
- **Commands need two places.** Every `vscode.commands.registerCommand(...)` needs a matching entry in `apps/extension/package.json` `contributes.commands`. Otherwise it won't show in the palette and VS Code won't activate the extension on it.
- **Dual IQ engines.** `store.ts` has IQ v1; `iqV2.ts` has v2 (six-pillar: Craft, Range, Velocity, Debug, Quality, Independence). Both run in parallel during transition and can drift. When editing IQ math, check both sides.
- **Paused teaching surfaces are intentional.** `FindingCodeLensProvider` is instantiated but never registered. `inlineErrors`/`peekTeach`/`didYouKnow`/`inlineLessonComment` imports are commented in `extension.ts`. Don't "fix" them — they're pending redesign, not bugs.
- **Skill taxonomy is webview-only.** `apps/extension/webview/skills-taxonomy.json` (260KB, 1000+ concepts) is hardcoded in the webview bundle, not synced from backend. Changes to it require rebuild, not backend restart.
- **OAITurn in, Anthropic out.** Backend chat endpoint accepts OpenAI-compatible `OAITurn` shape (`packages/types`), translates to Anthropic internally. Keeps on-device / other-provider swap cheap. Don't send Anthropic-shaped messages to `/chat`.
- **Prompt caching is on.** `/chat` and `/analyze` mark system prompt + tool defs with `cache_control: ephemeral`. Changing those strings invalidates cache — mind the 10% reuse discount when editing.
- **Anthropic tool names.** Chat flow exposes: `read_file`, `list_files`, `grep`, `show_code`, `highlight_code`, `clear_highlights`, `edit_file`, `teach_step`, `remember`, `forget`. Defined in `apps/extension/src/tools.ts` and mirrored server-side. If you add a new tool, update both.
- **Smart-routing budget.** Target is ~5–10 Anthropic calls/hour (vs. 50–100 naive). Watcher has budget + suppression (3 dismissals → mute). Don't add polling loops that defeat this.

---

## 9. When to read what

| You're doing... | Read first |
|---|---|
| Adding a backend route | `apps/backend/src/index.ts` + an existing `routes/*.ts` |
| Adding a store table | `apps/backend/src/store.ts` (hydration + shape) |
| Adding an Echo event type | `packages/types/src/index.ts` (EchoEvent union) + `routes/echo.ts` side-effect loop |
| Adding an Echo widget | `apps/backend/src/echo/widgets/w*.ts` for aggregation + `apps/extension/src/echo/widgets/*.tsx` for rendering |
| Adding an extension command | `apps/extension/src/extension.ts` for registration + `package.json` `contributes.commands` |
| Adding a webview | `apps/extension/vite.config.mts` `rollupOptions.input` + `apps/extension/webview/` |
| Big-picture system | `Architecture/full-architecture.md` (long, aspirational) |
| Agent teams feature | `.claude/agent-teams-reference.md` |

---

## 10. Don't-do-this list

- Don't add comments that explain what the code does. Names already do that.
- Don't add backwards-compat shims for code that's <1 day old.
- Don't introduce new dependencies without checking if something in `node_modules` already covers it.
- Don't edit `.protege-store.json` by hand — it's a cache. Delete it if you want a fresh state.
- Don't use `--no-verify` on commits.
- Don't push without the user asking.
