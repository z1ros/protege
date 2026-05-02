#!/usr/bin/env node
// Voice dialogue simulator. 15 multi-turn conversations, scores each
// turn for persona compliance, then scores the whole thread for
// coherence + drift.

import { readFileSync } from "node:fs";
import OpenAI from "openai";

const env = readFileSync(
  "/Users/Yura/Documents/GitHub/protege/apps/backend/.env",
  "utf8"
);
const apiKey = env
  .split("\n")
  .find((l) => l.startsWith("OPENAI_API_KEY="))
  .split("=")[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const openai = new OpenAI({ apiKey });

const { buildSystemPrompt } = await import(
  "/Users/Yura/Documents/GitHub/protege/apps/backend/dist/prompts/persona.js"
);
const systemPrompt = buildSystemPrompt("voice");

// Inline trimForVoice mirroring extension/src/teaching/explainMode.ts.
function trimForVoice(text, maxWords = 35) {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(" ");
  if (words.length <= maxWords) return stripped;
  const rough = words.slice(0, maxWords).join(" ");
  const lastPeriodBefore = Math.max(
    rough.lastIndexOf(". "),
    rough.lastIndexOf("! "),
    rough.lastIndexOf("? ")
  );
  if (lastPeriodBefore > rough.length / 3) {
    return rough.slice(0, lastPeriodBefore + 1).trim();
  }
  return rough.trim() + "…";
}

// 15 multi-turn voice dialogues. Each turn is what the user says; the
// dialogue runs to the configured length, threading prior assistant
// replies in as conversation history.
const DIALOGUES = [
  {
    id: "D1-conceptual-deepening",
    type: "A",
    turns: [
      "Why do we use JavaScript at all?",
      "Tell me a bit more about why it works in browsers.",
      "What about TypeScript then?",
      "Got it.",
    ],
  },
  {
    id: "D2-build-progressive",
    type: "C",
    turns: [
      "Add a counter component for me.",
      "Now make the count text red.",
      "Persist it to localStorage.",
      "Thanks.",
    ],
  },
  {
    id: "D3-walkthrough-paced",
    type: "B",
    turns: [
      "Walk me through this component line by line.",
      "Continue.",
      "What does that hook actually do?",
      "Next.",
    ],
  },
  {
    id: "D4-debug-flow",
    type: "B",
    turns: [
      "The page doesn't update when I click.",
      "It's a button inside a form. Help.",
      "OK I added preventDefault. What else?",
    ],
  },
  {
    id: "D5-confused-recovery",
    type: "A",
    turns: [
      "What's a closure?",
      "I don't get it.",
      "Slower please.",
      "OK that helped.",
    ],
  },
  {
    id: "D6-off-topic-return",
    type: "E",
    turns: [
      "Explain useState.",
      "Wait, why is the sky blue?",
      "Anyway, back to useState — what about updating arrays?",
    ],
  },
  {
    id: "D7-yes-no-followups",
    type: "S",
    turns: [
      "What's a Promise?",
      "Yes.",
      "Yes please.",
      "No, the other one.",
    ],
  },
  {
    id: "D8-beginner-onboarding",
    type: "A",
    turns: [
      "I'm completely new to coding. Where do I start?",
      "I want to build a website.",
      "OK so HTML first?",
    ],
  },
  {
    id: "D9-comparative",
    type: "A",
    turns: [
      "What's the difference between let and const?",
      "What about var?",
      "When would I ever use var?",
    ],
  },
  {
    id: "D10-async-deep",
    type: "A",
    turns: [
      "Explain async-await.",
      "Why not just callbacks?",
      "Show me an example.",
    ],
  },
  {
    id: "D11-react-lifecycle",
    type: "A",
    turns: [
      "What does useEffect actually do?",
      "When should I use the dependency array?",
      "What about cleanup?",
    ],
  },
  {
    id: "D12-css-question",
    type: "A",
    turns: [
      "What's flexbox?",
      "How is it different from grid?",
      "When do I use which?",
    ],
  },
  {
    id: "D13-error-handling",
    type: "B",
    turns: [
      "I'm getting 'Cannot read property of undefined'.",
      "It happens when the API is slow.",
      "OK so optional chaining?",
    ],
  },
  {
    id: "D14-stop-mid-flow",
    type: "S",
    turns: [
      "Teach me about Promises.",
      "Stop.",
      "Sorry, continue.",
    ],
  },
  {
    id: "D15-confirm-then-build",
    type: "C",
    turns: [
      "Should I use Tailwind?",
      "OK convince me.",
      "Fine, set it up for me then.",
    ],
  },
];

const wordCount = (s) =>
  s
    .replace(/[.!?,;:—()]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

// Reuse the per-turn flags from the single-shot sim, plus thread-level
// checks below.
function turnFlags(reply, type) {
  const f = [];
  const wc = wordCount(reply);
  if (wc > 50) f.push(`OVER_HARD_CAP(${wc})`);
  if (wc > 35) f.push(`over-trim-cap(${wc})`);
  if (/```|`[^`]+`|\*\*|##|^- |^\d+\./m.test(reply)) f.push("MARKDOWN");
  if (/^(great question|absolutely|certainly|sure thing|happy to|let me explain|so,)/i.test(reply.trim())) f.push("PREAMBLE");
  if (/let me know|any other question|feel free to|hope this helps/i.test(reply)) f.push("FILLER_CLOSER");
  if (/imagine (if|that)|think of it like|picture (a|the)|like a (recipe|book)/i.test(reply)) f.push("METAPHOR");
  if (type === "A") {
    const codeOffer =
      /(want me to|should i|let me) (drop|write|add|build|insert|put together|show you a|create|paste|generate)\b/i.test(reply) ||
      /tiny script|small example|let me code|build an example|i'll write|drop in a/i.test(reply);
    if (codeOffer) f.push("CODE_OFFER_TYPE_A");
    if (/i'?ll (open|check|look at|highlight|read|scan)|let me (open|check|highlight|look)|in your (file|code|editor)/i.test(reply)) {
      f.push("FILE_REFERENCE_TYPE_A");
    }
  }
  return f;
}

// Thread-level checks: did the bot stay on topic? Did it grow longer
// over turns (drift toward verbosity)?
function threadFlags(turns) {
  const f = [];
  const lengths = turns.map((t) => wordCount(t.reply));
  // Drift: average of last half should not be 1.5× the first half
  const half = Math.floor(turns.length / 2);
  if (turns.length >= 4) {
    const firstAvg = lengths.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const lastAvg =
      lengths.slice(-half).reduce((a, b) => a + b, 0) / half;
    if (firstAvg > 0 && lastAvg > firstAvg * 1.5) {
      f.push(`LENGTH_DRIFT(${firstAvg.toFixed(0)}→${lastAvg.toFixed(0)})`);
    }
  }
  // Repetition: any two consecutive replies that are textually almost identical
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1].reply.toLowerCase();
    const b = turns[i].reply.toLowerCase();
    if (a.length > 30 && b.length > 30) {
      const aWords = new Set(a.split(/\s+/));
      const bWords = new Set(b.split(/\s+/));
      let inter = 0;
      for (const w of aWords) if (bWords.has(w)) inter++;
      const j = inter / (aWords.size + bWords.size - inter);
      if (j > 0.7) f.push(`REPEAT_T${i - 1}_T${i}(jaccard=${j.toFixed(2)})`);
    }
  }
  return f;
}

console.log(`\nVoice dialogue sim — ${DIALOGUES.length} threads\n`);

let totalCost = 0;
let cleanThreads = 0;
const results = [];

for (const d of DIALOGUES) {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`${d.id} (TYPE ${d.type})`);
  console.log("═".repeat(80));

  const messages = [{ role: "system", content: systemPrompt }];
  const turns = [];
  for (let i = 0; i < d.turns.length; i++) {
    const userTurn = d.turns[i];
    messages.push({ role: "user", content: userTurn });
    process.stdout.write(`  T${i + 1} USR: ${userTurn}\n`);
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-5",
        messages,
        max_completion_tokens: 4096,
        reasoning_effort: "low",
      });
      const raw = res.choices[0]?.message?.content?.trim() ?? "";
      const reply = trimForVoice(raw, 35);
      const wc = wordCount(reply);
      const fl = wc === 0 ? ["EMPTY_REPLY"] : turnFlags(reply, d.type);
      const usage = res.usage;
      const cost =
        ((usage?.prompt_tokens ?? 0) * 1.25 +
          (usage?.completion_tokens ?? 0) * 10) /
        1_000_000;
      totalCost += cost;
      messages.push({ role: "assistant", content: reply });
      turns.push({ user: userTurn, reply, words: wc, flags: fl });

      const flagStr = fl.length === 0 ? "✅" : "⚠️ " + fl.join(" ");
      console.log(`     BOT: ${reply.replace(/\n/g, " ")}`);
      console.log(`          ${wc}w  ${flagStr}`);
    } catch (err) {
      console.log(`     BOT ERR: ${err.message}`);
      break;
    }
  }
  const tFlags = threadFlags(turns);
  const allTurnFlags = turns.flatMap((t) => t.flags.filter((f) => !f.startsWith("over-trim-cap")));
  const realFailures = [...allTurnFlags, ...tFlags];
  if (realFailures.length === 0) {
    cleanThreads++;
    console.log(`  THREAD: ✅ clean`);
  } else {
    console.log(`  THREAD: ❌ ${realFailures.join(", ")}`);
  }
  results.push({ id: d.id, turns, threadFlags: tFlags, ok: realFailures.length === 0 });
}

console.log(`\n${"═".repeat(80)}`);
console.log(`Results: ${cleanThreads}/${DIALOGUES.length} clean threads`);
console.log(`Total cost: $${totalCost.toFixed(4)}`);
console.log(`${"═".repeat(80)}\n`);
