import type { LineThatWontDiePayload } from "@protege/types";
import { topLineRewrite } from "../../store.js";

/**
 * W10 The line that won't die. Finds the single most-rewritten line since
 * `windowStart`. The widget hides itself when the rewrite count is below
 * MIN_REWRITES so we don't surface meaningless noise (a handful of edits
 * aren't a story — 3+ re-saves of the same line is).
 */

const MIN_REWRITES = 3;

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
  html: "xml",
  htm: "xml",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  sql: "sql",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
};

function languageFromPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

function emptyPayload(): LineThatWontDiePayload {
  return {
    filePath: "",
    roughLine: 0,
    content: "",
    language: null,
    rewriteCount: 0,
    lastRewriteAt: "",
    empty: true,
  };
}

export async function assembleRewrittenLinePayload(
  userId: string,
  windowStart: number,
  _windowEnd: number
): Promise<LineThatWontDiePayload> {
  const row = await topLineRewrite(userId, windowStart);
  if (!row || row.rewriteCount < MIN_REWRITES) {
    return emptyPayload();
  }
  return {
    filePath: row.filePath,
    // Rough line # is embedded in the fingerprint, but we don't store it
    // directly — use 0 as a placeholder; the UI treats 0 as "unknown".
    roughLine: 0,
    content: row.lastContent,
    language: languageFromPath(row.filePath),
    rewriteCount: row.rewriteCount,
    lastRewriteAt: row.lastRewriteAt,
    empty: false,
  };
}
