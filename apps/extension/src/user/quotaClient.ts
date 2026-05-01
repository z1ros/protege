import * as vscode from "vscode";
import type { QuotaSnapshot, QuotaExceededError, QuotaKind } from "@protege/types";
import { authedFetch, BACKEND_URL } from "./protegeClient.js";
import { log } from "../log.js";

/**
 * Quota client — talks to `GET /me/quota` and surfaces the running daily
 * usage to the Live tab "Today's usage" panel and toast notifications
 * when a 429 trips.
 *
 * Cached in-process for SHORT_TTL_MS so a webview that re-mounts doesn't
 * spam the endpoint, but every 429 also forces a refetch so the panel
 * reflects the actual reason a request was rejected.
 */

let cached: { snapshot: QuotaSnapshot; fetchedAt: number } | null = null;
const SHORT_TTL_MS = 30_000;

const listeners = new Set<(snap: QuotaSnapshot) => void>();

export function onQuotaChange(cb: (snap: QuotaSnapshot) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(snap: QuotaSnapshot): void {
  cached = { snapshot: snap, fetchedAt: Date.now() };
  for (const cb of listeners) {
    try {
      cb(snap);
    } catch {
      /* listener failures are isolated */
    }
  }
}

/** Force a refresh from the backend. Used by the toast/refresh-on-429 path
 *  and the periodic Live-tab refresher. Returns null on auth/network fail. */
export async function fetchQuota(): Promise<QuotaSnapshot | null> {
  try {
    const res = await authedFetch(`${BACKEND_URL}/me/quota`);
    if (!res.ok) {
      log("quota", `fetch FAIL · HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as QuotaSnapshot;
    emit(body);
    return body;
  } catch (err) {
    log("quota", `fetch THREW · ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Cheap getter for surfaces that just want "what was the last value?"
 *  without triggering a network round-trip. Returns null if nothing's
 *  been fetched this session. */
export function getCachedQuota(): QuotaSnapshot | null {
  return cached?.snapshot ?? null;
}

/** True when we have a fresh-enough cached value; false when callers
 *  should trigger a refetch. */
export function isQuotaCacheFresh(): boolean {
  return !!cached && Date.now() - cached.fetchedAt < SHORT_TTL_MS;
}

const KIND_LABEL: Record<QuotaKind, string> = {
  // User-facing categories (the ones surfaced in the panel)
  chat_messages: "Chat messages",
  tool_calls: "Tool calls",
  voice_minutes: "Voice minutes",
  // Internal route caps (only seen via 429 toasts when an internal
  // counter trips before the user-facing one; mostly invisible to user)
  scan: "Live Review scans",
  teach: "Chat (teach tier)",
  tts: "Text-to-speech calls",
  stt: "Speech-to-text calls",
  verify: "Intent verification",
  classify: "Intent classification",
};

function formatResetIn(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Show a clear, user-readable notification when a quota-gated route
 * returns 429. Single source of truth so every callsite that hits a
 * 429 routes through the same surface (no half-built error toasts
 * scattered across the codebase).
 */
export function showQuotaExceededToast(err: QuotaExceededError): void {
  const label = KIND_LABEL[err.kind] ?? err.kind;
  const resetIn = formatResetIn(err.resetAt - Date.now());
  const detail =
    err.reason === "dollar-cap"
      ? `You've hit today's $${err.limit.toFixed(2)} ceiling for AI usage. Resets in ${resetIn}.`
      : `You've used all ${err.limit} ${label} calls for today. Resets in ${resetIn}.`;
  // Refresh the cache so the Live tab's "Today's usage" panel updates
  // immediately to reflect the cap that just tripped.
  void fetchQuota();
  vscode.window
    .showWarningMessage(detail, "Show usage", "Dismiss")
    .then((choice) => {
      if (choice === "Show usage") {
        vscode.commands.executeCommand("protege.toggle");
        // No direct "switch to Live tab" command yet — the user lands on
        // whatever panel is open. Acceptable for now; the Live tab is
        // where the usage panel lives so the workflow is one click away.
      }
    });
}

/**
 * Inspect a fetch Response. If it's a 429 with the QuotaExceeded shape,
 * surfaces the toast and returns the parsed error. Returns null
 * otherwise. Use at every callsite that hits a quota-gated route.
 */
export async function maybeHandleQuotaError(
  res: Response
): Promise<QuotaExceededError | null> {
  if (res.status !== 429) return null;
  try {
    const body = (await res.clone().json()) as QuotaExceededError;
    if (body && body.error === "daily quota exceeded" && body.kind) {
      showQuotaExceededToast(body);
      return body;
    }
  } catch {
    /* Not a quota 429 — some other rate limit. Caller handles it. */
  }
  return null;
}
