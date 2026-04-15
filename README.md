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
```

## Dev

```bash
pnpm install

# backend
cp apps/backend/.env.example apps/backend/.env
pnpm dev:backend

# extension (in another terminal)
pnpm --filter @protege/extension build:webview
pnpm dev:extension
# then F5 in VS Code on apps/extension to launch Extension Host
```

See [Architecture/mvp.md](Architecture/mvp.md) and [Vision/improved-vision.md](Vision/improved-vision.md).
