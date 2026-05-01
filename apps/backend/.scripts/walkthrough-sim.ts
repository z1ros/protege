/**
 * Walkthrough simulation — verifies the chained teach_step flow.
 *
 * Goal: confirm that when a user asks "explain every line" in voice mode,
 * the model actually chains multiple teach_step tool calls (one per beat)
 * instead of dumping everything into one big highlight + prose reply.
 *
 * What this sim does:
 *   1. Builds the exact tool list + system prompt the production backend
 *      uses (so the model sees the same instructions).
 *   2. Sends a "walk me through every line" message.
 *   3. Mocks the extension-side execution of each tool call:
 *      - teach_step: simulates the highlight + audio playback wait,
 *        records the timing.
 *      - highlight_code: returns success without delay.
 *   4. Loops the tool round-trip until the model returns a final text.
 *   5. Reports a trace with one row per beat: line, narration, latency.
 *
 * Provider: Anthropic Claude Haiku 4.5 directly (matches what
 * routes/chat.ts maps voice-dialogue to). No backend HTTP — direct
 * SDK so we can iterate fast and don't need quota / auth set up.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

import { buildSystemPrompt } from "../src/prompts/persona.js";
import { TOOL_DEFINITIONS } from "../src/aiTools.js";

// ── env ───────────────────────────────────────────────────────────
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
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not loaded");
const client = new Anthropic({ apiKey });
const MODEL = "claude-haiku-4-5";

// ── mock target file the user is "looking at" ─────────────────────
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

// ── playback timing model (matches voice/hostAudio.ts) ─────────────
const CHARS_PER_SEC = 14;
const SPAWN_OVERHEAD_MS = 30;
function ttsPlaybackMs(text: string): number {
  return Math.round((text.length / CHARS_PER_SEC) * 1000) + SPAWN_OVERHEAD_MS;
}

// ── beat tracker ──────────────────────────────────────────────────
interface Beat {
  index: number;
  toolName: string;
  line?: number;
  endLine?: number;
  label?: string;
  narration?: string;
  highlightLineCount?: number;
  simulatedDurationMs: number;
  modelLatencyMs: number;
}
const beats: Beat[] = [];
let totalSimulatedAudioMs = 0;
let totalModelLatencyMs = 0;

// ── mock executor — mirrors apps/extension/src/ai/tools.ts dispatch
async function mockExecuteTool(
  call: Anthropic.Messages.ToolUseBlock,
  modelLatencyMs: number
): Promise<string> {
  const idx = beats.length;
  if (call.name === "teach_step") {
    // FLAT shape (current schema) with backward-compat fallback to
    // the legacy nested `highlight` object — same logic the runtime
    // uses in apps/extension/src/teaching/teachingStep.ts.
    const args = call.input as {
      path?: string;
      startLine?: number;
      endLine?: number;
      anchor?: string;
      label?: string;
      highlight?: { path?: string; startLine?: number; endLine?: number; anchor?: string; label?: string };
      narration?: string;
      pauseMsAfter?: number;
    };
    const narration = (args.narration ?? "").trim();
    const startLine = args.startLine ?? args.highlight?.startLine;
    const endLine = args.endLine ?? args.highlight?.endLine;
    const label = args.label ?? args.highlight?.label;
    if (!narration) {
      console.warn(`  WARN teach_step round ${idx + 1}: empty narration. raw args:`, JSON.stringify(args).slice(0, 300));
      beats.push({
        index: idx,
        toolName: "teach_step",
        line: startLine,
        endLine,
        label,
        narration: "(empty)",
        simulatedDurationMs: 0,
        modelLatencyMs,
      });
      return "teach_step error: narration is empty (required string field)";
    }
    const playMs = ttsPlaybackMs(narration);
    const pauseMs = Math.min(args.pauseMsAfter ?? 0, 1500);
    const totalMs = playMs + pauseMs;
    totalSimulatedAudioMs += totalMs;
    beats.push({
      index: idx,
      toolName: "teach_step",
      line: startLine,
      endLine,
      label,
      narration,
      simulatedDurationMs: totalMs,
      modelLatencyMs,
    });
    return `teach_step complete (ended): narrated "${narration.slice(0, 60)}…"`;
  }
  if (call.name === "highlight_code") {
    const args = call.input as { regions: Array<{ path: string; startLine: number; endLine: number; label?: string }> };
    const lineCount = args.regions?.length ?? 0;
    beats.push({
      index: idx,
      toolName: "highlight_code",
      highlightLineCount: lineCount,
      simulatedDurationMs: 0,
      modelLatencyMs,
    });
    return `Highlighted ${lineCount} region${lineCount === 1 ? "" : "s"} across 1 file`;
  }
  if (call.name === "read_file") {
    return `\`\`\`\n${MOCK_FILE_CONTENT}\n\`\`\``;
  }
  if (call.name === "show_code") {
    return `Showed code at ${MOCK_FILE_PATH}`;
  }
  if (call.name === "clear_highlights") {
    return "Highlights cleared";
  }
  // Anything else — just acknowledge
  return `${call.name} ok`;
}

// ── tool loop ─────────────────────────────────────────────────────
type Msg = Anthropic.Messages.MessageParam;

async function runChain(userPrompt: string, maxRounds = 15): Promise<string> {
  const messages: Msg[] = [
    {
      role: "user",
      content: `Currently looking at ${MOCK_FILE_PATH}:\n\`\`\`tsx\n${MOCK_FILE_CONTENT}\`\`\`\n\n${userPrompt}`,
    },
  ];

  const system = buildSystemPrompt("voice-dialogue");

  for (let round = 0; round < maxRounds; round++) {
    const tStart = Date.now();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
    });
    const modelLatencyMs = Date.now() - tStart;
    totalModelLatencyMs += modelLatencyMs;

    const toolUses = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    const textBlocks = res.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text"
    );

    if (toolUses.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join("\n").trim();
      console.log(`\nROUND ${round + 1}: final text reply (${modelLatencyMs}ms model latency)`);
      return finalText;
    }

    // Push assistant message with tool_use blocks
    messages.push({ role: "assistant", content: res.content });

    // Execute each tool call, build tool_result blocks
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const result = await mockExecuteTool(tu, modelLatencyMs);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: toolResults });

    console.log(
      `ROUND ${round + 1}: ${toolUses.length} tool call${toolUses.length === 1 ? "" : "s"} (${modelLatencyMs}ms model latency)`
    );
  }

  return "(max rounds reached)";
}

// ── main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════════");
  console.log("WALKTHROUGH SIM — chained teach_step in voice-dialogue mode");
  console.log("Verifying: model chains multiple teach_step calls instead of");
  console.log("           dumping one big highlight + prose reply.");
  console.log("════════════════════════════════════════════════════════════\n");

  console.log(`USER ▶ "explain every line of this code, walk me through it"\n`);
  const final = await runChain(
    "explain every line of this code, walk me through it"
  );

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("BEAT TRACE");
  console.log("────────────────────────────────────────────────────────────");
  for (const b of beats) {
    if (b.toolName === "teach_step") {
      console.log(
        `  [${String(b.index + 1).padStart(2)}] teach_step · L${b.line}` +
          (b.endLine && b.endLine !== b.line ? `-${b.endLine}` : "") +
          ` · ${b.simulatedDurationMs}ms audio · "${(b.narration ?? "").slice(0, 70)}"` +
          (b.label ? ` (label: "${b.label}")` : "")
      );
    } else if (b.toolName === "highlight_code") {
      console.log(
        `  [${String(b.index + 1).padStart(2)}] highlight_code · ${b.highlightLineCount} regions (no narration)`
      );
    } else {
      console.log(`  [${String(b.index + 1).padStart(2)}] ${b.toolName}`);
    }
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("FINAL REPLY");
  console.log("────────────────────────────────────────────────────────────");
  console.log(final);

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("SCORECARD");
  console.log("────────────────────────────────────────────────────────────");
  const teachStepCount = beats.filter((b) => b.toolName === "teach_step").length;
  const highlightCodeCount = beats.filter((b) => b.toolName === "highlight_code").length;

  console.log(`teach_step calls:       ${teachStepCount}`);
  console.log(`highlight_code calls:   ${highlightCodeCount}`);
  console.log(`Total simulated audio:  ${(totalSimulatedAudioMs / 1000).toFixed(1)}s`);
  console.log(`Total model latency:    ${(totalModelLatencyMs / 1000).toFixed(1)}s`);

  console.log("\nPASS/FAIL:");
  const usedChainedTeachStep = teachStepCount >= 3;
  const onlyHighlightThenProse = teachStepCount === 0 && highlightCodeCount > 0;
  const finalEndsWithInvitation = /(continue|keep going|next|show more)\??/i.test(
    final
  );

  console.log(
    `  ${usedChainedTeachStep ? "✓" : "✗"} Chained teach_step (≥3 calls): ${teachStepCount}`
  );
  console.log(
    `  ${!onlyHighlightThenProse ? "✓" : "✗"} Did NOT fall back to highlight_code+prose-only`
  );
  console.log(
    `  ${finalEndsWithInvitation ? "✓" : "✗"} Final reply invites continuation: "${final.slice(-80)}"`
  );
  console.log("════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("SIM FAILED:", err);
  process.exit(1);
});
