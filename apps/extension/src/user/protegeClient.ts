import * as vscode from "vscode";
import type { AnalyzeResponse, Finding, MeResponse } from "@protege/types";
import { authHeaders, getCachedGitHubUser, getGitHubUser, clearCachedUser } from "./auth.js";

export const BACKEND_URL =
  process.env.PROTEGE_BACKEND_URL ?? "http://localhost:8787";

const LEGACY_USER_ID_KEY = "protege.userId";

/** Thrown when a backend call is attempted without a GitHub session. */
export class NotAuthenticatedError extends Error {
  constructor(message = "Protege requires a GitHub sign-in to talk to the backend.") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Returns the current GitHub user id, or throws NotAuthenticatedError.
 * Use at every backend call site as the canonical entry point.
 */
export function requireUserId(): string {
  const gh = getCachedGitHubUser();
  if (!gh) throw new NotAuthenticatedError();
  return gh.githubId;
}

/**
 * Non-throwing variant for surfaces that need to short-circuit silently
 * (background timers, optional refreshes). Returns null when signed-out.
 */
export function currentUserIdOrNull(): string | null {
  return getCachedGitHubUser()?.githubId ?? null;
}

/**
 * Legacy shim. Old call sites pass `context` for the now-deleted UUID
 * fallback. Behaviour: returns the GitHub id when signed in, throws
 * NotAuthenticatedError otherwise. The `context` arg is ignored — kept
 * only so we don't have to touch every call site in this commit.
 *
 * One-time chore: deletes the abandoned UUID from globalState.
 */
export function getUserId(context?: vscode.ExtensionContext): string {
  if (context) {
    const stored = context.globalState.get<string>(LEGACY_USER_ID_KEY);
    if (stored) {
      void context.globalState.update(LEGACY_USER_ID_KEY, undefined);
    }
  }
  return requireUserId();
}

interface FetchOpts {
  method?: string;
  body?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Authenticated fetch with one-shot 401 recovery.
 *
 * On 401 we try a SILENT session refresh — re-reads VS Code's still-cached
 * GitHub session without showing any UI. That handles the common cause of
 * a 401 (the in-memory token in our cached user lagged behind a VS Code
 * rotation) without bothering the user.
 *
 * Two outcomes of the silent refresh:
 *   - Returned a session → the token is valid as far as VS Code is
 *     concerned. Retry once. If the retry still 401s, the backend itself
 *     is rejecting a valid token (cold start, validator hiccup, scope
 *     disagreement during a deploy) — we surface that 401 to the caller
 *     instead of popping OAuth, because re-OAuthing won't fix a broken
 *     backend, it would just spam-prompt the user.
 *   - Returned null → the underlying VS Code session really is gone.
 *     Clear the local cache, throw NotAuthenticatedError, and let the auth
 *     gate re-render. The user can click "Sign in" when they're ready;
 *     that click goes through `createIfNone: true`, which silently resolves
 *     a still-valid session or pops the OAuth dialog only on confirmed
 *     revocation.
 *
 * We deliberately do NOT call `forceNewSession: true` here. It always pops
 * the "wants you to sign in again" dialog, and we can't distinguish a
 * recoverable 401 (backend issue) from an unrecoverable one (token
 * revoked) at this layer — so triggering OAuth on every 401 spam-prompts
 * users whenever the backend hiccups.
 *
 * Pre-auth: throws NotAuthenticatedError synchronously; never hits network.
 */
export async function authedFetch(
  url: string,
  opts: FetchOpts = {}
): Promise<Response> {
  if (!getCachedGitHubUser()) throw new NotAuthenticatedError();

  const send = async (): Promise<Response> => {
    return fetch(url, {
      method: opts.method ?? "GET",
      headers: { ...authHeaders(), ...(opts.headers ?? {}) },
      body: opts.body,
      signal: opts.signal,
    });
  };

  const first = await send();
  if (first.status === 429) {
    // Quota-gated route returned 429. Surface a clear toast + refresh
    // the local quota snapshot so the Live tab's "Today's usage" panel
    // reflects what tripped. Then return the response so the caller
    // can decide what to render in-place (most callers throw on
    // non-OK; the toast is the user-visible signal).
    const { maybeHandleQuotaError } = await import("./quotaClient.js");
    await maybeHandleQuotaError(first);
    return first;
  }
  if (first.status !== 401) return first;

  const refreshed = await getGitHubUser(false);
  if (refreshed) {
    // VS Code still has a session. Retry once. If it 401s again the
    // backend is the problem, not the token — surface the response and
    // let the caller decide (toast, retry later, etc.). No OAuth dialog.
    return send();
  }

  // Silent refresh returned null — session is genuinely gone. Clear and
  // surface the gate. The user's next "Sign in" click handles the OAuth
  // round trip if VS Code can't resolve silently either.
  clearCachedUser();
  throw new NotAuthenticatedError();
}

export async function analyzeFile(
  userId: string,
  file: { path: string; language: string; content: string }
): Promise<Finding[]> {
  const res = await authedFetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    body: JSON.stringify({ userId, file }),
  });
  if (!res.ok) throw new Error(`analyze HTTP ${res.status}`);
  const data = (await res.json()) as AnalyzeResponse;
  return data.findings ?? [];
}

import type { GainEvent } from "@protege/types";

export interface RecordConceptsInput {
  filePath: string;
  fileHash: string;
  concepts: string[];
  contextScores?: Record<string, number>;
  hasErrors: boolean;
  errorCount: number;
  language?: string | null;
}

export interface RecordConceptsResult {
  skipped: boolean;
  codeIq: number;
  totalConcepts: number;
  gains: GainEvent[];
}

export async function recordConcepts(
  userId: string,
  input: RecordConceptsInput
): Promise<RecordConceptsResult> {
  const res = await authedFetch(`${BACKEND_URL}/concept-used`, {
    method: "POST",
    body: JSON.stringify({ userId, ...input }),
  });
  if (!res.ok) throw new Error(`concept-used HTTP ${res.status}`);
  return (await res.json()) as RecordConceptsResult;
}

/**
 * Fetch generalized "Did you know?" tips for a batch of concepts.
 *
 * Cache rows are global, not per-user. The backend handles charset /
 * length / language validation; this client just forwards what the
 * detector found. Returns a partial map: missing keys are normal
 * (transient backend failure or unsupported language) and the caller
 * should silently fall back to no tip.
 */
export async function fetchConceptTips(
  language: string,
  concepts: string[]
): Promise<Record<string, string>> {
  if (concepts.length === 0) return {};
  const res = await authedFetch(`${BACKEND_URL}/concept-tips/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language, concepts }),
  });
  if (!res.ok) throw new Error(`concept-tips HTTP ${res.status}`);
  const body = (await res.json()) as {
    tips?: Record<string, string>;
    promptVersion?: number;
  };
  return body.tips ?? {};
}

/** Concept names the user has demonstrated familiarity with (heuristic from
 *  the backend: usage count, manual authorship, breadth across files). The
 *  Did-You-Know tip selector subtracts these from the candidate set so we
 *  stop teaching `useState` to someone who has shipped it ten times. */
export async function fetchKnownConcepts(): Promise<string[]> {
  const res = await authedFetch(`${BACKEND_URL}/concept-used/known`);
  if (!res.ok) throw new Error(`concept-used/known HTTP ${res.status}`);
  const body = (await res.json()) as { known?: string[] };
  return body.known ?? [];
}

export async function fetchMe(userId: string): Promise<MeResponse> {
  const res = await authedFetch(
    `${BACKEND_URL}/me?userId=${encodeURIComponent(userId)}`
  );
  if (!res.ok) throw new Error(`me HTTP ${res.status}`);
  return (await res.json()) as MeResponse;
}

export async function fetchPreferences(
  userId: string
): Promise<Record<string, unknown>> {
  try {
    const res = await authedFetch(
      `${BACKEND_URL}/preferences?userId=${encodeURIComponent(userId)}`
    );
    if (!res.ok) return {};
    const body = (await res.json()) as { preferences?: Record<string, unknown> };
    return body.preferences ?? {};
  } catch {
    return {};
  }
}

export async function patchPreferences(
  userId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await authedFetch(
      `${BACKEND_URL}/preferences?userId=${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// BACKEND_URL is now exported at its declaration above.
