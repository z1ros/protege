# Protege

**AI coding mentor that lives inside your editor.**

Protege is a VS Code extension that watches you code, detects the concepts you use, tracks how your skills develop over time, and teaches you on demand — instead of writing the code for you.

**Created and architected by [Yurii Tovarnytskyi](https://github.com/z1ros)** — founder, project owner, and principal engineer.
Published to the VS Code Marketplace as `protege-ai.protege`. Current version **0.1.7**.

For the full record of who designed and built each system, see **[CONTRIBUTION-HISTORY.md](CONTRIBUTION-HISTORY.md)**.

---

## What it does

| Capability | What happens |
|---|---|
| **Mentor chat** | A sidebar mentor that reads your actual workspace — it can open files, grep, highlight lines in your editor, and teach against your real code. |
| **Live review** | Tiered background analysis surfaces issues as you type, gated so it stays quiet instead of nagging. |
| **Learning Mode** | Turn-based teaching that plans a concept into atomic micro-steps and walks you through them one at a time. |
| **Concept tracking** | Detects the concepts you encounter versus the ones you've actually authored yourself, across a 1000+ concept taxonomy. |
| **Code IQ** | A six-pillar skill model — Craft, Range, Velocity, Debug, Quality, Independence. |
| **Echo dashboard** | A behavior-analytics surface: sessions, authorship ratio, paste classification, commit enrichment, cohort survival. |
| **Voice** | Wake-word activation, speech-to-text, and on-device Kokoro TTS so you can talk to your mentor hands-free. |

---

## Stack

- **Monorepo:** pnpm workspaces
- **Extension:** TypeScript + VS Code API + React (sidebar webview, Vite)
- **Backend:** Node.js + Hono, OpenAI primary with Anthropic fallback
- **Database:** Supabase (Postgres)
- **Hosting:** Railway
- **Voice:** openWakeWord + Whisper STT + Kokoro TTS (on-device ONNX)
- **Tests:** vitest — 14 files, 172 tests

## Structure

```
apps/
  extension/   VS Code extension + React sidebar webview
  backend/     Hono server (chat, analyze, concepts, voice, echo, me)
packages/
  types/       Shared TS types between extension & backend
Architecture/  System architecture and cost documentation
Vision/        Product direction
voice/         Wake-word training config (openWakeWord)
scripts/       Git hook installer + build guards
```

Deeper map of every subsystem: [.claude/agent-repo-guide.md](.claude/agent-repo-guide.md).

## Requirements

- Node.js ≥ 20
- pnpm 9 (`corepack enable` or `npm i -g pnpm@9`)
- VS Code ≥ 1.90

## Dev

```bash
# 1. Install. The workspace `postinstall` hook also pre-downloads the
#    Kokoro TTS model (~160 MB) into the transformers.js cache so the
#    backend doesn't hit a known CDN bug on first boot, AND installs
#    the repo's pre-commit hooks into .git/hooks (idempotent).
#    Re-run this after every `git pull` to keep hooks in sync.
pnpm install

# 2. Backend env
cp apps/backend/.env.example apps/backend/.env
# fill in ANTHROPIC_API_KEY (required), OPENAI_API_KEY (for STT),
# and SUPABASE_* keys.

# 3. Run backend (terminal 1)
pnpm dev:backend
# → listens on http://localhost:8787
# → "[protege] kokoro ready in Xms" confirms TTS is up.

# 4. Build webview + run extension watcher (terminal 2)
pnpm --filter @protege/extension build:webview
pnpm dev:extension
```

Then in VS Code:

- Open the **repo root** (or `apps/extension`) as the workspace.
- Press **F5** → picks the `Run Extension` config from
  [.vscode/launch.json](.vscode/launch.json) and launches the
  Extension Development Host with Protege loaded.

If F5 opens a "find a Markdown extension" prompt, you're focused on a
Markdown file without a debug config selected — use the Run and Debug
panel and pick `Run Extension` explicitly.

## Tests

```bash
pnpm --filter @protege/backend test    # 14 files, 172 tests, ~1s
pnpm -r typecheck                      # every workspace
```

Run both before committing.

## Pointing the dev host at the local backend

`pnpm dev:extension` already defaults to `http://localhost:8787`, so 99%
of the time you don't need to do anything — just run `pnpm dev:backend`
and F5.

If you need to **force** the backend (e.g. running a `.vsix` build but
want it to talk to local, or repro a prod-only bug from your dev host),
copy the template:

```bash
cp apps/extension/src/user/teamOverride.local.ts.example \
   apps/extension/src/user/teamOverride.local.ts
# Edit it: set TEAM_OVERRIDE to "local" or "prod" instead of null.
```

The `.local.ts` file is gitignored. When you're done, delete it:

```bash
rm apps/extension/src/user/teamOverride.local.ts
```

**Don't run `pnpm build` while it's set** — tsup will refuse with a clear
error. That's intentional: it stops a `vsce package` from accidentally
shipping your override to the marketplace (this is what broke 0.1.4).
The pre-commit hook also blocks staging the file. Both guards are
installed automatically by `pnpm install`.

## Publishing

See [apps/extension/PUBLISHING.md](apps/extension/PUBLISHING.md) for the
full Open VSX release flow (build → package → publish). Token lives in
`apps/extension/.env` (gitignored; template at `.env.example`).

## Troubleshooting

- **`kokoro warmup failed: Unable to get model file path or buffer`** —
  the postinstall prep didn't run or was interrupted. Re-run manually:
  ```bash
  pnpm --filter @protege/backend prepare-kokoro
  ```
  Kokoro is used only for `/tts` (voice explanations). Failure is
  non-fatal — the rest of the backend still serves normally.
- **`Unknown tool: create_file`** from the extension chat — this is
  by design. `create_file` is disabled; edit existing files instead.
- **`@protege/extension` build shows duplicate-case warnings** — stale
  `dist/`. Re-run `pnpm --filter @protege/extension build`.
- **Logs aren't showing** — Protege logs to its own `Protege` Output
  channel via `src/log.ts`, not the debug console.

## Docs

| Doc | What's in it |
|---|---|
| [CONTRIBUTION-HISTORY.md](CONTRIBUTION-HISTORY.md) | Authorship and development history of the project |
| [.claude/agent-repo-guide.md](.claude/agent-repo-guide.md) | Working guide to every subsystem |
| [Architecture/full-architecture.md](Architecture/full-architecture.md) | Full system architecture |
| [Architecture/llm-cost-followups.md](Architecture/llm-cost-followups.md) | Per-user LLM cost risks and fixes |
| [Vision/improved-vision.md](Vision/improved-vision.md) | Product direction |
| [DEV_SETUP.md](DEV_SETUP.md) | Extended setup notes |

---

© Yurii Tovarnytskyi. Extension licensed MIT.
