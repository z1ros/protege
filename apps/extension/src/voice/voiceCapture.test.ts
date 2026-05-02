import { describe, expect, it, vi } from "vitest";
import { dedupRepetitiveTranscript } from "./voiceCapture.js";

// `voiceCapture.ts` imports `vscode` at module load. Stub the parts the
// module touches at import time so we can drive the pure helper under test.
// `vi.mock` calls are hoisted by Vitest above all imports — safe to declare
// after the import statement.
vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(),
  },
  ProgressLocation: { Notification: 15 },
}));

/**
 * Tests for `dedupRepetitiveTranscript` — written against the function's
 * docstring only (function body unread before authoring tests).
 *
 * Spec recap (from the function's JSDoc):
 *   - Returns `{ keep: text }` when no repetition is detected.
 *   - Returns `{ keep: head/tail }` when a 4+ word repetition sits at one
 *     end and there is real content on the non-repeated side.
 *   - Returns `{ keep: "" }` when both sides are too short to be content.
 *
 * NOTE: We exported the function for testability (it is otherwise
 * module-private). No behavioral change.
 */
describe("dedupRepetitiveTranscript", () => {
  it("Case A — prefix repetition: returns the trailing real content", () => {
    const input =
      "Can you hear me? Can you hear me? Like, explain the weather today.";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).not.toBe("");
    expect(keep.toLowerCase()).toContain("explain the weather today");
    expect(keep.toLowerCase()).not.toContain("can you hear me");
  });

  it("Case B — suffix repetition: returns the leading real content", () => {
    const input =
      "Explain me the weather today. The weather today, the weather today.";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).not.toBe("");
    expect(keep.toLowerCase()).toContain("explain me the weather today");
  });

  it("Case C — fully repetitive transcript: returns empty string", () => {
    const input = "yes yes yes yes yes yes yes yes";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).toBe("");
  });

  it("Case D — no repetition: returns input unchanged", () => {
    const input =
      "What is the difference between let and const in JavaScript?";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).toBe(input);
  });

  it("Case E — short transcript (3 tokens): returns input unchanged", () => {
    const input = "hi there friend";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).toBe(input);
  });

  it("Case F — repetition mid-transcript: keeps a meaningful slice", () => {
    const input =
      "First sentence. Then later, the bell, the bell, the bell. Final words.";
    const { keep } = dedupRepetitiveTranscript(input);
    // Per spec, the function picks whichever side of the repetition zone
    // has real content. Either side is acceptable here as long as
    // something meaningful survives.
    const lower = keep.toLowerCase();
    const hasHead = lower.includes("first sentence");
    const hasTail = lower.includes("final words");
    expect(hasHead || hasTail).toBe(true);
    // And the bell-loop should not dominate the kept text.
    expect(keep).not.toBe(input);
  });

  it("empty string returns empty string", () => {
    const { keep } = dedupRepetitiveTranscript("");
    expect(keep).toBe("");
  });

  it("normal sentence with one repeated word (not a 4+ word phrase) is unchanged", () => {
    // Real speech often repeats single words ("the the cat"). Spec is
    // tuned to 4+ word phrases, so single-word stutters should pass through.
    const input = "I I think this is a good idea overall.";
    const { keep } = dedupRepetitiveTranscript(input);
    expect(keep).toBe(input);
  });
});
