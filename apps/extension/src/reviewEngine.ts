import * as vscode from "vscode";
import { aiQuery } from "./aiBackend.js";

/**
 * Review Engine — AI-powered code review.
 *
 * Ships the active file to the user's selected backend (on-device Qwen or
 * Claude Haiku/Sonnet) and asks for a JSON array of issues. Unlike the
 * previous regex engine, this catches real bugs, logic errors, and
 * language-aware anti-patterns — not just surface patterns.
 */

export interface Suggestion {
  range: vscode.Range;
  message: string;
  severity: "info" | "warn" | "perf";
  fix?: string;
  ruleId: string;
}

interface AiIssue {
  line: number;
  severity: "info" | "warn" | "perf";
  message: string;
  fix?: string;
  ruleId?: string;
}

const MAX_FILE_LINES = 400;
const MAX_ISSUES = 5;

function buildPrompt(languageId: string, fileName: string, code: string): string {
  return `You are a senior code reviewer. Review the code below and return ONLY a JSON array of the most important issues (bugs, perf problems, clear anti-patterns). No prose, no markdown, no code fences — just the JSON array.

Each issue must be an object with exactly these fields:
- "line": 1-based line number where the issue is
- "severity": one of "warn" (real bug / risky), "perf" (performance), "info" (style / minor)
- "message": one sentence, plain English, specific
- "fix": optional replacement for the entire line, only if you're confident
- "ruleId": short kebab-case id (e.g. "missing-await", "off-by-one")

Rules:
- Return at most ${MAX_ISSUES} issues, highest-value first
- Skip trivial style nits that a linter would catch
- Skip issues in commented-out code
- If the code looks fine, return []
- Output ONLY the JSON array — nothing else

File: ${fileName}
Language: ${languageId}

\`\`\`${languageId}
${code}
\`\`\``;
}

function extractJsonArray(text: string): AiIssue[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (x): x is AiIssue =>
        x &&
        typeof x === "object" &&
        typeof x.line === "number" &&
        typeof x.message === "string" &&
        (x.severity === "warn" || x.severity === "perf" || x.severity === "info")
    );
  } catch {
    return null;
  }
}

export async function reviewDocument(
  document: vscode.TextDocument,
  signal?: { cancelled: boolean }
): Promise<Suggestion[]> {
  const fullText = document.getText();
  if (!fullText.trim()) return [];

  const allLines = fullText.split("\n");
  const truncated = allLines.length > MAX_FILE_LINES;
  const code = truncated ? allLines.slice(0, MAX_FILE_LINES).join("\n") : fullText;

  const fileName = document.fileName.split(/[\\/]/).pop() ?? "file";
  const prompt = buildPrompt(document.languageId, fileName, code);

  const raw = await aiQuery(prompt, 512);
  if (signal?.cancelled) return [];
  if (!raw) return [];

  const issues = extractJsonArray(raw);
  if (!issues) return [];

  const maxLine = document.lineCount;
  const suggestions: Suggestion[] = [];

  for (const issue of issues) {
    const lineIdx = Math.max(0, Math.min(maxLine - 1, Math.floor(issue.line) - 1));
    const lineText = document.lineAt(lineIdx).text;
    const startCol = lineText.search(/\S/);
    const start = new vscode.Position(lineIdx, startCol === -1 ? 0 : startCol);
    const end = new vscode.Position(lineIdx, lineText.length);

    suggestions.push({
      range: new vscode.Range(start, end),
      message: issue.message.trim(),
      severity: issue.severity,
      ruleId: issue.ruleId?.trim() || "ai-review",
      fix: issue.fix?.trim() || undefined,
    });
  }

  const order = { warn: 0, perf: 1, info: 2 };
  suggestions.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.range.start.line - b.range.start.line
  );

  return suggestions.slice(0, MAX_ISSUES);
}
