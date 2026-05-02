#!/usr/bin/env node
// Voice persona simulator. Sends 30 voice-shaped questions through
// the same persona prompt the backend uses, scores each response.

import { readFileSync } from "node:fs";
import OpenAI from "openai";

// Pull API key from backend's .env
const env = readFileSync(
  "/Users/Yura/Documents/GitHub/protege/apps/backend/.env",
  "utf8"
);
const apiKeyLine = env.split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
if (!apiKeyLine) throw new Error("OPENAI_API_KEY missing");
const apiKey = apiKeyLine.split("=")[1].trim().replace(/^["']|["']$/g, "");

const openai = new OpenAI({ apiKey });

// Import the persona builder. Since it's TS, use the compiled output.
const { buildSystemPrompt } = await import(
  "/Users/Yura/Documents/GitHub/protege/apps/backend/dist/prompts/persona.js"
);

const systemPrompt = buildSystemPrompt("voice");

// Inline copy of trimForVoice from apps/extension/src/teaching/explainMode.ts.
// Mirrors the production post-processor exactly so the sim measures what
// the user will actually see.
function trimForVoice(text, maxWords = 50) {
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
  // No good early boundary; just hard-stop at the cap with ellipsis.
  return rough.trim() + "…";
}

// 30 questions — mix of TYPE A (conceptual), TYPE B (code-specific),
// short commands, and mode-corner-cases. Goal: see if persona holds.
const TESTS = [
  // ─── TYPE A — conceptual / "in general" — SHOULD NOT call code tools ───
  { id: "A1", q: "Why do we use JavaScript at all?" },
  { id: "A2", q: "What's a closure?" },
  { id: "A3", q: "How do people use TypeScript in general?" },
  { id: "A4", q: "Why does React exist?" },
  { id: "A5", q: "What is async-await?" },
  { id: "A6", q: "Explain promises to me." },
  { id: "A7", q: "What's the point of useEffect?" },
  { id: "A8", q: "Why would I use Tailwind over plain CSS?" },
  { id: "A9", q: "What is server-side rendering?" },
  { id: "A10", q: "Tell me what Node.js is." },
  // ─── TYPE B — about code, MAY use highlight_code/teach_step ───
  { id: "B1", q: "Explain this useState call to me." },
  { id: "B2", q: "Why is this function broken?" },
  { id: "B3", q: "What does line 12 do?" },
  { id: "B4", q: "Why does the page not update when I click?" },
  { id: "B5", q: "Walk me through this component." },
  // ─── BUILD requests — should write code ───
  { id: "C1", q: "Add a click handler that increments the counter." },
  { id: "C2", q: "Set up Swiper for me." },
  { id: "C3", q: "Hook up a filter dropdown." },
  // ─── Short / casual ───
  { id: "S1", q: "Got it." },
  { id: "S2", q: "Yeah." },
  { id: "S3", q: "Continue." },
  // ─── Tricky / edge cases ───
  { id: "E1", q: "Honestly, I'm not sure. Maybe just explain the concept?" },
  { id: "E2", q: "Why do we use JavaScript? Like, in general." },
  { id: "E3", q: "Tell me more." },
  { id: "E4", q: "Can you explain a bit deeper why?" },
  { id: "E5", q: "Confirm — JavaScript runs in the browser, right?" },
  { id: "E6", q: "What's the difference between let and const?" },
  { id: "E7", q: "Show me how to add a button." },
  { id: "E8", q: "What does this do?" },
  { id: "E9", q: "Stop." },
];

// Scoring helpers
const wordCount = (s) =>
  s
    .replace(/[.!?,;:—()]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

// Question types — only some flags apply to some types.
//   A = conceptual / "in general" — must NOT offer code, must NOT highlight
//   B = about THIS file's code — highlight is fine, code talk is fine
//   C = explicit BUILD request — code offer is correct, just keep it short
//   S = short reaction (got it, yeah, continue) — short reply expected
//   E = edge case — depends on shape
const TYPE_FOR = (id) => id[0]; // A1 → A, B5 → B, etc.

const flags = (q, reply, type) => {
  const f = [];
  const wc = wordCount(reply);

  // Voice persona HARD CAP = 50 words. Apply to all types.
  if (wc > 50) f.push(`OVER_WORD_CAP(${wc})`);
  // Soft cap (target = 30 words). Warning, not failure.
  if (wc > 30) f.push(`over-soft-cap(${wc})`);

  // Markdown leakage — applies to ALL replies (TTS chokes on it).
  if (/```|`[^`]+`|\*\*|##|^- |^\d+\./m.test(reply)) f.push("MARKDOWN");

  // Banned filler / preamble — applies to all
  if (/^(great question|absolutely|certainly|sure thing|happy to|let me explain|so,)/i.test(reply.trim())) {
    f.push("PREAMBLE");
  }
  // "Let me know" / "any questions" — applies to all
  if (/let me know|any other question|feel free to|hope this helps/i.test(reply)) {
    f.push("FILLER_CLOSER");
  }

  // Metaphor / "imagine if" / "think of it like" — voice-mode persona forbids
  if (/imagine (if|that)|think of it like|picture (a|the)|like a (recipe|book)/i.test(reply)) {
    f.push("METAPHOR");
  }

  // TYPE A specific — conceptual questions
  if (type === "A") {
    // Code-offer language on a TYPE A question = persona violation
    const codeOffer = /(want me to|should i|let me) (drop|write|add|build|insert|put together|show you a|create|paste|generate)\b/i.test(reply) ||
      /tiny script|small example|let me code|build an example|i'll write|i'll add|drop in a/i.test(reply);
    if (codeOffer) f.push("CODE_OFFER_TYPE_A");

    // "I'll open the file" / "let me check your code" / "highlight" — wrong tool for conceptual Q
    if (/i'?ll (open|check|look at|highlight|read|scan)|let me (open|check|highlight|look)|in your (file|code|editor)/i.test(reply)) {
      f.push("FILE_REFERENCE_TYPE_A");
    }
  }

  return f;
};

console.log(`\nVoice persona sim — ${TESTS.length} cases\n`);
console.log("─".repeat(80));

let totalCost = 0;
let perfectCount = 0;
const failures = [];

for (const t of TESTS) {
  process.stdout.write(`${t.id}: ${t.q.slice(0, 50).padEnd(50)} `);
  try {
    const res = await openai.chat.completions.create({
      // gpt-5 (not mini) per user instruction 2026-05-02 — chat replies
      // use the full premium model.
      model: "gpt-5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: t.q },
      ],
      max_completion_tokens: 4096,
      reasoning_effort: "low",
    });
    const rawReply = res.choices[0]?.message?.content?.trim() ?? "";
    // Apply the same post-processor the extension applies in voice
    // mode — strip markdown, trim to last sentence boundary at-or-
    // before 50 words. Mirrors trimForVoice() in apps/extension/src/
    // teaching/explainMode.ts.
    const reply = trimForVoice(rawReply, 35);
    const wc = wordCount(reply);
    const type = TYPE_FOR(t.id);
    const fl = wc === 0 ? ["EMPTY_REPLY"] : flags(t.q, reply, type);
    const usage = res.usage;
    // gpt-5 pricing: $1.25/M input, $10/M output (rough — adjust as needed).
    const cost =
      ((usage?.prompt_tokens ?? 0) * 1.25 +
        (usage?.completion_tokens ?? 0) * 10) /
      1_000_000;
    totalCost += cost;

    // "Real" failures = anything other than the soft-cap warning.
    // Hard cap, code offers on TYPE A, file references on TYPE A,
    // markdown leak, preamble, filler closer, metaphor — all real.
    const realFailures = fl.filter((x) => !x.startsWith("over-soft-cap"));
    const flagStr =
      fl.length === 0
        ? "✅"
        : realFailures.length === 0
          ? "🟡 " + fl.join(" ")
          : "❌ " + fl.join(" ");
    console.log(`${wc}w  ${flagStr}`);
    if (realFailures.length === 0) perfectCount++;
    else failures.push({ id: t.id, q: t.q, reply, flags: fl, words: wc });
  } catch (err) {
    console.log(`ERR ${err.message}`);
  }
}

console.log("─".repeat(80));
console.log(`\nResults: ${perfectCount}/${TESTS.length} clean · failures: ${TESTS.length - perfectCount}`);
console.log(`Total cost: $${totalCost.toFixed(4)}\n`);

if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(`\n[${f.id}] ${f.q}`);
    console.log(`  flags: ${f.flags.join(", ")}  (${f.words} words)`);
    console.log(`  reply: ${f.reply.replace(/\n/g, " ").slice(0, 240)}`);
  }
}
