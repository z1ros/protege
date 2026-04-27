import type {
  TaskShape,
  ShapeContext,
  Understanding,
  VerifyResponse,
} from "@protege/types";
import { BACKEND_URL } from "../user/protegeClient.js";
import { authHeaders } from "../user/auth.js";
import { log } from "../log.js";

/**
 * Understanding Check — pre-reply verifier. See plans/understanding-check.md.
 *
 * Runs between shapeTask and the main chat call. Decides:
 *   - "clarify"     → bot asks ONE question, waits for reply
 *   - "offer-learn" → fork chips appear with a refined goal
 *   - "offer-do"    → bot just does it, no fork
 *   - "answer"      → proceed to normal chat
 *
 * The returned `goal` is the verifier's canonical rewrite of what the
 * user actually wants. Downstream surfaces (fork tag, synthetic "just do
 * it", protege.learning.start) should use it instead of the user's raw
 * message for better plan generation.
 *
 * FAIL-OPEN: any error (timeout, 5xx, bad JSON, network) returns a
 * default `{ action: "answer", goal: rawMessage }` so the chat pipeline
 * never blocks on a verify failure.
 */

const VERIFY_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const CLARIFY_CONF_FLOOR = 0.65;

interface CacheEntry {
  understanding: Understanding;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(
  message: string,
  shape: TaskShape,
  ctx: ShapeContext,
  forceProceed: boolean
): string {
  return `${message}|${shape.shape}|${ctx.activeFilePath ?? ""}|${ctx.activeFileLanguage ?? ""}|${forceProceed ? "1" : "0"}`;
}

function cacheGet(key: string): Understanding | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.understanding;
}

function cachePut(key: string, understanding: Understanding): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { understanding, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Synthetic default when verify is skipped or fails. Uses the user's
 *  raw message as the goal and routes to the normal chat path. */
function defaultAnswer(message: string, why: string): Understanding {
  return {
    action: "answer",
    goal: message,
    confidence: 1.0,
    signals: { tier: "skip", why },
  };
}

/**
 * Skip ladder from plans/understanding-check.md §2.2. Returns a synthetic
 * Understanding for cases where the verifier wouldn't add signal, so we
 * avoid the Haiku call. Returns null when verify SHOULD run.
 */
function shouldSkip(
  message: string,
  shape: TaskShape,
  forceProceed: boolean
): Understanding | null {
  if (forceProceed) return null; // always verify clarifier replies
  if (message.trim().length < 15) {
    return defaultAnswer(message, "message < 15 chars");
  }
  if (shape.complexity === "trivial") {
    return defaultAnswer(message, "classifier marked trivial");
  }
  if (
    (shape.shape === "chat" || shape.shape === "qna") &&
    shape.confidence >= 0.8
  ) {
    return defaultAnswer(message, `high-conf ${shape.shape}`);
  }
  return null;
}

export async function verifyUnderstanding(
  message: string,
  shape: TaskShape,
  context: ShapeContext,
  opts: { forceProceed?: boolean } = {}
): Promise<Understanding> {
  const forceProceed = !!opts.forceProceed;
  const skipped = shouldSkip(message, shape, forceProceed);
  if (skipped) {
    log(
      "verify",
      `skip: action=${skipped.action} why="${skipped.signals.why}"`
    );
    return skipped;
  }

  const key = cacheKey(message, shape, context, forceProceed);
  const cached = cacheGet(key);
  if (cached) {
    log(
      "verify",
      `cache: action=${cached.action} goal="${cached.goal.slice(0, 60)}"`
    );
    return {
      ...cached,
      signals: { tier: "cache", why: cached.signals.why },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/verify`, {
      method: "POST",
      headers: { ...authHeaders() },
      body: JSON.stringify({ message, shape, context, forceProceed }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log("verify", `fail-open: HTTP ${res.status}`);
      return defaultAnswer(message, `verify HTTP ${res.status}`);
    }
    const data = (await res.json()) as VerifyResponse;
    if ("error" in data) {
      log("verify", `fail-open: backend error "${data.error}"`);
      return defaultAnswer(message, `verify error: ${data.error}`);
    }
    let understanding = data.understanding;
    // Double-check client-side: backend already enforces forceProceed,
    // but defense in depth against a stale cache path or buggy build.
    if (forceProceed && understanding.action === "clarify") {
      understanding = { ...understanding, action: "answer", clarifier: undefined };
    }
    if (
      understanding.action === "clarify" &&
      understanding.confidence < CLARIFY_CONF_FLOOR
    ) {
      understanding = {
        ...understanding,
        action: "answer",
        clarifier: undefined,
      };
    }
    cachePut(key, understanding);
    log(
      "verify",
      `llm: action=${understanding.action} goal="${understanding.goal.slice(0, 60)}" conf=${understanding.confidence.toFixed(2)}`
    );
    return understanding;
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    log("verify", `fail-open: ${msg}`);
    return defaultAnswer(message, `verify exception: ${msg}`);
  }
}
