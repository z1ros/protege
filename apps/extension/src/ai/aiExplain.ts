import * as vscode from "vscode";
import { aiQuery } from "./aiBackend.js";
import { tryTemplate } from "./errorTemplates.js";
import { fetchConceptTips } from "../user/protegeClient.js";

/**
 * AI-powered explanations — replaces all local regex "intelligence."
 *
 * Every explanation, teaching card, and tip goes through the cloud AI
 * provider configured server-side.
 *
 * In-memory FIFO cache so the same error/concept doesn't hit the model
 * twice within a session. The tip slice (key prefix `tip:`) additionally
 * mirrors to globalState so it survives extension reloads, and is served
 * by the shared backend table — every user gets the same tip text and
 * the LLM call happens once per (language, concept) across the user
 * base, not once per machine.
 */

const cache = new Map<string, string>();
const MAX_CACHE = 200;
const TIP_PERSIST_KEY = "protege.tipCache";

let persistenceCtx: vscode.ExtensionContext | null = null;

function cached(key: string): string | null {
  return cache.get(key) ?? null;
}

function store(key: string, value: string): void {
  if (cache.size >= MAX_CACHE) {
    // Evict oldest entry
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, value);
  if (persistenceCtx && key.startsWith("tip:")) {
    void flushTipCache();
  }
}

async function flushTipCache(): Promise<void> {
  if (!persistenceCtx) return;
  const tipEntries = Array.from(cache.entries()).filter(([k]) =>
    k.startsWith("tip:")
  );
  await persistenceCtx.globalState.update(TIP_PERSIST_KEY, tipEntries);
}

/**
 * Wire the tip slice of the cache to globalState so a fresh session
 * starts warm. Call once on activate; idempotent thereafter. Only
 * `tip:` keys are persisted — error explanations and teaching cards
 * stay session-scoped.
 */
export function setTipCachePersistence(
  context: vscode.ExtensionContext
): void {
  if (persistenceCtx) return;
  persistenceCtx = context;

  const stored =
    context.globalState.get<[string, string][]>(TIP_PERSIST_KEY) ?? [];
  for (const [k, v] of stored) {
    if (typeof k === "string" && typeof v === "string" && k.startsWith("tip:")) {
      cache.set(k, v);
    }
  }

  context.subscriptions.push(
    new vscode.Disposable(() => {
      void flushTipCache();
      persistenceCtx = null;
    })
  );
}

/**
 * Explain a diagnostic error in plain English.
 *
 * Routing, in priority order:
 *   1. In-memory L0 cache (instant on repeat).
 *   2. Regex template table for the ~50 most common TS / ESLint /
 *      pyright / JS messages — covers ~85% of real diagnostics with
 *      zero LLM cost. See `errorTemplates.ts`.
 *   3. LLM via aiQuery. `kind: "scan"` so it routes through the
 *      auto-fire budget gate; tier defaults to "cheap" → gpt-4.1-mini
 *      / Haiku.
 *   4. Fallback to a mechanical message simplification on null reply.
 */
export async function aiExplainError(
  errorMessage: string,
  language: string
): Promise<string> {
  const key = `err:${language}:${errorMessage}`;
  const hit = cached(key);
  if (hit) return hit;

  const templated = tryTemplate(errorMessage, language);
  if (templated) {
    store(key, templated);
    return templated;
  }

  const result = await aiQuery(
    `You are a coding mentor. Explain this ${language} error in ONE short sentence (max 15 words). Be practical — what's wrong and how to fix it.\n\nError: ${errorMessage}`,
    64,
    { kind: "scan" }
  );

  const explanation = result?.trim() || simplifyMessage(errorMessage);
  store(key, explanation);
  return explanation;
}

/**
 * Generate a teaching card for a concept/symbol.
 * Returns structured JSON for the peek teaching view.
 */
export async function aiTeachConcept(
  concept: string,
  language: string,
  codeContext?: string
): Promise<{
  title: string;
  explanation: string;
  examples: { label: string; code: string; lang: string }[];
  mistakes: string[];
  related: string[];
  tip?: string;
} | null> {
  const contextBlock = codeContext
    ? `\nThe user's code:\n\`\`\`${language}\n${codeContext}\n\`\`\`\n`
    : "";

  const result = await aiQuery(
    `You are a coding mentor. Teach "${concept}" in ${language}.${contextBlock}
Reply in JSON (no markdown fencing):
{"title":"name","explanation":"2-3 sentences","examples":[{"label":"name","code":"code","lang":"${language}"}],"mistakes":["mistake1"],"related":["concept1"],"tip":"tip"}`,
    512,
    { kind: "teach" }
  );

  if (!result) return null;

  try {
    const cleaned = result.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      title: concept,
      explanation: result.slice(0, 500),
      examples: [],
      mistakes: [],
      related: [],
    };
  }
}

/**
 * Generate a contextual "Did You Know?" tip for a concept that appears
 * in the user's current code.
 *
 * Implementation:
 *   1. L0 cache (in-memory + globalState mirror via setTipCachePersistence).
 *   2. On miss, the backend `/concept-tips/batch` endpoint serves a
 *      generalized cached tip from Supabase, generating once per
 *      (language, concept) across the entire user base.
 *
 * The `codeSnippet` arg is intentionally ignored — the tip is now
 * generalized so that the cache key is independent of the user's
 * specific code. Kept in the signature so call sites do not change.
 */
export async function aiGenerateTip(
  concept: string,
  _codeSnippet: string,
  language: string
): Promise<string | null> {
  const key = `tip:${language}:${concept}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const tips = await fetchConceptTips(language, [concept]);
    const tip = tips[concept];
    if (typeof tip !== "string" || tip.length === 0) return null;
    store(key, tip);
    return tip;
  } catch (err) {
    // Silent fail — the call site (didYouKnow.ts) already treats null
    // as "skip this tip" with no UI surface.
    console.warn(
      "[protege] aiGenerateTip backend failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Generate a quiz question about a concept.
 */
export async function aiGenerateQuiz(
  concept: string,
  language: string
): Promise<{
  question: string;
  correct: string;
  wrong: string[];
} | null> {
  const result = await aiQuery(
    `Create ONE multiple-choice question about "${concept}" in ${language}. Test a real gotcha, not trivia.
Reply in JSON (no fencing):
{"question":"What happens when...?","correct":"the right answer","wrong":["wrong1","wrong2"]}`,
    256,
    { kind: "teach" }
  );

  if (!result) return null;
  try {
    const cleaned = result.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Fallback: strip jargon from error messages when AI is unavailable */
function simplifyMessage(msg: string): string {
  let s = msg.length > 100 ? msg.slice(0, 97) + "..." : msg;
  s = s.replace(/^TS\d+:\s*/, "");
  s = s.replace(/\s*\([\w-]+\)\s*$/, "");
  if (s.length > 0 && s[0] === s[0].toUpperCase()) {
    s = s[0].toLowerCase() + s.slice(1);
  }
  return s;
}
