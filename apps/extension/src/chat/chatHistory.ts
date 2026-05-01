import * as vscode from "vscode";
import type { ChatMessage } from "@protege/types";
import {
  authedFetch,
  BACKEND_URL,
  currentUserIdOrNull,
} from "../user/protegeClient.js";
import { log } from "../log.js";

/**
 * Chat History — per-user, synced to Supabase via the backend's
 * `/chat-history` route.
 *
 * Strategy:
 *   - Local globalState ("protege.chatHistory") is the offline cache.
 *     Reads always go through it so the UI is instant.
 *   - On activate (and on sign-in), we pull from cloud and merge.
 *     Cloud wins per-id when both sides have the same message; local
 *     adds (offline-created messages) get pushed up.
 *   - Every appendMessage writes through to the backend
 *     fire-and-forget. The UI doesn't wait.
 *   - clearHistory issues a DELETE to the backend; local wipes too.
 */

const STORAGE_KEY = "protege.chatHistory";
const PENDING_CLEAR_KEY = "protege.chatHistory.pendingClear";
const MAX_MESSAGES = 500;
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // periodic re-pull, hourly

let ctx: vscode.ExtensionContext | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let hydrated = false;

export function initChatHistory(context: vscode.ExtensionContext): void {
  ctx = context;
  void hydrateFromCloud();
  // Periodic re-pull catches messages another device of the user
  // wrote during this session. Cheap (one HTTP GET per hour).
  syncTimer = setInterval(() => void hydrateFromCloud(), SYNC_INTERVAL_MS);
}

async function hydrateFromCloud(): Promise<void> {
  if (!ctx) return;
  const userId = currentUserIdOrNull();
  if (!userId) return;
  try {
    // Step 1: if the user issued clearHistory while offline, retry the
    // cloud DELETE first. Without this, the cloud archive comes back
    // on next hydrate and the user-visible chat repopulates after they
    // explicitly cleared it.
    const pendingClear = ctx.globalState.get<boolean>(PENDING_CLEAR_KEY) ?? false;
    if (pendingClear) {
      try {
        const r = await authedFetch(`${BACKEND_URL}/chat-history`, {
          method: "DELETE",
        });
        if (r.ok) {
          await ctx.globalState.update(PENDING_CLEAR_KEY, undefined);
          // Cloud is now empty — local should be too. Pull will return
          // [] in step 2 and the merge will produce []. Push step is a
          // no-op.
        }
      } catch {
        /* offline still — keep flag set, retry next hydrate */
      }
    }

    const res = await authedFetch(
      `${BACKEND_URL}/chat-history?limit=${MAX_MESSAGES}`
    );
    if (!res.ok) return;
    const body = (await res.json()) as { messages: ChatMessage[] };
    const cloud = body.messages ?? [];
    const local = ctx.globalState.get<ChatMessage[]>(STORAGE_KEY) ?? [];
    // Merge by id. Messages are append-only (no edits), so collisions
    // just keep one copy — cloud's version wins arbitrarily.
    const merged = new Map<string, ChatMessage>();
    for (const m of cloud) merged.set(m.id, m);
    for (const m of local) {
      if (!merged.has(m.id)) merged.set(m.id, m);
    }
    const out = [...merged.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_MESSAGES);
    void ctx.globalState.update(STORAGE_KEY, out);
    hydrated = true;
    // Push up local-only messages.
    const cloudIds = new Set(cloud.map((m) => m.id));
    let pushedUp = 0;
    for (const m of local) {
      if (!cloudIds.has(m.id)) {
        void pushMessage(m);
        pushedUp++;
      }
    }
    log(
      "chatHistory",
      `hydrated · cloud=${cloud.length} local=${local.length} merged=${out.length} pushedUp=${pushedUp}`
    );
  } catch (err) {
    log(
      "chatHistory",
      `hydrate FAIL · ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function pushMessage(message: ChatMessage): Promise<void> {
  try {
    await authedFetch(`${BACKEND_URL}/chat-history`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  } catch {
    /* offline — local cache holds, reconciles on next hydrate */
  }
}

/** Get all stored messages (oldest-first). */
export function getHistory(): ChatMessage[] {
  if (!ctx) return [];
  return ctx.globalState.get<ChatMessage[]>(STORAGE_KEY) ?? [];
}

/** Append a message — local first, cloud-write fire-and-forget. */
export function appendMessage(message: ChatMessage): void {
  if (!ctx) return;
  const history = getHistory();
  history.push(message);

  const pruned =
    history.length > MAX_MESSAGES
      ? history.slice(history.length - MAX_MESSAGES)
      : history;

  void ctx.globalState.update(STORAGE_KEY, pruned);
  void pushMessage(message);
}

/** Clear all history — local + cloud. If the cloud DELETE fails
 *  (offline / signed-out / 5xx), set a pending-clear flag that the
 *  next successful hydrate will replay. Without this, the cloud
 *  archive would come back on next pull and the user's "I cleared
 *  this" intent would silently revert. */
export function clearHistory(): void {
  if (!ctx) return;
  void ctx.globalState.update(STORAGE_KEY, []);
  // Optimistically set the pending-clear flag — if the cloud DELETE
  // succeeds below, we clear it. If it fails, the flag stays and the
  // next hydrate retries.
  void ctx.globalState.update(PENDING_CLEAR_KEY, true);
  void (async () => {
    try {
      const r = await authedFetch(`${BACKEND_URL}/chat-history`, {
        method: "DELETE",
      });
      if (r.ok && ctx) {
        await ctx.globalState.update(PENDING_CLEAR_KEY, undefined);
      }
    } catch {
      /* offline — pending-clear flag persists; reconciles on next hydrate */
    }
  })();
}

/** Re-run hydration. Called when auth state changes so a fresh sign-in
 *  pulls that user's history immediately rather than waiting for the
 *  hourly tick. */
export function rehydrateChatHistory(): void {
  void hydrateFromCloud();
}

/** Search messages by keyword — returns matching messages with context. */
export function searchHistory(
  query: string,
  limit = 20
): { message: ChatMessage; snippet: string }[] {
  const q = query.toLowerCase();
  const all = getHistory();
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

/** Group messages by day for the history view. */
export function getHistoryByDay(): {
  date: string; // yyyy-mm-dd
  label: string; // "Today", "Yesterday", "Apr 14"
  messages: ChatMessage[];
}[] {
  const all = getHistory();
  const groups = new Map<string, ChatMessage[]>();

  for (const msg of all) {
    const date = msg.createdAt.slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(msg);
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const result: { date: string; label: string; messages: ChatMessage[] }[] = [];
  for (const [date, msgs] of groups) {
    const label =
      date === today
        ? "Today"
        : date === yesterday
          ? "Yesterday"
          : new Date(date + "T00:00:00").toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
    result.push({ date, label, messages: msgs });
  }

  result.sort((a, b) => b.date.localeCompare(a.date));
  return result;
}

export function isChatHistoryHydrated(): boolean {
  return hydrated;
}

export function disposeChatHistory(): void {
  if (syncTimer) clearInterval(syncTimer);
}
