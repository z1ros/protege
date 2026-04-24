import * as vscode from "vscode";

/**
 * GitHub authentication via VS Code's built-in provider.
 *
 * VS Code / Cursor already handles the OAuth flow, token refresh, and
 * credential storage. We just ask for a session. When the user isn't
 * signed in yet, `createIfNone: false` returns null silently; the
 * webview shows a "Sign in with GitHub" button which calls back with
 * a `auth/login` message, and we retry with `createIfNone: true` to
 * pop the native auth dialog.
 *
 * The session gives us:
 *   - `session.accessToken`  — GitHub PAT, send to backend as Bearer
 *   - `session.account.id`   — stable numeric GitHub user ID
 *   - `session.account.label` — GitHub username (e.g. "YuriiTov")
 *
 * The backend verifies the token via `GET https://api.github.com/user`
 * with the Bearer header to confirm identity. No secrets needed on the
 * client side — the token is managed entirely by VS Code.
 */

const SCOPES = ["user:email"];

export interface ProtegeUser {
  githubId: string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
  accessToken: string;
}

let cachedUser: ProtegeUser | null = null;

export async function getGitHubUser(
  createIfNone = false
): Promise<ProtegeUser | null> {
  if (cachedUser) return cachedUser;

  try {
    const session = await vscode.authentication.getSession("github", SCOPES, {
      createIfNone,
    });
    if (!session) return null;

    const user: ProtegeUser = {
      githubId: session.account.id,
      login: session.account.label,
      email: null,
      avatarUrl: null,
      accessToken: session.accessToken,
    };

    // Fetch full profile to get email + avatar
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
      // Non-fatal — we still have the basics from the session
    }

    cachedUser = user;
    return user;
  } catch (err) {
    console.warn("[protege] GitHub auth failed:", err);
    return null;
  }
}

export function clearCachedUser() {
  cachedUser = null;
}

/**
 * Returns headers for backend API calls. If the user is authenticated,
 * includes a Bearer token the backend can verify against GitHub.
 * Falls back to the legacy x-user-id header with the random UUID.
 */
export function authHeaders(
  fallbackUserId: string
): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cachedUser) {
    h["Authorization"] = `Bearer ${cachedUser.accessToken}`;
    h["x-github-login"] = cachedUser.login;
  } else {
    h["x-user-id"] = fallbackUserId;
  }
  return h;
}
