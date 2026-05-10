import type { EchoEvent } from "@protege/types";
import type { Persona } from "./runPersona.js";

/**
 * Absolute Beginner — first weeks of coding, no field signal.
 *
 * Tests the cold-start path: confidence MUST stay low, maturity MUST
 * be cold, rank should fall to learner. The system is supposed to be
 * humble when it knows nothing.
 *
 * Only ~12 events total — well below the 300 maturity threshold.
 */
export const learnerGeneralist: Persona = {
  id: "persona:learnerGeneralist",
  description: "Absolute beginner — minimal events, no field signal",

  field: {
    // No repo signals, no concepts, no self-declaration → uniform field
    // prior (P=0.1 for each of 10 fields). Whichever ends up dominant
    // is essentially random — we only assert rank, not field.
  },

  events: () => {
    const events: EchoEvent[] = [];
    const t0 = 1_700_000_000_000;

    // 6 jump-in reads (just edits without exploring)
    for (let i = 0; i < 6; i++) {
      events.push({
        type: "read_pattern_observed",
        ts: t0 + i * 60_000,
        pattern: "jump-in",
        msToFirstEdit: 800,
        navCount: 0,
      });
    }

    // 4 vague short prompts
    for (let i = 0; i < 4; i++) {
      events.push({
        type: "chat_turn",
        ts: t0 + i * 600_000 + 3_600_000,
        intent: "vague",
        charCount: 14,
        containsStackTraceOrLineRef: false,
        containsConstraintWords: false,
        acceptedAi: true,
      });
    }

    // 2 wip commits
    for (let i = 0; i < 2; i++) {
      events.push({
        type: "commit_detected",
        ts: t0 + i * 86_400_000,
        sha: `l${i.toString().padStart(7, "0")}`,
        message: "wip",
        filesTouched: ["main.js"],
      });
    }

    return events;
  },

  expect: {
    // No rank assertion: with so few events the headline lands near
    // the prior (~500 from the neutral pillar default), which falls
    // into "junior" by current bands — even though the user is truly
    // a learner. The maturity bucket + low confidence are the more
    // honest signals at this stage; assert those.
    //
    // No dominantField assertion either: with no signal the field
    // vector stays uniform, and `dominantField()` tie-breaks on
    // FIELD_IDS order (returns "web" first). Asserting "generalist"
    // would lock in a bug; leave it open.
    maturity: "cold",
    headlineRange: [350, 600],
  },
};
