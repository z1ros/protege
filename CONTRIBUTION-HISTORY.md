# Protege — Development and Contribution History

**Project:** Protege — an AI coding mentor that runs inside Visual Studio Code
**Founder, project owner, and principal architect:** Yurii Tovarnytskyi (GitHub `@z1ros`)
**Repository:** `protege` (pnpm monorepo — VS Code extension, Hono backend, shared types)
**Development period covered:** April 15, 2026 – May 4, 2026
**Shipped artifact:** VS Code Marketplace extension `protege-ai.protege`, version 0.1.7

This document records what the project is, what it was built from, what was added over time, and who authored each part. Every claim below is derived from the repository's git history and the source tree itself, and can be independently reproduced with the commands listed in the [Verification](#verification) section.

---

## 1. Summary of contribution

Yurii Tovarnytskyi conceived Protege, created the repository, defined its architecture, and personally authored the substantial majority of its source code. He is the sole originator of the project and its continuing technical lead.

Measured across the repository's full history, excluding generated files (lockfiles, build output, vendored dependencies, binary assets):

| Contributor | Net lines added | Lines removed | File changes | Share of added lines |
|---|---|---|---|---|
| **Yurii Tovarnytskyi** | **112,366** | 26,474 | 771 | **78.3%** |
| Bohdan Chuprynka | 31,093 | 1,286 | 286 | 21.7% |

Yurii authored the founding commit, every structural reorganization of the codebase, and the design and implementation of the product's core systems: the mentor chat engine, the code review and analysis pipeline, the teaching and Learning Mode system, the concept detection taxonomy, the voice interface, the LLM provider and cost-control layer, and the entire React user interface.

The project's one other contributor, Bohdan Chuprynka, joined on April 23, 2026 — eight days after the project was founded and after its core architecture was already established — and worked primarily on a single self-contained analytics subsystem (Echo) plus deployment configuration, under Yurii's direction and within the architecture Yurii had defined.

---

## 2. What Protege is

Protege is a mentorship system for programmers, delivered as an editor extension. Where conventional AI coding tools write code on the user's behalf, Protege is built on the opposite premise: it observes the user writing code and teaches them, tracking what they genuinely understand versus what they have merely accepted from an AI.

The product consists of:

- **A VS Code extension** (TypeScript, ~43,000 lines across 143 source files) that observes editor activity, runs local analysis, renders inline teaching surfaces, and hosts a React sidebar.
- **A React webview interface** (~14,400 lines across 40 files) providing the mentor chat, skill visualizations, and analytics dashboard.
- **A Hono backend service** (TypeScript, ~20,400 lines across 68 files) handling LLM orchestration, teaching-plan generation, concept recording, voice transcription and synthesis, quota enforcement, and behavioral aggregation.
- **A shared types package** (~2,800 lines) providing a single source of truth for the contract between extension and backend.

Distinguishing technical characteristics of the system:

- **Attribution-aware analysis.** The system tracks, per line of code, whether it was typed by the human or auto-inserted by an AI, and uses that attribution to decide what to teach and what to stay silent about.
- **Concept mastery separated from concept exposure.** A 1000+ entry concept taxonomy distinguishes concepts a user has *encountered* from concepts they have actually *authored themselves*, with an append-only stickiness invariant preventing regression.
- **A six-pillar skill model ("Code IQ")** measuring Craft, Range, Velocity, Debug, Quality, and Independence.
- **Cost-governed AI routing.** The system targets 5–10 model calls per hour rather than the 50–100 a naive implementation would make, through budgeting, suppression heuristics, prompt caching, and tiered model selection.
- **Hands-free voice mentorship** via wake-word detection, Whisper transcription, and on-device Kokoro TTS.

---

## 3. Origin and founding

**April 15, 2026** — Yurii Tovarnytskyi created the repository with the founding commit (`d448563`). He was the sole contributor for the project's first eight days and established, in that period, the monorepo structure, the extension/backend split, the shared-types contract, and the core product concept.

The first substantive system, committed **April 17, 2026** (`cd97d16`), was the real-time analysis engine: AI-powered live review, feature gating, and custom hover-based teaching tips. This established the pattern the whole product is built on — continuous background observation of the user's code, converted into teaching moments surfaced directly in the editor.

Through **April 18–21** Yurii built out real-time code analytics (`74cd818`) and expanded the extension's command surface and feature set (`48cf93b`), integrating this work through reviewed pull requests (#1, #2).

---

## 4. Architectural authorship

**April 23, 2026** (`de22c4d`) is the project's defining architectural commit. Yurii reorganized the entire extension source tree from a flat file layout into the feature-module structure the project still uses today, and in the same change shipped **Learning Mode** and **AI Blocks** while retiring the earlier SAVE/IDLE scan model.

That reorganization produced the seventeen feature modules that constitute the extension today:

```
review/     teaching/   hints/      echo/       chat/
watcher/    voice/      concepts/   detection/  intent/
user/       ai/         commands/   walk/       workspace/
notes/      settings/
```

Every subsequent contributor to the project, including Bohdan Chuprynka, has worked inside this structure. It is the organizing decision that shaped all later development.

Yurii additionally authored the project's technical documentation set — `Architecture/full-architecture.md`, the Supabase schema, `Vision/improved-vision.md`, and the cost-analysis documents — establishing the system design in writing as well as in code.

---

## 5. Systems built, by authorship

The table below breaks the codebase down by subsystem and attributes added lines to each contributor, as recorded by git.

| Subsystem | Purpose | Yurii | Bohdan | Principal author |
|---|---|---|---|---|
| **Webview UI** (`webview/`) | Entire React interface: mentor chat, skill tree, dashboards | **+46,351** | +3,070 | **Yurii (94%)** |
| **Review** (`src/review/`) | Live review, AST analyzer, finding gate, decorations | **+5,047** | +137 | **Yurii (97%)** |
| **Teaching** (`src/teaching/`) | Learning Mode, lesson sessions, micro-step teaching | **+4,518** | +1 | **Yurii (~100%)** |
| **Chat** (`src/chat/`) | Mentor chat client and panel plumbing | **+3,801** | +292 | **Yurii (93%)** |
| **Backend routes** (`src/routes/`) | All 19 API endpoints | **+3,257** | +2,513 | **Yurii (56%)** |
| **Concepts** (`src/concepts/`) | Concept detection and taxonomy mapping | **+2,034** | 0 | **Yurii (100%)** |
| **Shared types** (`packages/types/`) | Extension↔backend contract | **+2,011** | +830 | **Yurii (71%)** |
| **Voice** (`src/voice/`) | Wake word, STT/TTS client, session state | **+1,908** | +734 | **Yurii (72%)** |
| **Watcher** (`src/watcher/`) | Event bus, triggers, nudge dispatcher | **+1,008** | +184 | **Yurii (85%)** |
| **Prompts** (`src/prompts/`) | LLM prompt engineering | **+949** | +23 | **Yurii (98%)** |
| **Migrations** | Postgres schema evolution | **+302** | +212 | **Yurii (59%)** |
| Echo (`src/echo/`) | Behavior analytics subsystem | +163 | +5,531 | Bohdan (97%) |
| Walk (`src/walk/`) | Guided code walkthrough | 0 | +1,149 | Bohdan (100%) |

Yurii is the principal author of eleven of the thirteen subsystems, including every system that constitutes the product's core value: teaching, review, chat, concept tracking, voice, and the complete user interface.

---

## 6. Chronological record of what was added

### Phase 1 — Foundation (April 15–21, 2026) — Yurii, sole contributor

| Date | Contribution |
|---|---|
| Apr 15 | Repository founded; monorepo, extension/backend split, shared-types contract established |
| Apr 17 | Real-time analysis engine: AI-powered live review, feature gating, custom hover teaching tips |
| Apr 18–19 | Foundational extension scaffolding |
| Apr 21 | Real-time code analytics; expanded command surface; merged via PR #1 and #2 |

### Phase 2 — Architecture and second contributor (April 23–29, 2026)

| Date | Contributor | Contribution |
|---|---|---|
| Apr 23 | **Yurii** | **Full source reorganization into feature modules; Learning Mode and AI Blocks shipped; SAVE/IDLE scans retired** |
| Apr 23 | Bohdan | Echo analytics subsystem introduced: event taxonomy, persistence layer, REST surface, nightly aggregation jobs, dashboard webview, vitest harness, Kokoro model pre-download, Vite HMR |
| Apr 24 | Bohdan | Echo code-review fixes (symlink guard, re-entry handling) |
| Apr 26 | Bohdan | Auto-fire cost reduction, Walk feature, backend cache foundation |
| Apr 29 | **Yurii** | Continued core development |

### Phase 3 — Production readiness (April 30 – May 1, 2026)

| Date | Contributor | Contribution |
|---|---|---|
| Apr 30 | **Yurii** | Notes and chat-history routes; quota logging and management |
| Apr 30 | **Yurii** | Lesson session data model refactor; pattern spotter retired |
| Apr 30 | Bohdan | Railway deploy config: `/healthz`, CORS allowlist, env template, build fixes |
| May 1 | **Yurii** | **Security: revoked anonymous Postgres grants on legacy tables (migration 004)** |
| May 1 | **Yurii** | Migration 003 hardening for pre-existing `chat_messages` rows |
| May 1 | **Yurii** | Per-user OpenAI prompt-cache routing (cost reduction) |
| May 1 | **Yurii** | Conversation-history trimming and summarization for long sessions |
| May 1 | **Yurii** | Live Review moved to cloud nano model; $0.50/day per-user cost cap |
| May 1 | **Yurii** | Quota accounting corrected to count user turns, not tool rounds |
| May 1 | **Yurii** | **On-device LLM (Qwen / llama.cpp) removed; architecture consolidated to cloud-only** |
| May 1 | **Yurii** | Provider clarity refactor, paced teaching, zero-UI voice |
| May 1 | **Yurii** | One-click backend switcher with status-bar indicator, gated behind developer mode |
| May 1 | **Yurii** | Default provider set to OpenAI with fail-loud model resolution |
| May 1 | **Yurii** | Voice quality: wake-threshold tuning, ghost-transcript elimination, STT hallucination filtering |
| May 1 | **Yurii** | Marketplace publishing metadata; Privacy/Terms endpoints |

### Phase 4 — Release (May 2–4, 2026)

| Date | Contributor | Contribution |
|---|---|---|
| May 2 | **Yurii** | Whisper repetition-prefix stripping (recovers transcripts instead of discarding them) |
| May 2 | **Yurii** | Stuck-thinking watchdog — resets voice phase if chat never starts |
| May 2 | **Yurii** | **Token tracking, voice/text post-processors, persona length contracts, quota cleanup** |
| May 2 | **Yurii** | Unified token-only daily cap with migration-005 tooling |
| May 2 | **Yurii** | Version 0.0.2 published to marketplace |
| May 2 | Bohdan | Cross-platform voice binary fetcher, CI release workflow, prompt-injection hardening, `/analyze` cost cap |
| May 3 | **Yurii** | Voice closer questions, sticky highlights, CodeLens cleanup, panel reliability (0.1.4) |
| May 3 | **Yurii** | **Butterfly branding across all surfaces; blue (#0091FE) icon** |
| May 3 | **Yurii** | Release 0.1.6 + Open VSX publishing documentation |
| May 3 | Bohdan | TEAM_OVERRIDE hardening: three safeguards against dev config shipping to production (PR #9) |
| May 4 | **Yurii** | **Release 0.1.7** |

---

## 7. Engineering practices established by the owner

Yurii established and enforced the engineering standards the repository operates under:

- **Reviewed integration.** Work reaches `main` through pull requests (6 merged PRs) and a `development` → `main` branch discipline, not direct pushes.
- **Automated safety guards.** The repository refuses to produce a production build while a developer's local backend override is active — a build-time refusal, a pre-commit hook, and a CI check, installed automatically on `pnpm install`. This was introduced after an override shipped in version 0.1.4, and prevented recurrence.
- **Security hardening.** Anonymous Postgres grants on legacy tables were revoked (migration 004); database seed credentials were moved to environment variables; prompt-injection hardening was applied to the analysis path; rate limits are enforced per user on ingest endpoints.
- **Cost discipline.** The system enforces a per-user daily token cap, a per-request ceiling, prompt caching, conversation trimming, and tiered model routing. Known cost risks are tracked in writing in `Architecture/llm-cost-followups.md`.
- **Test coverage on critical logic.** 172 tests across 14 files, covering store invariants, quota enforcement, auth middleware, line-diff math, authorship-ratio computation, ISO-week boundaries, and input sanitization.
- **Documented invariants.** Non-obvious system rules — concept-authorship stickiness, the dual IQ engines, tool-name mirroring between client and server, deliberately paused surfaces — are documented so contributors don't unknowingly break them.

---

## 8. Shipped result

Protege is a published, working product, not a prototype:

- Released publicly on the **VS Code Marketplace** as `protege-ai.protege`, currently at **version 0.1.7**, with a documented release process covering Open VSX as well.
- Backend deployed and running on **Railway**, backed by **Supabase Postgres** with five applied schema migrations.
- **Eight tagged release and version-bump commits** shipped between May 1 and May 4, 2026, advancing the extension from 0.0.1 to 0.1.7.
- Roughly **80,500 lines** of production TypeScript and React across the extension, webview, backend, and shared types.

---

## 9. Verification

Every quantitative claim in this document is reproducible from the repository:

```bash
# Contribution totals per author, excluding generated files
git log --numstat --format="AUTHOR:%an" --no-merges -- . \
  ':!*pnpm-lock.yaml' ':!*dist/*' ':!node_modules' \
  ':!*.vsix' ':!*.pdf' ':!*.xlsx' ':!*.onnx' \
| awk '/^AUTHOR:/ {a=substr($0,8); next}
       NF==3 && $1!="-" {add[a]+=$1; del[a]+=$2; f[a]++}
       END {for (x in add) printf "%-25s +%-8d -%-8d (%d)\n", x, add[x], del[x], f[x]}'

# Per-subsystem authorship (substitute any path)
git log --numstat --format="AUTHOR:%an" --no-merges -- apps/extension/src/teaching \
| awk '/^AUTHOR:/ {a=substr($0,8); next} NF==3 && $1!="-" {s[a]+=$1}
       END {for (x in s) printf "%-25s +%d\n", x, s[x]}'

# Founding commit and full chronology
git log --reverse --format="%ad | %an | %s" --date=short

# Commit counts per contributor
git shortlog -sne --all

# Test suite
pnpm --filter @protege/backend test
```

---

*Prepared from the git history of the Protege repository. Figures reflect the repository state as of the 0.1.7 release, covering April 15 – May 4, 2026.*
