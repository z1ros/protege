/**
 * Teaching-style simulation — verifies our pedagogy implementation.
 *
 * Runs two scenarios:
 *
 *   A) VOICE-DIALOGUE teaching ("teach me X" said aloud)
 *      → expects chained teach_step beats with audio pacing
 *      → expects bot to ASK before showing more (one beat per turn)
 *      → tracks: beats per turn, narration length, highlight↔speech sync
 *
 *   B) TEACHING-TEXT teaching ("teach me X" typed in chat)
 *      → expects one beat per turn (not a wall of text)
 *      → expects quiz-shaped questions to verify understanding
 *      → expects "want me to keep going?" invitation between beats
 *      → tracks: words per turn, question-shape, highlight_code use
 *
 * Each scenario is a 4-turn loop where an "AI student" plays the
 * learner role, replying naturally between bot turns.
 *
 * Provider: Whatever AI_PROVIDER points at (default openai → GPT-5).
 * Calls go through Anthropic SDK directly with the production system
 * prompt and tool list — bypasses backend auth/HTTP for fast iteration.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

import { buildSystemPrompt } from "../src/prompts/persona.js";
import { TOOL_DEFINITIONS } from "../src/aiTools.js";

function loadEnv(path: string): void {
  const txt = readFileSync(path, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv("/Users/Yura/Documents/GitHub/protege/apps/backend/.env");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not loaded (sim runs against Anthropic for parity with persona prompt; production uses OpenAI but the prompt is the same)");
const client = new Anthropic({ apiKey });
const MODEL = "claude-haiku-4-5";

// ── target file ──────────────────────────────────────────────────
const MOCK_FILE_PATH = "/Users/Yura/Desktop/todo-demo/app/page.tsx";
const MOCK_FILE_CONTENT = `'use client'

import { useState } from 'react'

export default function Page() {
  let [todo, setTodo] = useState()
  let [gsg, setGG] = useState()

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 16 }}>
      <h2>While loop demo</h2>
    </div>
  )
}
`;

// ── helpers ───────────────────────────────────────────────────────
const CHARS_PER_SEC = 14;
const SPAWN_OVERHEAD_MS = 30;
function ttsPlaybackMs(text: string): number {
  return Math.round((text.length / CHARS_PER_SEC) * 1000) + SPAWN_OVERHEAD_MS;
}

interface Beat {
  turn: number;
  index: number;
  toolName: string;
  line?: number;
  endLine?: number;
  label?: string;
  narration?: string;
  highlightLineCount?: number;
  simulatedDurationMs: number;
}

interface TurnReport {
  turn: number;
  studentSaid: string;
  beats: Beat[];
  finalText: string;
  finalWords: number;
  hasQuestionMark: boolean;
  hasInvitation: boolean;
  modelLatencyMs: number;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const INVITATION_RE =
  /\b(want me to|should i|ready for|next part|keep going|continue|let me know|see why|guess|what (?:do you|would you) think|in your own words|spot the)\b/i;

const QUIZ_RE =
  /\?[\s]*$|\b(what (?:does|will|would|happens|prints|returns)|why does|how would|explain|in (?:your|one) (?:words|sentence)|spot the bug|guess what)\b/i;

// ── tool execution mock ──────────────────────────────────────────
async function mockExecuteTool(
  call: Anthropic.Messages.ToolUseBlock,
  beats: Beat[],
  turnIdx: number
): Promise<string> {
  const idx = beats.length;
  if (call.name === "teach_step") {
    const args = call.input as {
      path?: string;
      startLine?: number;
      endLine?: number;
      anchor?: string;
      label?: string;
      narration?: string;
      highlight?: { path?: string; startLine?: number; endLine?: number; anchor?: string; label?: string };
    };
    const narration = (args.narration ?? "").trim();
    const startLine = args.startLine ?? args.highlight?.startLine;
    const endLine = args.endLine ?? args.highlight?.endLine;
    const label = args.label ?? args.highlight?.label;
    if (!narration) {
      beats.push({
        turn: turnIdx, index: idx, toolName: "teach_step",
        line: startLine, endLine, label, narration: "(empty)",
        simulatedDurationMs: 0,
      });
      return "teach_step error: narration is empty (required string field)";
    }
    const ms = ttsPlaybackMs(narration);
    beats.push({
      turn: turnIdx, index: idx, toolName: "teach_step",
      line: startLine, endLine, label, narration,
      simulatedDurationMs: ms,
    });
    return `teach_step complete (ended): narrated "${narration.slice(0, 60)}…"`;
  }
  if (call.name === "highlight_code") {
    const args = call.input as { regions?: Array<{ startLine?: number; endLine?: number; label?: string }> };
    const regions = args.regions ?? [];
    beats.push({
      turn: turnIdx, index: idx, toolName: "highlight_code",
      highlightLineCount: regions.length,
      simulatedDurationMs: 0,
    });
    return `Highlighted ${regions.length} region${regions.length === 1 ? "" : "s"}`;
  }
  if (call.name === "read_file") {
    return `\`\`\`tsx\n${MOCK_FILE_CONTENT}\n\`\`\``;
  }
  if (call.name === "remember") {
    const args = call.input as { type?: string; content?: string };
    return `remembered (${args.type}): ${args.content?.slice(0, 60)}…`;
  }
  if (call.name === "show_code" || call.name === "clear_highlights") {
    return `${call.name} ok`;
  }
  return `${call.name} ok`;
}

// ── one bot turn ──────────────────────────────────────────────────
async function runBotTurn(
  history: Anthropic.Messages.MessageParam[],
  systemPrompt: string,
  beats: Beat[],
  turnIdx: number
): Promise<{ finalText: string; latencyMs: number }> {
  let totalLatency = 0;
  for (let round = 0; round < 12; round++) {
    const tStart = Date.now();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: history,
    });
    totalLatency += Date.now() - tStart;
    const toolUses = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    const textBlocks = res.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text"
    );
    if (toolUses.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join("\n").trim();
      // CRITICAL: push the final assistant text into history before
      // returning — otherwise the next turn's user message lands
      // immediately after the previous turn's "user tool_result" block,
      // which Anthropic rejects as consecutive user-role messages and
      // also breaks role-alternation. If the model returned literal
      // empty content, substitute a sentinel so the API doesn't reject
      // a zero-length text block.
      const assistantContent =
        res.content.length > 0
          ? res.content
          : [{ type: "text" as const, text: "(no reply)" }];
      history.push({ role: "assistant", content: assistantContent });
      return { finalText, latencyMs: totalLatency };
    }
    history.push({ role: "assistant", content: res.content });
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const result = await mockExecuteTool(tu, beats, turnIdx);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    history.push({ role: "user", content: toolResults });
  }
  return { finalText: "(max rounds reached)", latencyMs: totalLatency };
}

// ── student persona ──────────────────────────────────────────────
const STUDENT_SYSTEM = `You are simulating a junior developer being taught about JavaScript / React. The mentor is teaching you. You're new to React but you have basic JS down. You CAN see the file in your editor — assume the lesson is happening normally and ENGAGE with it. Don't ask "where's the file" or "did you paste it" — that's a dead-end loop.

Your job: respond NATURALLY between mentor turns and PUSH THE LESSON FORWARD. Vary your replies:
 - Answer the mentor's probe questions directly ("Yeah I've used hooks but only useState briefly")
 - When asked "want me to continue?" → say "yes" or ask a follow-up that moves forward
 - If quizzed, attempt an answer (sometimes right, sometimes wrong-but-thoughtful)
 - If asked to TRY writing code, paste a small attempt: "I'd write \`const [count, setCount] = useState(0)\`"
 - Acknowledge briefly when something clicks: "oh, so todo holds the value and setTodo updates it?"

Keep replies SHORT — 1-2 sentences. NEVER say you're an AI or this is a sim. NEVER play the mentor role. Stay engaged-and-curious.`;

async function studentReply(
  context: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 80,
    system: STUDENT_SYSTEM,
    messages: [
      ...history.map((t) => ({
        role: t.role === "user" ? ("assistant" as const) : ("user" as const),
        content: t.content,
      })),
      { role: "user", content: context },
    ],
  });
  const block = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
  return block?.text.trim() ?? "(silent)";
}

// ── scenario runner ──────────────────────────────────────────────
async function runScenario(args: {
  label: string;
  channel: "voice-dialogue" | "teaching-text";
  initialUserMessage: string;
  turns: number;
}): Promise<TurnReport[]> {
  const reports: TurnReport[] = [];
  const beatsAll: Beat[] = [];

  // Mentor-side full message log (assistant + tool messages) — fed back
  // every turn so the model has continuity.
  const mentorHistory: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: `Currently looking at ${MOCK_FILE_PATH}:\n\`\`\`tsx\n${MOCK_FILE_CONTENT}\`\`\`\n\n${args.initialUserMessage}`,
    },
  ];
  // Student-side log (just role + plain content) — used to maintain
  // student persona consistency when generating replies.
  const studentSeenHistory: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: args.initialUserMessage },
  ];

  const systemPrompt = buildSystemPrompt(args.channel);

  let userMessage = args.initialUserMessage;

  console.log(`\n══ ${args.label} ══`);
  console.log(`USER ▶ "${userMessage}"`);

  for (let turn = 1; turn <= args.turns; turn++) {
    const turnBeats: Beat[] = [];
    const { finalText, latencyMs } = await runBotTurn(
      mentorHistory,
      systemPrompt,
      turnBeats,
      turn
    );
    beatsAll.push(...turnBeats);
    studentSeenHistory.push({ role: "assistant", content: finalText });

    const finalWords = countWords(finalText);
    const hasQuestionMark = /\?/.test(finalText);
    const hasInvitation = INVITATION_RE.test(finalText);

    console.log(`\nTURN ${turn} (${latencyMs}ms model latency)`);
    if (turnBeats.length > 0) {
      for (const b of turnBeats) {
        if (b.toolName === "teach_step") {
          console.log(
            `  · teach_step L${b.line ?? "?"} "${(b.narration ?? "").slice(0, 70)}"`
          );
        } else if (b.toolName === "highlight_code") {
          console.log(`  · highlight_code (${b.highlightLineCount} regions)`);
        } else {
          console.log(`  · ${b.toolName}`);
        }
      }
    }
    console.log(`MENTOR ▶ "${finalText.slice(0, 200)}${finalText.length > 200 ? "…" : ""}"`);
    console.log(`         ${finalWords} words · question=${hasQuestionMark} · invitation=${hasInvitation}`);

    reports.push({
      turn,
      studentSaid: userMessage,
      beats: turnBeats,
      finalText,
      finalWords,
      hasQuestionMark,
      hasInvitation,
      modelLatencyMs: latencyMs,
    });

    if (turn < args.turns) {
      // Defensive: if the mentor returned an empty final text (rare but
      // happens when the model treated tool calls as the entire reply),
      // give the student a fallback prompt so the sim doesn't crash on
      // empty-content. The empty mentor reply IS a bug worth flagging,
      // but the sim should keep running so we can score the rest.
      const promptForStudent =
        finalText.trim() ||
        "(mentor returned empty content — student inferring from tool calls)";
      userMessage = await studentReply(promptForStudent, studentSeenHistory);
      mentorHistory.push({ role: "user", content: userMessage });
      studentSeenHistory.push({ role: "user", content: userMessage });
      console.log(`\nSTUDENT ▶ "${userMessage}"`);
    }
  }

  return reports;
}

// ── scorecard ────────────────────────────────────────────────────
function score(reports: TurnReport[], channel: "voice-dialogue" | "teaching-text"): void {
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`SCORECARD — ${channel}`);
  console.log("────────────────────────────────────────────────────────────");

  const wordsPerTurn = reports.map((r) => r.finalWords);
  const teachStepCounts = reports.map((r) => r.beats.filter((b) => b.toolName === "teach_step").length);
  const highlightCounts = reports.map((r) => r.beats.filter((b) => b.toolName === "highlight_code").length);
  const turnsWithQuestion = reports.filter((r) => r.hasQuestionMark).length;
  const turnsWithInvitation = reports.filter((r) => r.hasInvitation).length;

  // teach_step IS a highlight (it paints + narrates atomically). Count
  // it alongside highlight_code for the "did highlighting happen?" check.
  const anyHighlightCounts = teachStepCounts.map(
    (c, i) => c + highlightCounts[i]
  );
  const turnsWithEmptyText = reports.filter((r) => r.finalWords === 0).length;

  console.log(`Words per turn:           [${wordsPerTurn.join(", ")}]  (median: ${wordsPerTurn.slice().sort((a,b)=>a-b)[Math.floor(wordsPerTurn.length/2)]})`);
  console.log(`teach_step calls / turn:  [${teachStepCounts.join(", ")}]`);
  console.log(`highlight_code / turn:    [${highlightCounts.join(", ")}]`);
  console.log(`ANY highlight / turn:     [${anyHighlightCounts.join(", ")}]  (teach_step + highlight_code)`);
  console.log(`Turns with question (?):  ${turnsWithQuestion}/${reports.length}`);
  console.log(`Turns with invitation:    ${turnsWithInvitation}/${reports.length}`);
  console.log(`Empty-text turns:         ${turnsWithEmptyText}/${reports.length}  ${turnsWithEmptyText > 0 ? "⚠️ user sees empty bubble" : ""}`);

  console.log("\nVERIFICATION:");
  if (channel === "voice-dialogue") {
    const totalTeachStep = teachStepCounts.reduce((s, x) => s + x, 0);
    const usedChained = teachStepCounts.some((c) => c >= 3);
    const wordsOk = wordsPerTurn.every((w) => w <= 70);
    console.log(`  ${totalTeachStep > 0 ? "✓" : "✗"} Used teach_step (total: ${totalTeachStep})`);
    console.log(`  ${usedChained ? "✓" : "✗"} At least one turn chained ≥3 teach_step calls`);
    console.log(`  ${wordsOk ? "✓" : "✗"} Final-text replies stay short (<70 words each)`);
    console.log(`  ${turnsWithEmptyText === 0 ? "✓" : "✗"} No empty chat-bubble turns (every reply has prose)`);
  } else {
    const wordsOk = wordsPerTurn.every((w) => w <= 200);
    const askedQuestions = turnsWithQuestion >= Math.ceil(reports.length / 2);
    const usedHighlights = anyHighlightCounts.some((c) => c > 0);
    console.log(`  ${wordsOk ? "✓" : "✗"} Stays under 200 words per turn (no wall-of-text)`);
    console.log(`  ${askedQuestions ? "✓" : "✗"} Asks questions in ≥${Math.ceil(reports.length / 2)}/${reports.length} turns`);
    console.log(`  ${usedHighlights ? "✓" : "✗"} Used a highlight (any tool) at least once`);
    console.log(`  ${turnsWithEmptyText === 0 ? "✓" : "✗"} No empty chat-bubble turns`);
  }
}

// ── main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════");
  console.log("TEACHING-STYLE SIM — does our pedagogy actually work?");
  console.log("════════════════════════════════════════════════════════════");

  // SCENARIO A — voice-dialogue, "explain every line"
  // 5 turns — long enough to see the wrap-up + a couple of follow-up
  // questions exercise the deeper pedagogy.
  const voiceReports = await runScenario({
    label: "A · VOICE-DIALOGUE · 'walk me through every line'",
    channel: "voice-dialogue",
    initialUserMessage: "walk me through every line of this file, one at a time please",
    turns: 5,
  });
  score(voiceReports, "voice-dialogue");

  // SCENARIO B — teaching-text, "teach me about useState"
  // 6 turns — long enough to push past PROBE (T1-T2) into EXPLAIN (T3),
  // SHOW (T4 with a code block), TRY (T5 asks user to write code),
  // REVIEW (T6 reacts to what student "wrote"). This tests the FULL
  // teaching arc + verifies highlight_code engages once the bot starts
  // pointing at specific identifiers in the file.
  const textReports = await runScenario({
    label: "B · TEACHING-TEXT · 'teach me useState' (FULL ARC)",
    channel: "teaching-text",
    initialUserMessage:
      "teach me how useState works in this file, line by line",
    turns: 6,
  });
  score(textReports, "teaching-text");

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("DONE.");
  console.log("════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("SIM FAILED:", err);
  process.exit(1);
});
