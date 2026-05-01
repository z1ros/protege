import { Hono } from "hono";
import { createHash } from "node:crypto";
import type {
  ClassifyRequest,
  ClassifyResponse,
  TaskShape,
  TaskShapeKind,
  TaskComplexity,
} from "@protege/types";
import { callOneShot } from "../llm.js";
import { githubAuth } from "../middleware/auth.js";
import { quotaMiddleware } from "../middleware/quota.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
} from "../prompts/classifier.js";

/**
 * POST /classify — task-shape classifier (plans/task-shaping.md §2).
 *
 * Called by the extension BEFORE a chat turn when the regex tier is
 * ambiguous (confidence < 0.7 or no pattern matched). Returns a
 * TaskShape used to decide whether to offer the fork chip, which
 * mode to route to, and (Phase 2) how many steps to seed a roadmap with.
 *
 * Caching: keyed on sha256(message + activeFilePath + activeFileLanguage),
 * TTL 10 min. Typical dogfooding re-asks the same prompt several times
 * while iterating — cache keeps that free.
 *
 * Strict JSON parsing: if Haiku returns anything other than a valid
 * shape-shaped object, we return { error } and the extension falls back
 * to its regex-tier result.
 */

export const classifyRoute = new Hono();

classifyRoute.use("*", githubAuth());
classifyRoute.use("*", quotaMiddleware("classify"));

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { shape: TaskShape; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(body: ClassifyRequest): string {
  const h = createHash("sha256");
  h.update(body.message);
  h.update("|");
  h.update(body.context.activeFilePath ?? "");
  h.update("|");
  h.update(body.context.activeFileLanguage ?? "");
  return h.digest("hex");
}

function cacheGet(key: string): TaskShape | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.shape;
}

function cachePut(key: string, shape: TaskShape): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop oldest entry — Map iteration is insertion order, so the first
    // key() is the oldest insertion. Good enough for this scale.
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { shape, expiresAt: Date.now() + CACHE_TTL_MS });
}

const VALID_SHAPES: TaskShapeKind[] = [
  "qna",
  "build",
  "teach",
  "debug",
  "refactor",
  "chat",
];
const VALID_COMPLEXITY: TaskComplexity[] = [
  "trivial",
  "single-step",
  "multi-step",
];
const VALID_MODES = ["text", "voice-dialogue", "learning"] as const;

/**
 * Strict-parse a classifier JSON reply into a TaskShape. Returns null
 * on any schema violation. We accept reasonable leading/trailing
 * whitespace and tolerant but fail closed on missing / wrong-typed fields.
 */
function parseClassifierReply(raw: string): TaskShape | null {
  let text = raw.trim();
  // Strip accidental markdown fencing: ```json ... ```.
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
  if (typeof p.shape !== "string" || !VALID_SHAPES.includes(p.shape as TaskShapeKind))
    return null;
  if (
    typeof p.complexity !== "string" ||
    !VALID_COMPLEXITY.includes(p.complexity as TaskComplexity)
  )
    return null;
  if (typeof p.mode !== "string" || !VALID_MODES.includes(p.mode as (typeof VALID_MODES)[number]))
    return null;
  if (typeof p.confidence !== "number" || p.confidence < 0 || p.confidence > 1)
    return null;
  const why = typeof p.why === "string" ? p.why : "";
  const needsRoadmap = p.complexity === "multi-step";
  let roadmapSeeds: string[] | undefined;
  if (needsRoadmap && Array.isArray(p.roadmapSeeds)) {
    roadmapSeeds = p.roadmapSeeds
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 80)
      .slice(0, 5);
    if (roadmapSeeds.length < 2) roadmapSeeds = undefined;
  }
  return {
    shape: p.shape as TaskShapeKind,
    complexity: p.complexity as TaskComplexity,
    mode: p.mode as TaskShape["mode"],
    needsRoadmap,
    roadmapSeeds,
    confidence: p.confidence,
    signals: { tier: "llm", why: why.slice(0, 140) },
  };
}

classifyRoute.post("/", async (c) => {
  const body = (await c.req.json()) as ClassifyRequest;
  if (!body || typeof body.message !== "string" || body.message.trim().length === 0) {
    return c.json<ClassifyResponse>({ error: "message is required" }, 400);
  }

  const key = cacheKey(body);
  const hit = cacheGet(key);
  if (hit) {
    return c.json<ClassifyResponse>({
      shape: { ...hit, signals: { tier: "cache", why: hit.signals.why } },
    });
  }

  const diagErrors = body.context.diagnosticsOnActiveFile.filter(
    (d) => d.severity === "error"
  ).length;
  const diagWarns = body.context.diagnosticsOnActiveFile.filter(
    (d) => d.severity === "warning"
  ).length;

  const userPrompt = buildClassifierUserPrompt(body.message, {
    activeFilePath: body.context.activeFilePath,
    activeFileLanguage: body.context.activeFileLanguage,
    currentMode: body.context.currentMode,
    wakeActive: body.context.wakeActive,
    diagnosticsCount: { errors: diagErrors, warnings: diagWarns },
    recentTurns: body.context.recentMessages,
  });

  try {
    const { text } = await callOneShot({
      systemText: CLASSIFIER_SYSTEM_PROMPT,
      userText: userPrompt,
      maxTokens: 300,
      cacheSystem: false,
    });
    const shape = parseClassifierReply(text);
    if (!shape) {
      console.warn(
        `[protege] /classify parse failed: ${text.slice(0, 200)}`
      );
      return c.json<ClassifyResponse>(
        { error: "classifier produced invalid JSON" },
        502
      );
    }
    cachePut(key, shape);
    console.log(
      `[protege] /classify shape=${shape.shape}/${shape.complexity} mode=${shape.mode} conf=${shape.confidence.toFixed(2)}`
    );
    return c.json<ClassifyResponse>({ shape });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[protege] /classify failed: ${msg}`);
    return c.json<ClassifyResponse>({ error: msg }, 500);
  }
});
