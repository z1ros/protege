#!/usr/bin/env node
// Text-mode persona sim. 12 questions across shapes; verifies the
// 200-word cap holds AND that trimForText doesn't break code/markdown.

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
const systemPrompt = buildSystemPrompt("text");

// Inline copy of trimForText mirroring extension/src/teaching/explainMode.ts.
function trimForText(text, maxWords = 200) {
  const proseView = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\*\*|\*|_|~/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = proseView.split(" ").filter(Boolean).length;
  if (wordCount <= maxWords) return text;

  let inFence = false;
  let inBacktick = false;
  let words = 0;
  let lastWasWordChar = false;
  let lastParagraphBreak = -1;
  let lastSentenceEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (text.slice(i, i + 3) === "```") {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (!inFence && c === "`") {
      inBacktick = !inBacktick;
      continue;
    }
    if (inFence || inBacktick) continue;
    const isWordChar = /[A-Za-z0-9'-]/.test(c);
    if (isWordChar && !lastWasWordChar) words++;
    lastWasWordChar = isWordChar;
    if (c === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      if (words <= maxWords) lastParagraphBreak = i;
    }
    if ((c === "." || c === "!" || c === "?") && i + 1 < text.length && /[\s\n]/.test(text[i + 1])) {
      if (words <= maxWords) lastSentenceEnd = i + 1;
    }
    if (words > maxWords) break;
  }

  if (lastParagraphBreak > 0) return text.slice(0, lastParagraphBreak).trimEnd();
  if (lastSentenceEnd > 0) return text.slice(0, lastSentenceEnd).trimEnd();
  return text.slice(0, Math.floor(text.length * (maxWords / wordCount))).trimEnd() + "…";
}

const wordCount = (s) =>
  s.replace(/[.!?,;:—()]/g, " ").split(/\s+/).filter(Boolean).length;
const proseWordCount = (s) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\*\*|\*|_|~/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/[.!?,;:—()]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

// Edge-case unit tests for trimForText itself.
console.log("\n=== UNIT TESTS for trimForText ===");
const tests = [
  {
    name: "under cap → verbatim (no mutation)",
    input: "Hello world. This is fine.",
    maxWords: 200,
    check: (out, inp) => out === inp,
  },
  {
    name: "over cap, breaks at paragraph",
    // 30 words then \n\n then 100 more. Cap=50 → break should land at \n\n (word 30).
    input: "word ".repeat(30).trim() + "\n\nlater " + "more ".repeat(100),
    maxWords: 50,
    check: (out) => /\bword\b/.test(out) && !/\bmore\b/.test(out),
  },
  {
    name: "preserves code fence in short reply",
    input: "Here's an example:\n\n```ts\nconst x = 1;\n```\n\nThat's it.",
    maxWords: 200,
    check: (out) => out.includes("```ts") && out.includes("```\n\nThat"),
  },
  {
    name: "preserves inline backticks",
    input: "Use `useState` for state. Done.",
    maxWords: 200,
    check: (out) => out.includes("`useState`"),
  },
  {
    name: "preserves headers + bold in short reply",
    input: "# Header\n\n**bold** text here.",
    maxWords: 200,
    check: (out) => out.includes("**bold**") && out.includes("# Header"),
  },
  {
    name: "code fence inside cap stays intact",
    // 20 words prose + code fence + 10 more words. Cap=200 → no trim.
    input: "Here is the explanation in words. " + "blah ".repeat(15).trim() + "\n\n```js\nfunction foo() { return 1; }\n```\n\nThat is all.",
    maxWords: 200,
    check: (out) => out.includes("```js") && out.includes("function foo()"),
  },
  {
    name: "fence words don't count toward cap",
    // 20 prose words + ENORMOUS code block + 5 prose. Cap=30 should NOT trim the code.
    input: "intro " + "word ".repeat(19).trim() + "\n\n```\n" + "code line\n".repeat(50) + "```\n\nend.",
    maxWords: 30,
    // After trim, output should be the full thing (under cap because code doesn't count).
    check: (out, inp) => out === inp,
  },
  {
    name: "trims long bullet list at sentence break",
    input: "Intro paragraph. Now bullets:\n\n- one item here\n- two item here\n- three item here\n- four item here\n- five item here\n- six item here\n- seven item here\n- eight item here\n- nine item here\n- ten item here.",
    maxWords: 15,
    check: (out) => out.length < "Intro paragraph. Now bullets:\n\n- one item here\n- two item here\n- three item here\n- four item here\n- five item here\n- six item here\n- seven item here\n- eight item here\n- nine item here\n- ten item here.".length,
  },
];
let unitPass = 0;
for (const t of tests) {
  const out = trimForText(t.input, t.maxWords);
  const ok = t.check(out, t.input);
  console.log(`  ${ok ? "✅" : "❌"}  ${t.name}`);
  if (!ok) {
    console.log(`     in:  ${JSON.stringify(t.input.slice(0, 100))}`);
    console.log(`     out: ${JSON.stringify(out.slice(0, 150))}`);
  } else unitPass++;
}
console.log(`  ${unitPass}/${tests.length} unit tests pass\n`);

const TESTS = [
  { id: "T1", q: "Explain how we use JavaScript in general." },
  { id: "T2", q: "What is a closure?" },
  { id: "T3", q: "Why does React exist?" },
  { id: "T4", q: "Show me how to fetch data in React." },
  { id: "T5", q: "What does this useEffect do?" },
  { id: "T6", q: "I'm getting Cannot read property of undefined." },
  { id: "T7", q: "Add a click handler to my counter." },
  { id: "T8", q: "Got it." },
  { id: "T9", q: "Tell me about Promises." },
  { id: "T10", q: "What's the difference between let and const?" },
  { id: "T11", q: "How does TypeScript help?" },
  { id: "T12", q: "Walk me through this component." },
];

const flags = (q, reply) => {
  const f = [];
  const wc = proseWordCount(reply);
  // Hard cap is 200 — trimForText guarantees this
  if (wc > 200) f.push(`OVER_HARD_CAP(${wc})`);
  // Soft target is 60-120 — warn outside
  if (wc > 150) f.push(`over-target(${wc})`);
  // No more than 4 headers
  const headerCount = (reply.match(/^#+\s/gm) || []).length;
  if (headerCount > 4) f.push(`TOO_MANY_HEADERS(${headerCount})`);
  // No more than 8 bullets
  const bulletCount = (reply.match(/^[-*]\s/gm) || []).length;
  if (bulletCount > 8) f.push(`TOO_MANY_BULLETS(${bulletCount})`);
  // No 8+ paragraphs (\n\n separated). Bullet sub-blocks count as
  // paragraphs in markdown — 7 is borderline, 8+ is definite encyclopedia.
  const paraCount = reply.split(/\n\n+/).length;
  if (paraCount > 7) f.push(`TOO_MANY_PARAS(${paraCount})`);
  // Code-fence integrity — must be balanced
  const fenceCount = (reply.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) f.push(`BROKEN_CODE_FENCE`);
  return f;
};

console.log(`\n=== TEXT-MODE PERSONA SIM (${TESTS.length} cases) ===\n`);

let totalCost = 0;
let cleanCount = 0;
const failures = [];

for (const t of TESTS) {
  process.stdout.write(`${t.id}: ${t.q.slice(0, 50).padEnd(50)} `);
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: t.q },
      ],
      max_completion_tokens: 4096,
      reasoning_effort: "low",
    });
    const raw = res.choices[0]?.message?.content?.trim() ?? "";
    const reply = trimForText(raw, 200);
    const rawWc = proseWordCount(raw);
    const trimWc = proseWordCount(reply);
    const fl = flags(t.q, reply);
    const usage = res.usage;
    const cost =
      ((usage?.prompt_tokens ?? 0) * 1.25 + (usage?.completion_tokens ?? 0) * 10) / 1_000_000;
    totalCost += cost;
    const trimmed = rawWc !== trimWc ? `(was ${rawWc}w → trimmed ${trimWc}w)` : `(${trimWc}w)`;
    const flagStr = fl.length === 0 ? "✅" : "❌ " + fl.join(" ");
    console.log(`${trimmed.padEnd(28)} ${flagStr}`);
    if (fl.length === 0) cleanCount++;
    else failures.push({ id: t.id, q: t.q, raw, reply, flags: fl, rawWc, trimWc });
  } catch (err) {
    console.log(`ERR ${err.message}`);
  }
}

console.log(`\nResults: ${cleanCount}/${TESTS.length} clean`);
console.log(`Total cost: $${totalCost.toFixed(4)}\n`);

if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(`\n[${f.id}] ${f.q}`);
    console.log(`  raw: ${f.rawWc}w · trimmed: ${f.trimWc}w · flags: ${f.flags.join(", ")}`);
    console.log(`  output (first 300 chars): ${f.reply.replace(/\n/g, "↵").slice(0, 300)}`);
  }
}
