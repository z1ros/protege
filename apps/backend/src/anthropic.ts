import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

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
              kind: {
                type: "string",
                enum: ["focus", "bug", "pattern", "tip"],
              },
              label: { type: "string", description: "Short inline label shown after the highlighted line" },
              issue: { type: "string", description: "What's wrong or noteworthy — one sentence" },
              fix: { type: "string", description: "The corrected code snippet. Shown as a copyable code block in the hover card" },
              explanation: { type: "string", description: "Why this matters — the conceptual lesson. Max two sentences" },
            },
            required: ["path", "startLine", "endLine"],
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
      "Replace exact text in an existing file. oldString must be unique unless replaceAll=true. Always read_file first.",
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
    name: "remember",
    description:
      "Save a durable fact about the user for future sessions. Use sparingly — only things worth remembering next week. Types: profile (stack, goals), struggle (recurring gaps), win (breakthroughs), decision (choices + why), preference (how they like to work), context (short-term project notes).",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["profile", "struggle", "win", "decision", "preference", "context"],
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
