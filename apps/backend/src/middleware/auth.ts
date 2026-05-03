import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * GitHub Bearer-token auth for Echo/classify/verify routes.
 *
 * Activation: controlled by the PROTEGE_AUTH_REQUIRED env var.
 *   - unset | "true" | "1"   → enforce (default). Missing/invalid Bearer → 401.
 *   - "false" | "0"          → pass through (local single-user dev only).
 *
 * When enforcing, the middleware:
 *   1. Extracts `Authorization: Bearer <token>`.
 *   2. Validates the token against GET https://api.github.com/user.
 *      Successful lookups are cached by token for 5 min to stay well
 *      inside GitHub's 5k/hr authenticated rate limit.
 *   3. Rejects with 403 if the request declares an `x-user-id` header or
 *      `?userId=` query param that doesn't match the GitHub numeric id.
 *   4. Attaches the verified id to the request context as
 *      `authenticatedUserId` for handlers to consume.
 *
 * Handlers can opt in to the verified id via `getAuthenticatedUserId(c)`,
 * or use `resolveUserId(c, body.userId)` to get the canonical id while
 * also rejecting body-supplied userIds that disagree with the verified one.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_TOKEN_LEN = 400;

interface CacheEntry {
  githubId: string;
  /** GitHub username (case-preserved as the API returned it). Drives the
   *  internal-team allowlist gate on `/me`. Logins are case-insensitive
   *  in GitHub's auth model — compare lowercased. */
  githubLogin: string | null;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

/** Test-only: clear the verified-token cache between tests. Not exported
 *  from package.json — consumers outside the backend should not call this. */
export function _resetAuthCacheForTests(): void {
  tokenCache.clear();
}

export function isAuthRequired(): boolean {
  const v = process.env.PROTEGE_AUTH_REQUIRED;
  // Default ON. Only an explicit "false" or "0" disables auth — for local
  // single-user dev. Absent / anything else → enforce.
  return v !== "false" && v !== "0";
}

async function verifyGitHubToken(token: string): Promise<CacheEntry | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  if (cached) tokenCache.delete(token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Protege-Backend",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: number | string;
      login?: string;
    };
    if (data.id == null) return null;
    const entry: CacheEntry = {
      githubId: String(data.id),
      githubLogin: typeof data.login === "string" ? data.login : null,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    tokenCache.set(token, entry);
    return entry;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue);
  if (!m) return null;
  const token = m[1].trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  return token;
}

/**
 * Hono middleware factory. Call once per route group you want guarded:
 *
 *   const echoRoute = new Hono();
 *   echoRoute.use("*", githubAuth());
 */
export function githubAuth(): MiddlewareHandler {
  return async (c, next) => {
    const required = isAuthRequired();
    const token = extractBearer(c.req.header("Authorization"));

    if (!required) {
      if (token) {
        const verified = await verifyGitHubToken(token);
        if (verified) {
          c.set("authenticatedUserId", verified.githubId);
          if (verified.githubLogin) {
            c.set("authenticatedGitHubLogin", verified.githubLogin);
          }
        }
      }
      await next();
      return;
    }

    if (!token) {
      return c.json({ error: "authentication required" }, 401);
    }
    const verified = await verifyGitHubToken(token);
    if (!verified) {
      return c.json({ error: "invalid or expired token" }, 401);
    }

    const claimedHeader = c.req.header("x-user-id");
    const claimedQuery = c.req.query("userId");
    if (claimedHeader && claimedHeader !== verified.githubId) {
      return c.json(
        { error: "x-user-id does not match authenticated identity" },
        403
      );
    }
    if (claimedQuery && claimedQuery !== verified.githubId) {
      return c.json(
        { error: "userId does not match authenticated identity" },
        403
      );
    }

    c.set("authenticatedUserId", verified.githubId);
    if (verified.githubLogin) {
      c.set("authenticatedGitHubLogin", verified.githubLogin);
    }
    await next();
  };
}

/** Read the verified userId set by `githubAuth`. Returns null when the
 *  middleware didn't run or wasn't able to verify (dev mode, no token). */
export function getAuthenticatedUserId(c: Context): string | null {
  const v = c.get("authenticatedUserId") as string | undefined;
  return v ?? null;
}

/** Read the verified GitHub login (username) set by `githubAuth`. Returns
 *  null when the middleware didn't run, the token was invalid, or the
 *  GitHub /user response somehow didn't include a login. */
export function getAuthenticatedGitHubLogin(c: Context): string | null {
  const v = c.get("authenticatedGitHubLogin") as string | undefined;
  return v ?? null;
}

/**
 * Canonical userId resolution for any handler that receives a request
 * payload with a (possibly client-supplied) `userId` field.
 *
 * - If auth is enforced and verified: returns the verified GitHub id, and
 *   throws 403 if any of body/header/query disagrees.
 * - If auth is enforced and somehow not verified (defensive): throws 401.
 * - If auth is off (local dev opt-out): falls back to body/header/query,
 *   then "local-dev". Caps length at 200 chars.
 *
 * Use this in route handlers instead of inline `body.userId ?? header ??
 * query ?? "local-dev"` patterns — that idiom is unsafe when auth is off
 * and was the IDOR vector across /me, /concept-used, /memory, /preferences.
 */
export function resolveUserId(
  c: Context,
  bodyUserId: string | undefined
): string {
  const verified = getAuthenticatedUserId(c);
  const header = c.req.header("x-user-id");
  const query = c.req.query("userId");

  if (verified) {
    for (const claimed of [bodyUserId, header, query]) {
      if (
        typeof claimed === "string" &&
        claimed.length > 0 &&
        claimed !== verified
      ) {
        throw new HTTPException(403, {
          message: "userId does not match authenticated identity",
        });
      }
    }
    return verified;
  }
  if (isAuthRequired()) {
    // Middleware should have already rejected this — defensive fallback.
    throw new HTTPException(401, { message: "authentication required" });
  }
  // Auth is OFF — dev-mode opt-out. The historical fallback chain
  // `body ?? header ?? query ?? "local-dev"` is too permissive for
  // anything that isn't a vitest harness: it lets a misconfigured
  // server accept arbitrary header-supplied userIds. Require an
  // explicit `PROTEGE_ALLOW_DEV_USER=true` opt-in. Without it, refuse.
  if (process.env.PROTEGE_ALLOW_DEV_USER !== "true") {
    throw new HTTPException(401, {
      message:
        "authentication required (set PROTEGE_ALLOW_DEV_USER=true for dev-mode tests)",
    });
  }
  const candidate = bodyUserId ?? header ?? query ?? "local-dev";
  if (typeof candidate !== "string" || candidate.length === 0) return "local-dev";
  if (candidate.length > 200) return "local-dev";
  return candidate;
}
