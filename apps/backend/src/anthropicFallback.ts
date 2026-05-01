/**
 * Anthropic SDK init — FALLBACK PROVIDER ONLY.
 *
 * The active production provider is OpenAI (GPT-5). See `AI_PROVIDER`
 * env var (default `openai`) and `getProvider()` in llm.ts. This file
 * exists so callChat() in llm.ts can route to Anthropic when explicitly
 * requested via `AI_PROVIDER=anthropic` — it is NOT the default path.
 *
 * Renamed from `anthropic.ts` 2026-05-01 because the original name
 * implied Anthropic was the primary provider, which it is not.
 *
 * Tool definitions + the system prompt have moved to `aiTools.ts`
 * (provider-neutral). This file is now a single-purpose SDK shim.
 */

import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

/** Fallback model when AI_PROVIDER=anthropic. Override via env. */
export const FALLBACK_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
