import { Hono } from "hono";
import * as crypto from "node:crypto";
import type {
  WalkRequest,
  WalkResponse,
  WalkStep,
  WalkQuotaError,
} from "@protege/types";
import { callOneShot } from "../llm.js";
import { githubAuth, resolveUserId } from "../middleware/auth.js";

export const walkRoute = new Hono();

walkRoute.use("*", githubAuth());

const MAX_CONTENT_BYTES = 50_000;
const MAX_IMPORTS = 5;
const MAX_IMPORT_BYTES_TOTAL = 8_000;
const MAX_STEPS = 30;
const DAILY_LIMIT = 5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** In-memory cache, keyed by fileHash. Survives the process lifetime —
 *  good enough for MVP; promote to Supabase later if hit-rate proves it. */
const stepCache = new Map<string, WalkStep[]>();

interface DailyCounter {
  windowStart: number;
  count: number;
}
const dailyByUser = new Map<string, DailyCounter>();

function bumpDaily(userId: string): { used: number; limit: number; resetAt: number; ok: boolean } {
  const now = Date.now();
  const existing = dailyByUser.get(userId);
  if (!existing || now - existing.windowStart >= ONE_DAY_MS) {
    dailyByUser.set(userId, { windowStart: now, count: 1 });
    return { used: 1, limit: DAILY_LIMIT, resetAt: now + ONE_DAY_MS, ok: true };
  }
  if (existing.count >= DAILY_LIMIT) {
    return {
      used: existing.count,
      limit: DAILY_LIMIT,
      resetAt: existing.windowStart + ONE_DAY_MS,
      ok: false,
    };
  }
  existing.count += 1;
  return {
    used: existing.count,
    limit: DAILY_LIMIT,
    resetAt: existing.windowStart + ONE_DAY_MS,
    ok: true,
  };
}

const WALK_PROMPT = `You are Protege — an AI coding mentor. The user has asked you to walk them through a single file in their codebase, line by line, in execution order.

## Goal
Produce an ordered sequence of steps so the learner can follow the file from "first thing that runs" to "last thing that runs." Each step covers a coherent line or run of lines and is explained in plain language.

## Ordering
1. Top-level imports and side-effect statements, in lexical order.
2. Then exported / entry-point functions or default exports — these run when something imports this module.
3. Then supporting (non-exported) functions in declaration order.
4. Skip pure type declarations unless they shape behavior the learner needs.

## What each step must contain
- index: 0-based step number (must match position in array)
- lineStart, lineEnd: 1-indexed INCLUSIVE line range from the file. lineEnd >= lineStart. Stay within the file. NEVER anchor a step on a blank line, a trailing newline, or whitespace-only rows — pick the actual code line you mean.
- title: ≤ 60 chars, names the step ("Imports React + state hook")
- body: 2–4 sentences in plain English. Explain what runs, why it matters, and how it ties to the rest of the file. Use the import excerpts and repo summary to ground the explanation in context. NO code blocks; reference identifiers inline.
- concepts: array of canonical concept names referenced in this step (e.g. "React useState", "async/await", "Promise"). 0–4 entries. Use the user's mental-model names — short and standard.

## Step count
Aim for as many steps as the file genuinely needs in execution order — typically 5–15 for a small file, up to ${MAX_STEPS} for a large one. NEVER exceed ${MAX_STEPS}. Don't pad; don't skip the meaningful pieces.

## Output
JSON only. Exact shape:
{ "steps": [ { "index": number, "lineStart": number, "lineEnd": number, "title": string, "body": string, "concepts": string[] } ] }
No prose outside the JSON.`;

function clampSteps(steps: WalkStep[], lines: string[]): WalkStep[] {
  const maxLine = lines.length;
  const cleaned: WalkStep[] = [];
  for (let i = 0; i < steps.length && cleaned.length < MAX_STEPS; i++) {
    const s = steps[i];
    if (
      typeof s?.lineStart !== "number" ||
      typeof s?.lineEnd !== "number" ||
      typeof s?.title !== "string" ||
      typeof s?.body !== "string"
    ) {
      continue;
    }
    let lineStart = Math.max(1, Math.min(maxLine, Math.floor(s.lineStart)));
    let lineEnd = Math.max(lineStart, Math.min(maxLine, Math.floor(s.lineEnd)));
    // Snap empty-line anchors to the nearest non-blank content. The LLM
    // occasionally targets a trailing newline or a gap between blocks; the
    // walk then highlights and explains a blank row, which looks broken.
    const snapped = snapToNonBlank(lineStart, lineEnd, lines);
    lineStart = snapped.lineStart;
    lineEnd = snapped.lineEnd;
    cleaned.push({
      index: cleaned.length,
      lineStart,
      lineEnd,
      title: s.title.slice(0, 100),
      body: s.body.slice(0, 1200),
      concepts: Array.isArray(s.concepts)
        ? s.concepts
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim())
            .slice(0, 6)
        : [],
    });
  }
  return cleaned;
}

function snapToNonBlank(
  start: number,
  end: number,
  lines: string[]
): { lineStart: number; lineEnd: number } {
  const isBlank = (i: number) =>
    i < 1 || i > lines.length || lines[i - 1].trim() === "";

  let allBlank = true;
  for (let i = start; i <= end; i++) {
    if (!isBlank(i)) {
      allBlank = false;
      break;
    }
  }
  if (!allBlank) return { lineStart: start, lineEnd: end };

  let forward = -1;
  for (let i = end + 1; i <= lines.length; i++) {
    if (!isBlank(i)) {
      forward = i;
      break;
    }
  }
  let backward = -1;
  for (let i = start - 1; i >= 1; i--) {
    if (!isBlank(i)) {
      backward = i;
      break;
    }
  }

  const forwardDist = forward === -1 ? Infinity : forward - end;
  const backwardDist = backward === -1 ? Infinity : start - backward;
  if (forwardDist === Infinity && backwardDist === Infinity) {
    return { lineStart: start, lineEnd: end };
  }
  if (forwardDist <= backwardDist) {
    return { lineStart: forward, lineEnd: forward };
  }
  return { lineStart: backward, lineEnd: backward };
}

function buildUserText(body: WalkRequest): string {
  const parts: string[] = [];
  parts.push(`File: ${body.file.path} (${body.file.language})`);
  if (body.repoSummary) {
    const r = body.repoSummary;
    parts.push(
      `Repo context: ${r.fileCount} files, languages=${r.primaryLanguages.join(",") || "unknown"}, top concepts=${r.topConcepts.slice(0, 8).join(", ") || "n/a"}.`
    );
  }
  if (body.imports && body.imports.length > 0) {
    let used = 0;
    parts.push("Imported file excerpts (for context, not for stepping):");
    for (const imp of body.imports.slice(0, MAX_IMPORTS)) {
      if (used >= MAX_IMPORT_BYTES_TOTAL) break;
      const remaining = MAX_IMPORT_BYTES_TOTAL - used;
      const excerpt = imp.excerpt.slice(0, remaining);
      used += Buffer.byteLength(excerpt, "utf8");
      parts.push(`--- ${imp.path} ---\n${excerpt}`);
    }
  }
  parts.push("--- FILE TO WALK ---");
  parts.push(body.file.content);
  return parts.join("\n\n");
}

walkRoute.post("/", async (c) => {
  const body = (await c.req.json()) as WalkRequest;

  const userId = resolveUserId(c, body.userId);

  if (!body.file?.content || typeof body.file.content !== "string") {
    return c.json({ error: "file.content is required" }, 400);
  }
  if (Buffer.byteLength(body.file.content, "utf8") > MAX_CONTENT_BYTES) {
    return c.json(
      { error: `file content exceeds ${MAX_CONTENT_BYTES} bytes` },
      413
    );
  }

  // Cache key MUST be derived from the actual content. Trusting a
  // client-supplied hash would let one user seed the global cache under
  // any key they choose — and `step.body` ends up rendered as markdown in
  // every other user's editor, so a poisoned entry could ship arbitrary
  // command-links to a victim who walks the file the attacker targeted.
  const fileHash = crypto
    .createHash("sha256")
    .update(body.file.content)
    .digest("hex");

  const cached = stepCache.get(fileHash);
  if (cached) {
    return c.json<WalkResponse>({
      fileHash,
      steps: cached,
      cached: true,
    });
  }

  // Only count quota on cache miss — repeats are free.
  const quota = bumpDaily(userId);
  if (!quota.ok) {
    const err: WalkQuotaError = {
      error: "daily quota exceeded",
      used: quota.used,
      limit: quota.limit,
      resetAt: quota.resetAt,
    };
    return c.json(err, 429);
  }

  const lines = body.file.content.split("\n");

  const refundQuota = () => {
    const counter = dailyByUser.get(userId);
    if (counter && counter.count > 0) counter.count -= 1;
  };

  let text: string;
  try {
    const res = await callOneShot({
      systemText: WALK_PROMPT,
      userText: buildUserText(body),
      maxTokens: 3000,
    });
    text = res.text;
  } catch (err) {
    refundQuota();
    throw err;
  }

  let steps: WalkStep[] = [];
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { steps?: WalkStep[] };
      steps = clampSteps(parsed.steps ?? [], lines);
    }
  } catch {
    steps = [];
  }

  if (steps.length === 0) {
    refundQuota();
    return c.json({ error: "failed to generate walk steps" }, 502);
  }

  stepCache.set(fileHash, steps);

  return c.json<WalkResponse>({
    fileHash,
    steps,
    cached: false,
  });
});
