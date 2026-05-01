import { Hono } from "hono";
import type { ChatMessage } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { getSupabase, isSupabaseEnabled } from "../supabase.js";

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
  role: "user" | "assistant";
  content: string;
  source: string | null;
  created_at: string;
}

function rowToMessage(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    source: (r.source as "voice" | "text" | undefined) ?? undefined,
  };
}

/** GET /chat-history?limit=N — most recent N messages, oldest-first
 *  (so the extension can append without resorting). Default 500. */
chatHistoryRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const limitRaw = c.req.query("limit");
  const limit = Math.min(2000, Math.max(1, Number(limitRaw) || 500));
  if (!isSupabaseEnabled() || chatHistorySchemaBroken) {
    return c.json({ messages: [] });
  }
  const sb = getSupabase()!;
  // Pull the newest `limit` rows, then reverse so oldest is first
  // — preserves the existing ChatMessage[] semantics.
  const { data, error } = await sb
    .from("chat_messages")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
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
  const body = (await c.req.json()) as { message: ChatMessage };
  if (!body?.message?.id) {
    return c.json({ error: "message.id required" }, 400);
  }
  if (!isSupabaseEnabled() || chatHistorySchemaBroken) {
    return c.json({ ok: true });
  }
  const sb = getSupabase()!;
  const { error } = await sb.from("chat_messages").upsert(
    {
      id: body.message.id,
      user_id: userId,
      role: body.message.role,
      content: body.message.content,
      source: body.message.source ?? null,
      created_at: body.message.createdAt,
    },
    { onConflict: "id" }
  );
  if (error) {
    noteSchemaMiss(error);
    return c.json({ ok: true });
  }
  return c.json({ ok: true });
});

/** DELETE /chat-history — wipe everything for this user. Used by the
 *  in-app "clear chat history" command. */
chatHistoryRoute.delete("/", async (c) => {
  const userId = resolveUserId(c, undefined);
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
