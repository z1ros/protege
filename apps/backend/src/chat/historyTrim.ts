import type { OAITurn } from "@protege/types";
import { callChat, type ProviderId } from "../llm.js";

/**
 * Conversation-history trim + summarize.
 *
 * Why: every `/chat` POST sends the full message history. Multi-tool
 * turns and long sessions cause the input-token bill to grow O(n²) in
 * the number of rounds — a 30-message session pays for ~30 messages on
 * round 1, plus the tool result, plus another full re-send on round 2,
 * and so on. The dominant cost driver in long chats.
 *
 * Strategy:
 *   - Below TRIM_THRESHOLD turns: pass through unchanged.
 *   - Above TRIM_THRESHOLD: keep system messages + the last KEEP_RECENT
 *     non-system turns. Walk forward in the tail to ensure it starts
 *     with a `user` role so we don't orphan a tool_use/tool_result pair.
 *   - Above SUMMARIZE_THRESHOLD: also LLM-summarize the dropped chunk
 *     and surface it as a synthetic system note so the model still has
 *     coarse context for what happened earlier. Cached in-process so
 *     the same dropped chunk doesn't get re-summarized on every round.
 *
 * Quality impact: ~zero on typical chats. The recent KEEP_RECENT turns
 * carry the active context the model is reasoning about; the summary
 * preserves coarse history for cases where the user references
 * something from earlier ("remember that bug we fixed yesterday?").
 *
 * Cost impact: ~30-50% on conversations longer than KEEP_RECENT turns.
 * Larger as conversations grow.
 */

// Tuned for typical chat sessions. KEEP_RECENT must comfortably hold a
// full multi-tool turn (user msg + 3-4 assistant/tool round-trips) so
// trimming never severs the in-progress turn.
const TRIM_THRESHOLD = 20;
const KEEP_RECENT = 14;
const SUMMARIZE_THRESHOLD = 26;

// Process-lifetime cache for generated summaries. Keyed by a content
// hash of the dropped messages so identical histories reuse the same
// summary without re-paying for the LLM call. LRU-ish eviction at
// MAX_CACHE_SIZE — first-inserted entries get evicted when full.
const summaryCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

function hashOAITurns(msgs: OAITurn[]): string {
  // 32-bit string hash (djb2-ish). Doesn't need crypto strength —
  // we just need different message sequences to land on different keys.
  let h = 0;
  for (const m of msgs) {
    const c = m.content ?? "";
    const s = `${m.role}|${c}|${m.tool_call_id ?? ""}|${(m.tool_calls ?? []).map((t) => t.id).join(",")}`;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
  }
  return String(h);
}

export interface TrimResult {
  messages: OAITurn[];
  /** Synthetic system-prompt addendum carrying a summary of dropped
   *  turns. Append to systemDynamic in the chat route. Undefined when
   *  no summary was generated (below threshold or summary call failed). */
  summaryNote?: string;
  trimmed: boolean;
  droppedCount: number;
  summarized: boolean;
}

export interface TrimOptions {
  provider: ProviderId;
  userId: string | undefined;
  openaiModel: string | undefined;
  anthropicModel: string;
}

export async function trimAndSummarize(
  messages: OAITurn[],
  opts: TrimOptions
): Promise<TrimResult> {
  if (messages.length <= TRIM_THRESHOLD) {
    return { messages, trimmed: false, droppedCount: 0, summarized: false };
  }

  // Always preserve system messages — small (one or two short blocks
  // typically) and structurally important. They don't bloat history and
  // dropping them risks losing the persona/mode framing.
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  // Slice to last KEEP_RECENT turns, then walk forward dropping any
  // leading non-user fragments. Tool results have a `tool_call_id`
  // pointing back at an assistant `tool_use`; if we keep the result
  // without the use, the API rejects the request. Walking forward to
  // the next user message is the simplest way to guarantee a clean
  // window edge.
  let tail = nonSystem.slice(-KEEP_RECENT);
  while (tail.length > 0 && tail[0].role !== "user") {
    tail.shift();
  }

  const droppedCount = nonSystem.length - tail.length;
  if (droppedCount === 0) {
    return { messages, trimmed: false, droppedCount: 0, summarized: false };
  }

  const trimmedMessages = [...systemMessages, ...tail];
  const dropped = nonSystem.slice(0, droppedCount);

  // Below the summarize threshold: just trim. Saves the cost of the
  // summary LLM call on medium-length sessions where dropping context
  // is unlikely to bite.
  if (messages.length < SUMMARIZE_THRESHOLD) {
    return {
      messages: trimmedMessages,
      trimmed: true,
      droppedCount,
      summarized: false,
    };
  }

  // Generate (or fetch cached) summary of the dropped chunk.
  const cacheKey = hashOAITurns(dropped);
  let summary = summaryCache.get(cacheKey);
  let summarized = false;

  if (!summary) {
    try {
      summary = await generateSummary(dropped, opts);
      if (summaryCache.size >= MAX_CACHE_SIZE) {
        const firstKey = summaryCache.keys().next().value;
        if (firstKey !== undefined) summaryCache.delete(firstKey);
      }
      summaryCache.set(cacheKey, summary);
      summarized = true;
    } catch (err) {
      // Don't fail the request just because summary failed. Fall back
      // to plain trim — model still gets recent context, just no
      // synthetic recap of older turns.
      console.warn(
        "[historyTrim] summary call failed, falling back to plain trim:",
        err instanceof Error ? err.message : String(err)
      );
    }
  } else {
    // Cache hit — counts as "summarized" from the consumer's POV.
    summarized = true;
  }

  const summaryNote = summary
    ? `\n\n[Earlier in this conversation, summarized:\n${summary}\n]`
    : undefined;

  return {
    messages: trimmedMessages,
    summaryNote,
    trimmed: true,
    droppedCount,
    summarized,
  };
}

async function generateSummary(
  dropped: OAITurn[],
  opts: TrimOptions
): Promise<string> {
  // Format as a transcript. Cap each message at 500 chars so a long
  // tool-result body (e.g. a full file read) doesn't blow up the
  // summary prompt. The summarizer only needs the gist anyway.
  const transcript = dropped
    .map((m) => {
      const content = (m.content ?? "").slice(0, 500);
      const roleLabel = m.role.toUpperCase();
      return `${roleLabel}: ${content}`;
    })
    .join("\n\n");

  const prompt =
    `Summarize this conversation between a user and an AI coding mentor in 3-5 sentences. ` +
    `Capture: (1) what the user is working on, (2) key decisions or context established, ` +
    `(3) specific code, files, or concepts referenced. Be concise — this summary is ` +
    `background context for future replies.\n\nTRANSCRIPT:\n${transcript}\n\nSUMMARY:`;

  const result = await callChat({
    provider: opts.provider,
    anthropicModel: opts.anthropicModel,
    openaiModel: opts.openaiModel,
    maxTokens: 300,
    systemStable: "You produce concise factual summaries of coding conversations.",
    systemDynamic: "",
    anthropicMessages: [{ role: "user", content: prompt }],
    useTools: false,
    reasoningEffort: "minimal",
    userId: opts.userId,
  });

  return result.text.trim();
}

/** Test/debug helper — clears the in-process summary cache. */
export function _clearSummaryCacheForTests(): void {
  summaryCache.clear();
}
