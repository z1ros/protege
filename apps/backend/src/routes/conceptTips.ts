import { Hono } from "hono";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { getConceptTips, putConceptTips } from "../store.js";
import { generateConceptTipsBatch } from "../ai/conceptTips.js";
import { sanitizeLanguage } from "./echo.js";

/**
 * Generalized "Did you know?" tip cache.
 *
 * POST /concept-tips/batch
 *   body:    { language: string, concepts: string[] }
 *   returns: { tips: Record<concept, string>, promptVersion: number }
 *
 * Cache rows are keyed by (language, concept_name, prompt_version) and
 * are NOT user-specific. One LLM call per (language, concept) across
 * the entire user base.
 *
 * Security:
 *   - githubAuth gate (every caller is a verified GitHub user).
 *   - Concept names validated against a strict charset + length cap
 *     before they ever reach the LLM or the table — blocks prompt
 *     injection (newlines, control chars) and key-cardinality abuse.
 *   - Languages restricted to a small allowlist.
 *   - Per-user request rate limit (in-memory bucket).
 *   - MAX_BATCH cap on concepts per request.
 */

export const conceptTipsRoute = new Hono();

conceptTipsRoute.use("*", githubAuth());

// ===== Constants =====

/** Bump this integer to invalidate every cached tip without deleting rows.
 *  Old rows stay resident (cheap) but become invisible to lookups because
 *  the SELECT filters on prompt_version. */
const PROMPT_VERSION = 1;

/** Cap concepts per request. Keeps the LLM call bounded in tokens + cost
 *  and prevents an extension bug or malicious caller from forcing a giant
 *  batch through. The detector typically yields 3–10 concepts per file. */
const MAX_BATCH = 8;

/** Concept-name allowlist. Identifier-ish strings only: must start with a
 *  letter, can contain letters/digits/space/dot/underscore/dash. Newlines
 *  and control chars cannot pass — that closes the prompt-injection vector
 *  where a name like "useState\nIgnore previous instructions" could smuggle
 *  text into the LLM message. */
const CONCEPT_PATTERN = /^[A-Za-z][A-Za-z0-9 _.\-]{0,63}$/;
const MAX_CONCEPT_LEN = 64;

/** Languages the cache will serve. sanitizeLanguage already rejects
 *  malformed labels; this allowlist further narrows to languages we
 *  actually have detector coverage for. Adding a language here without
 *  detector support is harmless but wastes LLM calls. */
const ALLOWED_LANGUAGES = new Set<string>([
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
  "cpp",
  "ruby",
  "php",
]);

// ===== Per-user rate limit =====
// Same in-memory bucket pattern as routes/echo.ts. Not shared across
// processes — sufficient for the single-instance backend; revisit when
// we move to multi-replica.

const RATE_WINDOW_MS = 60_000;
const MAX_POSTS_PER_WINDOW = 30;
const rateBuckets = new Map<string, number[]>();

function checkTipsRateLimit(bucket: string): boolean {
  const now = Date.now();
  const arr = rateBuckets.get(bucket) ?? [];
  const pruned = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (pruned.length >= MAX_POSTS_PER_WINDOW) {
    rateBuckets.set(bucket, pruned);
    return false;
  }
  pruned.push(now);
  rateBuckets.set(bucket, pruned);
  return true;
}

// ===== Validation =====

interface BatchBody {
  language?: unknown;
  concepts?: unknown;
}

function sanitizeConcepts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CONCEPT_LEN) continue;
    if (!CONCEPT_PATTERN.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_BATCH) break;
  }
  return out;
}

// ===== Route =====

conceptTipsRoute.post("/batch", async (c) => {
  // Auth gate: throws 401/403 if anything is wrong with the verified
  // identity. The verified userId is used purely as a rate-limit bucket;
  // it is never written to the table.
  const userId = resolveUserId(c, undefined);

  if (!checkTipsRateLimit(`tips:${userId}`)) {
    return c.json({ error: "rate limited" }, 429);
  }

  let body: BatchBody | null;
  try {
    body = (await c.req.json()) as BatchBody;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }

  const language = sanitizeLanguage(body.language);
  if (!language || !ALLOWED_LANGUAGES.has(language)) {
    return c.json({ error: "unsupported language" }, 400);
  }

  const concepts = sanitizeConcepts(body.concepts);
  if (concepts.length === 0) {
    return c.json({ tips: {}, promptVersion: PROMPT_VERSION });
  }

  // L2 read.
  const cached = await getConceptTips(language, concepts, PROMPT_VERSION);

  const misses = concepts.filter((name) => !(name in cached));
  let fresh: Record<string, string> = {};

  if (misses.length > 0) {
    try {
      const generated = await generateConceptTipsBatch(language, misses);
      // Best-effort write — failures are logged and ignored. The lookup
      // path will retry next time.
      await putConceptTips(language, PROMPT_VERSION, generated);
      for (const [concept, row] of Object.entries(generated)) {
        fresh[concept] = row.tip;
      }
    } catch (err) {
      console.warn(
        "[protege] /concept-tips generation failed:",
        err instanceof Error ? err.message : String(err)
      );
      // Swallow: caller already handles missing keys silently.
    }
  }

  console.log(
    `[protege] /concept-tips lang=${language} hits=${
      Object.keys(cached).length
    } misses=${misses.length} fresh=${Object.keys(fresh).length}`
  );

  return c.json({
    tips: { ...cached, ...fresh },
    promptVersion: PROMPT_VERSION,
  });
});
