import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRunRequest,
  ChatRunResponse,
  ChatTier,
  OAITurn,
  ToolCall,
} from "@protege/types";
import { MENTOR_SYSTEM_PROMPT } from "../anthropic.js";
import { callChat, getProvider } from "../llm.js";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { buildSystemPrompt, buildLearnerBlock } from "../prompts/persona.js";
import {
  removeMemory,
  getMemorySnapshot,
  getRelevantMemories,
  openSession,
  touchSessionFile,
  type MemoryType,
} from "../store.js";
import { reconcileAndStore } from "../memoryReconciler.js";

export const chatRoute = new Hono();

chatRoute.use("*", githubAuth());

/**
 * Tool-enabled chat using Claude Sonnet 4.5 with prompt caching.
 *
 * The wire format stays OAITurn[] (OpenAI-shaped) so the extension's
 * chatRunner.ts doesn't need to change. Internally we translate to
 * Anthropic's messages / content-block format per call.
 *
 * Prompt caching: the system prompt + tool definitions are marked with
 * cache_control: "ephemeral", so on repeat calls Anthropic reuses them
 * at ~10% of input token cost. Huge win for a mentor that makes many
 * multi-turn tool rounds per user question.
 */
/**
 * Map the client-side backend preference + tier to a concrete Anthropic
 * model id.
 *
 * TEMP (2026-04-18): Sonnet is disabled server-side for cost reasons.
 * Every cloud Anthropic call — regardless of the client's stated
 * preference — routes to Haiku, so cheap and premium currently collapse
 * to the same id on the Anthropic side. When Sonnet is re-enabled,
 * branch on `tier === "premium"` here.
 */
function resolveAnthropicModel(
  _backend: ChatRunRequest["backend"],
  _tier: ChatTier
): string {
  return process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5";
}

/**
 * Map the tier to a concrete OpenAI model id. Cheap → gpt-4.1-mini
 * ($0.40/$1.60 per MTok). Premium → gpt-4.1 ($2/$8 per MTok). Both can
 * be overridden via env: OPENAI_CHEAP_MODEL / OPENAI_MODEL.
 */
function resolveOpenAIModel(tier: ChatTier): string {
  if (tier === "cheap") {
    return process.env.OPENAI_CHEAP_MODEL ?? "gpt-4.1-mini";
  }
  return process.env.OPENAI_MODEL ?? "gpt-4.1";
}

/**
 * Cap reply length by channel:
 *  - voice / voice-dialogue → 300 tokens (~150–200 words, 45–60s of speech
 *    max). Hard ceiling that prevents the LLM from unrolling a 3-paragraph
 *    explanation that the user will then sit through being read aloud.
 *    Soft pressure from the VOICE_MODE prompt + this hard cap together.
 *  - teaching → 1200 tokens. Tool-loop turns are shorter than full text
 *    but the terminal reply still needs room for context.
 *  - text → 4096 (no practical cap). Chat is scannable, long is fine.
 */
function maxTokensForMode(mode: string): number {
  if (mode === "voice" || mode === "voice-dialogue") return 300;
  if (mode === "teaching") return 1200;
  return 4096;
}

chatRoute.post("/", async (c) => {
  const body = (await c.req.json()) as ChatRunRequest;
  const userId = resolveUserId(c, body.userId);
  const mode = body.mode ?? "text";
  const tier: ChatTier = body.tier ?? "premium";
  const anthropicModel = resolveAnthropicModel(body.backend, tier);
  const openaiModel = resolveOpenAIModel(tier);
  const maxTokens = maxTokensForMode(mode);

  let messages: OAITurn[] = body.messages ?? [];

  // "Fresh turn" detection: frontend passes a newUserMessage with no system
  // message in the history. That means this is the start of a new user
  // turn — build the full system prompt + context block, then append any
  // prior user/assistant history between the system message and the new
  // user message. Without this, passing prior conversation history would
  // SKIP the system prompt entirely and strip Claude of persona/workspace.
  const hasSystemMessage = messages.some((m) => m.role === "system");
  const isFreshTurn = !hasSystemMessage && !!body.newUserMessage;

  if (isFreshTurn) {
    // Build a query string for contextual retrieval: the new user message
    // plus a short slice of the active file. This lets cosine ranking pick
    // memories tied to *this* moment instead of just the most recent ones.
    // Fallback to the legacy non-semantic snapshot when there's no signal
    // to retrieve against (rare — fresh turns always carry newUserMessage).
    const retrievalQuery = [
      body.newUserMessage ?? "",
      body.workspace?.activeFile?.path ?? "",
      body.workspace?.activeFile?.language ?? "",
      body.workspace?.activeFile?.selection ??
        body.workspace?.activeFile?.content?.slice(0, 1500) ??
        "",
    ]
      .filter((s) => s)
      .join("\n");

    const memoriesPromise = retrievalQuery.trim()
      ? getRelevantMemories(userId, retrievalQuery, 12)
      : getMemorySnapshot(userId, 12);

    const [memories, sessionInfo] = await Promise.all([
      memoriesPromise,
      openSession(userId),
    ]);

    // Derive a learner block from the memory snapshot — profile memories
    // drive level inference, recent struggles flag concepts to tread
    // carefully on. Empty-string when there's no signal yet; the prompt
    // degrades gracefully without it.
    const profileNotes = memories
      .filter((m) => m.type === "profile")
      .map((m) => m.content);
    const recentStruggles = memories
      .filter((m) => m.type === "struggle")
      .map((m) => m.content);
    const learnerBlock = buildLearnerBlock({
      profileNotes,
      recentStruggles,
      // Mastery fields (owned/decaying/new) are not yet wired from a
      // mastery store on the backend side. When that exists, populate
      // them here and the prompt will automatically adapt.
    });
    const basePersona = buildSystemPrompt(mode, learnerBlock);

    // === Memory block ===
    let memoryBlock = "";
    if (memories.length > 0) {
      const lines = memories.map(
        (m) => `- [${m.type}] (${m.id}) ${m.content}`
      );
      memoryBlock = `\n\n## What you know about this user\n${lines.join("\n")}\n\n(Reference these naturally when relevant. Use \`forget(id)\` if any entry turns out to be wrong.)`;
    }

    // === Session / continuity block ===
    let sessionBlock = "";
    if (sessionInfo.isFirstToday && sessionInfo.lastSession) {
      const last = sessionInfo.lastSession;
      const parts: string[] = [`Last session: ${last.date}`];
      if (last.endSummary) parts.push(`Summary: ${last.endSummary}`);
      if (last.filesTouched.length > 0)
        parts.push(`Files touched: ${last.filesTouched.slice(-6).join(", ")}`);
      sessionBlock = `\n\n## Session continuity\nThis is the user's FIRST message today. ${parts.join(" · ")}\n\nOpen with a brief, specific acknowledgement of where they left off (one sentence), then address their current message. Don't be sappy. Example: "Morning — yesterday we got the voice mode working. Okay, what's up?"`;
    } else if (!sessionInfo.isFirstToday) {
      sessionBlock = `\n\n## Session\nContinuing today's session. Don't re-greet.`;
    }

    // === Workspace block ===
    const wsBlock = body.workspace
      ? `\n\n## Current workspace\nRoot: ${body.workspace.root ?? "(unknown)"}\n${
          body.workspace.activeFile
            ? `Active file: ${body.workspace.activeFile.path} (${body.workspace.activeFile.language})\n\`\`\`${body.workspace.activeFile.language}\n${body.workspace.activeFile.content.slice(0, 4000)}\n\`\`\`\n${
                body.workspace.activeFile.selection
                  ? `\nUser selection:\n\`\`\`\n${body.workspace.activeFile.selection}\n\`\`\``
                  : ""
              }`
            : "No active file."
        }\n${
          body.workspace.fileTree && body.workspace.fileTree.length > 0
            ? `\nFile tree (first ${body.workspace.fileTree.length} files):\n${body.workspace.fileTree.join("\n")}`
            : ""
        }`
      : "";

    // Track the active file in the session (for next-day continuity)
    if (body.workspace?.activeFile?.path) {
      touchSessionFile(userId, body.workspace.activeFile.path).catch(() => {});
    }

    // Delimiter lets toAnthropic() split the system prompt into a GLOBALLY
    // CACHEABLE prefix (basePersona — identical bytes for every user) and a
    // per-user tail (memory, session, workspace). The prefix gets a long
    // cache TTL shared across users; the tail stays uncached.
    const systemMessage: OAITurn = {
      role: "system",
      content:
        basePersona +
        CACHE_SPLIT_MARKER +
        (memoryBlock + sessionBlock + wsBlock),
    };
    // Prior user/assistant turns (history) stay between system + new user,
    // so Claude sees: [system, ...history, new user message].
    const priorHistory = messages;
    messages = [
      systemMessage,
      ...priorHistory,
      { role: "user", content: body.newUserMessage! },
    ];
  } else if (body.toolResults && body.toolResults.length > 0) {
    for (const tr of body.toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.id,
        name: tr.name,
        content: tr.error ? `ERROR: ${tr.error}` : tr.content,
      });
    }
  } else if (body.newUserMessage) {
    messages.push({ role: "user", content: body.newUserMessage });
  }

  // Translate OAITurn[] → Anthropic format
  const { systemStable, systemDynamic, anthropicMessages } = toAnthropic(messages);

  // One-shot callers (review engine, voice explain) pass `noTools: true`.
  // Without this flag, Claude can respond with a tool call instead of
  // text — which the one-shot path can't consume, so the caller sees an
  // empty reply and the scan produces zero suggestions. The scan prompt
  // asks for JSON-only, but Claude sometimes "prepares" by calling
  // read_file before answering. Disabling tools forces a direct reply.
  const useTools = body.noTools !== true;

  // Log the model that will ACTUALLY be used. The Anthropic id and
  // OpenAI id are resolved separately above; the active provider
  // decides which one fires.
  const provider = getProvider();
  const loggedModel = provider === "openai" ? openaiModel : anthropicModel;
  console.log(
    `[protege] /chat provider=${provider} model=${loggedModel} tier=${tier} requestedBackend=${body.backend ?? "default"} tools=${useTools ? "on" : "off"} turns=${messages.length} lastRole=${messages.at(-1)?.role}`
  );

  const result = await callChat({
    anthropicModel,
    openaiModel,
    maxTokens,
    systemStable,
    systemDynamic,
    anthropicMessages,
    useTools,
  });

  console.log(
    `[protege] /chat provider=${result.providerUsed} model=${result.modelUsed} stop=${result.stopReason} usage=`,
    result.usage
  );

  const toolUses = result.toolUses;
  const assistantText = result.text;

  // Append assistant turn to the running conversation
  messages.push({
    role: "assistant",
    content: assistantText || null,
    tool_calls: toolUses.length
      ? toolUses.map((tu) => ({
          id: tu.id,
          type: "function" as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }))
      : undefined,
  });

  // Server-side tools (no bounce to extension): remember / forget.
  // If Claude only called these, execute locally and recurse with tool results.
  const extensionCalls = toolUses.filter(
    (tu) => tu.name !== "remember" && tu.name !== "forget"
  );
  const serverCalls = toolUses.filter(
    (tu) => tu.name === "remember" || tu.name === "forget"
  );

  if (serverCalls.length > 0) {
    // Execute each server tool inline and push tool_result turns
    for (const tu of serverCalls) {
      const args = (tu.input ?? {}) as Record<string, unknown>;
      let resultText = "";
      try {
        if (tu.name === "remember") {
          const result = await reconcileAndStore(
            userId,
            String(args.type ?? "context") as MemoryType,
            String(args.content ?? "")
          );
          if (result.row) {
            resultText = `${result.decision.action.toLowerCase()} (id=${result.row.id}, type=${result.row.type})`;
          } else if (result.decision.action === "DELETE") {
            resultText = `Removed superseded memory (id=${result.decision.targetId ?? "?"})`;
          } else {
            resultText = "Skipped (duplicate of existing memory)";
          }
        } else if (tu.name === "forget") {
          const ok = await removeMemory(userId, String(args.id ?? ""));
          resultText = ok ? "Forgotten" : "Nothing to forget (id not found)";
        }
      } catch (err) {
        resultText = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tu.id,
        name: tu.name,
        content: resultText,
      });
    }

    // If there are ALSO extension tool calls, return them now so the
    // extension can run them. Otherwise the server has fully handled this
    // round — but we still need to return something. Claude's next response
    // will come on the next POST from the extension which already has the
    // updated messages, so return those with no toolCalls.
    if (extensionCalls.length > 0) {
      const toolCalls: ToolCall[] = extensionCalls.map((tu) => ({
        id: tu.id,
        name: tu.name,
        arguments:
          typeof tu.input === "object" && tu.input !== null
            ? (tu.input as Record<string, unknown>)
            : {},
      }));
      return c.json<ChatRunResponse>({ toolCalls, messages });
    }

    // Pure server-tool round — synthesize a continuation by calling the LLM
    // again with the tool results appended. This keeps the UX instant
    // (no extra client roundtrip) when the model is just updating memory.
    const { systemStable: ss2, systemDynamic: sd2, anthropicMessages: am2 } =
      toAnthropic(messages);
    const result2 = await callChat({
      anthropicModel,
      openaiModel,
      maxTokens,
      systemStable: ss2,
      systemDynamic: sd2,
      anthropicMessages: am2,
      useTools: true,
    });
    const text2 = result2.text;
    const toolUses2 = result2.toolUses;

    messages.push({
      role: "assistant",
      content: text2 || null,
      tool_calls: toolUses2.length
        ? toolUses2.map((tu) => ({
            id: tu.id,
            type: "function" as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          }))
        : undefined,
    });

    if (toolUses2.length > 0) {
      const toolCalls: ToolCall[] = toolUses2
        .filter((tu) => tu.name !== "remember" && tu.name !== "forget")
        .map((tu) => ({
          id: tu.id,
          name: tu.name,
          arguments:
            typeof tu.input === "object" && tu.input !== null
              ? (tu.input as Record<string, unknown>)
              : {},
        }));
      if (toolCalls.length > 0) {
        return c.json<ChatRunResponse>({ toolCalls, messages });
      }
    }

    return c.json<ChatRunResponse>({ reply: text2, messages });
  }

  // If Claude wants tool calls → return them to the extension for execution
  if (toolUses.length > 0) {
    const toolCalls: ToolCall[] = toolUses.map((tu) => ({
      id: tu.id,
      name: tu.name,
      arguments:
        typeof tu.input === "object" && tu.input !== null
          ? (tu.input as Record<string, unknown>)
          : {},
    }));
    return c.json<ChatRunResponse>({ toolCalls, messages });
  }

  // Terminal: final text reply. Always return the full reply (including
  // code blocks) — the chat UI renders it as markdown. The /tts route
  // sanitizes for speech on its side, so voice modes hear a clean spoken
  // summary while the chat still shows the code the user asked for.
  return c.json<ChatRunResponse>({ reply: assistantText, messages });
});

/**
 * Translate OpenAI-shaped turns → Anthropic format.
 * Tool results must be embedded as `tool_result` content blocks on
 * a user message in Anthropic's model (not a separate role).
 */
/** Marker inserted between the stable persona and the per-user dynamic
 *  context so toAnthropic() can split them into two separate cache blocks.
 *  Never user-facing — stripped before the prompt reaches Claude. */
const CACHE_SPLIT_MARKER = "\n<<<PROTEGE_SYSTEM_SPLIT>>>\n";

function toAnthropic(turns: OAITurn[]): {
  systemStable: string;
  systemDynamic: string;
  anthropicMessages: Anthropic.Messages.MessageParam[];
} {
  let systemText = MENTOR_SYSTEM_PROMPT;
  const out: Anthropic.Messages.MessageParam[] = [];

  for (const t of turns) {
    if (t.role === "system") {
      // Use the last system message as the system prompt
      if (t.content) systemText = t.content;
      continue;
    }

    if (t.role === "user") {
      if (typeof t.content === "string") {
        out.push({ role: "user", content: t.content });
      }
      continue;
    }

    if (t.role === "assistant") {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (t.content) {
        blocks.push({ type: "text", text: t.content });
      }
      if (t.tool_calls && t.tool_calls.length > 0) {
        for (const tc of t.tool_calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: input as Record<string, unknown>,
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (t.role === "tool") {
      // Anthropic: tool_result goes inside a user message's content array.
      // If the previous out-message is a user with content blocks, push into it.
      // Otherwise start a new user message.
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: t.tool_call_id ?? "",
        content: t.content ?? "",
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content)
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
  }

  // Split into stable (cacheable globally) + dynamic (per-user) halves.
  // If no marker is present (legacy / fallback path) the whole prompt is
  // treated as stable.
  const splitIdx = systemText.indexOf(CACHE_SPLIT_MARKER);
  const systemStable =
    splitIdx === -1 ? systemText : systemText.slice(0, splitIdx);
  const systemDynamic =
    splitIdx === -1
      ? ""
      : systemText.slice(splitIdx + CACHE_SPLIT_MARKER.length);

  return { systemStable, systemDynamic, anthropicMessages: out };
}
