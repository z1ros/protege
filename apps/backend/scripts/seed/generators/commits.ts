import type { CommitStoryRowStore } from "../../../src/store.js";
import type { Rng } from "../random.js";
import { COMMIT_MESSAGES, FILES_BY_LANGUAGE, LANGUAGES } from "../fixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Options {
  userId: string;
  nowMs: number;
  rng: Rng;
}

/**
 * Five commits spaced across the last 7 days, newest first. Enrichment
 * fields (activeMinutes, undoCount, etc.) come in a plausible range so
 * W11's story chips render with real numbers.
 */
export function generateCommitStories(opts: Options): CommitStoryRowStore[] {
  const { userId, nowMs, rng } = opts;
  const allFiles = LANGUAGES.flatMap((l) => FILES_BY_LANGUAGE[l]);
  const messages = rng.shuffle(COMMIT_MESSAGES).slice(0, 5);
  const rows: CommitStoryRowStore[] = [];

  // Evenly space 5 commits over the last 7 days.
  const offsets = [0.3, 1.2, 2.5, 4.0, 6.1];
  for (let i = 0; i < 5; i += 1) {
    const daysBack = offsets[i];
    const commitTs = new Date(nowMs - daysBack * DAY_MS).toISOString();
    const filesTouched = rng.shuffle(allFiles).slice(0, rng.int(1, 4));
    rows.push({
      userId,
      commitSha: rng.hex(40),
      commitTs,
      message: messages[i],
      filesTouched,
      activeMinutes: rng.int(12, 85),
      undoCount: rng.int(0, 6),
      pasteCount: rng.int(0, 4),
      aiAcceptCount: rng.int(0, 7),
      peakFocusMin: rng.int(8, 45),
    });
  }
  return rows;
}
