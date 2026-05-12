import * as vscode from "vscode";
import type { ChatMessage, ChatSession } from "@protege/types";
import {
  authedFetch,
  BACKEND_URL,
  currentUserIdOrNull,
} from "../user/protegeClient.js";
import { log } from "../log.js";

/**
 * Chat Sessions — client-side companion to the /chat-sessions backend
 * route. Holds the in-memory list of the user's conversations, mints
 * fresh ids locally, and writes through to the cloud fire-and-forget.
 *
 * Storage model:
 *   - `protege.chatSessions` — ChatSession[] cache (newest-active first).
 *   - `protege.chatSessions.current` — id of the active conversation
 *     (or null if "New chat" has been pressed but no message sent yet).
 *   - `protege.chatSessions.migratedV1` — one-shot flag for the legacy
 *     backfill in migrateLegacyMessages().
 *
 * The cloud is authoritative across devices but lazy: hydrate runs on
 * init and on demand from webviewHost; between those, mutations land
 * in the local cache immediately and replay to the server.
 */

const STORAGE_KEY = "protege.chatSessions";
const CURRENT_SESSION_KEY = "protege.chatSessions.current";
const MIGRATION_FLAG = "protege.chatSessions.migratedV1";
const FLAT_HISTORY_KEY = "protege.chatHistory";

let ctx: vscode.ExtensionContext | null = null;

/** Serialize globalState read-modify-write on STORAGE_KEY. Without this,
 *  rapid noteMessageAppended calls (user msg + assistant msg in one
 *  chat turn) can both read the same pre-state, both mutate, both queue
 *  an update — last write wins and one mutation is lost. */
let sessionsWriteQueue: Promise<void> = Promise.resolve();

export function initChatSessions(context: vscode.ExtensionContext): void {
  ctx = context;
  void (async () => {
    await migrateLegacyMessages();
    await hydrateSessionsFromCloud();
  })();
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
  sessionsWriteQueue = sessionsWriteQueue
    .then(async () => {
      if (!ctx) return;
      await ctx.globalState.update(STORAGE_KEY, sessions);
    })
    .catch((err) => {
      log(
        "chatSessions",
        `writeSessionsCache failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
    // Merge: cloud wins on id collisions, local-only sessions (created
    // offline) are kept and will be pushed back up on next mutation.
    const merged = new Map<string, ChatSession>();
    for (const s of cloud) merged.set(s.id, s);
    for (const s of getCachedSessions()) {
      if (!merged.has(s.id)) merged.set(s.id, s);
    }
    const out = [...merged.values()].sort((a, b) =>
      b.lastMessageAt.localeCompare(a.lastMessageAt),
    );
    writeSessionsCache(out);
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

export async function createSession(
  firstUserMessage?: string,
): Promise<ChatSession> {
  const id = newSessionId();
  const now = new Date().toISOString();
  const title = firstUserMessage
    ? deriveSessionTitle(firstUserMessage)
    : "New chat";
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
  // Fire-and-forget cloud insert. The race-safe placeholder upsert in
  // /chat-history's POST handler keeps the FK valid if the message
  // write lands before this response does.
  void authedFetch(`${BACKEND_URL}/chat-sessions`, {
    method: "POST",
    body: JSON.stringify({ id, title }),
  }).catch(() => {});
  return session;
}

export async function renameSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim().slice(0, 200);
  if (!trimmed) return;
  const next = getCachedSessions().map((s) =>
    s.id === id ? { ...s, title: trimmed, updatedAt: new Date().toISOString() } : s,
  );
  writeSessionsCache(next);
  void authedFetch(
    `${BACKEND_URL}/chat-sessions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    },
  ).catch(() => {});
}

export async function deleteSession(id: string): Promise<void> {
  const next = getCachedSessions().filter((s) => s.id !== id);
  writeSessionsCache(next);
  void authedFetch(
    `${BACKEND_URL}/chat-sessions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  ).catch(() => {});
}

/** Update local cache to reflect a new message appended to a session.
 *  Called by chatHistory.appendMessage so the panel re-sorts and the
 *  card title evolves from the placeholder "New chat" to the first
 *  user message without an extra round trip. */
export function noteMessageAppended(message: ChatMessage): void {
  // Serialize the entire read-modify-write — reading getCachedSessions
  // outside the queue would let two rapid appends both observe the same
  // pre-state and drop one mutation. The read happens *inside* the
  // queued task, after the previous task has flushed its update.
  sessionsWriteQueue = sessionsWriteQueue
    .then(async () => {
      if (!ctx) return;
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
      const reordered = [updated, ...sessions.filter((_, i) => i !== idx)];
      await ctx.globalState.update(STORAGE_KEY, reordered);
      // If we retitled, push the rename to cloud too so other devices
      // pick up the right name on next hydrate. Fire-and-forget — does
      // not gate the queue.
      if (updated.title !== s.title) {
        void authedFetch(
          `${BACKEND_URL}/chat-sessions/${encodeURIComponent(s.id)}`,
          { method: "PATCH", body: JSON.stringify({ title: updated.title }) },
        ).catch(() => {});
      }
    })
    .catch((err) => {
      log(
        "chatSessions",
        `noteMessageAppended failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/* ---------- One-time local migration ---------- */

/**
 * Bucket pre-existing flat history (rows in `protege.chatHistory` that
 * were written before the sessions feature shipped) under a single
 * `legacy-<userId>` session. Idempotent and gated by a globalState flag
 * so it runs at most once per install per user.
 */
export async function migrateLegacyMessages(): Promise<void> {
  if (!ctx) return;
  const done = ctx.globalState.get<boolean>(MIGRATION_FLAG) ?? false;
  if (done) return;

  const messages =
    ctx.globalState.get<ChatMessage[]>(FLAT_HISTORY_KEY) ?? [];
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
  await ctx.globalState.update(FLAT_HISTORY_KEY, tagged);

  // Add the legacy session to the cache if cloud hydrate hasn't already
  // pulled an equivalent row (deterministic id makes it idempotent).
  const existing = getCachedSessions();
  if (!existing.find((s) => s.id === legacyId)) {
    writeSessionsCache([legacySession, ...existing]);
  }

  await ctx.globalState.update(MIGRATION_FLAG, true);
  log(
    "chatSessions",
    `migrated ${messages.length} legacy messages into ${legacyId}`,
  );
}

/* ---------- Pure helpers (tested directly) ---------- */

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
