# Protege

AI coding mentor that lives inside your editor.

## Stack

- **Monorepo:** pnpm workspaces
- **Extension:** TypeScript + VS Code API + React (sidebar webview)
- **Backend:** Node.js + Hono + Anthropic SDK
- **Database:** Supabase
- **Hosting:** Railway

## Structure

```
apps/
  extension/   VS Code extension + React sidebar webview
  backend/     Hono server (chat, analyze, concepts, me)
packages/
  types/       Shared TS types between extension & backend
voice/         Wake-word training config (openWakeWord)
```

## Requirements

- Node.js ≥ 20
- pnpm 9 (`corepack enable` or `npm i -g pnpm@9`)
- VS Code ≥ 1.90

## Dev

```bash
# 1. Install. The workspace `postinstall` hook also pre-downloads the
#    Kokoro TTS model (~160 MB) into the transformers.js cache so the
#    backend doesn't hit a known CDN bug on first boot. Safe to re-run.
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

See [Architecture/mvp.md](Architecture/mvp.md) and
[Vision/improved-vision.md](Vision/improved-vision.md).
