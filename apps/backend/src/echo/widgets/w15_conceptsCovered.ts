import type {
  ConceptKnownStatus,
  ConceptLanguageCount,
  ConceptsCoveredPayload,
  ConceptsCoveredTile,
} from "@protege/types";
import {
  getEchoPreferences,
  readConceptStates,
  readConceptStatuses,
} from "../../store.js";

const MAX_TILES = 300;
const MANUAL_AUTHORSHIP_THRESHOLD = 0.5;

type Bucket = ConceptsCoveredTile["bucket"];

/**
 * W15 Concepts Covered (v5). Two buckets:
 *
 *   - **yours**  — concepts with `hasBeenAuthored === true` (sticky, set
 *                  once the user has personally crossed the manual-
 *                  authorship threshold in any file).
 *   - **ai**     — not yet authored, but a non-null authorshipRatio below
 *                  the threshold signals AI-driven inclusion.
 *
 * Concepts with `hasBeenAuthored === false && authorshipRatio === null`
 * are excluded entirely — those belong to W17 (Repo Concepts), not here.
 *
 * A single shared language preference filters both buckets. The preference
 * lives on UserPreferenceRow.echoConceptLanguage (null = All languages)
 * so W17 can read the same key and stay in sync.
 */
export async function assembleConceptsCoveredPayload(
  userId: string,
  windowStart: number,
  _windowEnd: number
): Promise<ConceptsCoveredPayload | null> {
  const [states, statuses, prefs] = await Promise.all([
    readConceptStates(userId),
    readConceptStatuses(userId),
    getEchoPreferences(userId),
  ]);

  const windowStartIso = new Date(windowStart).toISOString();

  const statusMap = new Map<string, ConceptKnownStatus>();
  for (const s of statuses) {
    // Store rows are already v5 after the Rv5.D migration pass on load.
    statusMap.set(s.concept, s.status);
  }

  const selectedLanguage =
    typeof prefs.echoConceptLanguage === "string" ||
    prefs.echoConceptLanguage === null
      ? prefs.echoConceptLanguage ?? null
      : null;

  // Build all candidate tiles first so we can compute the full language
  // histogram before filtering.
  interface Candidate {
    state: (typeof states)[number];
    bucket: Bucket;
  }
  const candidates: Candidate[] = [];
  for (const state of states) {
    const bucket = bucketFor(state.hasBeenAuthored, state.authorshipRatio);
    if (bucket === null) continue;
    candidates.push({ state, bucket });
  }

  // Language histogram across the full pre-filter candidate pool.
  const langHisto = new Map<string | null, number>();
  for (const c of candidates) {
    const key = c.state.language ?? null;
    langHisto.set(key, (langHisto.get(key) ?? 0) + 1);
  }
  const languages: ConceptLanguageCount[] = Array.from(langHisto.entries())
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (a.language ?? "~").localeCompare(b.language ?? "~");
    });

  // Apply the language filter.
  const filtered = selectedLanguage === null
    ? candidates
    : candidates.filter((c) => (c.state.language ?? null) === selectedLanguage);

  const tiles: ConceptsCoveredTile[] = filtered.map((c) => {
    const firstSeenAt = c.state.firstSeenAt;
    const isNew = firstSeenAt >= windowStartIso;
    return {
      name: c.state.conceptName,
      language: c.state.language ?? null,
      timesUsed: c.state.timesUsed,
      distinctFiles: c.state.distinctFiles.length,
      bucket: c.bucket,
      status: statusMap.get(c.state.conceptName) ?? "unset",
      isNew,
      firstSeenAt,
      lastUsedAt: c.state.lastUsedAt,
    };
  });

  // Sort: most recent lastUsedAt first, then timesUsed desc.
  tiles.sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) {
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    }
    return b.timesUsed - a.timesUsed;
  });

  // Secondary stable sort by known-status: unset → not_known → known.
  // Relies on Array.prototype.sort stability (V8) so recency/usage order
  // is preserved within each status group.
  const STATUS_ORDER: Record<ConceptKnownStatus, number> = {
    unset: 0,
    not_known: 1,
    known: 2,
  };
  tiles.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 0;
    const sb = STATUS_ORDER[b.status] ?? 0;
    return sa - sb;
  });

  const counts = { yours: 0, ai: 0 };
  for (const t of tiles) counts[t.bucket] += 1;

  return {
    tiles: tiles.slice(0, MAX_TILES),
    counts,
    languages,
    selectedLanguage,
  };
}

/** Returns the v5 bucket, or null when the concept belongs in W17 (no
 *  user-authorship signal at all → "in codebase"). */
export function bucketFor(
  hasBeenAuthored: boolean,
  authorshipRatio: number | null
): Bucket | null {
  if (hasBeenAuthored) return "yours";
  if (authorshipRatio === null || !Number.isFinite(authorshipRatio)) {
    return null;
  }
  if (authorshipRatio < MANUAL_AUTHORSHIP_THRESHOLD) return "ai";
  // Ratio ≥ threshold but hasBeenAuthored still false — the nightly
  // backfill/sticky flag will catch this on the next pass. Until then,
  // treat as "yours" so the widget reflects intent.
  return "yours";
}

