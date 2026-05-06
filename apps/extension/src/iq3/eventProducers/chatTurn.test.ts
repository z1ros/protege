import { describe, it, expect } from "vitest";
import { buildChatTurnEvent } from "./chatTurn.js";

describe("buildChatTurnEvent", () => {
  it("never includes raw text in the event", () => {
    const e = buildChatTurnEvent("My API key is sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect((e as any).text).toBeUndefined();
  });

  it("flags stack-trace-shaped prompts", () => {
    const e = buildChatTurnEvent("Why does this throw at line 42 with undefined?");
    expect(e.containsStackTraceOrLineRef).toBe(true);
  });

  it("does not flag plain-English prompts", () => {
    const e = buildChatTurnEvent("Can you help me restructure the routing logic?");
    expect(e.containsStackTraceOrLineRef).toBe(false);
  });

  it("flags constraint-shaped prompts", () => {
    const e = buildChatTurnEvent("This API must respond within 100ms and cannot block the main thread.");
    expect(e.containsConstraintWords).toBe(true);
  });

  it("classifies intent", () => {
    expect(buildChatTurnEvent("fix").intent).toBe("vague");
    expect(buildChatTurnEvent("Why does my reduce throw on empty arrays in this case?").intent).toBe("debug");
    expect(buildChatTurnEvent("How should I plan the architecture for this trade-off?").intent).toBe("plan");
  });

  it("captures charCount", () => {
    const text = "x".repeat(150);
    expect(buildChatTurnEvent(text).charCount).toBe(150);
  });
});
