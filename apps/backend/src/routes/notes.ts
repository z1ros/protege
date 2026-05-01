import { Hono } from "hono";
import type { Note } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { getSupabase, isSupabaseEnabled } from "../supabase.js";

/**
 * Notes — per-user CRUD synced to Supabase so notes follow the user
 * across devices. The extension keeps a local globalState cache for
 * offline use; the cloud is the source of truth on activate.
 *
 * Schema (run once in Supabase SQL editor):
 *
 *   create table if not exists notes (
 *     id text primary key,
 *     user_id text not null,
 *     title text not null default 'Untitled',
 *     body text not null default '',
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_notes_user_updated
 *     on notes (user_id, updated_at desc);
 *
 * Auth is required — userId comes from the verified GitHub session
 * via `githubAuth()`. The extension's `authedFetch` includes the Bearer.
 */

export const notesRoute = new Hono();

notesRoute.use("*", githubAuth());

interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function rowToNote(r: NoteRow): Note {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** GET /notes — list this user's notes, newest first. */
notesRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  if (!isSupabaseEnabled()) {
    // Cloud-disabled deploy → empty list. Extension falls back to its
    // local cache and operates as if cloud sync is off.
    return c.json({ notes: [] });
  }
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from("notes")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) {
    console.warn("[protege] /notes GET failed:", error.message);
    return c.json({ notes: [] });
  }
  const notes = (data as NoteRow[]).map(rowToNote);
  return c.json({ notes });
});

/** POST /notes — create or upsert (idempotent on id). */
notesRoute.post("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const body = (await c.req.json()) as { note: Note };
  if (!body?.note?.id) {
    return c.json({ error: "note.id required" }, 400);
  }
  if (!isSupabaseEnabled()) return c.json({ ok: true });
  const sb = getSupabase()!;
  const { error } = await sb.from("notes").upsert(
    {
      id: body.note.id,
      user_id: userId,
      title: body.note.title,
      body: body.note.body,
      created_at: body.note.createdAt,
      updated_at: body.note.updatedAt,
    },
    { onConflict: "id" }
  );
  if (error) {
    console.warn("[protege] /notes POST failed:", error.message);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});

/** PATCH /notes/:id — partial update; bumps updated_at. */
notesRoute.patch("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  const patch = (await c.req.json()) as { title?: string; body?: string };
  if (!isSupabaseEnabled()) return c.json({ ok: true });
  const sb = getSupabase()!;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.title === "string") updates.title = patch.title;
  if (typeof patch.body === "string") updates.body = patch.body;
  const { error } = await sb
    .from("notes")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    console.warn("[protege] /notes PATCH failed:", error.message);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});

/** DELETE /notes/:id */
notesRoute.delete("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  if (!isSupabaseEnabled()) return c.json({ ok: true });
  const sb = getSupabase()!;
  const { error } = await sb
    .from("notes")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) {
    console.warn("[protege] /notes DELETE failed:", error.message);
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});
