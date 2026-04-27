import { Hono } from "hono";
import type { AnalyzeRequest, AnalyzeResponse, Finding } from "@protege/types";
import { callOneShot } from "../llm.js";
import { githubAuth } from "../middleware/auth.js";

export const analyzeRoute = new Hono();

analyzeRoute.use("*", githubAuth());

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

  const content = body.file?.content ?? "";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return c.json(
      { error: `file content exceeds ${MAX_CONTENT_BYTES} bytes` },
      413
    );
  }

  const { text } = await callOneShot({
    systemText: ANALYZE_PROMPT,
    userText: `File: ${body.file.path} (${body.file.language})\n\n${body.file.content}`,
    maxTokens: 1024,
  });

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
