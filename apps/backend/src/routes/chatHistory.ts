import { Hono } from "hono";
import type { ChatMessage } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { getSupabase, isSupabaseEnabled } from "../supabase.js";

/** Per-user limiter for /chat-history writes + clear. Reads are exempt
 *  (cheap, idempotent). 120 writes/min comfortably covers a fast typer
 *  sending multi-burst messages while still bounding a runaway producer. */
const chatHistoryLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

/**
 * Chat history — per-user, synced to Supabase so conversations carry
 * across devices. Append-only on this route; the extension keeps a
 * local cache for offline use, hydrates from cloud on activate, and
 * writes through on every new message.
 *
 * Schema (run once in Supabase SQL editor):
 *
 *   create table if not exists chat_messages (
 *     id text primary key,
 *     user_id text not null,
 *     role text not null,
 *     content text not null,
 *     source text,
 *     created_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_chat_messages_user_created
 *     on chat_messages (user_id, created_at);
 *
 * Pruning lives client-side (cap at 500 in extension) — the cloud
 * keeps the full archive. If a user wants their history wiped, the
 * extension's clear-history command issues a DELETE.
 */

export const chatHistoryRoute = new Hono();

chatHistoryRoute.use("*", githubAuth());

/**
 * Sticky flag — once we hit a schema-missing error (table or column not
 * found), stop hammering Supabase on every chat append. Cleared on
 * server restart so re-running the migration takes effect without code
 * changes. Same pattern as quotas.ts isQuotaSchemaReady().
 */
let chatHistorySchemaBroken = false;
function noteSchemaMiss(error: { code?: string; message: string }): void {
  // 42P01 = relation does not exist; PGRST204/PGRST205/etc = schema cache
  // miss for a column. Either way, retrying won't help until the user
  // re-runs the migration — they'll restart the backend after that.
  const msg = error.message || "";
  const code = error.code ?? "";
  if (
    code === "42P01" ||
    code.startsWith("PGRST") ||
    /Could not find the .* (?:column|table)/i.test(msg)
  ) {
    if (!chatHistorySchemaBroken) {
      console.warn(
        `[protege] /chat-history schema mismatch — disabling cloud sync until restart. Error: ${msg}`
      );
      chatHistorySchemaBroken = true;
    }
  }
}

interface ChatRow {
  id: string;
  user_id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  source: string | null;
  created_at: string;
}

function rowToMessage(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    source: (r.source as "voice" | "text" | undefined) ?? undefined,
  };
}

/** GET /chat-history?limit=N&sessionId=S — most recent N messages,
 *  oldest-first (so the extension can append without resorting). Default
 *  500. When `sessionId` is provided, results are filtered to that
 *  session; otherwise the user's full flat history is returned (legacy
 *  callers + bootstrap migration rely on this). */
chatHistoryRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const limitRaw = c.req.query("limit");
  const limit = Math.min(2000, Math.max(1, Number(limitRaw) || 500));
  const sessionId = c.req.query("sessionId");
  if (!isSupabaseEnabled() || chatHistorySchemaBroken) {
    return c.json({ messages: [] });
  }
  const sb = getSupabase()!;
  // Pull the newest `limit` rows, then reverse so oldest is first
  // — preserves the existing ChatMessage[] semantics.
  let query = sb
    .from("chat_messages")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (sessionId) {
    query = query.eq("session_id", sessionId);
  }
  const { data, error } = await query;
  if (error) {
    noteSchemaMiss(error);
    return c.json({ messages: [] });
  }
  const messages = (data as ChatRow[]).reverse().map(rowToMessage);
  return c.json({ messages });
});

/** POST /chat-history — append one message. Idempotent on id (UPSERT). */
chatHistoryRoute.post("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  if (!chatHistoryLimiter(userId)) {
    return c.json({ error: "rate limited" }, 429);
  }
  const body = (await c.req.json()) as { message: ChatMessage };
  if (!body?.message?.id) {
    return c.json({ error: "message.id required" }, 400);
  }
  if (!body.message.sessionId || typeof body.message.sessionId !== "string") {
    return c.json({ error: "message.sessionId required" }, 400);
  }
  if (!isSupabaseEnabled() || chatHistorySchemaBroken) {
    return c.json({ ok: true });
  }
  const sb = getSupabase()!;

  // IDOR guard: backend talks to Supabase as service_role, which bypasses
  // RLS. If an attacker submits a sessionId already owned by a different
  // user, we must refuse — otherwise the chat_messages insert below would
  // attach attacker-authored content to a victim-owned session_id, and
  // the placeholder upsert below could clobber an existing-owner check.
  const { data: ownerRow, error: ownerError } = await sb
    .from("chat_sessions")
    .select("user_id")
    .eq("id", body.message.sessionId)
    .maybeSingle();
  if (ownerError) {
    noteSchemaMiss(ownerError);
    // Treat schema/transport errors as a soft-fail so the extension's
    // offline cache keeps working — same pattern as the rest of this route.
    return c.json({ ok: true });
  }
  if (ownerRow && ownerRow.user_id !== userId) {
    return c.json({ error: "session not owned by caller" }, 403);
  }

  // Race safety: the extension fire-and-forgets POST /chat-sessions and
  // immediately POST /chat-history. Without this guard, the message
  // insert FK-violates if the parent session hasn't landed yet. The
  // ownership check above guarantees that if a row already exists, it's
  // ours — so ignoreDuplicates is safe here.
  if (!ownerRow) {
    const { error: parentError } = await sb.from("chat_sessions").upsert(
      {
        id: body.message.sessionId,
        user_id: userId,
        title: "New chat",
        created_at: body.message.createdAt,
        updated_at: body.message.createdAt,
        last_message_at: body.message.createdAt,
        message_count: 0,
      },
      { onConflict: "id", ignoreDuplicates: true }
    );
    if (parentError) {
      noteSchemaMiss(parentError);
      // Fall through — if the parent upsert fails for a non-schema
      // reason, the message insert below will surface the real error.
    }
  }

  // Insert (not upsert) so a guessed message id from another user cannot
  // overwrite an existing row's content. Duplicate-id replays from the
  // same caller are dedup'd by treating 23505 as success.
  const { error } = await sb.from("chat_messages").insert({
    id: body.message.id,
    user_id: userId,
    session_id: body.message.sessionId,
    role: body.message.role,
    content: body.message.content,
    source: body.message.source ?? null,
    created_at: body.message.createdAt,
  });
  if (error) {
    if (error.code === "23505") {
      // Idempotent replay — message with this id already exists.
      return c.json({ ok: true });
    }
    noteSchemaMiss(error);
    return c.json({ ok: true });
  }

  // Bump parent session metadata so it sorts to the top of the list and
  // shows the fresh message count. Best-effort; failure does not roll
  // back the message write.
  void (async () => {
    try {
      await sb.rpc("bump_chat_session", {
        p_session_id: body.message.sessionId,
        p_user_id: userId,
        p_at: body.message.createdAt,
      });
    } catch {
      /* swallow */
    }
  })();

  return c.json({ ok: true });
});

/** DELETE /chat-history — wipe everything for this user. Used by the
 *  in-app "clear chat history" command. */
chatHistoryRoute.delete("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  if (!chatHistoryLimiter(userId)) {
    return c.json({ error: "rate limited" }, 429);
  }
  if (!isSupabaseEnabled()) return c.json({ ok: true });
  const sb = getSupabase()!;
  const { error } = await sb
    .from("chat_messages")
    .delete()
    .eq("user_id", userId);
  if (error) {
    console.warn("[protege] /chat-history DELETE failed:", error.message);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});
