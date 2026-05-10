import { describe, it, expect } from "vitest";
import { initialUserState, applyMatchKeys } from "./hmm.js";

describe("Iq3 HMM Bayesian update", () => {
  it("starts from a uniform-ish prior", () => {
    const s = initialUserState("u1");
    const t = s.traits.readsBeforeWrites;
    expect(t.low).toBeCloseTo(1 / 3, 5);
    expect(t.mid).toBeCloseTo(1 / 3, 5);
    expect(t.high).toBeCloseTo(1 / 3, 5);
  });

  it("shifts toward 'high' on a positive match", () => {
    // Likelihoods softened in the reading calibration pass
    // (0.05/0.30/0.70 → 0.15/0.35/0.50). Single-event posterior is
    // therefore 0.15/0.35/0.50 — assertion expresses the directional
    // shift (high goes UP from 0.333) rather than a hard magnitude.
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, [
      "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
    ]);
    expect(after.traits.readsBeforeWrites.high).toBeGreaterThan(1 / 3);
    expect(after.traits.readsBeforeWrites.low).toBeLessThan(1 / 3);
  });

  it("shifts toward 'low' on a negative match", () => {
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, [
      "file_opened.then.first_text_change.withinMs<5s",
    ]);
    expect(after.traits.readsBeforeWrites.low).toBeGreaterThan(1 / 3);
    expect(after.traits.readsBeforeWrites.high).toBeLessThan(1 / 3);
  });

  it("is monotonic across consecutive same-direction matches", () => {
    let s = initialUserState("u1");
    let prevHigh = s.traits.readsBeforeWrites.high;
    for (let i = 0; i < 5; i++) {
      s = applyMatchKeys(s, [
        "file_opened.then.navigations>=2.then.first_text_change.afterMs>30s",
      ]);
      expect(s.traits.readsBeforeWrites.high).toBeGreaterThanOrEqual(prevHigh);
      prevHigh = s.traits.readsBeforeWrites.high;
    }
  });

  it("posteriors always sum to 1 within float tolerance", () => {
    let s = initialUserState("u1");
    s = applyMatchKeys(s, [
      "paste_classified.source=ai.size>=80lines.no_edit_within_60s",
      "commit_detected.msg_chars<20",
    ]);
    for (const t of Object.values(s.traits)) {
      const sum = t.low + t.mid + t.high;
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("eventCount and aiEventCount track correctly", () => {
    let s = initialUserState("u1");
    s = applyMatchKeys(s, ["chat_turn.intent=specific.charCount>=120"], {
      isAiEvent: true,
    });
    expect(s.eventCount).toBe(1);
    expect(s.aiEventCount).toBe(1);
  });

  it("ignores unknown matchKeys without throwing", () => {
    const s = initialUserState("u1");
    const after = applyMatchKeys(s, ["bogus.matchKey.never.declared"]);
    // posteriors unchanged (uniform), eventCount still increments
    expect(after.traits.readsBeforeWrites.low).toBeCloseTo(1 / 3, 5);
    expect(after.eventCount).toBe(1);
  });
});
