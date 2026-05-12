# Chat Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single flat chat-message log with first-class chat sessions so users can start, switch between, rename, and delete distinct conversations — both locally and synced to the cloud.

**Architecture:**
- A new `chat_sessions` table (Supabase / Postgres) owns conversation metadata. `chat_messages` gains a `session_id` FK column. Existing flat history is bucketed into one `legacy-<userId>` session per user during migration, so no message is lost and old clients keep working.
- The extension host (`webviewHost.ts`) holds the current active session ID per webview and threads it through every message append and broadcast. The webview tracks `sessions[]` + `currentSessionId` and renders the history panel as a list of conversations (newest first), each click switches the live view to that session's messages.
- "New chat" mints a fresh session ID locally; the row is only persisted to the cloud on the first message in the session (lazy creation, no empty rows).
- Title is derived automatically from the first user message (first ~60 chars, code blocks stripped) and is editable later via a rename endpoint.

**Tech Stack:**
- Shared types: `packages/types` (TypeScript)
- Backend: Hono + Supabase (Node.js on Railway), Vitest tests in `apps/backend/`
- Extension host: TypeScript / VS Code Extension API, globalState persistence, Vitest tests in `apps/extension/src/`
- Webview UI: React 18, plain CSS (`apps/extension/webview/`)

---

## File Structure

### Files to Create

| Path | Responsibility |
|------|----------------|
| `apps/backend/migrations/006_chat_sessions.sql` | Schema: new `chat_sessions` table, `session_id` column on `chat_messages`, backfill legacy rows, RLS lockdown, indexes. Idempotent. |
| `apps/backend/src/routes/chatSessions.ts` | Hono routes: `GET /chat-sessions`, `POST /chat-sessions`, `PATCH /chat-sessions/:id`, `DELETE /chat-sessions/:id`, `GET /chat-sessions/:id/messages`. |
| `apps/backend/src/routes/chatSessions.test.ts` | Vitest integration tests for the routes against a stubbed Supabase client (mirrors `quotas.test.ts` pattern). |
| `apps/extension/src/chat/chatSessions.ts` | Extension-side session client: `listSessions()`, `createSession()`, `renameSession()`, `deleteSession()`, `getMessagesForSession()`. Local cache in globalState + cloud sync. |
| `apps/extension/src/chat/chatSessions.test.ts` | Vitest unit tests for the title-derivation helper + boundary logic. |
| `apps/extension/webview/ChatSessionsList.tsx` | New component: renders the list of past sessions, click to switch, supports rename and delete per item. Replaces the by-day turn list inside `ChatHistoryPanel`. |

### Files to Modify

| Path | Reason |
|------|--------|
| `packages/types/src/index.ts` | Add `ChatSession` interface; add `sessionId: string` to `ChatMessage`; add new `WebviewToHost` / `HostToWebview` message types (`chat/listSessions`, `chat/sessions`, `chat/switchSession`, `chat/sessionSwitched`, `chat/renameSession`, `chat/deleteSession`, etc.); deprecate `chat/getFullHistory` and `chat/fullHistory`. |
| `apps/backend/src/index.ts` | Mount the new `chatSessions` route under `/chat-sessions`. |
| `apps/backend/src/routes/chatHistory.ts` | `rowToMessage()` includes `sessionId`. POST insert writes `session_id`. GET filters by `session_id` query param. Backwards-compat default: missing `session_id` resolves to `legacy-<userId>` on read. |
| `apps/extension/src/chat/chatHistory.ts` | `appendMessage()` requires `sessionId`. `getHistory()` becomes `getMessagesForSession(sessionId)`. New `legacySessionIdFor(userId)` helper. Hydration pulls sessions list, then loads active session's messages. |
| `apps/extension/src/chat/webviewHost.ts` | Track `currentSessionId` per webview. New message-type handlers (`chat/listSessions`, `chat/switchSession`, `chat/newSession`, `chat/renameSession`, `chat/deleteSession`). `handleChat()` mints a session lazily if `currentSessionId === null` at the start of a turn. All `appendMessage()` calls pass `sessionId`. |
| `apps/extension/src/chat/chatRunner.ts` | No structural change — already takes `history` array; the caller now passes session-scoped history. |
| `apps/extension/src/teaching/teachingFlow.ts` | `chatMsg()` helper takes a `sessionId` parameter (or pulls it from a per-host accessor). |
| `apps/extension/src/teaching/exerciseEngine.ts` | Same as `teachingFlow.ts`. |
| `apps/extension/webview/App.tsx` | New state: `sessions: ChatSession[]`, `currentSessionId: string \| null`. New message handlers (`chat/sessions`, `chat/sessionSwitched`). Refactor `onNewChat` to send `chat/newSession`; refactor `onJumpTo` to switch sessions when clicking a card. Live view only renders messages whose `sessionId === currentSessionId`. |
| `apps/extension/webview/ChatHistoryPanel.tsx` | Becomes a session-list container; turn-grouping logic moves to a per-session preview helper that computes the headline from a session's first/last message. |
| `apps/extension/webview/styles/*.css` (or wherever ChatHistoryPanel styles live) | Add styles for session row, active indicator, hover delete/rename. |

---

## Conventions

- Migration files are idempotent. Use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and guard backfills with `WHERE session_id IS NULL`.
- Session IDs are client-generated: `s_<base36-timestamp>_<random>` (similar to `m_…` for messages). 22 chars max. Stored as TEXT.
- The fallback session for un-tagged legacy rows is deterministic: `legacy-<userId>`. The migration creates one such row per distinct `user_id` in `chat_messages`.
- Title trimming: strip fenced code blocks → strip inline backticks → collapse whitespace → take first 60 chars → ellipsis if longer. Defined once in `apps/extension/src/chat/chatSessions.ts` and re-used.
- Frequent commits: one commit per task. Use Conventional Commits prefixes (`feat`, `fix`, `chore`, `refactor`).

---

## Task 1: Add `ChatSession` type and `sessionId` field

**Files:**
- Modify: `packages/types/src/index.ts:10-20` (ChatMessage), and the `WebviewToHost`/`HostToWebview` union sections (around lines 629 and 801)

- [ ] **Step 1: Open `packages/types/src/index.ts` and locate the `ChatMessage` interface (around line 10).**

- [ ] **Step 2: Add `sessionId` to `ChatMessage`. Replace the existing interface with:**

```typescript
export interface ChatMessage {
  id: string;
  /** Which conversation this message belongs to. Required on all new
   *  messages. Legacy messages persisted before the sessions feature
   *  shipped resolve to `legacy-<userId>` during hydration. */
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** How this turn was delivered. "voice" means the user spoke it (wake
   *  word or voice mode) or the assistant's reply was spoken aloud. Used
   *  by the UI to show a small mic glyph, and by the backend to pick a
   *  short, ear-friendly prompt. Undefined on legacy/persisted messages. */
  source?: "voice" | "text";
}
```

- [ ] **Step 3: Below `ChatMessage`, add the `ChatSession` interface:**

```typescript
/**
 * A chat session = one continuous conversation. Sessions are user-scoped,
 * synced to the cloud, and visible as separate cards in the history panel.
 * Title defaults to a snippet of the first user message; the user can rename.
 */
export interface ChatSession {
  id: string;
  /** GitHub numeric ID (same shape as ChatMessage.userId, server-side only). */
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent message in the session. Used for
   *  list sort order ("most recently active first"). */
  lastMessageAt: string;
  messageCount: number;
}
```

- [ ] **Step 4: Scroll to the `WebviewToHost` union (around line 629) and add the new message types just below the existing `chat/*` entries. Keep the existing union members intact:**

```typescript
  | { type: "chat/listSessions" }
  | { type: "chat/switchSession"; sessionId: string }
  | { type: "chat/newSession" }
  | { type: "chat/renameSession"; sessionId: string; title: string }
  | { type: "chat/deleteSession"; sessionId: string }
```

Leave the existing `chat/getFullHistory` and `chat/clearHistory` members in place for now — `clearHistory` still means "wipe all sessions" and `getFullHistory` is removed in a later task.

- [ ] **Step 5: Scroll to the `HostToWebview` union (around line 801) and add the matching response types:**

```typescript
  | { type: "chat/sessions"; sessions: ChatSession[]; currentSessionId: string | null }
  | { type: "chat/sessionSwitched"; sessionId: string; messages: ChatMessage[] }
  | { type: "chat/sessionRenamed"; sessionId: string; title: string }
  | { type: "chat/sessionDeleted"; sessionId: string; nextSessionId: string | null }
```

Keep `chat/history`, `chat/fullHistory`, `chat/append` for now — they're refactored later, not removed yet.

- [ ] **Step 6: Run the typecheck to make sure nothing downstream broke yet.**

```bash
cd "/Users/bohdan/Documents/IT-Work/Projects/IT/Work/Protege Startup /protege"
pnpm -r --filter '@protege/types' build
```

Expected: clean build. Other packages will not yet compile (they need `sessionId` on constructed `ChatMessage` objects); we fix that as we go.

- [ ] **Step 7: Commit.**

```bash
git add packages/types/src/index.ts
git commit -m "feat(types): add ChatSession and sessionId to ChatMessage"
```

---

## Task 2: Backend migration — sessions table + backfill

**Files:**
- Create: `apps/backend/migrations/006_chat_sessions.sql`

- [ ] **Step 1: Create the migration file with the schema, indexes, RLS lockdown, and backfill. Idempotent throughout.**

```sql
-- 006_chat_sessions.sql
-- Introduces per-conversation sessions for chat history.
-- Idempotent: safe to re-run.

create table if not exists chat_sessions (
  id              text primary key,
  user_id         text not null,
  title           text not null default 'New chat',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  message_count   integer not null default 0
);

create index if not exists idx_chat_sessions_user_last
  on chat_sessions (user_id, last_message_at desc);

-- 1. Add the column to chat_messages, nullable for now so backfill can run.
alter table chat_messages
  add column if not exists session_id text;

-- 2. Backfill: create a single `legacy-<user_id>` session per distinct
--    user_id in chat_messages, anchored to the earliest message and
--    advanced to the latest. Then point all NULL session_id rows at it.
insert into chat_sessions (id, user_id, title, created_at, updated_at, last_message_at, message_count)
select
  'legacy-' || user_id           as id,
  user_id,
  'Conversations before sessions' as title,
  min(created_at)                 as created_at,
  max(created_at)                 as updated_at,
  max(created_at)                 as last_message_at,
  count(*)                        as message_count
from chat_messages
where session_id is null
group by user_id
on conflict (id) do nothing;

update chat_messages
   set session_id = 'legacy-' || user_id
 where session_id is null;

-- 3. Now enforce NOT NULL + FK + index.
alter table chat_messages
  alter column session_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name  = 'chat_messages'
      and constraint_name = 'chat_messages_session_id_fkey'
  ) then
    alter table chat_messages
      add constraint chat_messages_session_id_fkey
      foreign key (session_id) references chat_sessions (id) on delete cascade;
  end if;
end$$;

create index if not exists idx_chat_messages_session_created
  on chat_messages (session_id, created_at);

-- 4. RLS lockdown — service_role only, same pattern as chat_messages.
alter table chat_sessions enable row level security;
revoke all on chat_sessions from public;
revoke all on chat_sessions from anon;
revoke all on chat_sessions from authenticated;
grant select, insert, update, delete on chat_sessions to service_role;
```

- [ ] **Step 2: Verify the file looks right.**

```bash
ls -la "apps/backend/migrations/006_chat_sessions.sql"
```

Expected: file exists, ~2KB.

- [ ] **Step 3: Smoke-test by applying it to a scratch Postgres if available, or run via Supabase SQL editor. Idempotency check: run twice; second run must be a no-op.**

```bash
# Local Postgres (if SUPABASE_DB_URL is set to a dev DB)
psql "$SUPABASE_DB_URL" -f apps/backend/migrations/006_chat_sessions.sql
psql "$SUPABASE_DB_URL" -f apps/backend/migrations/006_chat_sessions.sql   # second run
```

Expected: both runs succeed, no errors. `chat_sessions` table has one row per distinct `user_id` in `chat_messages` (or zero rows if `chat_messages` is empty).

- [ ] **Step 4: Commit.**

```bash
git add apps/backend/migrations/006_chat_sessions.sql
git commit -m "feat(db): add chat_sessions table and session_id column"
```

---

## Task 3: Backend `rowToMessage` + `chat-history` route updates

**Files:**
- Modify: `apps/backend/src/routes/chatHistory.ts:70-77` (rowToMessage), POST handler (~line 92-112), GET handler (~line 76-90)

- [ ] **Step 1: Read `apps/backend/src/routes/chatHistory.ts` end-to-end so the edits are localized. Identify the `ChatRow` type, the `rowToMessage` function, and the GET/POST/DELETE handlers.**

- [ ] **Step 2: Update the `ChatRow` interface to include `session_id`.** Replace the existing definition with:

```typescript
interface ChatRow {
  id: string;
  user_id: string;
  session_id: string;
  role: string;
  content: string;
  source: string | null;
  created_at: string;
}
```

- [ ] **Step 3: Update `rowToMessage` to include `sessionId`.**

```typescript
function rowToMessage(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as "user" | "assistant",
    content: r.content,
    createdAt: r.created_at,
    source: (r.source as "voice" | "text" | undefined) ?? undefined,
  };
}
```

- [ ] **Step 4: Update the POST handler to require `message.sessionId` and write it.** Find the upsert call and add `session_id` to the payload object:

```typescript
const payload = {
  id: message.id,
  user_id: userId,
  session_id: message.sessionId,
  role: message.role,
  content: message.content,
  source: message.source ?? null,
  created_at: message.createdAt,
};
```

Add an input guard above the upsert:

```typescript
if (!message.sessionId || typeof message.sessionId !== "string") {
  return c.json({ error: "message.sessionId required" }, 400);
}
```

- [ ] **Step 5: Update the GET handler to accept an optional `sessionId` query param. When provided, filter to that session. When omitted, behavior is preserved (all messages for user — used as a fallback by legacy clients and by the backfill smoke test).**

Find the supabase query builder. Replace:

```typescript
const { data, error } = await supabase
  .from("chat_messages")
  .select("*")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(limit);
```

with:

```typescript
const sessionId = c.req.query("sessionId");
let query = supabase
  .from("chat_messages")
  .select("*")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(limit);
if (sessionId) {
  query = query.eq("session_id", sessionId);
}
const { data, error } = await query;
```

- [ ] **Step 6: Run the backend's existing typecheck.**

```bash
pnpm --filter '@protege/backend' typecheck
```

Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add apps/backend/src/routes/chatHistory.ts
git commit -m "feat(backend): thread sessionId through chat-history route"
```

---

## Task 4: Backend `chat-sessions` routes (write the failing test first)

**Files:**
- Create: `apps/backend/src/routes/chatSessions.ts`
- Create: `apps/backend/src/routes/chatSessions.test.ts`
- Modify: `apps/backend/src/index.ts` (mount route)

- [ ] **Step 1: Inspect the existing `quotas.test.ts` and `chatHistory.ts` for the test pattern (mock supabase client, build Hono app, assert on responses). Note the helpers used.**

- [ ] **Step 2: Write the failing test file first.** Create `apps/backend/src/routes/chatSessions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { chatSessionsRoute } from "./chatSessions.js";

// Mock the auth middleware so resolveUserId returns a known id.
vi.mock("../middleware/auth.js", () => ({
  githubAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  resolveUserId: () => "test-user-1",
  isAuthRequired: () => false,
  getAuthenticatedUserId: () => "test-user-1",
}));

// In-memory supabase stub keyed on the tables we touch.
const tables = new Map<string, Record<string, unknown>[]>();
vi.mock("../supabase.js", () => {
  function makeQuery(table: string) {
    return {
      select: () => makeQuery(table),
      eq: () => makeQuery(table),
      order: () => makeQuery(table),
      limit: () => makeQuery(table),
      upsert: (row: Record<string, unknown>) => {
        const rows = tables.get(table) ?? [];
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
        tables.set(table, rows);
        return Promise.resolve({ data: null, error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (col: string, val: unknown) => {
          const rows = tables.get(table) ?? [];
          for (const r of rows) if (r[col] === val) Object.assign(r, patch);
          return Promise.resolve({ data: null, error: null });
        },
      }),
      delete: () => ({
        eq: (col: string, val: unknown) => {
          const rows = tables.get(table) ?? [];
          tables.set(table, rows.filter((r) => r[col] !== val));
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
  }
  return {
    getSupabase: () => ({
      from: (name: string) => {
        const q = makeQuery(name);
        // The route uses .select().eq().order() — let the resolved promise
        // be the list of rows in the stubbed table for that user.
        // For simplicity, return a thenable on terminal calls; refine
        // per actual route code as needed.
        return new Proxy(q, {
          get(target, prop) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: tables.get(name) ?? [], error: null });
            }
            return (target as Record<string | symbol, unknown>)[prop];
          },
        });
      },
    }),
  };
});

function makeApp() {
  const app = new Hono();
  app.route("/chat-sessions", chatSessionsRoute);
  return app;
}

beforeEach(() => {
  tables.clear();
});

describe("chat-sessions routes", () => {
  it("lists sessions for the authenticated user", async () => {
    tables.set("chat_sessions", [
      { id: "s_1", user_id: "test-user-1", title: "First", created_at: "2026-05-10T10:00:00Z", updated_at: "2026-05-10T10:00:00Z", last_message_at: "2026-05-10T10:00:00Z", message_count: 2 },
      { id: "s_2", user_id: "other", title: "Other user", created_at: "2026-05-10T11:00:00Z", updated_at: "2026-05-10T11:00:00Z", last_message_at: "2026-05-10T11:00:00Z", message_count: 1 },
    ]);

    const res = await makeApp().request("/chat-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual(["s_1"]);
  });

  it("creates a new session via POST", async () => {
    const res = await makeApp().request("/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s_new", title: "Hello" }),
    });
    expect(res.status).toBe(200);
    expect((tables.get("chat_sessions") ?? []).length).toBe(1);
  });

  it("renames a session via PATCH", async () => {
    tables.set("chat_sessions", [
      { id: "s_rename", user_id: "test-user-1", title: "Old" },
    ]);
    const res = await makeApp().request("/chat-sessions/s_rename", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    });
    expect(res.status).toBe(200);
    expect((tables.get("chat_sessions") ?? [])[0].title).toBe("New title");
  });

  it("deletes a session via DELETE (cascades to messages)", async () => {
    tables.set("chat_sessions", [
      { id: "s_del", user_id: "test-user-1", title: "Doomed" },
    ]);
    tables.set("chat_messages", [
      { id: "m_1", user_id: "test-user-1", session_id: "s_del", role: "user", content: "x", created_at: "2026-05-10T10:00:00Z" },
    ]);
    const res = await makeApp().request("/chat-sessions/s_del", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(tables.get("chat_sessions")?.length).toBe(0);
    expect(tables.get("chat_messages")?.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails (route doesn't exist yet).**

```bash
pnpm --filter '@protege/backend' test -- chatSessions.test.ts
```

Expected: FAIL with module resolution error on `./chatSessions.js`.

- [ ] **Step 4: Create `apps/backend/src/routes/chatSessions.ts` with the minimal implementation to satisfy the tests:**

```typescript
import { Hono } from "hono";
import type { ChatSession } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { getSupabase } from "../supabase.js";

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  message_count: number;
}

function rowToSession(r: SessionRow): ChatSession {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
  };
}

export const chatSessionsRoute = new Hono();
chatSessionsRoute.use("*", githubAuth());

chatSessionsRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const supabase = getSupabase();
  if (!supabase) return c.json({ sessions: [] });
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) return c.json({ sessions: [], error: error.message });
  const sessions = (data ?? []).map((r) => rowToSession(r as SessionRow));
  return c.json({ sessions });
});

chatSessionsRoute.post("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const body = await c.req.json<{ id: string; title?: string }>();
  if (!body?.id) return c.json({ error: "id required" }, 400);
  const supabase = getSupabase();
  if (!supabase) return c.json({ ok: true });
  const now = new Date().toISOString();
  const { error } = await supabase.from("chat_sessions").upsert({
    id: body.id,
    user_id: userId,
    title: body.title ?? "New chat",
    created_at: now,
    updated_at: now,
    last_message_at: now,
    message_count: 0,
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

chatSessionsRoute.patch("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  const body = await c.req.json<{ title: string }>();
  if (typeof body?.title !== "string" || body.title.length === 0) {
    return c.json({ error: "title required" }, 400);
  }
  const supabase = getSupabase();
  if (!supabase) return c.json({ ok: true });
  const { error } = await supabase
    .from("chat_sessions")
    .update({ title: body.title.slice(0, 200), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

chatSessionsRoute.delete("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  const supabase = getSupabase();
  if (!supabase) return c.json({ ok: true });
  // Messages cascade via FK on session_id. Still issue an explicit delete
  // for clarity and so a misconfigured DB doesn't silently leak messages.
  await supabase.from("chat_messages").delete().eq("session_id", id);
  const { error } = await supabase
    .from("chat_sessions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
```

- [ ] **Step 5: Mount the route. Open `apps/backend/src/index.ts` and add:**

```typescript
import { chatSessionsRoute } from "./routes/chatSessions.js";
app.route("/chat-sessions", chatSessionsRoute);
```

Place it next to the existing `app.route("/chat-history", chatHistoryRoute)` line.

- [ ] **Step 6: Run the test again — should pass.**

```bash
pnpm --filter '@protege/backend' test -- chatSessions.test.ts
```

Expected: PASS for all four assertions.

- [ ] **Step 7: Commit.**

```bash
git add apps/backend/src/routes/chatSessions.ts apps/backend/src/routes/chatSessions.test.ts apps/backend/src/index.ts
git commit -m "feat(backend): chat-sessions CRUD routes"
```

---

## Task 5: Backend write-through — bump session metadata on new messages

When a message is appended via `POST /chat-history`, we need to update the parent session's `last_message_at`, `updated_at`, and `message_count`. Without this, the panel always shows the same stale order.

**Files:**
- Modify: `apps/backend/src/routes/chatHistory.ts` POST handler

- [ ] **Step 1: Before the upsert into `chat_messages`, ensure the parent session exists. Race-safe: the extension fire-and-forgets `POST /chat-sessions` and immediately `POST /chat-history` — without this guard the message write FK-violates if the session row hasn't landed yet. Add this just above the existing upsert call in the POST handler:**

```typescript
// Race safety: the extension may fire-and-forget the session create
// before the first message lands here. Upsert a placeholder row keyed
// on session_id so the FK never violates. If the real row arrived
// first, on conflict do nothing.
await supabase.from("chat_sessions").upsert(
  {
    id: message.sessionId,
    user_id: userId,
    title: "New chat",
    created_at: message.createdAt,
    updated_at: message.createdAt,
    last_message_at: message.createdAt,
    message_count: 0,
  },
  { onConflict: "id", ignoreDuplicates: true },
);
```

- [ ] **Step 2: After a successful upsert into `chat_messages`, also update the parent session. Add this after the message upsert call (keep it fire-and-forget — failure here is non-fatal for the message write):**

```typescript
// Bump parent session so it sorts to the top of the list and shows the
// fresh message count. Best-effort; failure does not roll back the
// message write.
void (async () => {
  try {
    await supabase.rpc("bump_chat_session", {
      p_session_id: message.sessionId,
      p_user_id: userId,
      p_at: message.createdAt,
    });
  } catch {
    /* swallow */
  }
})();
```

- [ ] **Step 3: Add the supporting RPC to `006_chat_sessions.sql` (idempotent — append at the bottom of the file):**

```sql
-- Atomic session bump on new-message write. Increments count and slides
-- last_message_at / updated_at forward (never backward, in case of
-- out-of-order writes from offline-resync).
create or replace function bump_chat_session(
  p_session_id text,
  p_user_id    text,
  p_at         timestamptz
) returns void
language plpgsql
as $$
begin
  update chat_sessions
     set last_message_at = greatest(last_message_at, p_at),
         updated_at      = greatest(updated_at, p_at),
         message_count   = message_count + 1
   where id = p_session_id
     and user_id = p_user_id;
end;
$$;
```

- [ ] **Step 4: Re-run the migration locally.**

```bash
psql "$SUPABASE_DB_URL" -f apps/backend/migrations/006_chat_sessions.sql
```

Expected: success.

- [ ] **Step 5: Typecheck the backend.**

```bash
pnpm --filter '@protege/backend' typecheck
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/backend/src/routes/chatHistory.ts apps/backend/migrations/006_chat_sessions.sql
git commit -m "feat(backend): bump chat session metadata + race-safe parent upsert"
```

---

## Task 6: Extension `chatSessions.ts` client + title helper (TDD)

**Files:**
- Create: `apps/extension/src/chat/chatSessions.ts`
- Create: `apps/extension/src/chat/chatSessions.test.ts`

- [ ] **Step 1: Write the failing test first. Create `apps/extension/src/chat/chatSessions.test.ts`:**

```typescript
import { describe, it, expect } from "vitest";
import {
  deriveSessionTitle,
  newSessionId,
  legacySessionIdFor,
} from "./chatSessions.js";

describe("deriveSessionTitle", () => {
  it("uses the first user message, trimmed", () => {
    expect(deriveSessionTitle("How does the useState hook re-render?")).toBe(
      "How does the useState hook re-render?",
    );
  });

  it("strips fenced code blocks", () => {
    expect(
      deriveSessionTitle("Fix this:\n```js\nconst x = 1\n```\nthanks!"),
    ).toBe("Fix this: [code] thanks!");
  });

  it("strips inline backticks but keeps the contents", () => {
    expect(deriveSessionTitle("Why is `foo()` returning undefined?")).toBe(
      "Why is foo() returning undefined?",
    );
  });

  it("truncates to 60 chars with an ellipsis", () => {
    const long = "x".repeat(120);
    const result = deriveSessionTitle(long);
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result.endsWith("…")).toBe(true);
  });

  it("falls back to 'New chat' for empty input", () => {
    expect(deriveSessionTitle("")).toBe("New chat");
    expect(deriveSessionTitle("   ")).toBe("New chat");
  });
});

describe("newSessionId", () => {
  it("starts with the s_ prefix", () => {
    expect(newSessionId().startsWith("s_")).toBe(true);
  });
  it("returns unique IDs across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe("legacySessionIdFor", () => {
  it("produces a deterministic id per user", () => {
    expect(legacySessionIdFor("123")).toBe("legacy-123");
    expect(legacySessionIdFor("foo")).toBe("legacy-foo");
  });
});
```

- [ ] **Step 2: Run it — expect failure.**

```bash
pnpm --filter '@protege/extension' test -- chatSessions.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Create `apps/extension/src/chat/chatSessions.ts` with the minimal API surface to make tests pass + the cloud-sync skeleton we'll fill in:**

```typescript
import * as vscode from "vscode";
import type { ChatMessage, ChatSession } from "@protege/types";
import {
  authedFetch,
  BACKEND_URL,
  currentUserIdOrNull,
} from "../user/protegeClient.js";
import { log } from "../log.js";

const STORAGE_KEY = "protege.chatSessions";
const CURRENT_SESSION_KEY = "protege.chatSessions.current";

let ctx: vscode.ExtensionContext | null = null;

export function initChatSessions(context: vscode.ExtensionContext): void {
  ctx = context;
  void hydrateSessionsFromCloud();
}

/* ---------- Local state accessors ---------- */

export function getCachedSessions(): ChatSession[] {
  if (!ctx) return [];
  return ctx.globalState.get<ChatSession[]>(STORAGE_KEY) ?? [];
}

export function getCurrentSessionId(): string | null {
  if (!ctx) return null;
  return ctx.globalState.get<string | null>(CURRENT_SESSION_KEY) ?? null;
}

export function setCurrentSessionId(id: string | null): void {
  if (!ctx) return;
  void ctx.globalState.update(CURRENT_SESSION_KEY, id);
}

function writeSessionsCache(sessions: ChatSession[]): void {
  if (!ctx) return;
  void ctx.globalState.update(STORAGE_KEY, sessions);
}

/* ---------- Cloud sync ---------- */

async function hydrateSessionsFromCloud(): Promise<void> {
  if (!ctx) return;
  if (!currentUserIdOrNull()) return;
  try {
    const res = await authedFetch(`${BACKEND_URL}/chat-sessions`);
    if (!res.ok) return;
    const body = (await res.json()) as { sessions: ChatSession[] };
    const cloud = body.sessions ?? [];
    writeSessionsCache(cloud);
  } catch (err) {
    log(
      "chatSessions",
      `hydrate FAIL · ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function rehydrateChatSessions(): Promise<void> {
  await hydrateSessionsFromCloud();
}

/* ---------- Mutations ---------- */

export async function createSession(firstUserMessage?: string): Promise<ChatSession> {
  const id = newSessionId();
  const now = new Date().toISOString();
  const title = firstUserMessage ? deriveSessionTitle(firstUserMessage) : "New chat";
  const session: ChatSession = {
    id,
    userId: currentUserIdOrNull() ?? "local-dev",
    title,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messageCount: 0,
  };
  const next = [session, ...getCachedSessions()];
  writeSessionsCache(next);
  // Fire-and-forget cloud insert.
  void authedFetch(`${BACKEND_URL}/chat-sessions`, {
    method: "POST",
    body: JSON.stringify({ id, title }),
  }).catch(() => {});
  return session;
}

export async function renameSession(id: string, title: string): Promise<void> {
  const next = getCachedSessions().map((s) =>
    s.id === id ? { ...s, title, updatedAt: new Date().toISOString() } : s,
  );
  writeSessionsCache(next);
  void authedFetch(`${BACKEND_URL}/chat-sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  }).catch(() => {});
}

export async function deleteSession(id: string): Promise<void> {
  const next = getCachedSessions().filter((s) => s.id !== id);
  writeSessionsCache(next);
  void authedFetch(`${BACKEND_URL}/chat-sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => {});
}

/** Update local cache to reflect a new message appended to a session. */
export function noteMessageAppended(message: ChatMessage): void {
  const sessions = getCachedSessions();
  const idx = sessions.findIndex((s) => s.id === message.sessionId);
  if (idx === -1) return;
  const s = sessions[idx];
  const updated: ChatSession = {
    ...s,
    lastMessageAt: message.createdAt,
    updatedAt: message.createdAt,
    messageCount: s.messageCount + 1,
    // If this is the first user message in a freshly-minted session and
    // the title is still the default, retitle from the message body.
    title:
      s.title === "New chat" && message.role === "user"
        ? deriveSessionTitle(message.content)
        : s.title,
  };
  const next = [updated, ...sessions.filter((_, i) => i !== idx)];
  writeSessionsCache(next);
  // If we retitled, push the rename to cloud too.
  if (updated.title !== s.title) {
    void authedFetch(
      `${BACKEND_URL}/chat-sessions/${encodeURIComponent(s.id)}`,
      { method: "PATCH", body: JSON.stringify({ title: updated.title }) },
    ).catch(() => {});
  }
}

/* ---------- Pure helpers ---------- */

export function newSessionId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `s_${t}_${r}`;
}

export function legacySessionIdFor(userId: string): string {
  return `legacy-${userId}`;
}

export function deriveSessionTitle(raw: string): string {
  let cleaned = raw.replace(/```[\s\S]*?```/g, " [code] ");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 60 ? cleaned.slice(0, 60) + "…" : cleaned;
}
```

- [ ] **Step 4: Run tests — should pass.**

```bash
pnpm --filter '@protege/extension' test -- chatSessions.test.ts
```

Expected: PASS for all assertions in `deriveSessionTitle`, `newSessionId`, `legacySessionIdFor`.

- [ ] **Step 5: Commit.**

```bash
git add apps/extension/src/chat/chatSessions.ts apps/extension/src/chat/chatSessions.test.ts
git commit -m "feat(extension): chat sessions client with cloud sync"
```

---

## Task 7: Refactor `chatHistory.ts` — session-scoped reads, session-tagged writes

**Files:**
- Modify: `apps/extension/src/chat/chatHistory.ts`

- [ ] **Step 1: Replace `getHistory()` exports with session-scoped variants. Keep `getAllMessagesUnsafe()` as a private fallback for migration only.**

In `apps/extension/src/chat/chatHistory.ts`, replace:

```typescript
export function getHistory(): ChatMessage[] {
  if (!ctx) return [];
  return ctx.globalState.get<ChatMessage[]>(STORAGE_KEY) ?? [];
}
```

with:

```typescript
/** All persisted messages across all sessions. Use sparingly — most
 *  callers want getMessagesForSession instead. Kept exported because
 *  the search route and the migration helper both need the flat list. */
export function getAllMessages(): ChatMessage[] {
  if (!ctx) return [];
  return ctx.globalState.get<ChatMessage[]>(STORAGE_KEY) ?? [];
}

export function getMessagesForSession(sessionId: string): ChatMessage[] {
  return getAllMessages().filter((m) => m.sessionId === sessionId);
}
```

- [ ] **Step 2: `appendMessage` no longer needs to change signature — sessionId now lives on the message itself. Update the inline doc and the cloud-push so the parent session is notified after append.**

Replace the existing `appendMessage`:

```typescript
export function appendMessage(message: ChatMessage): void {
  if (!ctx) return;
  if (!message.sessionId) {
    // Hard guard: every persisted message must have a session. Caller
    // bug if we hit this.
    log("chatHistory", `appendMessage REJECT · missing sessionId · id=${message.id}`);
    return;
  }
  const history = getAllMessages();
  history.push(message);

  const pruned =
    history.length > MAX_MESSAGES
      ? history.slice(history.length - MAX_MESSAGES)
      : history;

  void ctx.globalState.update(STORAGE_KEY, pruned);
  void pushMessage(message);
  // Side effect: update local session metadata immediately so the UI
  // reflects the new last_message_at without waiting for a cloud round-trip.
  // Import is at top of file (added below in step 3).
  import("./chatSessions.js").then((mod) => mod.noteMessageAppended(message));
}
```

- [ ] **Step 3: Add the static import at the top of the file (replace the dynamic import shown above with a real one):**

```typescript
import { noteMessageAppended } from "./chatSessions.js";
```

Then in `appendMessage`, replace the dynamic-import line with the direct call:

```typescript
noteMessageAppended(message);
```

- [ ] **Step 4: Update the hydrate step to backfill `sessionId` on any legacy in-memory rows that arrived from cloud without it. (Cloud rows already have `session_id` after migration; this is belt-and-suspenders for offline-cached pre-migration data.)**

Inside `hydrateFromCloud`, after the merge, before the final sort+slice, add:

```typescript
const userId = currentUserIdOrNull();
if (userId) {
  for (const m of merged.values()) {
    if (!m.sessionId) m.sessionId = `legacy-${userId}`;
  }
}
```

- [ ] **Step 5: Update `searchHistory` to optionally scope to a session.**

```typescript
export function searchHistory(
  query: string,
  limit = 20,
  sessionId?: string,
): { message: ChatMessage; snippet: string }[] {
  const q = query.toLowerCase();
  const all = sessionId ? getMessagesForSession(sessionId) : getAllMessages();
  const results: { message: ChatMessage; snippet: string }[] = [];

  for (let i = all.length - 1; i >= 0 && results.length < limit; i--) {
    const msg = all[i];
    const idx = msg.content.toLowerCase().indexOf(q);
    if (idx === -1) continue;

    const start = Math.max(0, idx - 40);
    const end = Math.min(msg.content.length, idx + query.length + 40);
    let snippet = msg.content.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < msg.content.length) snippet = snippet + "...";

    results.push({ message: msg, snippet });
  }

  return results;
}
```

- [ ] **Step 6: Remove the now-unused `getHistoryByDay` export (the panel computes day grouping itself).** Delete the function body and the export.

- [ ] **Step 7: Update the cloud GET URL in `hydrateFromCloud` to include the active session if known. This narrows the initial pull so we don't redownload every message of every session on cold start.**

Find:

```typescript
const res = await authedFetch(
  `${BACKEND_URL}/chat-history?limit=${MAX_MESSAGES}`,
);
```

Replace with:

```typescript
// Stage 1: pull every message for the user (capped at MAX_MESSAGES).
// We still need the flat list because the UI may switch into any past
// session without warning. If profile work later shows this is too
// heavy, switch to session-scoped lazy load.
const res = await authedFetch(
  `${BACKEND_URL}/chat-history?limit=${MAX_MESSAGES}`,
);
```

(No code change — just the comment, which makes the design decision explicit for the next reader.)

- [ ] **Step 8: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: errors only in callers that still call `getHistory()` (renamed) or construct messages without `sessionId`. We fix those in the next tasks.

- [ ] **Step 9: Commit.**

```bash
git add apps/extension/src/chat/chatHistory.ts
git commit -m "refactor(extension): scope chatHistory APIs to a sessionId"
```

---

## Task 8: Thread `sessionId` through `webviewHost.ts`

**Files:**
- Modify: `apps/extension/src/chat/webviewHost.ts` (handlers, handleChat, broadcast, message handler switch)

- [ ] **Step 1: Read the top of `webviewHost.ts` and locate the imports plus the per-webview state structure. Add an import:**

```typescript
import {
  createSession,
  deleteSession,
  getCachedSessions,
  getCurrentSessionId,
  legacySessionIdFor,
  noteMessageAppended,
  renameSession,
  setCurrentSessionId,
  rehydrateChatSessions,
} from "./chatSessions.js";
import { getAllMessages, getMessagesForSession } from "./chatHistory.js";
```

- [ ] **Step 2: Find the message-handler switch (around line 547 for `chat/send` and around line 754 for `chat/getFullHistory`). Add new handlers before the existing `chat/getFullHistory`:**

```typescript
} else if (msg.type === "chat/listSessions") {
  await rehydrateChatSessions();
  post(webview, {
    type: "chat/sessions",
    sessions: getCachedSessions(),
    currentSessionId: getCurrentSessionId(),
  });
} else if (msg.type === "chat/newSession") {
  // Lazy: don't persist to cloud until the user sends a message. Local
  // state still gets a placeholder so the UI can switch immediately.
  setCurrentSessionId(null);
  post(webview, {
    type: "chat/sessionSwitched",
    sessionId: "",
    messages: [],
  });
} else if (msg.type === "chat/switchSession") {
  setCurrentSessionId(msg.sessionId);
  post(webview, {
    type: "chat/sessionSwitched",
    sessionId: msg.sessionId,
    messages: getMessagesForSession(msg.sessionId),
  });
} else if (msg.type === "chat/renameSession") {
  await renameSession(msg.sessionId, msg.title);
  post(webview, {
    type: "chat/sessionRenamed",
    sessionId: msg.sessionId,
    title: msg.title,
  });
} else if (msg.type === "chat/deleteSession") {
  await deleteSession(msg.sessionId);
  const remaining = getCachedSessions();
  const nextId = remaining[0]?.id ?? null;
  if (getCurrentSessionId() === msg.sessionId) setCurrentSessionId(nextId);
  post(webview, {
    type: "chat/sessionDeleted",
    sessionId: msg.sessionId,
    nextSessionId: nextId,
  });
  // After delete, follow up with the active session's messages so the
  // live view doesn't render stale content from the deleted session.
  if (nextId) {
    post(webview, {
      type: "chat/sessionSwitched",
      sessionId: nextId,
      messages: getMessagesForSession(nextId),
    });
  }
}
```

- [ ] **Step 3: Remove the `chat/getFullHistory` handler (it's superseded by `chat/listSessions` + `chat/switchSession`).** Delete lines around 754-761 that respond with `chat/fullHistory`.

- [ ] **Step 4: Update the `chat/clearHistory` handler to delete all sessions instead of just wiping messages.** Find the existing handler and replace its body with:

```typescript
} else if (msg.type === "chat/clearHistory") {
  const sessions = getCachedSessions();
  for (const s of sessions) {
    await deleteSession(s.id);
  }
  setCurrentSessionId(null);
  post(webview, { type: "chat/history", messages: [] });
  post(webview, {
    type: "chat/sessions",
    sessions: getCachedSessions(),
    currentSessionId: null,
  });
}
```

- [ ] **Step 5: Inside `handleChat()` (around line 1666), at the top, mint a session if `currentSessionId` is null. Insert just after argument validation:**

```typescript
// Lazy session creation: first message in a fresh "New chat" mints
// the session here. The title is derived from the user's message;
// the cloud row is created in the background via createSession().
let sessionId = getCurrentSessionId();
if (!sessionId) {
  const fresh = await createSession(message);
  sessionId = fresh.id;
  setCurrentSessionId(sessionId);
  // Notify the webview so its `currentSessionId` and `sessions[]`
  // stay in sync without a round-trip request.
  broadcast({
    type: "chat/sessions",
    sessions: getCachedSessions(),
    currentSessionId: sessionId,
  });
}
```

- [ ] **Step 6: Find every site where a `ChatMessage` is constructed inside `webviewHost.ts` and add `sessionId`. Specifically the user message (~line 1860) and the assistant message (~line 2225) plus the interrupted-handler message (~line 2402):**

```typescript
const userMsg: ChatMessage = {
  id: userMsgId ?? generateMessageId(),
  sessionId,
  role: "user",
  content: message,
  createdAt: new Date().toISOString(),
  source,
};
```

(Apply the same `sessionId` field to the assistant message and the interrupted-response message.)

- [ ] **Step 7: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: errors remain in teaching/exerciseEngine and in the webview — fixed in the next tasks.

- [ ] **Step 8: Commit.**

```bash
git add apps/extension/src/chat/webviewHost.ts
git commit -m "feat(extension): thread sessionId through chat host + new session handlers"
```

---

## Task 9: Fix `teachingFlow.ts` and `exerciseEngine.ts` message construction

**Files:**
- Modify: `apps/extension/src/teaching/teachingFlow.ts:265` (chatMsg helper)
- Modify: `apps/extension/src/teaching/exerciseEngine.ts:400` (chatMsg helper)

- [ ] **Step 1: Open `teachingFlow.ts` and find the `chatMsg(content)` helper at line 265. Add a `sessionId` parameter:**

```typescript
function chatMsg(
  content: string,
  sessionId: string,
): { type: "chat/append"; message: ChatMessage } {
  return {
    type: "chat/append",
    message: {
      id: generateMessageId(),
      sessionId,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    },
  };
}
```

Then thread `sessionId` through every call site in the same file. Most lessons run inside `handleChat`, which already has `sessionId` in scope — pass it down to `chatMsg(...)`.

- [ ] **Step 2: Same change in `exerciseEngine.ts` around line 400. Add `sessionId` parameter and update every call site.**

- [ ] **Step 3: Typecheck — should now compile if nothing else slipped.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: clean (or remaining errors only in webview, fixed next).

- [ ] **Step 4: Commit.**

```bash
git add apps/extension/src/teaching/teachingFlow.ts apps/extension/src/teaching/exerciseEngine.ts
git commit -m "fix(teaching): thread sessionId through chatMsg helpers"
```

---

## Task 10: Webview state — sessions list + current session

**Files:**
- Modify: `apps/extension/webview/App.tsx` (state, message handlers)

- [ ] **Step 1: Add new state alongside the existing `messages` state. Find `const [messages, setMessages] = useState<ChatMessage[]>([])` (~line 577) and add directly below:**

```typescript
const [sessions, setSessions] = useState<ChatSession[]>([]);
const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
```

Import `ChatSession` from `@protege/types`.

- [ ] **Step 2: Remove `historyPanelMessages` state and any setter calls** — it's superseded by the sessions list. Search for `historyPanelMessages` and `setHistoryPanelMessages` and delete each occurrence.

- [ ] **Step 3: Add new host-message handlers inside the existing `onHostMessage` listener (~line 714).**

```typescript
} else if (msg.type === "chat/sessions") {
  setSessions(msg.sessions);
  setCurrentSessionId(msg.currentSessionId);
} else if (msg.type === "chat/sessionSwitched") {
  setCurrentSessionId(msg.sessionId || null);
  setMessages(msg.messages);
  setChatHistoryOpen(false);
} else if (msg.type === "chat/sessionRenamed") {
  setSessions((prev) =>
    prev.map((s) => (s.id === msg.sessionId ? { ...s, title: msg.title } : s)),
  );
} else if (msg.type === "chat/sessionDeleted") {
  setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
}
```

- [ ] **Step 4: On mount, request the sessions list. Find the existing webview-ready effect that requests `chat/history` and add a parallel request:**

```typescript
vscode.postMessage({ type: "chat/listSessions" });
```

- [ ] **Step 5: Update the `chat/append` handler (~line 740) to only accept messages whose `sessionId === currentSessionId`. This prevents stale broadcasts from polluting a switched-away view:**

```typescript
} else if (msg.type === "chat/append") {
  if (msg.message.sessionId !== currentSessionId && currentSessionId !== null) {
    // Message belongs to a different session — still bump the session
    // list so its lastMessageAt sorts up, but don't touch live view.
    setSessions((prev) =>
      prev.map((s) =>
        s.id === msg.message.sessionId
          ? { ...s, lastMessageAt: msg.message.createdAt, messageCount: s.messageCount + 1 }
          : s,
      ),
    );
    return;
  }
  setMessages((m) =>
    m.some((x) => x.id === msg.message.id) ? m : [...m, msg.message],
  );
  setToolActivity([]);
}
```

- [ ] **Step 6: Refactor `onNewChat` and `onClearAll` handlers in the ChatHistoryPanel mount (~line 1419-1435):**

```typescript
onClearAll={() => {
  if (confirm("Delete all chat history? This cannot be undone.")) {
    vscode.postMessage({ type: "chat/clearHistory" });
    setMessages([]);
    setSessions([]);
    setCurrentSessionId(null);
    setChatHistoryOpen(false);
  }
}}
onNewChat={() => {
  vscode.postMessage({ type: "chat/newSession" });
  setMessages([]);
  setChatHistoryOpen(false);
}}
```

- [ ] **Step 7: Typecheck the webview.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: errors only inside ChatHistoryPanel (props it now needs but doesn't have yet).

- [ ] **Step 8: Commit.**

```bash
git add apps/extension/webview/App.tsx
git commit -m "feat(webview): track sessions list and current session in App state"
```

---

## Task 11: Build `ChatSessionsList` component

**Files:**
- Create: `apps/extension/webview/ChatSessionsList.tsx`

- [ ] **Step 1: Create the component. It renders the list of sessions grouped by day (today / yesterday / older), with click-to-switch, hover-to-show-rename-and-delete affordances, and inline rename via double-click.**

```tsx
import React, { useState } from "react";
import type { ChatSession } from "@protege/types";

interface Props {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function groupByDay(sessions: ChatSession[]): { label: string; date: string; sessions: ChatSession[] }[] {
  const byDay = new Map<string, ChatSession[]>();
  for (const s of sessions) {
    const d = s.lastMessageAt.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(s);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      label:
        date === today
          ? "Today"
          : date === yesterday
            ? "Yesterday"
            : new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                weekday: "long",
                month: "short",
                day: "numeric",
              }),
      sessions: list.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    }));
}

export function ChatSessionsList({
  sessions,
  currentSessionId,
  onSwitch,
  onRename,
  onDelete,
}: Props) {
  const groups = groupByDay(sessions);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (groups.length === 0) {
    return (
      <div className="chp-empty">
        <p className="chp-empty-title">No conversations yet</p>
        <p className="chp-empty-sub">
          Start a chat and it'll land here, grouped by day.
        </p>
      </div>
    );
  }

  return (
    <>
      {groups.map((g) => (
        <section key={g.date} className="chp-day">
          <div className="chp-day-head">
            <span className="chp-day-label">{g.label}</span>
            <span className="chp-day-count">
              {g.sessions.length}{" "}
              {g.sessions.length === 1 ? "conversation" : "conversations"}
            </span>
          </div>
          <ul className="chp-sessions">
            {g.sessions.map((s) => {
              const time = new Date(s.lastMessageAt).toLocaleTimeString(
                undefined,
                { hour: "numeric", minute: "2-digit" },
              );
              const isActive = s.id === currentSessionId;
              const isEditing = editingId === s.id;
              return (
                <li
                  key={s.id}
                  className={`chp-session ${isActive ? "is-active" : ""}`}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      className="chp-session-edit"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => {
                        if (draft.trim() && draft !== s.title) onRename(s.id, draft.trim());
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="chp-session-main"
                      onClick={() => onSwitch(s.id)}
                      onDoubleClick={() => {
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                    >
                      <div className="chp-session-head">
                        <span className="chp-session-title">{s.title}</span>
                        <span className="chp-session-time">{time}</span>
                      </div>
                      <p className="chp-session-meta">
                        {s.messageCount}{" "}
                        {s.messageCount === 1 ? "message" : "messages"}
                      </p>
                    </button>
                  )}
                  <div className="chp-session-actions">
                    <button
                      className="chp-session-action"
                      title="Rename"
                      onClick={() => {
                        setEditingId(s.id);
                        setDraft(s.title);
                      }}
                      aria-label="Rename conversation"
                    >
                      ✎
                    </button>
                    <button
                      className="chp-session-action chp-session-action-danger"
                      title="Delete"
                      onClick={() => {
                        if (confirm(`Delete "${s.title}"? This cannot be undone.`)) {
                          onDelete(s.id);
                        }
                      }}
                      aria-label="Delete conversation"
                    >
                      🗑
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/extension/webview/ChatSessionsList.tsx
git commit -m "feat(webview): ChatSessionsList component with switch/rename/delete"
```

---

## Task 12: Rewire `ChatHistoryPanel` to render sessions

**Files:**
- Modify: `apps/extension/webview/ChatHistoryPanel.tsx`
- Modify: `apps/extension/webview/App.tsx` (props passed to the panel)

- [ ] **Step 1: Rewrite `ChatHistoryPanel.tsx` so the body renders `ChatSessionsList` instead of grouping flat messages. Keep the header, the search box, and the pager scaffold. Replace the `Props` and the body.**

Open the file and replace the entire `Props` interface and the body render:

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSession } from "@protege/types";
import { ChatSessionsList } from "./ChatSessionsList";

const SEARCH_DEBOUNCE_MS = 220;

interface Props {
  sessions: ChatSession[];
  currentSessionId: string | null;
  onSwitchSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onClose: () => void;
  onClearAll: () => void;
  onNewChat: () => void;
}

export function ChatHistoryPanel({
  sessions,
  currentSessionId,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onClose,
  onClearAll,
  onNewChat,
}: Props) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    if (query === "") {
      setDebouncedQuery("");
      return;
    }
    const h = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, debouncedQuery]);

  return (
    <div className="chp">
      <header className="chp-head">
        <div className="chp-head-main">
          <h2 className="chp-title">Chat history</h2>
          <span className="chp-meta">
            {filtered.length}{" "}
            {filtered.length === 1 ? "conversation" : "conversations"}
          </span>
        </div>
        <div className="chp-head-actions">
          <button
            className="chp-pill chp-pill-primary"
            onClick={onNewChat}
            title="Start a new chat"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New chat</span>
          </button>
          <button
            className="chp-icon chp-icon-danger"
            onClick={onClearAll}
            title="Delete all history"
            aria-label="Delete all"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            </svg>
          </button>
          <button
            className="chp-icon"
            onClick={onClose}
            title="Back to chat"
            aria-label="Close history"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="chp-search">
        <div className="chp-search-box">
          <input
            className="chp-search-input"
            type="text"
            placeholder="Search your conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              className="chp-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="chp-body">
        <ChatSessionsList
          sessions={filtered}
          currentSessionId={currentSessionId}
          onSwitch={onSwitchSession}
          onRename={onRenameSession}
          onDelete={onDeleteSession}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `App.tsx` ChatHistoryPanel mount (~line 1386) with the new props:**

```tsx
<ChatHistoryPanel
  sessions={sessions}
  currentSessionId={currentSessionId}
  onSwitchSession={(id) => vscode.postMessage({ type: "chat/switchSession", sessionId: id })}
  onRenameSession={(id, title) => vscode.postMessage({ type: "chat/renameSession", sessionId: id, title })}
  onDeleteSession={(id) => vscode.postMessage({ type: "chat/deleteSession", sessionId: id })}
  onClose={() => setChatHistoryOpen(false)}
  onClearAll={() => {
    if (confirm("Delete all chat history? This cannot be undone.")) {
      vscode.postMessage({ type: "chat/clearHistory" });
      setMessages([]);
      setSessions([]);
      setCurrentSessionId(null);
      setChatHistoryOpen(false);
    }
  }}
  onNewChat={() => {
    vscode.postMessage({ type: "chat/newSession" });
    setMessages([]);
    setChatHistoryOpen(false);
  }}
/>
```

- [ ] **Step 3: Find the `ChatSearchBar`'s `onOpenHistory` handler (~line 1452) and replace the `chat/getFullHistory` post with `chat/listSessions`:**

```typescript
onOpenHistory={() => {
  vscode.postMessage({ type: "chat/listSessions" });
  setChatHistoryOpen(true);
}}
```

- [ ] **Step 4: Add minimal CSS for the new classes. Locate the existing `chp-*` styles (likely `apps/extension/webview/styles/chat.css` or similar) and append:**

```css
.chp-sessions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.chp-session { display: flex; align-items: stretch; border-radius: 8px; transition: background-color 120ms; }
.chp-session:hover { background: var(--vscode-list-hoverBackground); }
.chp-session.is-active { background: var(--vscode-list-activeSelectionBackground); }
.chp-session-main { flex: 1; text-align: left; background: transparent; border: 0; padding: 10px 12px; color: inherit; cursor: pointer; }
.chp-session-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.chp-session-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chp-session-time { font-size: 11px; opacity: 0.6; flex-shrink: 0; }
.chp-session-meta { font-size: 11px; opacity: 0.6; margin: 2px 0 0; }
.chp-session-edit { width: calc(100% - 24px); margin: 8px 12px; padding: 6px 8px; border: 1px solid var(--vscode-input-border); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
.chp-session-actions { display: none; align-items: center; gap: 4px; padding-right: 8px; }
.chp-session:hover .chp-session-actions { display: flex; }
.chp-session-action { background: transparent; border: 0; cursor: pointer; padding: 4px 6px; border-radius: 4px; opacity: 0.6; }
.chp-session-action:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.chp-session-action-danger:hover { color: var(--vscode-errorForeground); }
```

If the styles live elsewhere or are inline, locate the right file with `grep -r "chp-day-label" apps/extension/webview/` and append in that file.

- [ ] **Step 5: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/extension/webview/ChatHistoryPanel.tsx apps/extension/webview/App.tsx apps/extension/webview/styles/
git commit -m "feat(webview): render sessions list in ChatHistoryPanel; click to switch"
```

---

## Task 13: Boot the sessions client at extension activation

**Files:**
- Modify: `apps/extension/src/extension.ts`

- [ ] **Step 1: Open `apps/extension/src/extension.ts` and locate the activation function. Find the call to `initChatHistory(context)`. Just below it, add:**

```typescript
import { initChatSessions } from "./chat/chatSessions.js";
// ...
initChatHistory(context);
initChatSessions(context);
```

- [ ] **Step 2: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add apps/extension/src/extension.ts
git commit -m "chore(extension): initialize chat sessions on activation"
```

---

## Task 14: Local migration of pre-existing flat history

The cloud migration in Task 2 buckets server rows into `legacy-<userId>` sessions. We need the same locally so the first time a user opens the extension after upgrading, their old chats appear in the panel.

**Files:**
- Modify: `apps/extension/src/chat/chatSessions.ts` (add `migrateLegacyMessages` helper)
- Modify: `apps/extension/src/chat/chatHistory.ts` (call it on init)

- [ ] **Step 1: In `chatSessions.ts`, add a one-time local migration. The migration runs once per install (gated by a flag in globalState):**

```typescript
const MIGRATION_FLAG = "protege.chatSessions.migratedV1";

export async function migrateLegacyMessages(): Promise<void> {
  if (!ctx) return;
  const done = ctx.globalState.get<boolean>(MIGRATION_FLAG) ?? false;
  if (done) return;

  const messages = ctx.globalState.get<ChatMessage[]>("protege.chatHistory") ?? [];
  if (messages.length === 0) {
    await ctx.globalState.update(MIGRATION_FLAG, true);
    return;
  }

  const userId = currentUserIdOrNull() ?? "local-dev";
  const legacyId = legacySessionIdFor(userId);
  const firstAt = messages[0].createdAt;
  const lastAt = messages[messages.length - 1].createdAt;
  const legacySession: ChatSession = {
    id: legacyId,
    userId,
    title: "Conversations before sessions",
    createdAt: firstAt,
    updatedAt: lastAt,
    lastMessageAt: lastAt,
    messageCount: messages.length,
  };

  // Tag every legacy message with the session id, in place.
  const tagged = messages.map((m) =>
    m.sessionId ? m : { ...m, sessionId: legacyId },
  );
  await ctx.globalState.update("protege.chatHistory", tagged);

  // Add the legacy session to the cache (idempotent — keep newest if
  // cloud hydrate already pulled a row).
  const existing = getCachedSessions();
  if (!existing.find((s) => s.id === legacyId)) {
    writeSessionsCache([legacySession, ...existing]);
  }

  await ctx.globalState.update(MIGRATION_FLAG, true);
  log("chatSessions", `migrated ${messages.length} legacy messages into ${legacyId}`);
}
```

- [ ] **Step 2: Call it from `initChatSessions` and ensure it runs before the cloud hydrate:**

```typescript
export function initChatSessions(context: vscode.ExtensionContext): void {
  ctx = context;
  void (async () => {
    await migrateLegacyMessages();
    await hydrateSessionsFromCloud();
  })();
}
```

- [ ] **Step 3: Typecheck.**

```bash
pnpm --filter '@protege/extension' typecheck
```

Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add apps/extension/src/chat/chatSessions.ts
git commit -m "feat(extension): one-time local migration of legacy chat history into a session"
```

---

## Task 15: Manual end-to-end test pass

**Files:**
- None (manual verification)

- [ ] **Step 1: Apply the migration to your dev Supabase.**

```bash
psql "$SUPABASE_DB_URL" -f apps/backend/migrations/006_chat_sessions.sql
```

- [ ] **Step 2: Build and launch the extension.**

```bash
pnpm -r build
# Launch in the Extension Development Host via VS Code's "Run Extension" config
```

- [ ] **Step 3: Cold-start sanity check.**
  - Open the chat panel.
  - Pre-existing flat history (if any) should appear as a single "Conversations before sessions" card in the history view.
  - Live chat should be empty (no current session — the next message will mint one).

- [ ] **Step 4: New chat flow.**
  - Type and send a message.
  - In the panel, a new card should appear at the top with a title derived from your first message.
  - Send another message. The card's `messageCount` ticks up. `lastMessageAt` updates.

- [ ] **Step 5: Switch flow.**
  - Click the "Conversations before sessions" card.
  - Panel closes, the live view now shows those old messages.
  - Header still shows that you're in chat mode.

- [ ] **Step 6: Rename flow.**
  - Hover a card, click the rename icon (or double-click the title).
  - Type a new title, press Enter.
  - Card updates immediately; reopen the extension and confirm it persists.

- [ ] **Step 7: Delete one session.**
  - Click the trash icon on a card.
  - Confirm. Card disappears. If it was the current session, the next-newest session becomes current.

- [ ] **Step 8: Delete all.**
  - Use the "Delete all history" button. Confirm.
  - All sessions vanish. Next message mints a fresh one.

- [ ] **Step 9: Offline resilience.**
  - Sign out / disable network. Send a message → it should append locally.
  - Sign back in → on next hydrate, the local-only message + session should sync up.

- [ ] **Step 10: Voice mode + teaching flow.**
  - Trigger a voice turn → confirm the user message and assistant reply both land in the current session and bump it.
  - Trigger a teaching flow / exercise → confirm the tutor messages also tag with the active session.

- [ ] **Step 11: Document the results.** Capture screenshots of (a) the sessions list, (b) an active conversation, (c) the rename UI. Add them to a PR description.

- [ ] **Step 12: Commit any small fixes discovered during the test pass, then declare ready for review.**

---

## Task 16: Cleanup — remove deprecated message types

Once the new flow is verified in dev, remove the now-unused `chat/getFullHistory` and `chat/fullHistory` message types.

**Files:**
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Open `packages/types/src/index.ts` and delete the `chat/getFullHistory` member from the `WebviewToHost` union and the `chat/fullHistory` member from the `HostToWebview` union.**

- [ ] **Step 2: Run a full typecheck across the monorepo.**

```bash
pnpm -r typecheck
```

Expected: clean. Any failures point to a residual caller that still references the old types — fix it.

- [ ] **Step 3: Commit.**

```bash
git add packages/types/src/index.ts
git commit -m "chore(types): remove deprecated chat/getFullHistory and chat/fullHistory"
```

---

## Self-Review Checklist

After execution:

- [ ] Every `ChatMessage` construction site has `sessionId` populated (4 known sites: App.tsx ~973, webviewHost.ts user/assistant/interrupted, teachingFlow.ts:265, exerciseEngine.ts:400).
- [ ] `getHistory()` is removed; callers use `getAllMessages()` or `getMessagesForSession()`.
- [ ] `chat/getFullHistory` and `chat/fullHistory` no longer appear in `packages/types`.
- [ ] Migration `006_chat_sessions.sql` runs cleanly twice in a row.
- [ ] Cloud row for a fresh chat is created via `POST /chat-sessions` *before* the first message's `POST /chat-history` (so the FK doesn't violate). Note: this is implicit in `handleChat`'s flow — verify the order in Task 8 Step 5.
- [ ] Voice mode persists messages under the current session.
- [ ] Teaching mode persists messages under the current session.
- [ ] Migration flag `protege.chatSessions.migratedV1` prevents double-tagging.
- [ ] Deleting a session deletes its messages (cascade on FK; explicit DELETE in route for clarity).

---

## Open Questions for Reviewer (not blocking the plan)

1. **Max sessions per user.** Currently we cap individual messages at 500 globally. Do we want a separate cap on sessions (e.g. keep newest 100) and on messages per session?
2. **Auto-archive vs hard delete.** Right now delete is destructive. Worth an "archive" middle ground? (Probably not for v1.)
3. **Session export.** Users may want to export a single conversation to markdown. Not in this plan; flag as a follow-up.
4. **Per-session settings.** Future: per-session mode (teaching / general / voice). Out of scope for v1 — would add `mode` to `ChatSession`.

---

**End of plan.**
