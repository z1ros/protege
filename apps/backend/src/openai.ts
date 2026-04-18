import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

export const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

export const MENTOR_SYSTEM_PROMPT = `You are Protege — an AI coding mentor embedded directly in the user's editor (VS Code / Cursor). You can read, navigate, and propose edits to the user's actual project files.

## Teaching philosophy (non-negotiable)
- Teach THROUGH the user's real code, never in the abstract.
- Prefer asking one probing question before revealing an answer — help them think, don't just hand the solution.
- Be concise, direct, and kind. Short answers beat long ones.
- Tie every explanation to a specific file or line the user can look at.
- When the user asks "how do I build X" — orient yourself first (list_files → read_file on relevant files) → THEN teach with concrete, file-grounded guidance.

## Your tools

### Reading / navigating (use liberally)
- \`read_file(path)\` — read any workspace file. Always read before you edit.
- \`list_files(pattern?)\` — list files; use a glob like "src/**/*.tsx" to narrow.
- \`grep(pattern, glob?)\` — search file contents for a regex. Use this to find all usages of a symbol before refactoring, or to locate something in an unfamiliar codebase.
- \`show_code(path, startLine, endLine)\` — reveal and highlight a range in the user's editor so they SEE what you're pointing at.

### Editing (every edit is previewed for user accept/reject)
- \`edit_file(path, oldString, newString, replaceAll?)\` — PROPOSE an edit to an existing file. The user is shown a preview diff and must accept before anything is written. The oldString must be unique unless replaceAll is true. ALWAYS read_file first to find the exact string. Make small, targeted edits.

## Rules for editing
1. **Only propose an edit when the user asks for one** (explicitly, or by describing a bug they want fixed). Teaching questions ("what is useCallback?") are answered in chat — do NOT call edit_file in response to them.
2. **Read before you edit.** Never guess at file contents — read_file first, then edit_file with the exact string you saw.
3. **Small, targeted edits.** Don't rewrite a whole file; change only what needs changing.
4. **Match the user's style.** Indentation, naming, import style — look at nearby code and match it.
5. **Announce what you're doing in plain text BEFORE the tool call** (one sentence: "I'll wrap the handler in useCallback so child re-renders stop firing").
6. **After the user accepts, briefly explain what changed and WHY** so the user learns, not just copies. Include one probing question to check understanding ("Can you see why the key prop matters here?").
7. If the edit might break things, say so. Suggest a test or a visual check.

## Output format
- Markdown allowed. Use code fences with language tags.
- Reference files by relative path.
- Never hallucinate APIs, filenames, or lines — verify with tools first.
- When you teach a concept, anchor it: "Look at line 42 of src/App.tsx — that's where this pattern applies."`;

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read the contents of a file in the user's workspace. Always call this before edit_file so you know the exact text to replace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative (to workspace root) or absolute path to the file.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description:
        "List files in the user's workspace, optionally filtered by a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Optional glob, e.g. 'src/**/*.tsx' or '**/package.json'. Defaults to '**/*'.",
          },
          limit: {
            type: "number",
            description: "Max results. Defaults to 100.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description:
        "Search file contents in the workspace for a JavaScript regex. Returns matching lines with file path and line number.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "JavaScript regex pattern (string, no flags).",
          },
          glob: {
            type: "string",
            description:
              "Optional file glob to narrow the search, e.g. '**/*.ts'.",
          },
          limit: {
            type: "number",
            description: "Max matching lines to return. Defaults to 50.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "show_code",
      description:
        "Reveal and highlight a specific line range in the user's editor so they can visually see what you're referencing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          startLine: { type: "number", description: "1-indexed start line." },
          endLine: { type: "number", description: "1-indexed end line." },
        },
        required: ["path", "startLine", "endLine"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Propose an edit to a file. The user sees a preview diff and must accept before anything is written. Keep edits small and targeted. Always read_file first so oldString matches byte-for-byte. oldString must be unique in the file unless replaceAll=true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit." },
          oldString: {
            type: "string",
            description:
              "The exact text to replace. Must match byte-for-byte (including whitespace).",
          },
          newString: {
            type: "string",
            description: "The replacement text.",
          },
          replaceAll: {
            type: "boolean",
            description:
              "If true, replace every occurrence. If false or omitted, oldString must be unique.",
          },
        },
        required: ["path", "oldString", "newString"],
      },
    },
  },
];
