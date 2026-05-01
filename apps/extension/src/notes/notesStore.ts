import * as vscode from "vscode";
import type { Note } from "@protege/types";
import {
  authedFetch,
  BACKEND_URL,
  currentUserIdOrNull,
} from "../user/protegeClient.js";
import { log } from "../log.js";

/**
 * Notes — per-user, synced to Supabase via the backend's `/notes` route.
 *
 * Strategy:
 *   - Local `globalState` is the offline cache (kept up to date eagerly).
 *   - On sign-in / activation, we hydrate from cloud and merge with local.
 *     Cloud wins on conflict (newer `updatedAt` is kept).
 *   - Every mutation (create / update / delete) writes through to the
 *     backend fire-and-forget. The UI updates immediately from local
 *     state — backend latency doesn't block typing.
 *   - If the user is signed-out OR the backend is unreachable, the
 *     local cache keeps working. Next successful hydrate folds the
 *     offline-created notes into the cloud.
 */

const STORAGE_KEY = "protege.notes";
const TOMBSTONE_KEY = "protege.notes.tombstones";
const MAX_NOTES = 500;

let ctx: vscode.ExtensionContext | null = null;
let hydrated = false;

interface Tombstone {
  id: string;
  /** ISO timestamp of the local delete. Used for cleanup of stale
   *  tombstones (we drop them after 30 days). */
  deletedAt: string;
}

function readTombstones(): Tombstone[] {
  if (!ctx) return [];
  return ctx.globalState.get<Tombstone[]>(TOMBSTONE_KEY) ?? [];
}

async function writeTombstone(id: string): Promise<void> {
  if (!ctx) return;
  const all = readTombstones();
  if (all.some((t) => t.id === id)) return;
  await ctx.globalState.update(TOMBSTONE_KEY, [
    ...all,
    { id, deletedAt: new Date().toISOString() },
  ]);
}

async function clearTombstone(id: string): Promise<void> {
  if (!ctx) return;
  const all = readTombstones();
  const next = all.filter((t) => t.id !== id);
  if (next.length !== all.length) {
    await ctx.globalState.update(TOMBSTONE_KEY, next);
  }
}

export function initNotesStore(context: vscode.ExtensionContext): void {
  ctx = context;
  // Fire-and-forget cloud hydration on activate. Doesn't block ready.
  void hydrateFromCloud();
}

/** Pull cloud notes and merge with local. Cloud wins per-id on
 *  newer `updatedAt`; offline-created notes (cloud doesn't have them)
 *  are pushed up. Idempotent — safe to call multiple times. */
async function hydrateFromCloud(): Promise<void> {
  if (!ctx) return;
  const userId = currentUserIdOrNull();
  if (!userId) return; // signed-out: stay local-only
  try {
    // Step 1: flush pending tombstones BEFORE pulling. If the user
    // deleted a note offline, retry the cloud DELETE here so when we
    // pull below we don't re-pull the deleted note (which would make
    // it visibly reappear). Tombstones successfully delivered are
    // cleared from the local list.
    const tombstones = readTombstones();
    const stillPending: Tombstone[] = [];
    for (const t of tombstones) {
      // Drop tombstones older than 30 days — at that point the cloud
      // either accepted the delete long ago or the user reinstalled;
      // either way keeping a stale tombstone risks suppressing a
      // legitimate cloud-side re-creation.
      const ageMs = Date.now() - new Date(t.deletedAt).getTime();
      if (ageMs > 30 * 24 * 60 * 60 * 1000) continue;
      try {
        const r = await authedFetch(
          `${BACKEND_URL}/notes/${encodeURIComponent(t.id)}`,
          { method: "DELETE" }
        );
        if (!r.ok) stillPending.push(t);
      } catch {
        stillPending.push(t);
      }
    }
    if (stillPending.length !== tombstones.length) {
      await ctx.globalState.update(TOMBSTONE_KEY, stillPending);
    }
    const tombstoneIds = new Set(stillPending.map((t) => t.id));

    // Step 2: pull cloud.
    const res = await authedFetch(`${BACKEND_URL}/notes`);
    if (!res.ok) return;
    const body = (await res.json()) as { notes: Note[] };
    // Filter any notes whose tombstones we couldn't deliver this pass —
    // we'll retry next hydrate. Keeps the user from seeing a "deleted"
    // note flicker back into the list while offline.
    const cloudNotes = (body.notes ?? []).filter(
      (n) => !tombstoneIds.has(n.id)
    );

    // Step 3: merge by id, latest updatedAt wins. Track which ids
    // local won so we can push them up afterward (otherwise the
    // cloud row stays at its older version forever).
    const local = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
    const merged = new Map<string, Note>();
    for (const n of cloudNotes) merged.set(n.id, n);
    const localWon: Note[] = [];
    const cloudByIdMap = new Map<string, Note>(
      cloudNotes.map((n) => [n.id, n])
    );
    for (const n of local) {
      if (tombstoneIds.has(n.id)) continue; // locally-deleted; do not resurrect
      const cloud = merged.get(n.id);
      if (!cloud) {
        // Local-only note (created offline). Keep + push up.
        merged.set(n.id, n);
        localWon.push(n);
      } else if (n.updatedAt > cloud.updatedAt) {
        // Local edited while offline — local wins, but cloud needs
        // the update too.
        merged.set(n.id, n);
        localWon.push(n);
      }
    }
    void cloudByIdMap; // diagnostic-only; kept readable for future
    const out = [...merged.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_NOTES);
    void ctx.globalState.update(STORAGE_KEY, out);
    hydrated = true;
    log(
      "notes",
      `hydrated · cloud=${cloudNotes.length} local=${local.length} merged=${out.length} pushedUp=${localWon.length} pendingDeletes=${stillPending.length}`
    );

    // Step 4: push up everything local won (creates AND updates).
    for (const n of localWon) void pushNote(n);
  } catch (err) {
    log(
      "notes",
      `hydrate FAIL · ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function pushNote(note: Note): Promise<void> {
  try {
    const r = await authedFetch(`${BACKEND_URL}/notes`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    /* offline / signed-out — local cache holds, retry on next hydrate */
  }
}

/** Both create AND update use pushNote (POST upsert with the full
 *  note state). Avoids the create+update race where a PATCH could
 *  arrive before the original UPSERT and silently no-op. */

async function dropNote(id: string): Promise<void> {
  try {
    const r = await authedFetch(
      `${BACKEND_URL}/notes/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    // Tombstone is cleared optimistically in `deleteNote`; only re-add
    // if the cloud DELETE didn't land (network / 5xx).
    if (r.ok) {
      await clearTombstone(id);
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch {
    /* offline — tombstone stays; reconciles on next hydrate */
  }
}

export function listNotes(): Note[] {
  if (!ctx) return [];
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createNote(title?: string): Note {
  const now = new Date().toISOString();
  const note: Note = {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: title?.trim() || "Untitled",
    body: "",
    createdAt: now,
    updatedAt: now,
  };
  if (ctx) {
    const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
    const next = [note, ...all].slice(0, MAX_NOTES);
    void ctx.globalState.update(STORAGE_KEY, next);
  }
  // If the user is creating a note whose id was previously tombstoned
  // (extremely unlikely with our random ids, but defensive), clear the
  // tombstone so the next hydrate doesn't immediately re-delete it.
  void clearTombstone(note.id);
  void pushNote(note);
  return note;
}

export function updateNote(
  id: string,
  patch: { title?: string; body?: string }
): Note | null {
  if (!ctx) return null;
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  const idx = all.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  const updated: Note = {
    ...all[idx],
    title: patch.title !== undefined ? patch.title : all[idx].title,
    body: patch.body !== undefined ? patch.body : all[idx].body,
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[idx] = updated;
  void ctx.globalState.update(STORAGE_KEY, next);
  // Wire change: send the full note via POST (upsert) instead of
  // PATCH. Closes the race where a PATCH could arrive before the
  // original create's POST and silently update no rows.
  void pushNote(updated);
  return updated;
}

export function deleteNote(id: string): void {
  if (!ctx) return;
  const all = ctx.globalState.get<Note[]>(STORAGE_KEY) ?? [];
  void ctx.globalState.update(
    STORAGE_KEY,
    all.filter((n) => n.id !== id)
  );
  // Write the tombstone FIRST so an offline delete still reconciles
  // on next hydrate. dropNote clears the tombstone if the cloud
  // DELETE actually lands (and re-leaves it if it doesn't).
  void writeTombstone(id);
  void dropNote(id);
}

/** True once the cloud hydrate has completed at least once this
 *  session. Useful for tests / debug logs. */
export function isNotesHydrated(): boolean {
  return hydrated;
}

/** Re-run hydration. Called from the auth-change listener so a sign-in
 *  mid-session pulls the new user's notes immediately. */
export function rehydrateNotes(): void {
  void hydrateFromCloud();
}
