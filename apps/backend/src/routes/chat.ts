import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRunRequest,
  ChatRunResponse,
  OAITurn,
  ToolCall,
} from "@protege/types";
import {
  anthropic,
  MODEL,
  MENTOR_SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
} from "../anthropic.js";
import { buildSystemPrompt, buildLearnerBlock } from "../prompts/persona.js";
import { sanitizeForVoice } from "../voicePostProcess.js";
import {
  addMemory,
  removeMemory,
  getMemorySnapshot,
  openSession,
  touchSessionFile,
  type MemoryType,
} from "../store.js";

export const chatRoute = new Hono();

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
 * Map the client-side backend preference to a concrete Anthropic model id.
 *
 * TEMP (2026-04-18): Sonnet is disabled server-side for cost reasons. Every
 * cloud call — regardless of the client's stated preference — routes to
 * Haiku. To restore Sonnet, bring back the original branch on `backend ===
 * "sonnet"` and re-enable `ANTHROPIC_SONNET_MODEL` in env.
 */
function resolveModel(_backend: ChatRunRequest["backend"]): string {
  return process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5";
}

chatRoute.post("/", async (c) => {
  const body = (await c.req.json()) as ChatRunRequest;
  const userId = body.userId ?? c.req.header("x-user-id") ?? "local-dev";
  const mode = body.mode ?? "text";
  const model = resolveModel(body.backend);

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
    const [memories, sessionInfo] = await Promise.all([
      getMemorySnapshot(userId, 12),
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

  console.log(
    `[protege] /chat provider=anthropic model=${model} requestedBackend=${body.backend ?? "default"} tools=${useTools ? "on" : "off"} turns=${messages.length} lastRole=${messages.at(-1)?.role}`
  );

  // Two-block system with selective caching:
  //   [0] stable persona — identical bytes for every user of Protege,
  //       so the cache entry is shared globally. At any scale >1 call per
  //       5 min, this is essentially always warm → 90% off on ~3000 tokens.
  //   [1] dynamic tail — memory + session + workspace, varies per user.
  //       Not cached (would only help within a single user's session and
  //       adds write-cost overhead).
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: systemStable,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (systemDynamic) {
    systemBlocks.push({ type: "text", text: systemDynamic });
  }

  const res = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemBlocks,
    ...(useTools ? { tools: TOOL_DEFINITIONS } : {}),
    messages: anthropicMessages,
  });

  console.log(
    `[protege] /chat stop=${res.stop_reason} usage=`,
    res.usage
  );

  // Parse assistant response into OAITurn-shaped history entry + extract tool calls
  const textParts: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];

  for (const block of res.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  const assistantText = textParts.join("\n").trim();

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
          const row = await addMemory(
            userId,
            String(args.type ?? "context") as MemoryType,
            String(args.content ?? "")
          );
          resultText = `Remembered (id=${row.id}, type=${row.type})`;
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

    // Pure server-tool round — synthesize a continuation by calling Claude
    // again with the tool results appended. This keeps the UX instant
    // (no extra client roundtrip) when Claude is just updating memory.
    const { systemStable: ss2, systemDynamic: sd2, anthropicMessages: am2 } =
      toAnthropic(messages);
    const sysBlocks2: Anthropic.Messages.TextBlockParam[] = [
      { type: "text", text: ss2, cache_control: { type: "ephemeral" } },
    ];
    if (sd2) sysBlocks2.push({ type: "text", text: sd2 });
    const res2 = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: sysBlocks2,
      tools: TOOL_DEFINITIONS,
      messages: am2,
    });
    const text2 = res2.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
    const toolUses2 = res2.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }>;

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

    return c.json<ChatRunResponse>({
      reply: mode === "voice" || mode === "voice-dialogue" ? sanitizeForVoice(text2) : text2,
      messages,
    });
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

  // Terminal: final text reply
  return c.json<ChatRunResponse>({
    reply: mode === "voice" || mode === "voice-dialogue" ? sanitizeForVoice(assistantText) : assistantText,
    messages,
  });
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
