import type { TaskShape, ShapeContext, ClassifyResponse } from "@protege/types";
import { BACKEND_URL } from "../user/protegeClient.js";
import { authHeaders } from "../user/auth.js";

/**
 * LLM-tier classifier — invoked when regex tier returns null or low
 * confidence. POSTs to backend /classify (Haiku). See plans/task-shaping.md §2.4.
 *
 * Timeout: 2s. On timeout / non-2xx / bad JSON we return null and the
 * caller falls back to whatever the regex tier gave it (even if low-conf).
 * This keeps the main chat path responsive when Haiku is slow or down.
 *
 * Exactly one retry on network failure. No retry on 4xx/5xx — the backend
 * is telling us something and we shouldn't hammer it.
 */

const REQUEST_TIMEOUT_MS = 2000;

async function callOnce(
  message: string,
  context: ShapeContext,
  signal: AbortSignal
): Promise<TaskShape | null> {
  const res = await fetch(`${BACKEND_URL}/classify`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: JSON.stringify({ message, context }),
    signal,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as ClassifyResponse;
  if ("error" in data) return null;
  return data.shape;
}

export async function classifyWithLlm(
  message: string,
  context: ShapeContext
): Promise<TaskShape | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const shape = await callOnce(message, context, controller.signal);
      clearTimeout(timer);
      return shape;
    } catch (err) {
      clearTimeout(timer);
      // Retry once on network errors (AbortError or fetch reject). Don't
      // retry on 4xx/5xx — callOnce already swallowed those to null.
      const isAbort =
        err instanceof Error && err.name === "AbortError";
      const isNetwork =
        err instanceof TypeError || isAbort;
      if (!isNetwork || attempt === 1) return null;
    }
  }
  return null;
}
