import * as vscode from "vscode";
import { aiQuery } from "./aiBackend.js";
import { log, logBlock } from "./log.js";

/**
 * Review Engine — AI-powered code review.
 *
 * Ships the active file to the user's selected backend (on-device Qwen or
 * Claude Haiku/Sonnet) and asks for a JSON array of issues. Unlike the
 * previous regex engine, this catches real bugs, logic errors, and
 * language-aware anti-patterns — not just surface patterns.
 */

/**
 * A location in the workspace that's *related* to a suggestion but lives
 * in a different line or file. Used for block-scope findings (function-
 * wide bugs) and flow-scope findings (multi-file architectural issues).
 */
export interface Anchor {
  /** `uri.toString()` of the related document. */
  uri: string;
  /** 0-based line number. */
  line: number;
  /** Short human-readable reason this anchor is part of the finding. */
  label: string;
}

export interface Suggestion {
  range: vscode.Range;
  message: string;
  severity: "info" | "warn" | "perf";
  fix?: string;
  ruleId: string;
  /**
   * How big the issue is:
   *  - "atom"  → one line / one token (default; what the LIVE scanner emits)
   *  - "block" → a function / component body
   *  - "flow"  → spans 2+ files, tracked by `flowId`
   */
  scope?: "atom" | "block" | "flow";
  /** Related locations elsewhere in the same file or across files. */
  anchors?: Anchor[];
  /** Groups flow-scope findings that belong to the same architectural flow. */
  flowId?: string;
  /**
   * Which scan tier emitted this finding. Used by the store to dedup
   * and by telemetry/debug to trace where a suggestion came from.
   */
  tier?: "live" | "save" | "idle";
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

/**
 * Pull a JSON array out of a small-model response that might be wrapped
 * in markdown fences, prefaced with prose ("Here's the JSON:"), or even
 * contain brackets in the prose itself. Strategy, in order:
 *
 *   1. Strip ```json / ``` fences.
 *   2. Try to parse the whole thing as JSON.
 *   3. Scan for balanced top-level `[...]` blocks, biggest first, and
 *      parse each until one succeeds.
 *
 * The old impl (`first [` → `last ]`) broke the moment the model wrote
 * anything like "I see [useState] in the code — here are the issues: [...]".
 */
function extractJsonArray(text: string): AiIssue[] | null {
  // 1. Strip common markdown wrappers
  let cleaned = text.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```\s*$/m;
  const fenceMatch = cleaned.match(fence);
  if (fenceMatch && fenceMatch[1]) cleaned = fenceMatch[1].trim();

  // 2. Direct parse attempt
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // 3. Find every balanced top-level [...] and try each, largest first
  const candidates: string[] = [];
  let depth = 0;
  let startIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "[") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        candidates.push(cleaned.slice(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function tryParse(raw: string): AiIssue[] | null {
  try {
    const parsed = JSON.parse(raw);
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
  if (!fullText.trim()) {
    log("reviewEngine", `skip ${fileNameOf(document)} — empty`);
    return [];
  }

  const allLines = fullText.split("\n");
  const truncated = allLines.length > MAX_FILE_LINES;
  const code = truncated ? allLines.slice(0, MAX_FILE_LINES).join("\n") : fullText;

  const fileName = fileNameOf(document);
  const prompt = buildPrompt(document.languageId, fileName, code);

  log(
    "reviewEngine",
    `scan start · ${fileName} · ${allLines.length} lines${truncated ? " (truncated to " + MAX_FILE_LINES + ")" : ""} · prompt ${prompt.length}ch`
  );

  const started = Date.now();
  const raw = await aiQuery(prompt, 512);
  const elapsed = Date.now() - started;

  if (signal?.cancelled) {
    log("reviewEngine", `scan cancelled ${fileName} after ${elapsed}ms`);
    return [];
  }
  if (!raw) {
    log(
      "reviewEngine",
      `scan FAIL ${fileName} after ${elapsed}ms — aiQuery returned null (model unavailable? on-device not ready?)`
    );
    return [];
  }

  log("reviewEngine", `scan got raw reply · ${raw.length}ch · ${elapsed}ms`);

  const issues = extractJsonArray(raw);
  if (!issues) {
    // Critical: the model returned text but we couldn't parse JSON. Dump
    // the raw reply so you can see what it actually said. Most common
    // cause on Qwen 1.5B is markdown fences or prose before/after the array.
    logBlock(
      "reviewEngine",
      `JSON PARSE FAIL for ${fileName} — first 800 chars of raw reply`,
      raw.slice(0, 800)
    );
    return [];
  }

  log("reviewEngine", `parsed ${issues.length} issue${issues.length === 1 ? "" : "s"}`);

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
      scope: "atom",
      tier: "live",
    });
  }

  const order = { warn: 0, perf: 1, info: 2 };
  suggestions.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.range.start.line - b.range.start.line
  );

  log(
    "reviewEngine",
    `scan done · ${suggestions.length} final suggestion${suggestions.length === 1 ? "" : "s"} after cap (${MAX_ISSUES})`
  );

  return suggestions.slice(0, MAX_ISSUES);
}

function fileNameOf(doc: vscode.TextDocument): string {
  return doc.fileName.split(/[\\/]/).pop() ?? "file";
}
