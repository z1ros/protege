import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "./hmm.js";
import { computePillars } from "./pillars.js";

describe("Iq3 pillar projection", () => {
  it("returns 6 pillars from any state", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(Object.keys(p)).toEqual([
      "reading",
      "writing",
      "debugging",
      "testing",
      "maintainability",
      "aiLiteracy",
    ]);
  });

  it("uniform prior maps to ~500 calibrated pillar score (with low confidence)", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(p.reading.score).toBeGreaterThan(450);
    expect(p.reading.score).toBeLessThan(550);
  });

  it("strong positive evidence raises pillar score above 700", () => {
    let s = initialUserState("u1");
    for (let i = 0; i < 8; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
      ]);
    }
    const p = computePillars(s);
    expect(p.reading.score).toBeGreaterThan(700);
  });

  it("AI Partnership is pending when ai_event_count is 0", () => {
    const s = initialUserState("u1");
    const p = computePillars(s);
    expect(p.aiLiteracy.pending).toBe(true);
    expect(p.aiLiteracy.score).toBe(500);
  });

  it("AI Partnership is non-pending after enough AI events", () => {
    let s = initialUserState("u1");
    for (let i = 0; i < 10; i++) {
      s = applyMatchKeys(s, ["chat_turn.intent=specific.charCount>=120"], {
        isAiEvent: true,
      });
    }
    const p = computePillars(s);
    expect(p.aiLiteracy.pending).toBe(false);
  });
});
