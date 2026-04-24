import type { CommitStoriesPayload } from "@protege/types";
import {
  readCommitStories,
  readEchoEvents,
  upsertCommitStory,
  type EchoEventRow,
} from "../../store.js";

/**
 * W11 Commit stories. The extension posts `commit_detected` events as part
 * of the normal batcher stream; it also POSTs an enriched story via
 * `/echo/commits`. When an enriched story is missing for a commit this
 * helper backfills the enrichment from EchoEvent rows collected between
 * the prior commit and this one.
 *
 * Enrichment metrics:
 *  - activeMinutes   : count of session_tick events × 1 minute each
 *  - undoCount       : undo_triggered
 *  - pasteCount      : paste_classified
 *  - aiAcceptCount   : ai_suggestion_accepted
 *  - peakFocusMin    : max focusStretchMs across session_tick events
 */

const MIN_MS_PER_TICK = 60_000;

export interface CommitEnrichmentInput {
  userId: string;
  commitSha: string;
  commitTs: number;
  priorCommitTs: number;
  message: string;
  filesTouched: string[];
}

function enrichFromEvents(events: EchoEventRow[]): {
  activeMinutes: number;
  undoCount: number;
  pasteCount: number;
  aiAcceptCount: number;
  peakFocusMin: number;
} {
  let ticks = 0;
  let undoCount = 0;
  let pasteCount = 0;
  let aiAcceptCount = 0;
  let peakFocusMs = 0;
  for (const e of events) {
    switch (e.type) {
      case "session_tick": {
        ticks += 1;
        const stretch = Number(
          (e.payload as { focusStretchMs?: number }).focusStretchMs ?? 0
        );
        if (Number.isFinite(stretch) && stretch > peakFocusMs) peakFocusMs = stretch;
        break;
      }
      case "undo_triggered":
        undoCount += 1;
        break;
      case "paste_classified":
        pasteCount += 1;
        break;
      case "ai_suggestion_accepted":
        aiAcceptCount += 1;
        break;
      default:
        break;
    }
  }
  return {
    activeMinutes: ticks * (MIN_MS_PER_TICK / 60_000),
    undoCount,
    pasteCount,
    aiAcceptCount,
    peakFocusMin: Math.round(peakFocusMs / 60_000),
  };
}

/** Compute enrichment on demand and persist a CommitStory row. */
export async function enrichAndStoreCommit(input: CommitEnrichmentInput): Promise<void> {
  const sinceMs = Math.max(0, Math.min(input.priorCommitTs, input.commitTs));
  const untilMs = Math.max(input.priorCommitTs, input.commitTs);
  const events = await readEchoEvents(input.userId, sinceMs, untilMs);
  const metrics = enrichFromEvents(events);
  await upsertCommitStory({
    userId: input.userId,
    commitSha: input.commitSha,
    commitTs: new Date(input.commitTs).toISOString(),
    message: input.message,
    filesTouched: input.filesTouched.slice(0, 200),
    activeMinutes: metrics.activeMinutes,
    undoCount: metrics.undoCount,
    pasteCount: metrics.pasteCount,
    aiAcceptCount: metrics.aiAcceptCount,
    peakFocusMin: metrics.peakFocusMin,
  });
}

export async function assembleCommitStoriesPayload(
  userId: string,
  windowStart: number,
  windowEnd: number
): Promise<CommitStoriesPayload | null> {
  const rows = await readCommitStories(userId, windowStart, windowEnd);
  if (rows.length === 0) return null;
  return {
    cards: rows.slice(0, 8).map((c) => ({
      sha: c.commitSha,
      shortSha: c.commitSha.slice(0, 7),
      message: c.message.split(/\r?\n/)[0] ?? "",
      filesTouched: c.filesTouched,
      activeMinutes: c.activeMinutes,
      undoCount: c.undoCount,
      pasteCount: c.pasteCount,
      aiAcceptCount: c.aiAcceptCount,
      peakFocusMin: c.peakFocusMin,
      ts: c.commitTs,
    })),
  };
}
