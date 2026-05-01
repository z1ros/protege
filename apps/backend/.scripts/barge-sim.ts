/**
 * Protege barge-in simulation.
 *
 * Runs a real AI-vs-AI conversation:
 *   - Mentor: Anthropic Claude with the actual Protege voice-dialogue persona
 *   - Student: Anthropic Claude playing a confused junior dev who interrupts
 *
 * For each mentor turn, we:
 *   1. Get the reply from Claude.
 *   2. Split into sentences using the SAME splitForStreaming() logic that
 *      hostAudio.ts uses in production.
 *   3. Simulate TTS playback timing (chars / 14 chars per sec, ~150 wpm).
 *   4. Ask the student model: "would you interrupt? if so, after which
 *      sentence and at what fraction of the way through it?"
 *   5. Synthesize a prob stream — silent frames during mentor speech,
 *      voiced frames once the student starts talking.
 *   6. Run the EXACT 2-frame averaging logic from voiceCapture.ts on
 *      that prob stream and report when barge-in fires + the latency.
 *
 * Reports an end-to-end trace showing where interruptions land, how fast
 * the audio gets killed, and what the mentor does on the next turn.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

// Pull persona straight from the backend so the simulation tracks the
// real prompt as it evolves.
import { buildSystemPrompt } from "../src/prompts/persona.js";

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

// ── playback model ────────────────────────────────────────────────
// Mirrors apps/extension/src/voice/hostAudio.ts (post-fix: strip markdown +
// per-chunk size cap so single mega-chunks can't hold playback hostage).
function stripMarkdownForVoice(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const MAX_CHUNK_CHARS = 600;
function splitOversizeChunk(chunk: string): string[] {
  if (chunk.length <= MAX_CHUNK_CHARS) return [chunk];
  const out: string[] = [];
  let remaining = chunk;
  while (remaining.length > MAX_CHUNK_CHARS) {
    const window = remaining.slice(0, MAX_CHUNK_CHARS);
    const cutAt =
      window.lastIndexOf(", ") + 1 ||
      window.lastIndexOf(" — ") + 1 ||
      window.lastIndexOf("— ") + 1 ||
      window.lastIndexOf(" ") + 1 ||
      MAX_CHUNK_CHARS;
    out.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
// Mirrors trimForVoice in apps/extension/src/teaching/explainMode.ts —
// VOICE-ONLY by design (text/chat mode is unaffected; max_tokens 4096,
// no client trim). Bulletproofed to never produce mid-sentence cuts:
// looks before AND after maxWords for a sentence boundary and prefers
// slight overshoot to a chopped half-thought.
function trimForVoice(text: string, maxWords = 50): string {
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
  const beyond = words.slice(maxWords).join(" ");
  const overshootMatch = beyond.match(/[.!?](?=\s|$)/);
  const firstPeriodAfter = overshootMatch
    ? rough.length + 1 + (overshootMatch.index ?? 0)
    : -1;
  const minEarlyChars = Math.floor(rough.length / 3);
  if (lastPeriodBefore >= minEarlyChars) {
    return rough.slice(0, lastPeriodBefore + 1).trim();
  }
  if (firstPeriodAfter >= 0) {
    return stripped.slice(0, firstPeriodAfter + 1).trim();
  }
  return stripped;
}

function splitForStreaming(text: string, minChars = 18): string[] {
  // Production order: trimForVoice runs in webviewHost.ts BEFORE
  // playHostAudioStreaming, then stripMarkdownForVoice runs inside
  // splitForStreaming. We chain them here for parity.
  // Cap is 50 words (matches webviewHost.ts post-2026-04-30 tightening).
  const cleaned = stripMarkdownForVoice(trimForVoice(text, 50));
  const raw = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (raw.length === 0) return [];
  const out: string[] = [];
  let buf = "";
  for (const s of raw) {
    if (buf.length === 0) { buf = s; continue; }
    if (buf.length < minChars) buf = `${buf} ${s}`;
    else { out.push(buf); buf = s; }
  }
  if (buf) out.push(buf);
  return out.flatMap(splitOversizeChunk);
}

// Kokoro TTS produces ~14 chars/sec at typical reading pace. Add a small
// per-chunk afplay spawn cost (~30ms).
const CHARS_PER_SEC = 14;
const SPAWN_OVERHEAD_MS = 30;
function chunkPlaybackMs(chunk: string): number {
  return Math.round((chunk.length / CHARS_PER_SEC) * 1000) + SPAWN_OVERHEAD_MS;
}

// ── barge-in detector (mirrors voiceCapture.ts) ───────────────────
const BARGE_PROB_THRESHOLD = 0.12;
const BARGE_FRAME_COUNT = 2;
const FRAME_HOP_MS = 80; // openWakeWord default

interface DetectorResult {
  fired: boolean;
  fireFrameMs: number | null;
  framesProcessed: number;
}

/** Feed a prob stream to the detector; return when (if) it fires. */
function runDetector(probs: number[]): DetectorResult {
  const recent: number[] = [];
  for (let i = 0; i < probs.length; i++) {
    recent.push(probs[i]);
    if (recent.length > BARGE_FRAME_COUNT) recent.shift();
    if (recent.length >= BARGE_FRAME_COUNT) {
      const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
      if (avg > BARGE_PROB_THRESHOLD) {
        return {
          fired: true,
          fireFrameMs: (i + 1) * FRAME_HOP_MS,
          framesProcessed: i + 1,
        };
      }
    }
  }
  return { fired: false, fireFrameMs: null, framesProcessed: probs.length };
}

/** Synthesize a prob stream over a window: silence (0.02–0.05) until the
 *  student starts speaking at startMs, then voiced (0.15–0.25). */
function buildProbStream(totalMs: number, voiceStartMs: number | null): number[] {
  const frames = Math.ceil(totalMs / FRAME_HOP_MS);
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    const tMs = f * FRAME_HOP_MS;
    const speaking = voiceStartMs !== null && tMs >= voiceStartMs;
    if (!speaking) {
      out.push(0.02 + Math.random() * 0.03); // 0.02–0.05
    } else {
      out.push(0.15 + Math.random() * 0.10); // 0.15–0.25
    }
  }
  return out;
}

// ── conversation drivers ──────────────────────────────────────────
type Turn = { role: "user" | "assistant"; content: string };

const STUDENT_SYSTEM = `You are simulating a junior developer learning JavaScript who is talking to an AI mentor by VOICE. You are confused about closures and want to understand them. Speak naturally, as you would aloud. ONE OR TWO short sentences per turn. No markdown, no bullets. Sound like a real person mid-thought.

You will sometimes INTERRUPT the mentor mid-sentence when:
- They start saying something you already know
- They use a word you don't recognize
- You want to ask a clarifying question

When you interrupt, your reply should start with a brief overlap word like "wait —" or "sorry, but —" or "hold on —".

Stay in character. NEVER acknowledge that this is a simulation.`;

async function studentReply(history: Turn[]): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 120,
    system: STUDENT_SYSTEM,
    messages: history.map((t) => ({
      role: t.role === "user" ? "assistant" : "user",
      content: t.content,
    })),
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

async function mentorReply(history: Turn[]): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    // Mirrors maxTokensForMode("voice-dialogue") in routes/chat.ts —
    // 200 gives the model headroom to finish a thought; trimForVoice
    // clips at sentence boundary so the user never hears a mid-sentence
    // stop_reason=max_tokens cut.
    max_tokens: 200,
    system: buildSystemPrompt("voice-dialogue"),
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

interface InterruptDecision {
  willInterrupt: boolean;
  afterChunkIndex: number; // index in the chunked sentence stream
  fractionThrough: number; // 0..1 within that chunk
  reason: string;
}

async function decideInterrupt(
  history: Turn[],
  chunks: string[]
): Promise<InterruptDecision> {
  const numbered = chunks.map((c, i) => `[${i}] ${c}`).join("\n");
  const prompt = `The mentor is about to say this aloud, sentence by sentence:\n\n${numbered}\n\nWill you interrupt? Reply with ONE LINE in this exact format:\nINTERRUPT=yes|no | AFTER=<chunk_index> | AT=<fraction_0_to_1> | REASON=<short>\n\nIf no, use AFTER=-1 AT=0.\nInterrupt only if it feels natural — about 40% of the time. Don't interrupt every turn.`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 100,
    system: STUDENT_SYSTEM + "\n\nWhen asked about interrupting, answer in the structured format requested. Be honest about whether the moment calls for it.",
    messages: [
      ...history.map((t) => ({
        role: t.role === "user" ? ("assistant" as const) : ("user" as const),
        content: t.content,
      })),
      { role: "user", content: prompt },
    ],
  });
  const block = res.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text.trim() : "";
  const m = text.match(/INTERRUPT=(yes|no)\s*\|\s*AFTER=(-?\d+)\s*\|\s*AT=([\d.]+)\s*\|\s*REASON=(.*)/i);
  if (!m) return { willInterrupt: false, afterChunkIndex: -1, fractionThrough: 0, reason: "parse-fail" };
  return {
    willInterrupt: m[1].toLowerCase() === "yes",
    afterChunkIndex: parseInt(m[2], 10),
    fractionThrough: parseFloat(m[3]),
    reason: m[4].trim(),
  };
}

// ── main loop ─────────────────────────────────────────────────────
function pad(n: number, w = 5): string { return String(n).padStart(w); }

async function main(): Promise<void> {
  const history: Turn[] = [];

  // Seed turn from the student.
  const seed = "Hey, I keep hearing about closures in JavaScript. What actually is one?";
  history.push({ role: "user", content: seed });
  console.log("════════════════════════════════════════════════════════════");
  console.log("BARGE-IN SIMULATION — student vs Protege voice-dialogue mode");
  console.log("Detector: 2-frame avg > 0.12 over 80ms hops (~160ms floor)");
  console.log("Playback: 14 chars/sec + 30ms per-chunk spawn overhead");
  console.log("════════════════════════════════════════════════════════════\n");
  console.log(`STUDENT  ▶ ${seed}\n`);

  const TURNS = 4;
  let totalLatency = 0;
  let interruptions = 0;

  for (let t = 0; t < TURNS; t++) {
    // Mentor turn.
    const reply = await mentorReply(history);
    history.push({ role: "assistant", content: reply });

    const chunks = splitForStreaming(reply);
    const chunkMs = chunks.map(chunkPlaybackMs);
    const totalReplyMs = chunkMs.reduce((s, x) => s + x, 0);

    console.log(`MENTOR   ▶ "${reply}"`);
    console.log(`         · ${chunks.length} chunks, ${totalReplyMs}ms total playback`);
    chunks.forEach((c, i) => {
      console.log(`         · [${i}] ${chunkMs[i]}ms — "${c}"`);
    });

    // Interrupt decision.
    const decision = await decideInterrupt(history, chunks);

    let voiceStartMs: number | null = null;
    if (decision.willInterrupt && decision.afterChunkIndex >= 0 && decision.afterChunkIndex < chunks.length) {
      const chunkStart = chunkMs.slice(0, decision.afterChunkIndex).reduce((s, x) => s + x, 0);
      voiceStartMs = chunkStart + Math.round(chunkMs[decision.afterChunkIndex] * decision.fractionThrough);
      console.log(`         · student decides to interrupt at chunk ${decision.afterChunkIndex} (frac=${decision.fractionThrough.toFixed(2)}) — ${decision.reason}`);
      console.log(`         · voice starts at ${voiceStartMs}ms`);
    } else {
      console.log(`         · student does NOT interrupt — ${decision.reason}`);
    }

    const probs = buildProbStream(totalReplyMs, voiceStartMs);
    const result = runDetector(probs);

    if (result.fired) {
      const latency = result.fireFrameMs! - (voiceStartMs ?? 0);
      totalLatency += latency;
      interruptions++;
      console.log(`BARGE-IN ▶ fired at frame ${result.framesProcessed} (${result.fireFrameMs}ms) — latency ${latency}ms after voice start`);

      // What chunk was playing when the kill happened?
      let acc = 0;
      let killedChunk = -1;
      for (let i = 0; i < chunks.length; i++) {
        acc += chunkMs[i];
        if (acc >= result.fireFrameMs!) { killedChunk = i; break; }
      }
      const remaining = chunks.length - 1 - killedChunk;
      console.log(`         · killed mid-chunk ${killedChunk} (${remaining} sentences NOT spoken)`);
    } else if (voiceStartMs !== null) {
      console.log(`BARGE-IN ▶ DID NOT fire (false negative) — voice was at ${voiceStartMs}ms but detector missed it`);
    } else {
      console.log(`BARGE-IN ▶ no interruption attempted, audio played to completion`);
    }

    // Student replies — context-aware on whether they interrupted or not.
    const followUp = await studentReply(history);
    history.push({ role: "user", content: followUp });
    console.log(`\nSTUDENT  ▶ ${followUp}\n`);
  }

  console.log("════════════════════════════════════════════════════════════");
  console.log(`SUMMARY — ${interruptions}/${TURNS} turns had barge-in`);
  if (interruptions > 0) {
    console.log(`Average detection latency: ${Math.round(totalLatency / interruptions)}ms`);
    console.log(`(Frame floor is 160ms; 80ms hop × 2-frame avg.)`);
  }
  console.log("════════════════════════════════════════════════════════════");
}

main().catch((err) => { console.error(err); process.exit(1); });
