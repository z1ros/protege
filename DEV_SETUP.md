# Protege — Developer Setup

How to clone, run, and switch between local and production backends.

## Quick start (the happy path)

```bash
git clone https://github.com/z1ros/protege.git
cd protege
pnpm install
```

Open in VS Code / Cursor:

```bash
code .   # or: cursor .
```

Then start the backend + extension dev loop:

```bash
# Terminal 1 — backend
cd apps/backend
pnpm dev      # listens on http://localhost:8787

# Terminal 2 — extension
cd apps/extension
pnpm dev      # tsup watch + vite watch
```

In VS Code: press **F5** (Run → Start Debugging) to launch a child window with the extension loaded. The child window's Protege panel will hit your local backend automatically.

## How the extension picks a backend URL

When the extension boots, it resolves which backend to talk to in this order:

1. **`PROTEGE_BACKEND_URL` environment variable** — wins over everything. Useful for one-off testing without persistent state:
   ```bash
   PROTEGE_BACKEND_URL=https://staging.example.com cursor .
   ```

2. **`protege.backendUrl` VS Code setting** — what the in-app switcher writes to. Persists across reloads.

3. **Default** — depends on how the extension was built:
   - **Built with `pnpm dev` (NODE_ENV=development)** → `http://localhost:8787` (local backend)
   - **Built with `pnpm build` (release / .vsix from marketplace)** → `https://protege-backend-production.up.railway.app` (Railway prod)

So if you cloned the repo and ran `pnpm dev`, you don't need to do anything — the default is already localhost.

## Switching backends from inside the editor

`Cmd+Shift+P` → **`Protege: Switch Backend`**

A quick-pick opens with three options:

- **Production** (Railway) — clears the setting, falls back to default
- **Local** (`http://localhost:8787`) — sets the VS Code setting
- **Custom URL…** — for staging / self-hosted

The currently active one shows a checkmark. After switching, **reload the window** (`Developer: Reload Window` or `Cmd+R`) — the URL is cached at module-load time.

> ⚠️ The switcher command is gated behind the `protege.developerMode` setting. Toggle it on under VS Code Settings if the command is hidden.

## Verifying which backend is active

Two ways:

1. **Status bar** — bottom right shows "Server: Prod" or similar.
2. **Output channel** — `Cmd+Shift+P` → `Protege: Show Logs` → look for the `[protege] backend …` line at startup.

## Required env in `apps/backend/.env`

```
AI_PROVIDER=openai
OPENAI_MODEL=gpt-5-mini          # premium tier — chat, voice, teaching
OPENAI_CHEAP_MODEL=gpt-5-nano    # cheap tier — Live Review, classifiers

OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...     # only used when AI_PROVIDER=anthropic

# Supabase (memory + chat history + quotas)
SUPABASE_URL=https://...
SUPABASE_SERVICE_KEY=...
```

If `OPENAI_MODEL` is unset, the backend throws a clear error on the first chat call instead of silently routing to a retired model id. Same for `OPENAI_CHEAP_MODEL`.

## Common gotchas

- **Switched backend, nothing happened** — you forgot to reload the window. The URL is read once at module-load.
- **`Command 'protege.switchBackend' not found`** — toggle on `protege.developerMode` in settings. The command is hidden for non-devs by design.
- **Empty chat reply / 401** — your GitHub session may have expired. Sign out + back in via the Profile tab.
- **Hearing audio with no chat history** — orphan `afplay` from a prior reload. Killed automatically on next activation; if not, run `pkill -f protege-tts-` in your terminal.
