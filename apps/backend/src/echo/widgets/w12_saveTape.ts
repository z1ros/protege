import type { SaveTapeEntry, SaveTapePayload } from "@protege/types";
import { readEchoEvents, type EchoEventRow } from "../../store.js";

/**
 * W12 Save Tape. Builds a newest-first feed of the last MAX_ENTRIES
 * `line_diff` events in the window. Each row pulls context (errors,
 * AI, paste) from the ±30s neighborhood of the save so the tape reads
 * as "this save, and what happened around it".
 *
 * Relative timestamps are formatted server-side so the feed doesn't drift
 * with client/server clock skew on refresh.
 */

const MAX_ENTRIES = 30;
const CONTEXT_WINDOW_MS = 30_000;

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

function lastTwoSegments(filePath: string): string {
  // Normalize both separators so Windows paths render the same way.
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return filePath;
  return parts.slice(-2).join("/");
}

function wallClock(ts: number): string {
  const d = new Date(ts);
  const h24 = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const suffix = h24 >= 12 ? "pm" : "am";
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${m}${suffix}`;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Server-side relative-time formatter. Avoids client/server clock skew and
 * matches the copy called out in the task:
 *   "3m ago", "21m ago", "2h ago", "Yesterday 9:47pm", "Apr 15 9:47pm".
 */
function formatRelative(ts: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - ts);
  const deltaMin = Math.floor(deltaMs / 60_000);
  if (deltaMin < 1) return "just now";
  if (deltaMin < 60) return `${deltaMin}m ago`;

  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;

  // Switch to wall-clock phrasing once we cross a calendar day boundary.
  const then = new Date(ts);
  const now = new Date(nowMs);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  if (ts >= startOfYesterday && ts < startOfToday) {
    return `Yesterday ${wallClock(ts)}`;
  }

  const month = MONTH_NAMES[then.getMonth()];
  return `${month} ${then.getDate()} ${wallClock(ts)}`;
}

function countInWindow(
  events: EchoEventRow[],
  type: string,
  file: string,
  centerTs: number
): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type !== type) continue;
    if (ev.file !== file) continue;
    const dt = Math.abs(ev.ts - centerTs);
    if (dt <= CONTEXT_WINDOW_MS) n += 1;
  }
  return n;
}

export async function assembleSaveTapePayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<SaveTapePayload> {
  // Widen the read by the context window so we can correctly annotate saves
  // that landed right at the leading edge of the dashboard window.
  const readStart = windowStart - CONTEXT_WINDOW_MS;
  const readEnd = windowEnd + CONTEXT_WINDOW_MS;
  const events = await readEchoEvents(userId, readStart, readEnd);

  // Saves we tape = `line_diff` events inside the dashboard window.
  const saves = events
    .filter(
      (ev) =>
        ev.type === "line_diff" &&
        typeof ev.file === "string" &&
        ev.ts >= windowStart &&
        ev.ts <= windowEnd
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ENTRIES);

  const nowMs = Date.now();

  const entries: SaveTapeEntry[] = saves.map((save) => {
    const file = save.file as string;
    // Canonical shape is {linesAdded, linesRemoved}. Older seed fixtures
    // use {added, removed} — fall back so dev data still renders chips.
    const payload = save.payload as {
      linesAdded?: number;
      linesRemoved?: number;
      added?: number;
      removed?: number;
    };
    const linesAdded =
      typeof payload.linesAdded === "number"
        ? payload.linesAdded
        : typeof payload.added === "number"
        ? payload.added
        : 0;
    const linesRemoved =
      typeof payload.linesRemoved === "number"
        ? payload.linesRemoved
        : typeof payload.removed === "number"
        ? payload.removed
        : 0;

    const errorsAdded = countInWindow(
      events,
      "diagnostic_appeared",
      file,
      save.ts
    );
    const errorsResolved = countInWindow(
      events,
      "diagnostic_resolved",
      file,
      save.ts
    );
    const aiAccepts = countInWindow(
      events,
      "ai_suggestion_accepted",
      file,
      save.ts
    );
    const pasted = countInWindow(events, "paste_classified", file, save.ts);

    return {
      ts: new Date(save.ts).toISOString(),
      relative: formatRelative(save.ts, nowMs),
      file,
      displayPath: lastTwoSegments(file),
      language: languageFromPath(file),
      linesAdded,
      linesRemoved,
      errorsAdded,
      errorsResolved,
      aiAccepts,
      pasted,
    };
  });

  return { entries };
}
