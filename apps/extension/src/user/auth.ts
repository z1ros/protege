import * as vscode from "vscode";
import {
  getCachedGitHubUser as authStateGetCachedUser,
  setSession,
  markSigningIn,
  setOptedOut,
  isOptedOut,
  type ProtegeUser,
} from "./authState.js";

/**
 * GitHub authentication via VS Code's built-in provider.
 *
 * Login-first: there is no anonymous fallback. Callers that need a userId
 * must check `getCachedGitHubUser()` (or `requireUserId()` in protegeClient)
 * before issuing requests. Without a session, network is silent.
 *
 * VS Code / Cursor handles the OAuth flow, token refresh, and credential
 * storage. We call `getSession` to read the existing session silently
 * (createIfNone: false) or to pop the OAuth dialog (createIfNone: true).
 *
 * The session gives us:
 *   - `session.accessToken`  — GitHub PAT, send to backend as Bearer
 *   - `session.account.id`   — stable numeric GitHub user ID
 *   - `session.account.label` — GitHub username (e.g. "YuriiTov")
 *
 * The backend verifies the token via `GET https://api.github.com/user`
 * with the Bearer header to confirm identity.
 */

const SCOPES = ["user:email"];

export type { ProtegeUser } from "./authState.js";
export {
  getCachedGitHubUser,
  getAuthState,
  isSignedIn,
  onAuthChange,
  installAuthSessionListener,
  bindAuthOptOutContext,
  isOptedOut,
  type AuthState,
  type AuthSnapshot,
} from "./authState.js";

interface GetSessionOptions {
  createIfNone?: boolean;
  forceNewSession?: boolean;
}

/**
 * Resolve the current GitHub session. Defaults to silent (no OAuth dialog).
 * Pass `createIfNone: true` to pop the native auth dialog. Pass
 * `forceNewSession: true` to force a token refresh (used by the 401 retry).
 *
 * Updates the canonical authState cache on success or null result.
 */
export async function getGitHubUser(
  createIfNoneOrOpts: boolean | GetSessionOptions = false
): Promise<ProtegeUser | null> {
  const opts: GetSessionOptions =
    typeof createIfNoneOrOpts === "boolean"
      ? { createIfNone: createIfNoneOrOpts }
      : createIfNoneOrOpts;

  if (opts.createIfNone || opts.forceNewSession) {
    markSigningIn();
    // Explicit user-initiated sign-in — clear any prior opt-out so the
    // resolved session sticks across restarts.
    await setOptedOut(false);
  }

  try {
    const session = await vscode.authentication.getSession("github", SCOPES, {
      createIfNone: opts.createIfNone,
      forceNewSession: opts.forceNewSession,
    });
    if (!session) {
      setSession(null);
      return null;
    }

    const user: ProtegeUser = {
      githubId: session.account.id,
      login: session.account.label,
      email: null,
      avatarUrl: null,
      accessToken: session.accessToken,
    };

    try {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "User-Agent": "Protege-VSCode",
          Accept: "application/vnd.github+json",
        },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          email?: string | null;
          avatar_url?: string;
        };
        user.email = data.email ?? null;
        user.avatarUrl = data.avatar_url ?? null;
      }
    } catch {
      // Non-fatal — session basics are already in `user`.
    }

    setSession(user);
    return user;
  } catch (err) {
    console.warn("[protege] GitHub auth failed:", err);
    setSession(null);
    return null;
  }
}

export function clearCachedUser() {
  setSession(null);
}

/**
 * In-app sign-out. We can't revoke VS Code's underlying GitHub session —
 * that's owned by the Accounts UI — but we can clear our cached user and
 * persist an opt-out flag so future activations skip the silent session
 * probe. Net effect: the gate UI takes over, all backend writes stop, and
 * the user can sign back in (which silently re-resolves the still-cached
 * VS Code session, no second OAuth dialog).
 *
 * If the user wants a hard logout (revoke the VS Code session itself),
 * they have to do it from the Accounts panel — caller surfaces that hint.
 */
export async function signOut(): Promise<void> {
  await setOptedOut(true);
  setSession(null);
}

/**
 * Counterpart to `signOut`. Called when the user clicks "Sign in" — clears
 * the opt-out flag so a successful resolve is honored on the next activate.
 */
export async function clearAuthOptOut(): Promise<void> {
  await setOptedOut(false);
}

/**
 * Headers for backend API calls. Login-first: no session → empty headers
 * for fetches that should never run. Callers MUST gate on `isSignedIn()`
 * before sending; this is defence-in-depth, not a contract.
 */
export function authHeaders(): Record<string, string> {
  const user = authStateGetCachedUser();
  const h: Record<string, string> = {
    "content-type": "application/json",
  };
  if (user) {
    h["Authorization"] = `Bearer ${user.accessToken}`;
    h["x-github-login"] = user.login;
  }
  return h;
}
