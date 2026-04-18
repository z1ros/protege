import * as vscode from "vscode";
import type {
  ChatBackend,
  ChatMode,
  ChatRunRequest,
  ChatRunResponse,
  OAITurn,
  ToolCall,
  ToolResult,
} from "@protege/types";
import { BACKEND_URL } from "./protegeClient.js";
import { executeTool, buildWorkspaceContext } from "./tools.js";

/**
 * We import the user's backend preference via dynamic require to avoid
 * a circular import (aiBackend imports runSingleQuery from here). Live-
 * binding dynamic lookup is safe because this is only called inside
 * request functions, long after both modules have finished loading.
 */
function resolveCloudBackend(): ChatBackend {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAiBackend } = require("./aiBackend.js") as {
      getAiBackend: () => "on-device" | "haiku" | "sonnet" | "auto";
    };
    const choice = getAiBackend();
    if (choice === "sonnet") return "sonnet";
    if (choice === "haiku") return "haiku";
    // on-device / auto both mean "no cloud preference" from the user; if
    // we end up here, on-device wasn't available → fall through to haiku.
    return "haiku";
  } catch {
    return "haiku";
  }
}

const MAX_TOOL_ROUNDS = 8; // safety cap

interface RunnerCallbacks {
  onTool?: (
    call: ToolCall,
    status: "running" | "done" | "error"
  ) => void;
  log?: (line: string) => void;
}

export interface RunChatOptions {
  mode?: ChatMode;
}

/**
 * Runs the tool-enabled chat loop client-side.
 * - First call seeds with workspace context + the user's message.
 * - If backend returns toolCalls, we execute them here and send results back.
 * - Loop until backend returns a final reply or we hit MAX_TOOL_ROUNDS.
 */
export async function runChat(
  userId: string,
  userMessage: string,
  cb: RunnerCallbacks = {},
  opts: RunChatOptions = {}
): Promise<string> {
  const mode: ChatMode = opts.mode ?? "text";
  const workspace = await buildWorkspaceContext();

  let messages: OAITurn[] = [];
  let newUserMessage: string | undefined = userMessage;
  let toolResults: ToolResult[] | undefined = undefined;

  const backend = resolveCloudBackend();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: ChatRunRequest = {
      userId,
      workspace: round === 0 ? workspace : undefined,
      messages,
      newUserMessage,
      toolResults,
      mode,
      backend,
    };

    const res = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": userId },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    let data: ChatRunResponse & { error?: string } = { messages: [] };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `Backend non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`
      );
    }
    if (!res.ok || data.error) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    messages = data.messages;
    newUserMessage = undefined;
    toolResults = undefined;

    if (data.reply !== undefined) {
      cb.log?.(`[protege] chat final round=${round + 1}`);
      return data.reply;
    }

    if (!data.toolCalls || data.toolCalls.length === 0) {
      return "";
    }

    // Execute tool calls, collect results
    const results: ToolResult[] = [];
    for (const call of data.toolCalls) {
      cb.onTool?.(call, "running");
      cb.log?.(`[protege] tool → ${call.name} ${JSON.stringify(call.arguments)}`);
      const result = await executeTool(call);
      cb.onTool?.(call, result.error ? "error" : "done");
      results.push(result);
    }
    toolResults = results;
  }

  throw new Error(
    `Chat exceeded ${MAX_TOOL_ROUNDS} tool rounds without reaching a reply`
  );
}

/**
 * Lightweight one-shot query to Claude — no tool loop, no workspace context.
 * Used for quick inline operations (fix-it, explain, etc.) where we just need
 * a short text reply and don't want tool execution overhead.
 */
export async function runSingleQuery(prompt: string): Promise<string> {
  const body: ChatRunRequest = {
    messages: [],
    newUserMessage: prompt,
    mode: "text",
    backend: resolveCloudBackend(),
  };

  const res = await fetch(`${BACKEND_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let data: ChatRunResponse & { error?: string } = { messages: [] };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Backend non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`
    );
  }
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.reply ?? "";
}
