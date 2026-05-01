import type { MiddlewareHandler } from "hono";
import {
  checkAndIncrement,
  checkDollarCapOnly,
  quotasEnforced,
  type QuotaKind,
} from "../quotas.js";
import { getAuthenticatedUserId } from "./auth.js";

/**
 * Per-route quota middleware.
 *
 * Place AFTER `githubAuth()` so a verified userId is on the context.
 * No userId → pass through (auth middleware would have already 401'd
 * if auth was enforced; if it wasn't, we have no key to count against).
 *
 * On the rejection path returns HTTP 429 with a structured body the
 * extension can render directly:
 *   { error, kind, used, limit, resetAt }
 *
 * `kind` for `/chat` is decided per-request inside the route handler
 * (depends on tier), not by the middleware factory — so chat passes
 * "scan" or "teach" via a header set on `c.set("quotaKind", ...)`. For
 * single-kind routes (tts/stt/verify/classify) the factory hard-codes
 * the kind.
 */
export function quotaMiddleware(kind: QuotaKind | "deferred"): MiddlewareHandler {
  return async (c, next) => {
    const userId = getAuthenticatedUserId(c);
    if (!userId) {
      // No verified user → no quota key. Fail-open. (In enforced mode
      // the auth middleware would have already 401'd before this.)
      return next();
    }

    // For `/chat`, the kind depends on the request's `tier` field which
    // the route extracts from the JSON body. The middleware can't read
    // the body without consuming it, so the chat route sets a context
    // key BEFORE calling `next()` past this middleware. We support
    // that via the "deferred" sentinel — when used, the route handler
    // is responsible for invoking `enforceQuotaInline(c, kind)` itself.
    if (kind === "deferred") {
      return next();
    }

    // Always check + increment — even when `PROTEGE_QUOTAS=off`. This is
    // the "record but don't block" mode: counters in `user_quotas` reflect
    // real usage so the Profile panel + telemetry stay live, but a hit
    // cap doesn't 429. Switching to enforce mode is one env-var flip.
    const result = await checkAndIncrement(userId, kind);
    if (!result.allowed && quotasEnforced()) {
      return c.json(
        {
          error: "daily quota exceeded",
          kind: result.kind,
          reason: result.reason,
          used: result.used,
          limit: result.limit,
          resetAt: result.resetAt,
        },
        429
      );
    }
    return next();
  };
}

/**
 * Inline variant for routes where the kind is only known after the
 * body is parsed (e.g. `/chat` distinguishing scan vs teach by tier).
 * Returns the 429 Response when blocked, or null when allowed.
 *
 * "Record but don't block" mode: when `PROTEGE_QUOTAS=off`, the counter
 * still bumps so the panel reflects real usage — the call just doesn't
 * 429 on cap. Flip the env var to switch from observe to enforce.
 */
export async function enforceQuotaInline(
  c: Parameters<MiddlewareHandler>[0],
  kind: QuotaKind
): Promise<Response | null> {
  const userId = getAuthenticatedUserId(c);
  if (!userId) return null;
  const result = await checkAndIncrement(userId, kind);
  if (result.allowed) return null;
  if (!quotasEnforced()) return null;
  return c.json(
    {
      error: "daily quota exceeded",
      kind: result.kind,
      reason: result.reason,
      used: result.used,
      limit: result.limit,
      resetAt: result.resetAt,
    },
    429
  );
}

/**
 * Cost-cap gate for the case where a route is being hit on a SECOND
 * leg of a single user turn (e.g. tool-use re-fires from `/chat`).
 *
 * Different from `enforceQuotaInline` because:
 *   - No increment of the route counter. The user-facing "Chat messages"
 *     metric should reflect user-typed turns, not internal multi-round
 *     tool execution. Bumping it on every tool re-fire is what made 3
 *     typed messages show up as "9 / 100" in the panel.
 *   - Still enforces the $ daily ceiling so a runaway tool loop can't
 *     blow through the cost cap. That's what the dollar guard exists
 *     for in the first place.
 *
 * Returns 429 Response when blocked, null when allowed.
 */
export async function enforceCostCapOnly(
  c: Parameters<MiddlewareHandler>[0]
): Promise<Response | null> {
  const userId = getAuthenticatedUserId(c);
  if (!userId) return null;
  const result = await checkDollarCapOnly(userId);
  if (result.allowed) return null;
  if (!quotasEnforced()) return null;
  return c.json(
    {
      error: "daily quota exceeded",
      kind: result.kind,
      reason: result.reason,
      used: result.used,
      limit: result.limit,
      resetAt: result.resetAt,
    },
    429
  );
}
