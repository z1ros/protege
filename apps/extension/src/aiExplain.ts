import { aiQuery } from "./aiBackend.js";

/**
 * AI-powered explanations — replaces all local regex "intelligence."
 *
 * Every explanation, teaching card, and tip now goes through real AI
 * (on-device Qwen or cloud Haiku/Sonnet depending on user's choice).
 *
 * Uses an in-memory LRU cache so the same error/concept doesn't hit
 * the model twice. Cache is per-session (cleared on reload).
 */

const cache = new Map<string, string>();
const MAX_CACHE = 200;

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
}

/**
 * Explain a diagnostic error in plain English.
 * Cached per error message so repeated errors are instant.
 */
export async function aiExplainError(
  errorMessage: string,
  language: string
): Promise<string> {
  const key = `err:${language}:${errorMessage}`;
  const hit = cached(key);
  if (hit) return hit;

  const result = await aiQuery(
    `You are a coding mentor. Explain this ${language} error in ONE short sentence (max 15 words). Be practical — what's wrong and how to fix it.\n\nError: ${errorMessage}`,
    64
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
    512
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
 * Generate a contextual "Did You Know?" tip for a concept
 * that appears in the user's current code.
 */
export async function aiGenerateTip(
  concept: string,
  codeSnippet: string,
  language: string
): Promise<string | null> {
  const key = `tip:${language}:${concept}`;
  const hit = cached(key);
  if (hit) return hit;

  const result = await aiQuery(
    `You are a coding mentor. The user just wrote ${language} code using "${concept}". Give ONE practical "did you know?" tip about "${concept}" that most developers don't know. Max 2 sentences. Be surprising and useful.\n\nTheir code:\n\`\`\`${language}\n${codeSnippet.slice(0, 300)}\n\`\`\``,
    128
  );

  if (!result) return null;
  store(key, result.trim());
  return result.trim();
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
    256
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
