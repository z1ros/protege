import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OAITurn } from "@protege/types";
import { trimAndSummarize, _clearSummaryCacheForTests } from "./historyTrim.js";

// Stub callChat so the summary-generation path is exercised without
// hitting a real LLM. Returns a deterministic summary so cache-hit
// behaviour is testable.
vi.mock("../llm.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../llm.js")>();
  return {
    ...real,
    callChat: vi.fn(async () => ({
      text: "STUB_SUMMARY",
      toolUses: [],
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      providerUsed: "openai" as const,
      modelUsed: "gpt-5-nano",
    })),
  };
});

const baseOpts = {
  provider: "openai" as const,
  userId: "test-user",
  openaiModel: "gpt-5-nano",
  anthropicModel: "claude-sonnet-4-5",
};

function userTurn(content: string): OAITurn {
  return { role: "user", content };
}
function assistantTurn(content: string): OAITurn {
  return { role: "assistant", content };
}
function systemTurn(content: string): OAITurn {
  return { role: "system", content };
}

beforeEach(() => {
  _clearSummaryCacheForTests();
});

describe("trimAndSummarize", () => {
  it("passes through unchanged below trim threshold", async () => {
    const messages: OAITurn[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }
    expect(messages.length).toBe(20); // exactly the threshold

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toBe(messages); // same reference
  });

  it("trims to last KEEP_RECENT turns above threshold without summarizing", async () => {
    // 22 turns is above TRIM_THRESHOLD (20) but below SUMMARIZE_THRESHOLD (26)
    const messages: OAITurn[] = [];
    for (let i = 0; i < 11; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }
    expect(messages.length).toBe(22);

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(true);
    expect(result.summarized).toBe(false);
    expect(result.summaryNote).toBeUndefined();
    // Kept tail starts with a user message (no orphan tool fragments)
    expect(result.messages[0]?.role).toBe("user");
    expect(result.droppedCount).toBeGreaterThan(0);
  });

  it("summarizes dropped turns above SUMMARIZE_THRESHOLD", async () => {
    const messages: OAITurn[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }
    expect(messages.length).toBe(28); // > SUMMARIZE_THRESHOLD

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(true);
    expect(result.summarized).toBe(true);
    expect(result.summaryNote).toContain("STUB_SUMMARY");
    expect(result.summaryNote).toContain("Earlier in this conversation");
  });

  it("preserves system messages even when trimming", async () => {
    const messages: OAITurn[] = [systemTurn("ROOT_SYSTEM_PROMPT")];
    for (let i = 0; i < 14; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(true);
    // System turn is at index 0 of trimmed messages
    expect(result.messages[0]).toEqual(systemTurn("ROOT_SYSTEM_PROMPT"));
  });

  it("walks forward to a user-role boundary so tool fragments are not orphaned", async () => {
    // Construct a history where the slice would otherwise land on an
    // assistant tool_use or a tool result, which the API rejects.
    const messages: OAITurn[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userTurn(`u${i}`));
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `t${i}`, type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      });
      messages.push({ role: "tool", content: `result_${i}`, tool_call_id: `t${i}` });
      messages.push(assistantTurn(`final_${i}`));
    }
    // 32 turns total (8 user + 8 assistant_tool_use + 8 tool + 8 assistant_text)
    expect(messages.length).toBe(32);

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(true);
    // The first non-system message must be a user message — never a
    // dangling tool result or assistant tool_use.
    const firstNonSystem = result.messages.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).toBe("user");
  });

  it("caches summaries — second identical call does not re-invoke the LLM", async () => {
    const llm = await import("../llm.js");
    const callChatSpy = llm.callChat as unknown as ReturnType<typeof vi.fn>;
    callChatSpy.mockClear();

    const messages: OAITurn[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }

    const r1 = await trimAndSummarize(messages, baseOpts);
    const callsAfterFirst = callChatSpy.mock.calls.length;
    expect(r1.summarized).toBe(true);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const r2 = await trimAndSummarize(messages, baseOpts);
    expect(r2.summarized).toBe(true);
    // No new callChat invocation — cache hit.
    expect(callChatSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it("falls back to plain trim when summary call throws", async () => {
    const llm = await import("../llm.js");
    const callChatSpy = llm.callChat as unknown as ReturnType<typeof vi.fn>;
    callChatSpy.mockImplementationOnce(async () => {
      throw new Error("simulated LLM outage");
    });

    const messages: OAITurn[] = [];
    for (let i = 0; i < 14; i++) {
      messages.push(userTurn(`u${i}`), assistantTurn(`a${i}`));
    }

    const result = await trimAndSummarize(messages, baseOpts);
    expect(result.trimmed).toBe(true);
    expect(result.summarized).toBe(false);
    expect(result.summaryNote).toBeUndefined();
    // Recent context still preserved — request can proceed.
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
