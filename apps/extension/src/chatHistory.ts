import * as vscode from "vscode";
import type { ChatMessage } from "@protege/types";

/**
 * Chat History — persists conversations across reloads.
 *
 * Architecture:
 *   1. Extension host owns the source of truth (globalState)
 *   2. On webview "ready" → host sends full history to webview
 *   3. On every new message → host appends to globalState
 *   4. Conversations are grouped by day for easy browsing
 *   5. Periodically syncs to Supabase (when configured)
 *
 * Storage:
 *   - globalState key: "protege.chatHistory"
 *   - Format: ChatMessage[] (last 500 messages, older pruned)
 *   - Each message has: id, role, content, createdAt
 *
 * Search:
 *   - Host-side search via "chat/search" message
 *   - Returns matching messages with highlighted snippets
 */

const STORAGE_KEY = "protege.chatHistory";
const MAX_MESSAGES = 500;
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let ctx: vscode.ExtensionContext | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

export function initChatHistory(context: vscode.ExtensionContext): void {
  ctx = context;

  // Periodic Supabase sync (when configured)
  syncTimer = setInterval(() => syncToCloud(), SYNC_INTERVAL_MS);
}

/** Get all stored messages */
export function getHistory(): ChatMessage[] {
  if (!ctx) return [];
  return ctx.globalState.get<ChatMessage[]>(STORAGE_KEY) ?? [];
}

/** Append a message and persist */
export function appendMessage(message: ChatMessage): void {
  if (!ctx) return;
  const history = getHistory();
  history.push(message);

  // Prune old messages if over limit
  const pruned = history.length > MAX_MESSAGES
    ? history.slice(history.length - MAX_MESSAGES)
    : history;

  ctx.globalState.update(STORAGE_KEY, pruned);
}

/** Clear all history */
export function clearHistory(): void {
  if (!ctx) return;
  ctx.globalState.update(STORAGE_KEY, []);
}

/** Search messages by keyword — returns matching messages with context */
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

    // Extract a snippet around the match
    const start = Math.max(0, idx - 40);
    const end = Math.min(msg.content.length, idx + query.length + 40);
    let snippet = msg.content.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < msg.content.length) snippet = snippet + "...";

    results.push({ message: msg, snippet });
  }

  return results;
}

/** Group messages by day for the history view */
export function getHistoryByDay(): {
  date: string; // yyyy-mm-dd
  label: string; // "Today", "Yesterday", "Apr 14"
  messages: ChatMessage[];
}[] {
  const all = getHistory();
  const groups = new Map<string, ChatMessage[]>();

  for (const msg of all) {
    const date = msg.createdAt.slice(0, 10); // yyyy-mm-dd
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(msg);
  }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const result: { date: string; label: string; messages: ChatMessage[] }[] = [];
  for (const [date, msgs] of groups) {
    const label =
      date === today ? "Today"
      : date === yesterday ? "Yesterday"
      : new Date(date + "T00:00:00").toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
    result.push({ date, label, messages: msgs });
  }

  // Sort newest first
  result.sort((a, b) => b.date.localeCompare(a.date));
  return result;
}

/** Sync to Supabase (placeholder — activates when Supabase is configured) */
async function syncToCloud(): Promise<void> {
  try {
    const { isSupabaseEnabled } = await import("../../backend/src/supabase.js");
    if (!isSupabaseEnabled()) return;
    // TODO: batch-insert messages since last sync
    console.log("[protege] Chat history cloud sync: not yet implemented");
  } catch {
    // Supabase not available — that's fine, local storage is the primary
  }
}

export function disposeChatHistory(): void {
  if (syncTimer) clearInterval(syncTimer);
}
