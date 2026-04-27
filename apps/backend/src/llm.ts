import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  anthropic,
  TOOL_DEFINITIONS as ANTHROPIC_TOOL_DEFINITIONS,
} from "./anthropic.js";
import { openai } from "./openai.js";

export type ProviderId = "anthropic" | "openai";

export function getProvider(): ProviderId {
  const raw = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  return raw === "openai" ? "openai" : "anthropic";
}

export interface ChatToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatResult {
  text: string;
  toolUses: ChatToolUse[];
  stopReason: string;
  usage: unknown;
  providerUsed: ProviderId;
  modelUsed: string;
}

export interface ChatCallOptions {
  anthropicModel: string;
  /**
   * Override for the OpenAI model id. When omitted, callOpenAI falls
   * back to OPENAI_MODEL env (or "gpt-4.1"). Lets the chat route pick
   * a cheaper id (gpt-4.1-mini) for cheap-tier requests without a
   * second env var dance at the callsite.
   */
  openaiModel?: string;
  maxTokens: number;
  systemStable: string;
  systemDynamic: string;
  anthropicMessages: Anthropic.Messages.MessageParam[];
  useTools: boolean;
}

export async function callChat(opts: ChatCallOptions): Promise<ChatResult> {
  const provider = getProvider();
  if (provider === "openai") return callOpenAI(opts);
  return callAnthropic(opts);
}

async function callAnthropic(opts: ChatCallOptions): Promise<ChatResult> {
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: opts.systemStable,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (opts.systemDynamic) {
    systemBlocks.push({ type: "text", text: opts.systemDynamic });
  }

  const res = await anthropic.messages.create({
    model: opts.anthropicModel,
    max_tokens: opts.maxTokens,
    system: systemBlocks,
    ...(opts.useTools ? { tools: ANTHROPIC_TOOL_DEFINITIONS } : {}),
    messages: opts.anthropicMessages,
  });

  const textParts: string[] = [];
  const toolUses: ChatToolUse[] = [];
  for (const block of res.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    text: textParts.join("\n").trim(),
    toolUses,
    stopReason: res.stop_reason ?? "",
    usage: res.usage,
    providerUsed: "anthropic",
    modelUsed: opts.anthropicModel,
  };
}

async function callOpenAI(opts: ChatCallOptions): Promise<ChatResult> {
  const model = opts.openaiModel ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
  const messages = anthropicToOpenAIMessages(
    opts.systemStable,
    opts.systemDynamic,
    opts.anthropicMessages
  );
  const tools = opts.useTools
    ? anthropicToolsToOpenAI(ANTHROPIC_TOOL_DEFINITIONS)
    : undefined;

  const res = await openai.chat.completions.create({
    model,
    max_tokens: opts.maxTokens,
    messages,
    ...(tools ? { tools } : {}),
  });

  const choice = res.choices[0];
  const msg = choice?.message;
  const toolUses: ChatToolUse[] = (msg?.tool_calls ?? []).flatMap((tc) => {
    if (tc.type !== "function") return [];
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {}
    return [{ id: tc.id, name: tc.function.name, input }];
  });

  return {
    text: (msg?.content ?? "").trim(),
    toolUses,
    stopReason: choice?.finish_reason ?? "",
    usage: res.usage,
    providerUsed: "openai",
    modelUsed: model,
  };
}

/**
 * Simple one-shot completion: single system + single user message, no tools,
 * returns plain text. Used by /analyze, /classify, /verify, /concept-tips,
 * /test — anywhere we just want a single LLM reply.
 *
 * On Anthropic: system is sent with cache_control: ephemeral when
 * `cacheSystem` is true (default) — the caller's prompt is reused at ~10%
 * input cost on repeat calls.
 *
 * On OpenAI: cacheSystem is ignored (no equivalent for arbitrary prefixes).
 */
export interface OneShotOptions {
  systemText?: string;
  userText: string;
  maxTokens: number;
  cacheSystem?: boolean;
  anthropicModel?: string;
}

export interface OneShotUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface OneShotResult {
  text: string;
  usage: OneShotUsage;
  modelUsed: string;
  providerUsed: ProviderId;
}

export async function callOneShot(
  opts: OneShotOptions
): Promise<OneShotResult> {
  const provider = getProvider();
  if (provider === "openai") return oneShotOpenAI(opts);
  return oneShotAnthropic(opts);
}

async function oneShotAnthropic(
  opts: OneShotOptions
): Promise<OneShotResult> {
  const model =
    opts.anthropicModel ??
    process.env.ANTHROPIC_MODEL ??
    "claude-haiku-4-5";
  const cacheSystem = opts.cacheSystem ?? true;

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: opts.userText }],
  };
  if (opts.systemText) {
    params.system = cacheSystem
      ? [
          {
            type: "text",
            text: opts.systemText,
            cache_control: { type: "ephemeral" },
          },
        ]
      : opts.systemText;
  }

  const res = await anthropic.messages.create(params);
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();
  return {
    text,
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    },
    modelUsed: model,
    providerUsed: "anthropic",
  };
}

async function oneShotOpenAI(opts: OneShotOptions): Promise<OneShotResult> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1";
  const messages: ChatCompletionMessageParam[] = [];
  if (opts.systemText) {
    messages.push({ role: "system", content: opts.systemText });
  }
  messages.push({ role: "user", content: opts.userText });

  const res = await openai.chat.completions.create({
    model,
    max_tokens: opts.maxTokens,
    messages,
  });
  const text = (res.choices[0]?.message?.content ?? "").trim();
  return {
    text,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
    modelUsed: model,
    providerUsed: "openai",
  };
}

function anthropicToolsToOpenAI(
  tools: Anthropic.Messages.Tool[]
): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/**
 * Convert Anthropic message format → OpenAI ChatCompletionMessageParam[].
 *
 * Anthropic embeds tool_result blocks inside user messages; OpenAI uses a
 * separate "tool" role with tool_call_id. This converter splits a single
 * Anthropic user-with-tool_results turn into N tool messages plus an
 * optional plain user message for any text blocks.
 */
function anthropicToOpenAIMessages(
  systemStable: string,
  systemDynamic: string,
  msgs: Anthropic.Messages.MessageParam[]
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  const systemContent =
    systemDynamic.length > 0 ? `${systemStable}\n\n${systemDynamic}` : systemStable;
  out.push({ role: "system", content: systemContent });

  for (const m of msgs) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
        continue;
      }
      const textParts: string[] = [];
      const toolResults: ChatCompletionMessageParam[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((b) => (b.type === "text" ? b.text : ""))
                    .join("\n")
                : "";
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content,
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) out.push(tr);
      continue;
    }

    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content)
        ? m.content
        : [{ type: "text" as const, text: m.content as string }];
      const textParts: string[] = [];
      const toolCalls: NonNullable<
        Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]
      > = [];
      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const text = textParts.join("\n");
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: toolCalls,
        });
      } else {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
  }

  return out;
}
