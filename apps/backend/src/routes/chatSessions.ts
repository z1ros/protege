import { Hono } from "hono";
import type { ChatSession } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { getSupabase, isSupabaseEnabled } from "../supabase.js";

/**
 * Chat sessions — one row per conversation. Owned by a user, holds the
 * title and bookkeeping (created/updated/last_message_at + message_count)
 * that the extension's history panel needs to render a list of past
 * conversations without scanning every message.
 *
 * Sessions are created lazily: the extension mints the id locally and
 * fires-and-forgets POST /chat-sessions. The matching POST /chat-history
 * upserts a placeholder parent row if the create hasn't landed yet,
 * which keeps the FK valid. The real create then overwrites the title.
 */

export const chatSessionsRoute = new Hono();
chatSessionsRoute.use("*", githubAuth());

let chatSessionsSchemaBroken = false;
function noteSchemaMiss(error: { code?: string; message: string }): void {
  const msg = error.message || "";
  const code = error.code ?? "";
  if (
    code === "42P01" ||
    code.startsWith("PGRST") ||
    /Could not find the .* (?:column|table)/i.test(msg)
  ) {
    if (!chatSessionsSchemaBroken) {
      console.warn(
        `[protege] /chat-sessions schema mismatch — disabling cloud sync until restart. Error: ${msg}`
      );
      chatSessionsSchemaBroken = true;
    }
  }
}

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

/** GET /chat-sessions — list sessions for the authenticated user,
 *  newest-active first. Cap at 200 (more than any user is likely to
 *  scroll through; if we need infinite scroll later, add pagination). */
chatSessionsRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  if (!isSupabaseEnabled() || chatSessionsSchemaBroken) {
    return c.json({ sessions: [] });
  }
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from("chat_sessions")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (error) {
    noteSchemaMiss(error);
    return c.json({ sessions: [] });
  }
  const sessions = (data as SessionRow[]).map(rowToSession);
  return c.json({ sessions });
});

/** POST /chat-sessions — create or rename a session. Upsert on id so
 *  the placeholder row written by /chat-history's race-safe path is
 *  promoted to the real title here. We intentionally do NOT touch
 *  message_count or last_message_at on conflict (those are owned by
 *  the bump RPC) — only title and updated_at move. */
chatSessionsRoute.post("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const body = (await c.req.json()) as { id?: string; title?: string };
  if (!body?.id || typeof body.id !== "string") {
    return c.json({ error: "id required" }, 400);
  }
  if (!isSupabaseEnabled() || chatSessionsSchemaBroken) {
    return c.json({ ok: true });
  }
  const sb = getSupabase()!;
  const title = (body.title ?? "New chat").slice(0, 200);
  const now = new Date().toISOString();
  // Two-step: try to update first (preserves message_count and
  // last_message_at if a placeholder already exists). If no row was
  // touched, insert a fresh one.
  const { data: updated, error: updateError } = await sb
    .from("chat_sessions")
    .update({ title, updated_at: now })
    .eq("id", body.id)
    .eq("user_id", userId)
    .select("id");
  if (updateError) {
    noteSchemaMiss(updateError);
    return c.json({ ok: true });
  }
  if (!updated || updated.length === 0) {
    const { error: insertError } = await sb.from("chat_sessions").insert({
      id: body.id,
      user_id: userId,
      title,
      created_at: now,
      updated_at: now,
      last_message_at: now,
      message_count: 0,
    });
    if (insertError) {
      // Race: another writer (placeholder upsert) just inserted between
      // our UPDATE and our INSERT. Retry the update once.
      if (insertError.code === "23505") {
        await sb
          .from("chat_sessions")
          .update({ title, updated_at: now })
          .eq("id", body.id)
          .eq("user_id", userId);
        return c.json({ ok: true });
      }
      noteSchemaMiss(insertError);
      return c.json({ error: insertError.message }, 500);
    }
  }
  return c.json({ ok: true });
});

/** PATCH /chat-sessions/:id — rename. */
chatSessionsRoute.patch("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  const body = (await c.req.json()) as { title?: string };
  if (typeof body?.title !== "string" || body.title.length === 0) {
    return c.json({ error: "title required" }, 400);
  }
  if (!isSupabaseEnabled() || chatSessionsSchemaBroken) {
    return c.json({ ok: true });
  }
  const sb = getSupabase()!;
  const { error } = await sb
    .from("chat_sessions")
    .update({
      title: body.title.slice(0, 200),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    noteSchemaMiss(error);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});

/** DELETE /chat-sessions/:id — delete one session. The FK on
 *  chat_messages.session_id cascades, but we still issue an explicit
 *  message delete for defense in depth so a misconfigured DB doesn't
 *  silently leak messages. */
chatSessionsRoute.delete("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  if (!isSupabaseEnabled() || chatSessionsSchemaBroken) {
    return c.json({ ok: true });
  }
  const sb = getSupabase()!;
  await sb
    .from("chat_messages")
    .delete()
    .eq("session_id", id)
    .eq("user_id", userId);
  const { error } = await sb
    .from("chat_sessions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    noteSchemaMiss(error);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});
