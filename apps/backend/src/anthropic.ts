import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

// Default to Haiku — Sonnet is disabled across the app for cost reasons
// (see resolveModel in routes/chat.ts). Override via env if a single test
// needs Sonnet.
export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

// The real prompt now lives in prompts/persona.ts and is composed
// per-request based on channel (text vs voice). MENTOR_SYSTEM_PROMPT is kept
// as a fallback for toAnthropic() when translating a history without an
// explicit system turn — defaults to text mode.
import { buildSystemPrompt } from "./prompts/persona.js";
export { buildSystemPrompt } from "./prompts/persona.js";
export const MENTOR_SYSTEM_PROMPT = buildSystemPrompt("text");


export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file in the user's workspace. Always call this before edit_file so you know the exact text to replace. Returned content has line numbers prepended.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative (to workspace root) or absolute path to the file.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in the user's workspace, optionally filtered by glob.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex. Returns matching lines with file and line.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string" },
        limit: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "show_code",
    description:
      "Jump the user's editor to a single line range with a soft flash. For rich labeled multi-range highlights use highlight_code instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path", "startLine", "endLine"],
    },
  },
  {
    name: "highlight_code",
    description:
      "Paint interactive highlights on code in the editor. For bug/tip kinds, provide issue + fix + explanation to enable rich hover cards with 'Fix it for me' buttons. Use BEFORE explaining so the user can see what you mean.",
    input_schema: {
      type: "object",
      properties: {
        regions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              startLine: { type: "number" },
              endLine: { type: "number" },
              anchor: {
                type: "string",
                description:
                  "REQUIRED. A short unique substring (4-40 chars) copied verbatim from startLine — used to verify the line number is correct. If the substring isn't on the claimed line, the highlight is rejected and you'll be told to retry. Pick something distinctive from the line: a tag name, function call, identifier — NOT generic punctuation like `}` or `)`. Example: for `<Swiper spaceBetween={20}>` use `<Swiper`.",
              },
              kind: {
                type: "string",
                enum: ["focus", "bug", "pattern", "tip"],
              },
              label: { type: "string", description: "Short inline label shown after the highlighted line" },
              issue: { type: "string", description: "What's wrong or noteworthy — one sentence" },
              fix: { type: "string", description: "The corrected code snippet. Shown as a copyable code block in the hover card" },
              explanation: { type: "string", description: "Why this matters — the conceptual lesson. Max two sentences" },
            },
            required: ["path", "startLine", "endLine", "anchor"],
          },
        },
      },
      required: ["regions"],
    },
  },
  {
    name: "clear_highlights",
    description: "Clear all Protege highlights.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "edit_file",
    description:
      "Propose an edit to a file. The user must accept the proposed edit in a preview diff before it is applied — this is NOT a silent write. Keep edits small and targeted; always read_file first so oldString matches byte-for-byte. oldString must be unique unless replaceAll=true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  // create_file REMOVED — Claude was dumping random lesson files into the
  // workspace. Teaching happens through chat responses only.
  // create_scratch_file REMOVED — same reason.
  // run_file REMOVED — too risky without user confirmation.
  {
    name: "teach_step",
    description:
      "VOICE TEACHING ONLY (mode === 'teaching'). Highlights ONE piece of code and narrates ONE short spoken sentence via TTS. The extension waits for audio playback to finish before returning. NEVER use this tool in 'teaching-text' or text channels — the user has no audio output, the call will appear as a stuck loading chip in chat with nothing happening. In teaching-text mode, write your explanation as prose and use highlight_code (silent) for the visual.",
    input_schema: {
      type: "object",
      properties: {
        highlight: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative or absolute path" },
            startLine: { type: "number" },
            endLine: { type: "number", description: "Same as startLine for a single line" },
            anchor: {
              type: "string",
              description:
                "REQUIRED. Unique substring (4-40 chars) copied verbatim from startLine. Verifies the line number is correct — wrong-line highlights are rejected. Pick something distinctive (tag name, identifier), not punctuation.",
            },
            label: { type: "string", description: "Optional short inline tag (e.g. 'state init')" },
          },
          required: ["path", "startLine", "endLine", "anchor"],
        },
        narration: {
          type: "string",
          description: "ONE sentence, under 20 words, spoken aloud. Contractions ok. No markdown, no code, no line numbers read out.",
        },
        pauseMsAfter: {
          type: "number",
          description: "Optional silence after speaking, 200-800ms for absorption. Default 0.",
        },
      },
      required: ["highlight", "narration"],
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user for future sessions. For most types — profile, struggle, win, decision, preference, context — use sparingly (things worth remembering next week, not every turn). EXCEPTION: type='concept' fires every time the user produces a correct YOUR-TURN answer in teaching mode — that's not 'sparing', that's the mastery-tracking signal future sessions rely on. Types: profile (stack, goals), struggle (recurring gaps), win (breakthroughs), decision (choices + why), preference (how they like to work), context (short-term project notes), concept (verified mastery — content MUST start with 'user owns: [concept name] — ').",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["profile", "struggle", "win", "decision", "preference", "context", "concept"],
        },
        content: {
          type: "string",
          description: "The fact itself. Write it as a compact sentence (≤ 200 chars).",
        },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "forget",
    description:
      "Retract a memory entry that turned out wrong. Use the id shown in the 'What you know about this user' block.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];
