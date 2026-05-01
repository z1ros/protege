import { Hono } from "hono";
import { createHash } from "node:crypto";
import type {
  VerifyRequest,
  VerifyResponse,
  Understanding,
  UnderstandingAction,
} from "@protege/types";
import { callOneShot } from "../llm.js";
import { githubAuth } from "../middleware/auth.js";
import { quotaMiddleware } from "../middleware/quota.js";
import {
  VERIFIER_SYSTEM_PROMPT,
  buildVerifierUserPrompt,
} from "../prompts/verifier.js";

/**
 * POST /verify — Understanding-Check (plans/understanding-check.md §2.4).
 *
 * Called by the extension between shapeTask and runChat when the skip
 * ladder (§2.2) says the turn might benefit from a pre-reply verifier.
 * Returns an Understanding describing what to do next:
 *   - clarify       → bot asks one question, waits for reply
 *   - offer-learn   → fork chips with refined goal
 *   - offer-do      → bot just does it, no fork
 *   - answer        → proceed to normal chat reply
 *
 * Strict JSON parse. On invalid output we return 502 and the extension
 * fails open to `{ action: "answer", goal: raw message }` — chat flow
 * never blocks on verify.
 *
 * Cache: sha256(message + shape.shape + activeFilePath + activeFileLanguage +
 * forceProceed). 10-min TTL, 200-entry bound. `forceProceed` is part of the
 * key because clarifier-reply verify is a different request than the
 * same message typed fresh.
 */

export const verifyRoute = new Hono();

verifyRoute.use("*", githubAuth());
verifyRoute.use("*", quotaMiddleware("verify"));

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { understanding: Understanding; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(body: VerifyRequest): string {
  const h = createHash("sha256");
  h.update(body.message);
  h.update("|");
  h.update(body.shape.shape);
  h.update("|");
  h.update(body.context.activeFilePath ?? "");
  h.update("|");
  h.update(body.context.activeFileLanguage ?? "");
  h.update("|");
  h.update(body.forceProceed ? "1" : "0");
  return h.digest("hex");
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

const VALID_ACTIONS: UnderstandingAction[] = [
  "clarify",
  "offer-learn",
  "offer-do",
  "answer",
];

/**
 * Strict-parse a verifier JSON reply. Returns null on any schema
 * violation so the extension fails open to `answer` with raw message.
 * Trim markdown fences in case Haiku wraps its JSON despite the prompt.
 */
function parseVerifierReply(
  raw: string,
  forceProceed: boolean
): Understanding | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.action !== "string" ||
    !VALID_ACTIONS.includes(p.action as UnderstandingAction)
  )
    return null;
  if (typeof p.goal !== "string" || p.goal.trim().length === 0) return null;
  if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1)
    return null;
  // forceProceed means: "the user already answered the last clarifier, so
  // don't ask another one." If the model ignores this, downgrade to
  // answer — never let the user get trapped in a clarify loop.
  let action = p.action as UnderstandingAction;
  if (forceProceed && action === "clarify") {
    action = "answer";
  }
  // Low-confidence clarify → downgrade to answer. Threshold from
  // plans/understanding-check.md §9. Prevents robotic nagging on
  // questions where the model is guessing whether clarify helps.
  if (action === "clarify" && (p.confidence as number) < 0.65) {
    action = "answer";
  }
  const clarifier =
    action === "clarify" && typeof p.clarifier === "string"
      ? p.clarifier.trim().slice(0, 240)
      : undefined;
  // Clarify without a clarifier string → downgrade.
  if (action === "clarify" && !clarifier) {
    action = "answer";
  }
  const why = typeof p.why === "string" ? p.why.slice(0, 160) : "";
  return {
    action,
    goal: (p.goal as string).trim().slice(0, 240),
    clarifier,
    confidence: p.confidence as number,
    signals: { tier: "llm", why },
  };
}

verifyRoute.post("/", async (c) => {
  const body = (await c.req.json()) as VerifyRequest;
  if (!body || typeof body.message !== "string" || body.message.trim().length === 0) {
    return c.json<VerifyResponse>({ error: "message is required" }, 400);
  }
  if (!body.shape || !body.context) {
    return c.json<VerifyResponse>({ error: "shape and context are required" }, 400);
  }

  const forceProceed = !!body.forceProceed;
  const key = cacheKey(body);
  const hit = cacheGet(key);
  if (hit) {
    return c.json<VerifyResponse>({
      understanding: { ...hit, signals: { tier: "cache", why: hit.signals.why } },
    });
  }

  const diagErrors = body.context.diagnosticsOnActiveFile.filter(
    (d) => d.severity === "error"
  ).length;
  const diagWarns = body.context.diagnosticsOnActiveFile.filter(
    (d) => d.severity === "warning"
  ).length;

  const userPrompt = buildVerifierUserPrompt(
    body.message,
    {
      activeFilePath: body.context.activeFilePath,
      activeFileLanguage: body.context.activeFileLanguage,
      diagnosticsCount: { errors: diagErrors, warnings: diagWarns },
      classifierShape: body.shape.shape,
      classifierComplexity: body.shape.complexity,
      classifierConfidence: body.shape.confidence,
      recentTurns: body.context.recentMessages,
    },
    forceProceed
  );

  try {
    const { text } = await callOneShot({
      systemText: VERIFIER_SYSTEM_PROMPT,
      userText: userPrompt,
      maxTokens: 300,
      cacheSystem: false,
    });
    const understanding = parseVerifierReply(text, forceProceed);
    if (!understanding) {
      console.warn(
        `[protege] /verify parse failed: ${text.slice(0, 200)}`
      );
      return c.json<VerifyResponse>(
        { error: "verifier produced invalid JSON" },
        502
      );
    }
    cachePut(key, understanding);
    console.log(
      `[protege] /verify action=${understanding.action} goal="${understanding.goal.slice(0, 60)}" conf=${understanding.confidence.toFixed(2)}`
    );
    return c.json<VerifyResponse>({ understanding });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[protege] /verify failed: ${msg}`);
    return c.json<VerifyResponse>({ error: msg }, 500);
  }
});
