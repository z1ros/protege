import type { Rng } from "../random.js";
import type { EchoEventInput } from "../../../src/store.js";
import { FILES_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

interface Options {
  userId: string;
  days: number;
  nowMs: number;
  rng: Rng;
}

/**
 * Emit ~300 EchoEvents with two distinct textures:
 *
 * 1. Dense "last completed session" (W12 Coastline) — wrapped in
 *    session_boundary start/end, with file_focus_change, line_diff,
 *    diagnostic_appeared/resolved, ai_suggestion_accepted, paste_classified,
 *    undo_triggered, keystroke_batch sprinkled in.
 *
 * 2. Sparse activity across the prior N-1 days — session_tick + occasional
 *    line_diff + keystroke_batch / ai_suggestion_accepted / paste_classified
 *    to feed W14 Code Origin.
 */
export function generateEchoEvents(opts: Options): EchoEventInput[] {
  const { userId, days, nowMs, rng } = opts;
  const allFiles = LANGUAGES.flatMap((l) => FILES_BY_LANGUAGE[l]);
  const out: EchoEventInput[] = [];

  // ===== Dense recent session (W12) =====
  // End ~30 minutes ago, lasts ~45 minutes, ~40 events.
  const sessionEnd = nowMs - 30 * MIN_MS;
  const sessionStart = sessionEnd - 45 * MIN_MS;
  const sessionFiles = rng.shuffle(allFiles).slice(0, 3);
  const activeMs = sessionEnd - sessionStart;

  out.push({
    userId,
    type: "session_boundary",
    ts: sessionStart,
    file: sessionFiles[0],
    payload: { kind: "start" },
  });

  // Emit a session_tick every 60s of the session. The rollup uses these to
  // compute activeMinutes + totalMinutes + hourHistogram; without them the
  // dashboard reports 0 time despite other events existing.
  for (let m = 0; m < Math.floor(activeMs / MIN_MS); m += 1) {
    const ts = sessionStart + m * MIN_MS;
    const file = rng.pick(sessionFiles);
    const ext = file.split(".").pop() ?? "";
    const language =
      ext === "ts" || ext === "tsx"
        ? "typescript"
        : ext === "py"
          ? "python"
          : ext === "rs"
            ? "rust"
            : null;
    out.push({
      userId,
      type: "session_tick",
      ts,
      file,
      payload: { file, language, focusStretchMs: rng.int(5_000, 55_000) },
    });
  }

  const intraEventCount = rng.int(32, 44);
  for (let i = 0; i < intraEventCount; i += 1) {
    const ts = sessionStart + Math.floor((activeMs * (i + 1)) / (intraEventCount + 1));
    const file = rng.pick(sessionFiles);
    const kind = rng.int(0, 100);
    if (kind < 20) {
      out.push({
        userId,
        type: "file_focus_change",
        ts,
        file,
        payload: { previousFile: rng.pick(sessionFiles) },
      });
    } else if (kind < 40) {
      out.push({
        userId,
        type: "line_diff",
        ts,
        file,
        payload: { linesAdded: rng.int(1, 12), linesRemoved: rng.int(0, 4) },
      });
    } else if (kind < 55) {
      out.push({
        userId,
        type: "keystroke_batch",
        ts,
        file,
        payload: { charsTyped: rng.int(40, 260) },
      });
    } else if (kind < 70) {
      out.push({
        userId,
        type: "ai_suggestion_accepted",
        ts,
        file,
        payload: { charsAccepted: rng.int(20, 160) },
      });
    } else if (kind < 80) {
      out.push({
        userId,
        type: "paste_classified",
        ts,
        file,
        payload: { chars: rng.int(30, 200), source: rng.pick(["clipboard", "ai-chat"]) },
      });
    } else if (kind < 88) {
      out.push({
        userId,
        type: "diagnostic_appeared",
        ts,
        file,
        payload: { severity: rng.pick(["error", "warning"]), message: "unresolved identifier" },
      });
    } else if (kind < 95) {
      out.push({
        userId,
        type: "diagnostic_resolved",
        ts,
        file,
        payload: {},
      });
    } else {
      out.push({
        userId,
        type: "undo_triggered",
        ts,
        file,
        payload: {},
      });
    }
  }

  out.push({
    userId,
    type: "session_boundary",
    ts: sessionEnd,
    file: sessionFiles[sessionFiles.length - 1],
    payload: { kind: "end", activeMs },
  });

  // ===== Sparse prior-day events =====
  for (let i = 1; i < days; i += 1) {
    const dayStart = nowMs - i * DAY_MS;
    const activeDay = rng.bool(0.75);
    if (!activeDay) continue;

    // A paired session per active day for W2 Polar arcs.
    const sessionsThisDay = rng.int(1, 2);
    for (let s = 0; s < sessionsThisDay; s += 1) {
      const hour = rng.int(9, 22);
      const start = dayStart + hour * 60 * MIN_MS + rng.int(0, 30) * MIN_MS;
      const durMs = rng.int(15, 90) * MIN_MS;
      const end = start + durMs;
      const file = rng.pick(allFiles);
      out.push({
        userId,
        type: "session_boundary",
        ts: start,
        file,
        payload: { kind: "start" },
      });

      // One session_tick per minute of the session (see comment on the
      // recent session above — same rationale).
      const ext = file.split(".").pop() ?? "";
      const language =
        ext === "ts" || ext === "tsx"
          ? "typescript"
          : ext === "py"
            ? "python"
            : ext === "rs"
              ? "rust"
              : null;
      for (let m = 0; m < Math.floor(durMs / MIN_MS); m += 1) {
        out.push({
          userId,
          type: "session_tick",
          ts: start + m * MIN_MS,
          file,
          payload: { file, language, focusStretchMs: rng.int(5_000, 55_000) },
        });
      }

      const innerCount = rng.int(3, 9);
      for (let k = 0; k < innerCount; k += 1) {
        const ts = start + Math.floor((durMs * (k + 1)) / (innerCount + 1));
        const pick = rng.int(0, 100);
        if (pick < 40) {
          out.push({
            userId,
            type: "keystroke_batch",
            ts,
            file,
            payload: { charsTyped: rng.int(30, 220) },
          });
        } else if (pick < 65) {
          out.push({
            userId,
            type: "line_diff",
            ts,
            file,
            payload: { added: rng.int(1, 10), removed: rng.int(0, 3) },
          });
        } else if (pick < 85) {
          out.push({
            userId,
            type: "ai_suggestion_accepted",
            ts,
            file,
            payload: { charsAccepted: rng.int(15, 140) },
          });
        } else {
          out.push({
            userId,
            type: "paste_classified",
            ts,
            file,
            payload: { chars: rng.int(20, 150), source: "clipboard" },
          });
        }
      }

      out.push({
        userId,
        type: "session_boundary",
        ts: end,
        file,
        payload: { kind: "end", activeMs: durMs },
      });
    }
  }

  return out.sort((a, b) => a.ts - b.ts);
}
