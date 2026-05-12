import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth: dev mode + no token = resolveUserId("local-dev"). Set before
// any module loads the auth middleware factory so the very first
// request sees auth-OFF. PROTEGE_ALLOW_DEV_USER opts the resolveUserId
// fallback into the "local-dev" path.
process.env.PROTEGE_AUTH_REQUIRED = "false";
process.env.PROTEGE_ALLOW_DEV_USER = "true";
process.env.NODE_ENV = "test";

/**
 * chat-sessions route tests — drive the Hono app with mocked Supabase
 * tables backed by in-memory Maps. Mirrors the quotas.test.ts pattern:
 * stub the supabase client, exercise the route via real Hono requests,
 * assert on response shape AND on what landed in the mocked table.
 */

const tables = new Map<string, Record<string, unknown>[]>();

function buildMockClient() {
  const builder = (table: string) => {
    type Filter = { col: string; val: unknown };
    let mode: "select" | "update" | "insert" | "delete" | null = null;
    let updates: Record<string, unknown> | null = null;
    let row: Record<string, unknown> | null = null;
    let selectReturn: string | null = null;
    const filters: Filter[] = [];

    const rows = () => tables.get(table) ?? [];
    const matches = (r: Record<string, unknown>) =>
      filters.every((f) => r[f.col] === f.val);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select(cols: string) {
        mode = mode ?? "select";
        selectReturn = cols;
        return api;
      },
      update(payload: Record<string, unknown>) {
        mode = "update";
        updates = payload;
        return api;
      },
      insert(payload: Record<string, unknown>) {
        mode = "insert";
        row = payload;
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, val });
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      // Make the chain itself awaitable. Terminal call shape varies per
      // mode, mimicking the real supabase-js behavior closely enough.
      then(resolve: (r: { data: unknown; error: unknown }) => void) {
        if (mode === "select") {
          const data = rows().filter(matches);
          resolve({ data, error: null });
          return;
        }
        if (mode === "update" && updates) {
          const before = rows();
          const after = before.map((r) =>
            matches(r) ? { ...r, ...updates } : r,
          );
          tables.set(table, after);
          // When a .select() follows an .update(), return the changed rows.
          const changed = after.filter(matches);
          resolve({
            data: selectReturn !== null ? changed : null,
            error: null,
          });
          return;
        }
        if (mode === "insert" && row) {
          const list = rows();
          // Conflict on primary key (id).
          if (list.some((r) => r.id === row!.id)) {
            resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            return;
          }
          list.push(row);
          tables.set(table, list);
          resolve({ data: null, error: null });
          return;
        }
        if (mode === "delete") {
          const list = rows();
          tables.set(table, list.filter((r) => !matches(r)));
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: null, error: null });
      },
    };
    return api;
  };
  return { from: (name: string) => builder(name) };
}

vi.mock("../supabase.js", () => ({
  isSupabaseEnabled: () => true,
  getSupabase: () => buildMockClient(),
}));

// Auth: dev mode (NODE_ENV !== "production") + no header → resolveUserId
// returns "local-dev". All seeded rows use that user_id so the routes
// can read them back.
const TEST_USER = "local-dev";

import { Hono } from "hono";
import { chatSessionsRoute } from "./chatSessions.js";

function makeApp() {
  const app = new Hono();
  app.route("/chat-sessions", chatSessionsRoute);
  return app;
}

beforeEach(() => {
  tables.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /chat-sessions", () => {
  it("returns sessions for the authenticated user only", async () => {
    tables.set("chat_sessions", [
      {
        id: "s_1",
        user_id: TEST_USER,
        title: "First",
        created_at: "2026-05-10T10:00:00Z",
        updated_at: "2026-05-10T10:00:00Z",
        last_message_at: "2026-05-10T10:00:00Z",
        message_count: 2,
      },
      {
        id: "s_2",
        user_id: "other",
        title: "Other user",
        created_at: "2026-05-10T11:00:00Z",
        updated_at: "2026-05-10T11:00:00Z",
        last_message_at: "2026-05-10T11:00:00Z",
        message_count: 1,
      },
    ]);

    const res = await makeApp().request("/chat-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("s_1");
  });

  it("returns an empty list when the user has no sessions", async () => {
    const res = await makeApp().request("/chat-sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });
});

describe("POST /chat-sessions", () => {
  it("creates a new session row", async () => {
    const res = await makeApp().request("/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s_new", title: "Hello" }),
    });
    expect(res.status).toBe(200);
    const rows = tables.get("chat_sessions") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("s_new");
    expect(rows[0].title).toBe("Hello");
    expect(rows[0].user_id).toBe(TEST_USER);
  });

  it("upgrades a placeholder row (preserves message_count)", async () => {
    // Placeholder written by /chat-history's race-safe path.
    tables.set("chat_sessions", [
      {
        id: "s_race",
        user_id: TEST_USER,
        title: "New chat",
        created_at: "2026-05-10T10:00:00Z",
        updated_at: "2026-05-10T10:00:00Z",
        last_message_at: "2026-05-10T10:00:00Z",
        message_count: 3, // Three messages already landed before the create.
      },
    ]);

    const res = await makeApp().request("/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s_race", title: "Real title" }),
    });
    expect(res.status).toBe(200);
    const row = (tables.get("chat_sessions") ?? [])[0];
    expect(row.title).toBe("Real title");
    expect(row.message_count).toBe(3); // Preserved.
  });

  it("rejects a request without id", async () => {
    const res = await makeApp().request("/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /chat-sessions/:id", () => {
  it("renames a session", async () => {
    tables.set("chat_sessions", [
      { id: "s_rename", user_id: TEST_USER, title: "Old" },
    ]);
    const res = await makeApp().request("/chat-sessions/s_rename", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    });
    expect(res.status).toBe(200);
    expect((tables.get("chat_sessions") ?? [])[0].title).toBe("New title");
  });

  it("rejects empty titles", async () => {
    tables.set("chat_sessions", [
      { id: "s_rename", user_id: TEST_USER, title: "Old" },
    ]);
    const res = await makeApp().request("/chat-sessions/s_rename", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /chat-sessions/:id", () => {
  it("deletes the session row and any messages under it", async () => {
    tables.set("chat_sessions", [
      { id: "s_del", user_id: TEST_USER, title: "Doomed" },
    ]);
    tables.set("chat_messages", [
      {
        id: "m_1",
        user_id: TEST_USER,
        session_id: "s_del",
        role: "user",
        content: "hi",
        created_at: "2026-05-10T10:00:00Z",
      },
      {
        id: "m_2",
        user_id: TEST_USER,
        session_id: "s_other",
        role: "user",
        content: "kept",
        created_at: "2026-05-10T11:00:00Z",
      },
    ]);

    const res = await makeApp().request("/chat-sessions/s_del", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(tables.get("chat_sessions")).toEqual([]);
    expect(tables.get("chat_messages")).toHaveLength(1);
    expect((tables.get("chat_messages") ?? [])[0].id).toBe("m_2");
  });
});
