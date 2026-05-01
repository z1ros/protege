import { describe, expect, it } from "vitest";
import { countableChatGapMs } from "./chat.js";

/**
 * Pure-logic tests for the chat-engagement gap calculator. Imported as
 * a separate symbol from chat.ts so we don't have to spin up Hono just
 * to verify the math. The route handler glues this together with a
 * userId-keyed Map and the addChatMinutes Supabase write — neither of
 * which adds anything testable here.
 */

describe("countableChatGapMs — chat-engagement window logic", () => {
  it("returns 0 for non-positive gaps", () => {
    expect(countableChatGapMs(0)).toBe(0);
    expect(countableChatGapMs(-100)).toBe(0);
  });

  it("counts the actual gap when within the 60s cap", () => {
    expect(countableChatGapMs(1_000)).toBe(1_000); // 1s
    expect(countableChatGapMs(15_000)).toBe(15_000); // 15s
    expect(countableChatGapMs(45_000)).toBe(45_000); // 45s
  });

  it("caps at 60s when the gap is between 60s and 10min", () => {
    expect(countableChatGapMs(60_000)).toBe(60_000); // exactly 60s
    expect(countableChatGapMs(120_000)).toBe(60_000); // 2 min
    expect(countableChatGapMs(5 * 60_000)).toBe(60_000); // 5 min
    expect(countableChatGapMs(10 * 60_000)).toBe(60_000); // exactly 10 min
  });

  it("returns 0 (fresh session) when gap exceeds 10 min", () => {
    expect(countableChatGapMs(10 * 60_000 + 1)).toBe(0); // 10min + 1ms
    expect(countableChatGapMs(15 * 60_000)).toBe(0); // 15 min
    expect(countableChatGapMs(60 * 60_000)).toBe(0); // 1 hour
    expect(countableChatGapMs(24 * 60 * 60_000)).toBe(0); // 1 day
  });

  it("realistic conversation: 5 quick turns sum correctly", () => {
    // Simulated turn timings: 12s, 8s, 25s, 4s, 19s — all within cap.
    const gaps = [12_000, 8_000, 25_000, 4_000, 19_000];
    const total = gaps.reduce((s, g) => s + countableChatGapMs(g), 0);
    expect(total).toBe(68_000); // 1 min 8s of engagement
  });

  it("user walks away mid-conversation: idle gap drops out, others count", () => {
    // First three turns 30s apart, then a 1-hour break, then two more
    // turns 20s apart. The 1-hour gap contributes 0, NOT 60s.
    const gaps = [30_000, 30_000, 60 * 60_000, 20_000];
    const total = gaps.reduce((s, g) => s + countableChatGapMs(g), 0);
    expect(total).toBe(80_000); // 30 + 30 + 0 + 20 = 80s
  });

  it("user reads slowly: 3-min thinking pause caps at 60s, doesn't drop out", () => {
    // A long-but-still-engaged "thinking about the answer" gap.
    expect(countableChatGapMs(3 * 60_000)).toBe(60_000);
  });
});
