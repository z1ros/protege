/**
 * 50-scenario simulation of the chat-turn voice/text decision.
 *
 * Each scenario captures a realistic conversation moment (mode the user
 * is in, whether teach_step fired, what the bot's reply text looks like)
 * and the expected `shouldSpeak` outcome. The test runs all scenarios
 * through `decideShouldSpeak`, prints a table of inputs → expected →
 * actual → ms, and fails if any expected outcome is wrong.
 *
 * The scenarios are NOT just permutations — they're written as the
 * actual things a user does: ask a code question by voice, run an
 * "explain each line" tour, switch to text mid-conversation, etc. Each
 * has a one-line `intent` field so the printout is readable.
 */

import { describe, expect, it } from "vitest";
import { decideShouldSpeak, type ShouldSpeakInput } from "./shouldSpeak.js";

interface Scenario {
  intent: string;
  input: ShouldSpeakInput;
  expectSpeak: boolean;
}

// -- 50 scenarios, grouped by class so the table reads like a story ---

const scenarios: Scenario[] = [
  // ── Plain text turns (1–8) ──
  {
    intent: "text mode, simple code question",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Use a useEffect with [count] in the deps array.",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode, code review reply",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Looks good. The useState default could be `null` instead of `''`.",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode, empty reply",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode with wake on, but mode is text — stays silent",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Try memoizing the callback with useCallback.",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode with closing question — still silent (mode wins)",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Want me to refactor it for you?",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode, teach_step fired (rare, no voice channel)",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: true,
      voiceChannel: false,
      reply: "That's the gist of useEffect — questions?",
    },
    expectSpeak: false,
  },
  {
    intent: "text mode, long explanation",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "JavaScript closures capture variable references, not values. ".repeat(
        4
      ),
    },
    expectSpeak: false,
  },
  {
    intent: "text mode, code-only fenced reply",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "```ts\nconst x = 1;\n```",
    },
    expectSpeak: false,
  },

  // ── Voice mode (single-shot) (9–16) ──
  {
    intent: "voice mode, short answer",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Closures capture references, not values.",
    },
    expectSpeak: true,
  },
  {
    intent: "voice mode, follow-up question",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Are you trying to fetch on mount or on a specific event?",
    },
    expectSpeak: true,
  },
  {
    intent: "voice mode, longer narrative",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "useEffect runs after render. Empty deps means once, on mount only.",
    },
    expectSpeak: true,
  },
  {
    intent: "voice mode, empty reply (model failed)",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "",
    },
    expectSpeak: true,
  }, // mode unconditionally speaks; sanitizer downstream handles empty
  {
    intent: "voice mode, teach_step fired AND closer is question — speaks",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply:
        "What are you trying to build here — a tiny Next page or a JS sandbox?",
    },
    expectSpeak: true,
  }, // ★ THE BUG FIX
  {
    intent: "voice mode, teach_step fired with summary statement — silent",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply:
        "And that's the rundown of useEffect, useState, and how they cooperate during render.",
    },
    expectSpeak: false,
  },
  {
    intent: "voice mode, teach_step fired with very long question — silent",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply:
        "Long pseudo-summary with a tail question " +
        "filler ".repeat(60) +
        "?",
    },
    expectSpeak: false,
  }, // > 280 chars, treated as summary
  {
    intent: "voice mode, teach_step fired, closer ends with period — silent",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "We covered the deps array and stale closures.",
    },
    expectSpeak: false,
  },

  // ── Voice-dialogue mode (17–24) ──
  {
    intent: "voice-dialogue, conversational reply",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Sure, what part of the loop is confusing you?",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, multi-sentence reply",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "That's a closure issue. Capture the latest count via a ref.",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, teach_step fired with closer Q — speaks (fix)",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Does that match the behavior you were seeing?",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, teach_step fired without closer Q — silent",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "So that's how the dependency array drives the re-runs.",
    },
    expectSpeak: false,
  },
  {
    intent: "voice-dialogue, empty reply",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, single-word reply",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Yep.",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, with code fence (will be sanitized downstream)",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Try this:\n```ts\nuseMemo(() => x * 2, [x]);\n```",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, voice channel mysteriously off — still speaks",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Right, that should fix the stale closure.",
    },
    expectSpeak: true,
  }, // mode wins regardless of channel

  // ── Teaching mode (25–34) ──
  {
    intent: "teaching mode, voice channel on, has reply",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Right — that's the moment the closure is captured.",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching mode, voice channel off — silent",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Right — that's the moment the closure is captured.",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching mode, voice channel on, empty reply — silent",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching mode, teach_step fired, closer Q — speaks (fix)",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Want to try that yourself?",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching mode, teach_step fired, summary — silent",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "And that ties together what we just covered.",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching mode, teach_step fired, voice off, closer Q — silent",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: true,
      voiceChannel: false,
      reply: "Want to try that yourself?",
    },
    expectSpeak: false,
  }, // closer-Q only matters when voice channel is open
  {
    intent: "teaching mode with code reply, voice on",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Read this:\n```js\nfor (let i = 0; i < 3; i++) { ... }\n```",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching mode, very short ack",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Right.",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching mode, multiple teach_steps then closer ?",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Make sense?",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching mode, teach_step + 281-char closer ? (boundary)",
    input: {
      effectiveMode: "teaching",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Q".repeat(280) + "?",
    },
    expectSpeak: false,
  }, // > 280 → summary

  // ── Teaching-text mode (35–42) ──
  {
    intent: "teaching-text, voice on, normal reply — speaks",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Closures stay in scope after the outer function returns.",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching-text, voice off — silent (typed lesson, no speakers)",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: false,
      voiceChannel: false,
      reply: "Closures stay in scope after the outer function returns.",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching-text, voice on, empty reply — silent",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching-text, voice on, teach_step + closer ? — speaks (fix)",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Got it?",
    },
    expectSpeak: true,
  },
  {
    intent: "teaching-text, voice on, teach_step + summary — silent",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Solid recap of the closures topic.",
    },
    expectSpeak: false,
  },
  {
    intent: "teaching-text, very long teaching-text reply, voice on",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "Okay so here's the full breakdown ".repeat(10),
    },
    expectSpeak: true,
  },
  {
    intent: "teaching-text, code-only reply, voice on",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: false,
      voiceChannel: true,
      reply: "```js\nconst counter = useRef(0);\n```",
    },
    expectSpeak: true,
  }, // non-empty after trim — sanitizer downstream handles fences
  {
    intent: "teaching-text, voice on, teach_step + question with extra space",
    input: {
      effectiveMode: "teaching-text",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Make sense?   \n\n",
    },
    expectSpeak: true,
  }, // trailing whitespace stripped before /\?\s*$/

  // ── Edge cases (43–50) ──
  {
    intent: "voice mode, reply ending in ? but only whitespace before",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "?",
    },
    expectSpeak: true,
  }, // 1 char, ends with ?, ≤280
  {
    intent: "voice mode, reply ends in ?! combined",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Ready?!",
    },
    expectSpeak: false,
  }, // ends with !, not ? — not a closing-Q
  {
    intent: "voice mode, reply has ? mid-sentence then a period",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "Was that clear? Yes, it should be.",
    },
    expectSpeak: false,
  }, // ends in ., not ? — summary
  {
    intent: "voice mode, multi-? reply ending in ?",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "What are you trying? What's the goal?",
    },
    expectSpeak: true,
  },
  {
    intent: "voice-dialogue, teach_step + exact 280-char Q — speaks (boundary)",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "X".repeat(279) + "?",
    },
    expectSpeak: true,
  }, // 280 chars exact
  {
    intent: "voice-dialogue, teach_step + 281-char Q — silent (over cap)",
    input: {
      effectiveMode: "voice-dialogue",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "X".repeat(280) + "?",
    },
    expectSpeak: false,
  },
  {
    intent: "voice mode, reply with leading whitespace + Q",
    input: {
      effectiveMode: "voice",
      teachStepWasCalled: true,
      voiceChannel: true,
      reply: "   \n\n  What's next for you?  ",
    },
    expectSpeak: true,
  }, // trim before length check
  {
    intent: "text mode, reply is a question — still silent (mode controls)",
    input: {
      effectiveMode: "text",
      teachStepWasCalled: true,
      voiceChannel: false,
      reply: "Was that helpful?",
    },
    expectSpeak: false,
  },
];

if (scenarios.length !== 50) {
  throw new Error(`Expected 50 scenarios, got ${scenarios.length}`);
}

describe("decideShouldSpeak — 50-scenario simulation", () => {
  it("matches expected outcome on every scenario and prints a report", () => {
    const rows: Array<{
      n: number;
      intent: string;
      mode: string;
      ts: string;
      vc: string;
      replyLen: number;
      endsQ: string;
      expected: string;
      actual: string;
      ok: string;
      ms: string;
    }> = [];

    let mismatches = 0;
    let totalNs = 0n;

    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      const t0 = process.hrtime.bigint();
      const actual = decideShouldSpeak(sc.input);
      const dtNs = process.hrtime.bigint() - t0;
      totalNs += dtNs;
      const ok = actual === sc.expectSpeak;
      if (!ok) mismatches++;
      rows.push({
        n: i + 1,
        intent: sc.intent.slice(0, 60),
        mode: sc.input.effectiveMode,
        ts: sc.input.teachStepWasCalled ? "y" : "n",
        vc: sc.input.voiceChannel ? "y" : "n",
        replyLen: sc.input.reply.length,
        endsQ: /[?]\s*$/.test(sc.input.reply.trim()) ? "y" : "n",
        expected: sc.expectSpeak ? "VOICE" : "text ",
        actual: actual ? "VOICE" : "text ",
        ok: ok ? "✓" : "✗",
        ms: (Number(dtNs) / 1_000_000).toFixed(3),
      });
    }

    // Print human-readable table.
    const header =
      "  # | result | mode             | ts vc | len | endsQ | exp   | got   |  ms     | intent";
    const sep = "----+--------+------------------+-------+-----+-------+-------+-------+---------+--------------------------------------------------------------";
    // eslint-disable-next-line no-console
    console.log("\n" + header + "\n" + sep);
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        ` ${String(r.n).padStart(2)} |   ${r.ok}    | ${r.mode.padEnd(16)} |  ${r.ts}  ${r.vc}   | ${String(r.replyLen).padStart(3)} |   ${r.endsQ}   | ${r.expected} | ${r.actual} | ${r.ms.padStart(7)} | ${r.intent}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(sep);
    const totalMs = (Number(totalNs) / 1_000_000).toFixed(3);
    const speakCount = rows.filter((r) => r.actual === "VOICE").length;
    // eslint-disable-next-line no-console
    console.log(
      `summary: 50 scenarios, ${speakCount} VOICE / ${50 - speakCount} text · total ${totalMs}ms · mismatches ${mismatches}\n`
    );

    expect(mismatches).toBe(0);
  });
});
