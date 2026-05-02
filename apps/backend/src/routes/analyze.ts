import { Hono } from "hono";
import type { AnalyzeRequest, AnalyzeResponse, Finding } from "@protege/types";
import { callOneShot } from "../llm.js";
import { githubAuth, resolveUserId, getAuthenticatedUserId } from "../middleware/auth.js";
import { addCostUsd, estimateCallCostUsd, checkTokenLimit } from "../quotas.js";

export const analyzeRoute = new Hono();

analyzeRoute.use("*", githubAuth());
// Daily token cap. /analyze fires on every save (1.5s-debounced) and
// ships full file content to the LLM — same gate as /chat (one budget,
// one number, no per-route ceilings). Replaces the old $-cap check.
analyzeRoute.use("*", async (c, next) => {
  const userId = getAuthenticatedUserId(c);
  if (userId) {
    const tokenGate = await checkTokenLimit(userId);
    if (!tokenGate.allowed) {
      return c.json(
        {
          error: "daily quota exceeded",
          kind: tokenGate.kind,
          reason: tokenGate.reason,
          used: tokenGate.used,
          limit: tokenGate.limit,
          resetAt: tokenGate.resetAt,
        },
        429
      );
    }
  }
  return next();
});

const MAX_CONTENT_BYTES = 200_000;

const ANALYZE_PROMPT = `You are Protege — an AI coding mentor reviewing a file the user just saved. Your goal is NOT to list every issue. Your goal is to find at most 3 findings that will TEACH the user something meaningful.

## What to surface
- Real bugs (race conditions, null deref, missing await, unhandled rejection, leaked resources)
- Security issues (injection, secrets in code, unsafe eval, weak crypto)
- Performance traps (N+1, unnecessary re-renders, O(n²) on hot paths, sync blocking)
- Teaching moments — "tip" findings that reveal a better mental model or a standard library shortcut the user clearly didn't know

## What to SKIP
- Style nits, formatting, naming preferences
- Beginner lessons that are obvious from context (don't teach \`let\` vs \`const\` to someone writing React hooks)
- Speculation — if you're not sure it's wrong, don't flag it
- Duplicate issues (pick the best instance)

## How to phrase findings
- **title**: ≤ 60 chars, name the problem not the symptom ("Missing await on async call" not "Code broken")
- **explanation**: 1-2 sentences that teach the WHY. When possible, phrase as a probing question the user can reason about: "What happens if \`res.json()\` throws here? Nothing catches it." — this is better than "You should add a try/catch."
- **line**: 1-indexed, the most relevant single line
- **type**: bug | security | performance | tip

If the file is clean, return { "findings": [] }. Never invent issues to fill a quota — honesty builds trust.

## Output
JSON only. Exact shape:
{ "findings": [ { "type": "bug"|"security"|"performance"|"tip", "line": number, "title": string, "explanation": string } ] }`;

analyzeRoute.post("/", async (c) => {
  const body = (await c.req.json()) as AnalyzeRequest;
  const userId = resolveUserId(c, body.userId);

  const content = body.file?.content ?? "";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return c.json(
      { error: `file content exceeds ${MAX_CONTENT_BYTES} bytes` },
      413
    );
  }

  // Pin to cheap-tier. callOneShot honors `cheap: true` by routing to
  // OpenAI gpt-5-nano (when OPENAI_API_KEY is set) regardless of the
  // env-wide AI_PROVIDER, so the actual model billed matches the
  // cheap-tier addCostUsd label below.
  const { text, usage } = await callOneShot({
    systemText: ANALYZE_PROMPT,
    userText: `File: ${body.file.path} (${body.file.language})\n\n${body.file.content}`,
    maxTokens: 1024,
    cheap: true,
  });

  // Bump the daily $ rollup so the cost-cap middleware on the next call
  // sees this scan's spend. Fire-and-forget — the response shouldn't
  // block on the rollup write. Without this bump, enforceCostCapOnly
  // never trips on /analyze traffic alone.
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    // Tokens ride in the same UPSERT — see addCostUsd. Migration 005
    // added prompt_tokens / completion_tokens / total_tokens columns.
    void addCostUsd(
      userId,
      estimateCallCostUsd("cheap", usage.inputTokens, usage.outputTokens),
      { prompt: usage.inputTokens, completion: usage.outputTokens }
    );
  }

  let findings: Finding[] = [];
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { findings?: Finding[] };
      findings = parsed.findings ?? [];
    }
  } catch {
    findings = [];
  }

  return c.json<AnalyzeResponse>({ findings });
});
