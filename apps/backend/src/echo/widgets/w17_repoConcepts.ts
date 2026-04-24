import type {
  ConceptKnownStatus,
  ConceptLanguageCount,
  RepoConceptTile,
  RepoConceptsPayload,
} from "@protege/types";
import {
  getEchoPreferences,
  readConceptStatuses,
  readRepoConceptIndex,
} from "../../store.js";

const MAX_TILES = 500;

/**
 * W17 Repo Concepts. Reads RepoConceptIndex rows for the (userId, workspaceRoot)
 * scope populated by the Rv5.B workspace scanner and renders them as tiles
 * that share the single language picker preference and the per-user concept
 * known-status table with W15.
 *
 * workspaceRoot origin: the extension passes `vscode.workspace.workspaceFolders[0]?.uri.fsPath`
 * as the `workspaceRoot` query param on /echo/dashboard. If it's missing or
 * fails the safety validator, the route skips calling this aggregator and
 * the dashboard slot stays null (W17 falls back to its idle empty state).
 *
 * Backend never tracks live scan state; the default `scanState` we emit is
 * `"idle"`. The webview overrides it locally from `repo_scan_status`
 * messages while a scan is in flight, then refetches the dashboard so the
 * tiles populate.
 */
export async function assembleRepoConceptsPayload(
  userId: string,
  workspaceRoot: string | null
): Promise<RepoConceptsPayload | null> {
  if (!workspaceRoot) {
    // No workspace context from the caller — report the idle empty-state
    // payload so the widget still renders an actionable message.
    return {
      tiles: [],
      totalConcepts: 0,
      languages: [],
      selectedLanguage: null,
      workspaceRoot: null,
      lastScannedAt: null,
      scannedFileCount: null,
      scanState: "idle",
    };
  }

  const [rows, statuses, prefs] = await Promise.all([
    readRepoConceptIndex(userId, workspaceRoot),
    readConceptStatuses(userId),
    getEchoPreferences(userId),
  ]);

  const statusMap = new Map<string, ConceptKnownStatus>();
  // Store rows are already v5 after the Rv5.D migration pass on load.
  for (const s of statuses) statusMap.set(s.concept, s.status);

  const selectedLanguage =
    typeof prefs.echoConceptLanguage === "string" ||
    prefs.echoConceptLanguage === null
      ? prefs.echoConceptLanguage ?? null
      : null;

  // Language histogram across ALL rows (pre-filter) so the picker lists
  // every language the scan touched, not just the filtered subset.
  const langHisto = new Map<string | null, number>();
  for (const row of rows) {
    const key = row.language ?? null;
    langHisto.set(key, (langHisto.get(key) ?? 0) + 1);
  }
  const languages: ConceptLanguageCount[] = Array.from(langHisto.entries())
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (a.language ?? "~").localeCompare(b.language ?? "~");
    });

  const filtered =
    selectedLanguage === null
      ? rows
      : rows.filter((r) => (r.language ?? null) === selectedLanguage);

  filtered.sort((a, b) => {
    if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

  const tiles: RepoConceptTile[] = filtered.slice(0, MAX_TILES).map((r) => ({
    name: r.concept,
    language: r.language ?? null,
    fileCount: r.fileCount,
    status: statusMap.get(r.concept) ?? "unset",
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
  }));

  // Secondary stable sort by known-status: unset → not_known → known.
  // Relies on Array.prototype.sort stability (V8) so fileCount/recency
  // order is preserved within each status group.
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

  const lastScannedAt =
    rows.length > 0
      ? rows.reduce(
          (acc, r) => (r.lastSeenAt > acc ? r.lastSeenAt : acc),
          rows[0].lastSeenAt
        )
      : null;
  const scannedFileCount =
    tiles.length > 0 ? tiles.reduce((acc, t) => acc + t.fileCount, 0) : null;

  return {
    tiles,
    totalConcepts: rows.length,
    languages,
    selectedLanguage,
    workspaceRoot,
    lastScannedAt,
    scannedFileCount,
    scanState: "idle",
  };
}

