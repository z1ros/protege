# Code IQ — Manual Test Plan

Goal: exercise every metric the iq3 system can score today, verify each
one moves in the expected direction, and surface anything broken before
shipping. Architecture reference: [`iq3-architecture.md`](iq3-architecture.md).

> **Scope.** This plan tests what's *currently shipping*. Deferred
> features (test-run producer, decay, cohort rebuild, several
> static-analyzer traits) are listed in §11 with the reason they can't
> be exercised today.

---

## 0. Setup (do once)

### 0.1 Environment

In `apps/backend/.env`:
```
NODE_ENV=development
PROTEGE_AUTH_REQUIRED=false
PROTEGE_ALLOW_DEV_USER=true
```
This routes you to the **local JSON store** (`apps/backend/.protege-store-iq3.json`)
under the user id `local-dev`, so reset is just `rm`.

```bash
# Terminal 1
cd apps/backend && pnpm dev

# Terminal 2
cd apps/extension && pnpm dev
```

Open the protege repo in Cursor → press **F5** → "Run Extension".
A child Extension Development Host (EDH) window opens.

### 0.2 Test workspace

In the EDH window: `File → Open Folder…` →
**`/Users/bohdan/Documents/IT-Work/Projects/IT/Work/Protege Startup /protege-test`**

That directory currently has only `sandbox.ts` and a `.git/`. Most tests
need a few more files to exercise navigation, commits, and field
detection. Seed it once with the script in **§0.4** before running.

### 0.3 Helpers

Stick these in scratch files for copy-paste during tests:

```bash
# Live state watcher — keep this open in a side terminal
USER=local-dev
watch -n 2 "curl -s 'http://localhost:8787/iq/me?userId=$USER' \
  -H 'x-user-id: $USER' | jq '{
    rank: .headline.rank.rank,
    score: .headline.score,
    eventCount: .headline.pillars.aiPartnership.pending,
    pillars: .headline.pillars | to_entries | map({
      pillar: .key,
      score: .value.score,
      pending: .value.pending,
      ci: .value.ciHalfWidth
    })
  }'"

# Raw HMM state — use after each action to see exact trait deltas
jq '."local-dev" | {
  eventCount, aiEventCount,
  topTraits: (.traits | to_entries | map({trait: .key, h: .value.high}) | sort_by(-.h) | .[:6])
}' apps/backend/.protege-store-iq3.json

# Hard reset between scenarios
rm -f apps/backend/.protege-store-iq3.json && echo "reset OK"
# Then in the EDH: Cmd+Shift+P → "Developer: Reload Window"
```

### 0.4 Seed the test workspace (run once)

These commands populate `protege-test/` with the minimum scaffolding the
plan needs. Safe to re-run — it skips files that already exist.

```bash
cd "/Users/bohdan/Documents/IT-Work/Projects/IT/Work/Protege Startup /protege-test"

# 1. package.json with web-shaped deps (drives §7.1 field detection → web)
cat > package.json <<'JSON'
{
  "name": "protege-test",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.0.0",
    "next": "^14.0.0",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/react": "^18.0.0"
  }
}
JSON

# 2. tsconfig so saves can produce real type errors
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
JSON

# 3. Several small files for navigation tests (§1.3, §1.4)
mkdir -p src
cat > src/utils.ts <<'TS'
export function add(a: number, b: number): number {
  return a + b;
}
export function multiply(a: number, b: number): number {
  return a * b;
}
TS

cat > src/users.ts <<'TS'
import { add } from "./utils.js";
export interface User { id: string; name: string; age: number; }
export function birthday(u: User): User {
  return { ...u, age: add(u.age, 1) };
}
TS

cat > src/posts.ts <<'TS'
export interface Post { id: string; authorId: string; title: string; }
export const samplePost: Post = { id: "p1", authorId: "u1", title: "Hello" };
TS

cat > src/comments.ts <<'TS'
import type { Post } from "./posts.js";
import type { User } from "./users.js";
export interface Comment { id: string; postId: Post["id"]; userId: User["id"]; body: string; }
TS

cat > src/feed.ts <<'TS'
import type { Post } from "./posts.js";
import type { User } from "./users.js";
export function authoredBy(posts: Post[], user: User): Post[] {
  return posts.filter((p) => p.authorId === user.id);
}
TS

# 4. A test file (used by §4.1, §4.4 — modify it for assertion-density tests)
cat > src/utils.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { add, multiply } from "./utils.js";

describe("utils", () => {
  it("adds", () => {
    expect(add(2, 3)).toBe(5);
  });
});
TS

# 5. Stage + commit so we have a clean git baseline for commit-detected tests
git add -A
git commit -m "seed: web-shaped workspace for iq3 manual tests" || true

echo "✓ workspace seeded"
ls -la
```

After this, the workspace has:
- `package.json` with React/Next/Tailwind → repo archaeology will detect **web** field
- 5 small interlinked source files in `src/` so you can use F12 / Cmd+T / Cmd+P meaningfully
- A `*.test.ts` file you can extend for Verification tests
- `tsconfig.json` so introducing type errors actually surfaces diagnostics

For **§7.2 (ML)** and **§7.3 (DevOps)** tests you'll need a *separate* workspace
with different deps. Either:
- Rename `package.json` to `package.web.json`, drop in an ML-shaped one, reload window, then restore
- Or `git worktree add ../protege-test-ml ml-branch` and seed that branch with the ML `package.json`

### 0.5 Test convention

Each test below uses:
- **Prep** — what state you need before
- **Do** — the user action
- **Fires** — the event/matchKey expected
- **Expect** — the metric that should change and direction
- **Verify** — a `jq` snippet to read the actual change

If "Expect" doesn't materialize: the producer→matcher→HMM chain is
broken somewhere. Check backend logs and the raw state file before
moving on.

---

## 1. Comprehension

5 traits: `readsBeforeWrites`, `pausesBeforeLargeEdits`,
`summarizesCodebase`, `asksClarifyingQuestions`, `navigatesBySymbols`.

### 1.1 readsBeforeWrites — deep read pattern (positive)
- **Prep**: reset state
- **Do**: open a file in `protege-test/` you've never opened (e.g. `src/posts.ts`). Scroll/PageDown ≥ 2 times. Wait **45 s**. Make a 1-character edit.
- **Fires**: `read_pattern_observed { pattern: "deep" }` → matchKey `file_opened.then.navigations>=2.then.first_text_change.afterMs>30s`
- **Expect**: `traits.readsBeforeWrites.high` rises noticeably (uniform 0.33 → ~0.55+); Comprehension pillar lifts off 500.
- **Verify**: `jq '."local-dev".traits.readsBeforeWrites' apps/backend/.protege-store-iq3.json`

### 1.2 readsBeforeWrites — jump-in (negative)
- **Prep**: reset state
- **Do**: open a file and start typing within **3 s**, no scrolling.
- **Fires**: `read_pattern_observed { pattern: "jump-in" }` → matchKey `file_opened.then.first_text_change.withinMs<5s`
- **Expect**: `traits.readsBeforeWrites.low` rises; Comprehension dips below 500.
- **Verify**: same jq command — `low` should win.

### 1.3 navigatesBySymbols — symbol search before edit
- **Prep**: reset state
- **Do**: in any file, **Cmd+T** (Go to Symbol in Workspace), pick a symbol, then make any edit. Repeat **3 times**.
- **Fires**: `editor_navigation { kind: "symbol-search" }` ×3 → matchKey `editor_navigation.kind=symbol-search.session_count>=2`
- **Expect**: `traits.navigatesBySymbols.high` rises; Comprehension up.
- **Verify**: `jq '."local-dev".traits.navigatesBySymbols'`

### 1.4 navigatesBySymbols — file-bounce only (negative)
- **Prep**: reset state
- **Do**: **Cmd+P** (Quick Open) → switch between **10 different files** without ever using F12 / Cmd+T.
- **Fires**: matchKey `editor_navigation.kind=file-bounce.session_count>=10.no_def-jump`
- **Expect**: `traits.navigatesBySymbols.low` rises; Comprehension dips.

### 1.5 asksClarifyingQuestions — substantive question (positive)
- **Prep**: reset state, open Protege chat
- **Do**: send a message ≥ 60 chars containing a `?`, e.g. `"Why does this function recompute the headline on every event instead of caching it?"`
- **Fires**: `chat_turn { containsQuestionMark: true, charCount >= 60 }` → matchKey `chat_turn.contains_question_mark.charCount>=60`
- **Expect**: `traits.asksClarifyingQuestions.high` rises.

### 1.6 asksClarifyingQuestions — vague (negative)
- **Prep**: reset state
- **Do**: send a chat message under 40 chars starting with one of `fix|why|help|broken|ok|do`. e.g. `"fix this"`.
- **Fires**: `chat_turn { intent: "vague", charCount<40 }` → matchKey `chat_turn.intent=vague.charCount<40`
- **Expect**: `traits.asksClarifyingQuestions.low` rises; Comprehension dips.

### 1.7 pausesBeforeLargeEdits — plan-then-edit (positive)
- **Prep**: reset state
- **Do**: send a chat message ≥ 80 chars about planning, containing one of `must|should|cannot|requires|constraint`, e.g. `"I need to refactor this module — the constraint is we cannot break the existing API surface, so the plan should be to add a wrapper first."`
- **Fires**: `chat_turn { intent: "plan", containsConstraintWords: true }` → matchKey `chat_turn.intent=plan.includes_constraints`
- **Expect**: `traits.pausesBeforeLargeEdits.high` rises (this trait shares the planning matchers).

---

## 2. Execution

5 traits: `compilesCleanOnSave`, `keepsFunctionsSmall`, `authorshipSelf`,
`conceptDepth`, `styleMatchesCodebase`. Two are static-analyzer-only and
will not move (see §11).

### 2.1 compilesCleanOnSave — clean save (positive)
- **Prep**: reset state. Have a TypeScript file open with no errors.
- **Do**: edit the file, save (Cmd+S). Repeat **5 times** within a session, every save clean.
- **Fires**: `file_saved.errorCount=0` ×5 → matchKey `file_saved.errorCount=0.session_proportion>=0.8`
- **Expect**: `traits.compilesCleanOnSave.high` rises; Execution lifts off 500.

### 2.2 compilesCleanOnSave — error-laden saves (negative)
- **Prep**: reset state. Open a TypeScript file. Introduce 5 type errors.
- **Do**: save while errors exist. Fix and break again, save. Repeat to get ≥ 40 % of saves with errors.
- **Fires**: matchKey `file_saved.errorCount>=3.session_proportion>=0.4` or `file_saved.errorCount>=5`
- **Expect**: `traits.compilesCleanOnSave.low` rises; Execution dips.

### 2.3 authorshipSelf — large AI paste, kept as-is (negative)
- **Prep**: reset state
- **Do**: in Cursor chat, ask for a code block ≥ 6000 chars / ~80 lines (e.g. `"write me a complete React component for a kanban board with drag-drop, ~200 lines"`). Paste into a `.tsx` file. **Do not touch it for 70 s.**
- **Fires**: `paste_outcome_observed { outcome: "kept-as-is", chars >= 6000 }` → matchKey `paste_classified.source=ai.size>=80lines.no_edit_within_60s`
- **Expect**: `traits.authorshipSelf.low` rises; Execution dips.

### 2.4 authorshipSelf — human typing run (positive)
- **Prep**: reset state
- **Do**: type **≥ 200 chars** of code by hand within a 10-minute window, no paste, no AI accept.
- **Fires**: `keystroke_batch.size>=200.during10minWindow`
- **Expect**: `traits.authorshipSelf.high` rises.

### 2.5 conceptDepth — deep concept usage (positive)
- **Prep**: reset state
- **Do**: write code that exercises ≥ 5 distinct concepts of difficulty 3 from `apps/extension/webview/skills-taxonomy.json` over a session (e.g. recursion, generics, async iterators, closures, type guards).
- **Fires**: `concept_encountered.distinct_difficulty3_count>=5.in_30days`
- **Expect**: `traits.conceptDepth.high` rises.
- **Note**: requires the concept analyzer to be running and recognizing your code patterns. Verify in backend logs that `concept_encountered` events are arriving.

### 2.6 conceptDepth — only easy concepts (negative)
- **Prep**: reset state
- **Do**: write only difficulty-1 code (variable assignments, basic if/else) for the session.
- **Fires**: `concept_encountered.only_difficulty1.in_30days`
- **Expect**: `traits.conceptDepth.low` rises.

---

## 3. Diagnostics

5 traits: `errorResolutionFast`, `hypothesisDriven`, `fixNotBandAid`,
`testsAfterError`, `readsStackTrace`.

### 3.1 readsStackTrace — paste stack trace into chat
- **Prep**: reset state, open chat
- **Do**: paste a stack trace into chat with ≥ 200 chars total, e.g. `"TypeError: Cannot read properties of null (reading 'push') at line 42 in foo.ts… [paste full trace]"`
- **Fires**: `chat_turn { intent: "debug", containsStackTraceOrLineRef: true, charCount in [200, 1500] }` → matchKeys `chat_turn.intent=debug.contains_stack_trace_or_line_ref` + `chat_turn.contains_stack_trace.charCount>=200`
- **Expect**: `traits.readsStackTrace.high` rises significantly (two simultaneous matchers).

### 3.2 hypothesisDriven — debug-intent without stack trace (mid signal)
- **Prep**: reset state
- **Do**: send chat: `"why does this function return undefined when the input array is empty"`
- **Fires**: `chat_turn { intent: "debug" }` only (no stack trace flag).
- **Expect**: `traits.hypothesisDriven.mid` rises (weaker than full stack trace).

### 3.3 errorResolutionFast — fast fix (positive)
- **Prep**: reset state. Introduce a TypeScript error in a file.
- **Do**: fix it within **2 minutes** of it appearing (the diagnostic event fires).
- **Fires**: `error_appeared` → `error_cleared.duration_since_appeared<=120s`
- **Expect**: `traits.errorResolutionFast.high` rises.

### 3.4 errorResolutionFast — slow fix (negative)
- **Prep**: reset state. Introduce a TypeScript error.
- **Do**: leave it for **15+ minutes**, then fix.
- **Fires**: `error_persists.duration>=600s` then `error_cleared.duration_since_appeared>=900s`
- **Expect**: `traits.errorResolutionFast.low` rises.

### 3.5 fixNotBandAid — targeted fix (positive)
- **Prep**: reset state. Have an error in a file.
- **Do**: fix the error by editing **≤ 5 lines** in the error neighborhood.
- **Fires**: `error_cleared.targeted_edit.line_count<=5`
- **Expect**: `traits.fixNotBandAid.high` rises.

### 3.6 fixNotBandAid — broad blast (negative)
- **Prep**: reset state. Have an error.
- **Do**: clear the error by deleting/rewriting **≥ 30 lines**.
- **Fires**: `error_cleared.broad_edit.line_count>=30`
- **Expect**: `traits.fixNotBandAid.low` rises.

### 3.7 testsAfterError — test follows fix (positive)
- **Prep**: reset state
- **Do**: introduce error → fix → within **20 min**, create or modify a `*.test.*` file related to the bug.
- **Fires**: `error_cleared.then.writesTestFile.in_window=20min`
- **Expect**: `traits.testsAfterError.high` rises.

---

## 4. Verification

5 traits. **`runsTestsOften` cannot be exercised today** — see §11.
The other four are commit-time signals.

### 4.1 writesTestFiles — add a test file (positive)
- **Prep**: reset state, in `protege-test/`
- **Do**: create `foo.test.ts` with at least 1 test, then `git commit`.
- **Fires**: `commit_detected.test_added>=1.no_edge_case_keyword` (or with edge-case if you include `null`/`empty`/boundary)
- **Expect**: `traits.writesTestFiles.high` rises after the commit watcher emits.

### 4.2 assertionDensity — dense assertions (positive)
- **Prep**: reset state
- **Do**: commit a test file with **≥ 5 assertions per added test function**.
- **Fires**: `commit_detected.assertions_per_loc>=0.05`
- **Expect**: `traits.assertionDensity.high` rises.

### 4.3 assertionDensity — sparse assertions (negative)
- **Prep**: reset state
- **Do**: commit code that adds ≥ 50 lines with **0 assertions**.
- **Fires**: `line_diff.assertions_added=0.lines_added>=50`
- **Expect**: `traits.assertionDensity.low` rises; Verification dips.

### 4.4 edgeCaseCoverage — boundary tests (positive)
- **Prep**: reset state
- **Do**: add tests whose names/bodies contain `null`, `empty`, `boundary`, `0`, `-1`, `MAX_VALUE` etc. Commit.
- **Fires**: `commit_detected.test_contains_boundary_value.test_added>=1` and `.test_contains_null_or_empty.*`
- **Expect**: `traits.edgeCaseCoverage.high` rises.

### 4.5 preCommitReads — diff before commit (positive)
- **Prep**: reset state. Stage some changes.
- **Do**: open the changed files in the editor (≥ 3 file opens) within **10 min before** committing.
- **Fires**: `commit_detected.recent_file_opens>=3.in_window=10min_before`
- **Expect**: `traits.preCommitReads.high` rises.

### 4.6 preCommitReads — blind commit (negative)
- **Prep**: reset state
- **Do**: stage and commit without opening any files for 10+ min before.
- **Fires**: `commit_detected.no_file_opens.in_window=10min_before`
- **Expect**: `traits.preCommitReads.low` rises; Verification dips.

---

## 5. Stewardship

### 5.1 meaningfulCommitMsgs — substantive Conventional commit (positive)
- **Prep**: reset state
- **Do**: commit with a message **≥ 80 chars**, conventional format, containing a "why" word (`because`, `to fix`, `since`, `so that`). Example: `fix(rank): cap senior at mid when any pillar below floor — prevents farming one pillar to inflate rank since spec §6.1 requires floor enforcement`
- **Fires**: matchKeys `commit_detected.msg_chars>=80.contains_why_keyword` + `.matches_conventional`
- **Expect**: `traits.meaningfulCommitMsgs.high` rises strongly (two matchers).

### 5.2 meaningfulCommitMsgs — wip/fix only (negative)
- **Prep**: reset state
- **Do**: commit with message just `"fix"` or `"wip"`.
- **Fires**: `commit_detected.msg_matches_wip_or_fix_only` and/or `commit_detected.msg_chars<20`
- **Expect**: `traits.meaningfulCommitMsgs.low` rises; Stewardship dips.

### 5.3 removesDeadCode — net-negative commit (positive)
- **Prep**: reset state
- **Do**: commit a change where `lines_deleted >= lines_added`. Repeat for **2+ such commits** in the session.
- **Fires**: `commit_detected.lines_deleted>=lines_added.session_count>=2`
- **Expect**: `traits.removesDeadCode.high` rises.

### 5.4 removesDeadCode — never deletes (negative)
- **Prep**: reset state
- **Do**: make **10 commits** in a session, all with 0 lines deleted.
- **Fires**: `commit_detected.lines_deleted=0.session_count>=10`
- **Expect**: `traits.removesDeadCode.low` rises.

### 5.5 removesDeadCode — unused import removed (positive, fast)
- **Prep**: reset state
- **Do**: remove an unused `import` line and commit.
- **Fires**: `line_diff.unused_import_removed>=1`
- **Expect**: `traits.removesDeadCode.high` rises (single-shot signal).

### 5.6 refactorsWhileTouching — rename during feature (positive)
- **Prep**: reset state
- **Do**: in one commit, both rename a function/variable AND add new functionality. Commit message should imply feature change.
- **Fires**: `commit_detected.contains_renames.feature_change_present`
- **Expect**: `traits.refactorsWhileTouching.high` rises.

### 5.7 commentsWhyNotWhat — add a "why" comment (positive)
- **Prep**: reset state
- **Do**: add a comment containing `because`, `to`, `since`, `so that` explaining a non-obvious decision. Commit.
- **Fires**: `line_diff.comments_added.contains_why_keyword>=1`
- **Expect**: `traits.commentsWhyNotWhat.high` rises.

### 5.8 commentsWhyNotWhat — comments restating code (negative)
- **Prep**: reset state
- **Do**: add 3+ comments that just restate what the code does (e.g. `// loop over items` above a `for` loop).
- **Fires**: `line_diff.comments_added.is_what_describing>=3`
- **Expect**: `traits.commentsWhyNotWhat.low` rises.

---

## 6. AI Partnership

This pillar starts **pending**. Two gating thresholds must clear before
it leaves pending:
- `aiEventCount >= 5`
- `aiEventCount / eventCount >= 0.05`

### 6.1 The flip itself
- **Prep**: reset state.
- **Do**: in Cursor, accept inline complete (Tab) **6 times**. After each, wait the 30-s window so `ai_accept_outcome_observed` fires.
- **Verify**: `jq '."local-dev" | {aiEventCount, eventCount, ratio: (.aiEventCount / (.eventCount | if . == 0 then 1 else . end))}' apps/backend/.protege-store-iq3.json` should show `aiEventCount >= 5` and ratio ≥ 0.05.
- **Expect**: AI Partnership pillar transitions from `pending: true` to `pending: false`. Dashboard shows a real bar instead of "awaiting evidence". Headline drops slightly because the 0.5×500 contribution becomes a 1×score contribution (and score will start near 500 with low concentration).

### 6.2 specificPrompts — long constraint-bearing prompt (positive)
- **Prep**: AI Partnership active (run §6.1 first or seed via onboarding)
- **Do**: chat: `"I need to refactor the rank computation — the constraint is the public Iq3Rank shape must not change, and we should preserve the floorViolation field so the UI dashboard can keep showing what blocked the user from senior."` (≥ 120 chars, intent `specific`)
- **Fires**: `chat_turn.intent=specific.charCount>=120` (also possibly `.intent=plan.includes_constraints`)
- **Expect**: `traits.specificPrompts.high` rises.

### 6.3 specificPrompts — vague (negative)
- **Prep**: AI Partnership active
- **Do**: chat `"fix it"`
- **Fires**: `chat_turn.intent=vague.charCount<40`
- **Expect**: `traits.specificPrompts.low` rises.

### 6.4 iteratesOnAiOutput — accept then edit (positive)
- **Prep**: AI Partnership active
- **Do**: accept an AI inline complete, then within **5 s** make edits worth ≥ 30 % of the accepted text.
- **Fires**: `ai_accept_outcome_observed { outcome: "iterated", editFraction >= 0.3 }` → matchKey `ai_suggestion_accepted.then.text_change.editFraction>=0.3.in_window=5min` and `.thenEditWithin30s.editFraction>=0.3`
- **Expect**: `traits.iteratesOnAiOutput.high` rises.

### 6.5 iteratesOnAiOutput — accept then walk away (negative)
- **Prep**: AI Partnership active
- **Do**: accept an AI inline complete, do not edit it for 30 s.
- **Fires**: `ai_suggestion_accepted.afterMs<2000.withoutEdit` (or `.no_edit.in_window=30min`)
- **Expect**: `traits.iteratesOnAiOutput.low` rises.

### 6.6 overridesAiConfidently — reject suggestions
- **Prep**: AI Partnership active
- **Do**: reject (Esc) Cursor inline suggestions **3 times** in a session. Then on a 4th, reject and immediately type your own alternative implementation.
- **Fires**: `ai_suggestion_rejected.session_count>=3` + `.then.text_change.contains_alternative_logic`
- **Expect**: `traits.overridesAiConfidently.high` rises.

### 6.7 explainsAfterAccept — explain follow-up
- **Prep**: AI Partnership active
- **Do**: accept AI suggestion. Within 15 min ask in chat: `"can you explain how this part works"` or `"walk me through this loop"`.
- **Fires**: `ai_suggestion_accepted.then.chat_turn.contains_explain_keyword.in_window=15min`
- **Expect**: `traits.explainsAfterAccept.high` rises.

---

## 7. Field vector

The field is mixed from **repo deps + concept usage + self-declaration**.
Use multiple test workspaces to validate the repo signal.

### 7.1 Web-shaped repo
- **Prep**: reset state. Open a workspace whose `package.json` has `react`, `next`, `vite`, `tailwindcss`.
- **Do**: just open the folder; `repo_scan_status` triggers archaeology.
- **Expect**: `field.web` ≥ 0.40 within 1 min; dashboard's "Field" card shows `web` dominant.
- **Verify**: `jq '."local-dev".field' apps/backend/.protege-store-iq3.json` — sorted, web should be top.

### 7.2 ML-shaped repo
- **Prep**: reset state. Workspace with `pyproject.toml` listing `torch`, `transformers`, `numpy`, `lightning`.
- **Do**: open.
- **Expect**: `field.ml` ≥ 0.40.

### 7.3 DevOps-shaped repo
- **Prep**: reset state. Workspace with `Dockerfile`, `*.tf`, `kubernetes/*.yaml`, `docker-compose.yml`.
- **Do**: open.
- **Expect**: `field.devOps` ≥ 0.30.

### 7.4 Generalist fallback
- **Prep**: reset state. Empty workspace or one with no recognized deps.
- **Do**: open + light edits.
- **Expect**: `field.generalist` near 0.10–0.20 (slight uplift over uniform 0.10).

### 7.5 Self-declaration override
- **Prep**: reset state.
- **Do**: complete onboarding picking `web` as your field even if the repo is ML-shaped.
- **Expect**: web gets +0.2 weight via EMA; final field vector blends both signals. Pure ML repo + web self-declaration should land ~`{ ml: 0.4, web: 0.3, generalist: ~0.15, others split }`.

---

## 8. Rank transitions

The rank is `learner / junior / mid / senior` derived from the
percentile of your **dominant-field** headline within the fallback
distribution (until cohort cron lands).

### 8.1 Cold start = junior (smoke test)
- **Prep**: reset state
- **Do**: nothing
- **Expect**: `rank.rank: "junior"` immediately. Headline 500 lands in the [25, 55) percentile band of every fallback distribution.

### 8.2 Mid threshold (web field)
- **Prep**: reset state, web-shaped workspace (so dominant = web)
- **Do**: drive Comprehension + Execution + Stewardship pillars to ≥ 700 each via §1, §2, §5 positive tests. Keep Diagnostics + Verification at ≥ 500.
- **Expect**: headline ≥ 600, percentile crosses 55, `rank.rank: "mid"`.

### 8.3 Pillar floor caps senior
- **Prep**: get a state with headline ≥ 850 in web (Senior band) but with one pillar — say Verification — kept below 500.
- **Do**: nothing more, just observe.
- **Expect**: `rank.uncappedRank: "senior"`, `rank.rank: "mid"`, `rank.floorViolation: { pillar: "verification", score: <500, floor: 500 }`. Dashboard rank shows "Mid" with a footnote about the floor.

### 8.4 Senior with all pillars passing
- **Prep**: continue from §8.3
- **Do**: drive Verification ≥ 500 via §4 positives.
- **Expect**: `rank.rank: "senior"`.

---

## 9. Onboarding

### 9.1 First-open shows probes
- **Prep**: reset state, reload EDH window
- **Do**: open the Protege panel, go to Profile tab.
- **Expect**: `OnboardingProbes` UI renders, not `IqDashboard`. 5 questions visible.

### 9.2 Submit moves traits
- **Do**: answer the 5 questions, submit.
- **Expect**: `POST /iq/onboarding` 200 OK. The 5 selected matchKeys land in `MATCHKEY_TO_TRAITS`, each Bayes-updates one trait. `eventCount: 0` (onboarding doesn't bump it). Field vector gets the self-declared field at weight 0.2. Dashboard re-renders showing the score view, no longer cold-branch.

### 9.3 Validation rejection
- **Do**: with curl, send `POST /iq/onboarding` with `matchKeys: ["totally-fake-key"]`.
- **Expect**: HTTP 400 `{ error: "unknown matchKey" }` (the H1 fix from the security audit).

### 9.4 Limit rejection
- **Do**: send `matchKeys` with 51 valid entries.
- **Expect**: HTTP 400 `{ error: "matchKeys exceeds limit of 50" }`.

---

## 10. Self-rating

### 10.1 Submit a rating
- **Prep**: any state
- **Do**: open the Profile tab, click the self-rating prompt (or trigger it from the Cmd+Shift+P palette if exposed). Enter rating 7, optional note.
- **Expect**: `POST /iq/self-rating` 200 OK. Row stored in `iq3_self_ratings` Supabase table (or local equivalent).
- **Verify**: scoring is unaffected today — self-rating is store-only until cohort calibration ships. Confirm by checking headline doesn't change.

### 10.2 Cooldown
- **Do**: try to submit a second rating within the 90-day cooldown window.
- **Expect**: UI prompt should not surface again. Backend may accept the row but UI gates it.

---

## 11. What you can't test today

These items will not move the dashboard regardless of what you do — they
need engineering work to wire up.

| Item | Reason |
|---|---|
| `runsTestsOften` (Verification) | Test-run producer was dropped — `testObserver` is a VS Code proposed API that blocked extension activation (commit `536213c`). Until the producer ships, `test_run_result.*` matchKeys never fire. |
| `keepsFunctionsSmall`, `assertionDensity`, `consistentNaming`, `styleMatchesCodebase`, `agenticFlowQuality` | No producers wired. Likelihood tables are sparse to empty. These traits will sit at uniform prior. |
| `chat_turn` AI partnership signal | `acceptedAi` flag is hardcoded `false` in `chatTurn.ts:31`. Chat turns will not contribute AI Partnership signal even after the flip. |
| Trait decay | Spec §14 calls for ~3 %/week decay; `applyDecay` doesn't exist. Long-idle scores stay frozen. |
| Cohort percentile recalibration | `cron/cohortRebuild.ts` is a function, not wired to any trigger. All percentile lookups use the hand-authored `FALLBACK_DISTRIBUTION`. |

If a test in §1–8 fails because the underlying matcher needs one of the
above to be wired, that's not a bug in the matcher — note it and skip.

---

## 12. Acceptance gate before shipping to prod

After running this plan, the following should all be true:

- [ ] §1.1, §1.2 pass — Comprehension swings on read pattern
- [ ] §1.5, §1.6 pass — chat_turn intent classifier wired
- [ ] §2.1, §2.2 pass — file_saved error tracking wired
- [ ] §2.3 passes — paste_outcome_observed rollup fires
- [ ] §3.1, §3.3 pass — error_appeared / error_cleared events arriving
- [ ] §4.1, §4.5 pass — gitCommitWatcher fires on real commits
- [ ] §5.1, §5.2 pass — commit message classification works
- [ ] §6.1 passes — AI Partnership flip is reachable
- [ ] §6.4 passes — ai_accept_outcome_observed iterated outcome wired
- [ ] §7.1, §7.2 pass — repo archaeology recognizes web + ML stacks
- [ ] §8.3 passes — pillar floor demotes senior → mid
- [ ] §9.1, §9.3, §9.4 pass — onboarding flow + validation
- [ ] §10.1 passes — self-rating store works
- [ ] No 5xx errors observed in backend logs across the full run

Anything failing → file an issue, link to the test number that failed,
attach the raw `.protege-store-iq3.json` after the failed action.

---

## 13. Quick reset between scenarios

```bash
# Hard reset
rm -f apps/backend/.protege-store-iq3.json

# In EDH window: Cmd+Shift+P → Developer: Reload Window

# Check it actually reset
curl -s -H 'x-user-id: local-dev' \
  'http://localhost:8787/iq/me?userId=local-dev' \
  | jq '.headline.score'
# Expected: 500
```
