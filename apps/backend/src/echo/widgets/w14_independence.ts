import type {
  IndependenceDayPoint,
  IndependenceLanguageRow,
  IndependenceTrendPayload,
} from "@protege/types";
import { readEchoEvents } from "../../store.js";
import { dateKey, rangeDates } from "../util/shared.js";

/**
 * W14 Independence Trend. Replaces the old W14 Code Origin donut. Derives
 * an authorship trajectory over the window plus depth signals:
 *   - manualPct for the window + signed delta vs. prior equal-length window
 *   - daily typed / AI / paste char stacks for the area chart
 *   - edit-after-accept rate + signed trend
 *   - count of undo_triggered events within 10s of ai_suggestion_accepted
 *   - per-language accept-rate breakdown (top 4 by total chars)
 *
 * Null return means the window has no authorship signal at all — the
 * widget renders its empty state instead of a chart of zeros.
 */
export async function assembleIndependencePayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<IndependenceTrendPayload | null> {
  const rows = await readEchoEvents(userId, windowStart, windowEnd);

  // Day buckets: every day in the window gets an entry (missing days render
  // as zero stacks so the area chart reads as "no activity" instead of
  // collapsing the x-axis).
  const dates = rangeDates(windowStart, windowEnd);
  const dayMap = new Map<string, IndependenceDayPoint>();
  for (const d of dates) {
    dayMap.set(d, {
      date: d,
      label: formatDayLabel(d),
      typedChars: 0,
      aiChars: 0,
      pastedChars: 0,
    });
  }

  // Per-language buckets — keyed by normalized language string. We collect
  // typed + ai + accept/reject counts so we can fall back to a chars-share
  // rate when reject events aren't present.
  interface LangAgg {
    typedChars: number;
    aiChars: number;
    acceptCount: number;
    rejectCount: number;
  }
  const langMap = new Map<string, LangAgg>();
  const bumpLang = (lang: string | null | undefined): LangAgg | null => {
    const normalized = normalizeLanguage(lang);
    if (!normalized) return null;
    const existing = langMap.get(normalized);
    if (existing) return existing;
    const fresh: LangAgg = {
      typedChars: 0,
      aiChars: 0,
      acceptCount: 0,
      rejectCount: 0,
    };
    langMap.set(normalized, fresh);
    return fresh;
  };

  let totalTyped = 0;
  let totalAi = 0;
  let totalPasted = 0;
  let aiAcceptCount = 0;
  let aiEditAfterAcceptCount = 0;

  // Collect ai_suggestion_accepted timestamps per file so we can later
  // detect undo_triggered events within 10s on the same file.
  interface AcceptEvt {
    ts: number;
    file: string;
  }
  const acceptEvents: AcceptEvt[] = [];
  const undoEvents: AcceptEvt[] = [];

  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const file = typeof p.file === "string" ? p.file : "";
    switch (row.type) {
      case "keystroke_batch": {
        const raw = p.charsTyped;
        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
          const v = Math.floor(raw);
          totalTyped += v;
          const key = dateKey(row.ts);
          const bucket = dayMap.get(key);
          if (bucket) bucket.typedChars += v;
          const lang = bumpLang(
            typeof p.language === "string"
              ? p.language
              : languageFromFile(file)
          );
          if (lang) lang.typedChars += v;
        }
        break;
      }
      case "ai_suggestion_accepted": {
        aiAcceptCount += 1;
        const accepted = p.charsAccepted;
        const fallback = p.chars;
        let chars = 0;
        if (typeof accepted === "number" && Number.isFinite(accepted)) {
          chars = Math.max(0, Math.floor(accepted));
        } else if (typeof fallback === "number" && Number.isFinite(fallback)) {
          chars = Math.max(0, Math.floor(fallback));
        }
        totalAi += chars;
        const bucket = dayMap.get(dateKey(row.ts));
        if (bucket) bucket.aiChars += chars;
        const lang = bumpLang(
          typeof p.language === "string" ? p.language : languageFromFile(file)
        );
        if (lang) {
          lang.aiChars += chars;
          lang.acceptCount += 1;
        }
        if (file) acceptEvents.push({ ts: row.ts, file });
        break;
      }
      case "ai_suggestion_rejected": {
        const lang = bumpLang(
          typeof p.language === "string" ? p.language : languageFromFile(file)
        );
        if (lang) lang.rejectCount += 1;
        break;
      }
      case "paste_classified": {
        const chars = p.chars;
        if (typeof chars === "number" && Number.isFinite(chars) && chars > 0) {
          const v = Math.floor(chars);
          totalPasted += v;
          const bucket = dayMap.get(dateKey(row.ts));
          if (bucket) bucket.pastedChars += v;
        }
        break;
      }
      case "ai_edit_after_accept": {
        aiEditAfterAcceptCount += 1;
        break;
      }
      case "undo_triggered": {
        if (file) undoEvents.push({ ts: row.ts, file });
        break;
      }
      default:
        break;
    }
  }

  // No signal at all → empty state.
  if (totalTyped + totalAi + totalPasted <= 0) return null;

  // Manual% — paste excluded from denominator. Paste is recorded in `days`
  // for chart context but it's a separate axis from the "wrote it vs.
  // accepted AI" ratio we want to track here.
  const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
  const humanAiTotal = totalTyped + totalAi;
  const manualPct = humanAiTotal > 0 ? clamp(totalTyped / humanAiTotal) : 0;

  const editAfterAcceptRate =
    aiAcceptCount > 0 ? clamp(aiEditAfterAcceptCount / aiAcceptCount) : null;

  // undo-within-10s: for each accept, check if any undo on the same file
  // fired in (ts, ts + 10_000]. O(A*U) is fine — these are sparse events.
  const UNDO_WINDOW_MS = 10_000;
  let undoAfterAcceptCount = 0;
  for (const ac of acceptEvents) {
    for (const u of undoEvents) {
      if (
        u.file === ac.file &&
        u.ts > ac.ts &&
        u.ts - ac.ts <= UNDO_WINDOW_MS
      ) {
        undoAfterAcceptCount += 1;
        break;
      }
    }
  }

  // Prior-window trend. Immediately before current window, same length.
  const windowMs = Math.max(1, windowEnd - windowStart);
  const priorStart = windowStart - windowMs;
  const priorEnd = windowStart - 1;
  let manualPctTrend: number | null = null;
  let editAfterAcceptTrend: number | null = null;
  if (priorEnd > 0) {
    const priorRows = await readEchoEvents(userId, priorStart, priorEnd);
    let priorTyped = 0;
    let priorAi = 0;
    let priorAccepts = 0;
    let priorEdits = 0;
    for (const row of priorRows) {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (row.type === "keystroke_batch") {
        const raw = p.charsTyped;
        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
          priorTyped += Math.floor(raw);
        }
      } else if (row.type === "ai_suggestion_accepted") {
        priorAccepts += 1;
        const accepted = p.charsAccepted;
        const fallback = p.chars;
        if (typeof accepted === "number" && Number.isFinite(accepted)) {
          priorAi += Math.max(0, Math.floor(accepted));
        } else if (typeof fallback === "number" && Number.isFinite(fallback)) {
          priorAi += Math.max(0, Math.floor(fallback));
        }
      } else if (row.type === "ai_edit_after_accept") {
        priorEdits += 1;
      }
    }
    const priorHumanAi = priorTyped + priorAi;
    if (priorHumanAi > 0) {
      const priorManual = clamp(priorTyped / priorHumanAi);
      manualPctTrend = manualPct - priorManual;
    }
    if (editAfterAcceptRate !== null && priorAccepts > 0) {
      const priorRate = clamp(priorEdits / priorAccepts);
      editAfterAcceptTrend = editAfterAcceptRate - priorRate;
    }
  }

  // Per-language: prefer accept-vs-reject rate when rejects exist,
  // otherwise fall back to typed-vs-AI chars share (inverted so a higher
  // value means "AI was accepted more often"). Keep top 4 by sample.
  const langRows: IndependenceLanguageRow[] = [];
  for (const [language, agg] of langMap) {
    const interactions = agg.acceptCount + agg.rejectCount;
    const sample = agg.typedChars + agg.aiChars;
    let acceptRate: number;
    if (interactions > 0) {
      acceptRate = clamp(agg.acceptCount / interactions);
    } else if (sample > 0) {
      acceptRate = clamp(agg.aiChars / sample);
    } else {
      acceptRate = 0;
    }
    langRows.push({ language, acceptRate, sample });
  }
  langRows.sort((a, b) => b.sample - a.sample);

  const days = dates
    .map((d) => dayMap.get(d))
    .filter((x): x is IndependenceDayPoint => !!x);

  return {
    manualPct,
    manualPctTrend,
    editAfterAcceptRate,
    editAfterAcceptTrend,
    undoAfterAcceptCount,
    days,
    byLanguage: langRows.slice(0, 4),
  };
}

/** Format a YYYY-MM-DD date key as a short display label (e.g. "Wed 22"). */
function formatDayLabel(d: string): string {
  const ms = Date.parse(`${d}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return d;
  const dt = new Date(ms);
  const weekday = dt.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  const day = dt.getUTCDate();
  return `${weekday} ${day}`;
}

/** Trim + lowercase to normalize language keys; returns null on empty/bogus. */
function normalizeLanguage(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  if (t.length === 0 || t === "plaintext" || t === "unknown") return null;
  return t;
}

/** Minimal extension → language map used as a fallback when the event
 *  payload omits `language`. Covers the languages the rest of the Echo
 *  pipeline cares about — anything else returns null and rolls up as
 *  "no language detected". */
function languageFromFile(file: string): string | null {
  if (!file) return null;
  const dot = file.lastIndexOf(".");
  if (dot < 0 || dot === file.length - 1) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "cs":
      return "csharp";
    case "cpp":
    case "cc":
    case "cxx":
      return "cpp";
    case "c":
    case "h":
      return "c";
    case "swift":
      return "swift";
    case "kt":
    case "kts":
      return "kotlin";
    case "scala":
      return "scala";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    default:
      return null;
  }
}
