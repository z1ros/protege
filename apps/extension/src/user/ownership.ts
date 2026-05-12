import * as vscode from "vscode";
import type {
  FileOwnership,
  OwnershipRegion,
  OwnershipSummary,
  OwnershipState,
} from "@protege/types";
import { log } from "../log.js";

/**
 * Per-file ownership tracking — the core of the vibecoding partnership.
 *
 * Model:
 *   - Every large auto-insert leaves a RED region ("auto-inserted",
 *     explainedAt: null).
 *   - Normal typing leaves a GREEN region ("typed"). These still count
 *     as owned without explanation — you can't fake writing code.
 *   - Explain-back + drill mark existing regions with explainedAt, which
 *     promotes auto-inserted → owned.
 *
 * Derived metric: `ownedPct = (typed + explained-auto) / totalLines`.
 * Everything the inviter and UI show flows from this single number.
 *
 * Persistence: context.globalState under `protege.ownership:<uri>`. A
 * session in-memory cache sits on top; globalState writes are debounced
 * (1s) to avoid thrashing the vscode extension state file.
 *
 * Region math:
 *   Regions are half-open in intent but we store them as inclusive
 *   [startLine, endLine] because vscode.Range is naturally inclusive.
 *   On insert we merge adjacent same-origin, same-explained regions.
 *   We cap at MAX_REGIONS_PER_FILE and coarsen (merge the smallest gap)
 *   when exceeded, so pathological editing patterns can't bloat state.
 */

const KEY_PREFIX = "protege.ownership:";
const MAX_REGIONS_PER_FILE = 200;
const PERSIST_DEBOUNCE_MS = 1_000;

/** Drop unreviewed auto-inserted regions older than this. Reopening a
 *  file from a past session should not keep flagging code as AI forever —
 *  if the user didn't review it within the window, it's stale noise.
 *  30 min covers "I stepped away and came back" but not "it's been there
 *  for days." */
const AUTO_INSERTED_TTL_MS = 30 * 60_000;

/** Minimum size for an auto-inserted region to stick around. Anything
 *  smaller was almost certainly created by a spurious burst/pace trip
 *  (fast-typing, auto-import). Gated at the write path AND pruned on
 *  every read so they never render a CodeLens. */
const MIN_AUTO_LINES = 3;

/** How many blank/typed lines between two same-origin regions are still
 *  treated as "adjacent" for merge purposes. With value 2 we tolerate
 *  ONE blank line between the regions — covers the common case where
 *  an AI paste contains multiple statements separated by whitespace
 *  (e.g. a `const views = [...]` block, then a blank line, then a
 *  `useEffect(...)` block) and they would otherwise render as two
 *  separate "Teach me this block" lenses for what's conceptually one
 *  paste. Larger gaps stay split so unrelated edits don't fuse. */
const MERGE_LINE_GAP = 2;

let ctx: vscode.ExtensionContext | null = null;
const cache = new Map<string, FileOwnership>();
const pendingSaves = new Map<string, NodeJS.Timeout>();

const emitter = new vscode.EventEmitter<string>();
/** Fires with the URI string whenever a file's ownership changes. */
export const onOwnershipChanged: vscode.Event<string> = emitter.event;

export function installOwnership(context: vscode.ExtensionContext): void {
  ctx = context;
  log("ownership", "installed");
}

/** Prune unreviewed auto-inserted regions that are stale (too old, too
 *  small, or missing createdAt after upgrade). Runs on every read so
 *  stale data from old sessions can't leak into UI surfaces. Returns a
 *  new array; mutates nothing in place. Also returns whether anything
 *  was actually dropped so callers can decide whether to re-persist. */
function pruneStale(
  regions: OwnershipRegion[],
  now: number
): { regions: OwnershipRegion[]; changed: boolean } {
  const kept: OwnershipRegion[] = [];
  let changed = false;
  for (const r of regions) {
    // Typed / explained regions are keepers regardless of age or size —
    // they represent real ownership signal the user earned.
    if (r.origin === "typed" || r.explainedAt !== null) {
      kept.push(r);
      continue;
    }
    // Unreviewed auto-inserted OR pasted — apply TTL + size gate.
    const lines = r.endLine - r.startLine + 1;
    // No createdAt? Legacy region from before the field existed —
    // treat as stale so a reload after upgrade wipes the old backlog.
    if (r.createdAt === undefined) {
      changed = true;
      continue;
    }
    if (now - r.createdAt > AUTO_INSERTED_TTL_MS) {
      changed = true;
      continue;
    }
    if (lines < MIN_AUTO_LINES) {
      changed = true;
      continue;
    }
    kept.push(r);
  }
  return { regions: kept, changed };
}

/** Read-through accessor: cache first, then globalState, then empty.
 *  Prunes stale unreviewed auto-inserted regions on each load so old
 *  records from prior sessions decay quietly. Also re-runs
 *  `sortAndMerge` against the current MERGE_LINE_GAP so regions
 *  recorded under an older (tighter) tolerance get coalesced when the
 *  rule loosens. Without this, the user's existing split regions stay
 *  split until the next edit, which leaves stale UI like "two CodeLens
 *  for one paste" lingering across reloads. */
function load(uriKey: string): FileOwnership {
  const cached = cache.get(uriKey);
  if (cached) return cached;
  const stored = ctx?.globalState.get<FileOwnership>(KEY_PREFIX + uriKey);
  const base: FileOwnership = stored ?? {
    version: 1,
    regions: [],
    lastScanAt: 0,
    totalLinesAtLastScan: 0,
  };
  const now = Date.now();
  const pruned = pruneStale(base.regions, now);
  const remerged = sortAndMerge(pruned.regions);
  // sortAndMerge always returns a fresh array, so reference-equality
  // doesn't tell us whether anything actually changed. Compare lengths
  // and per-region bounds; if either differs we mark the file dirty.
  const merged = !sameRegions(pruned.regions, remerged);
  const finalRegions = merged ? remerged : pruned.regions;
  const changed = pruned.changed || merged;
  const result: FileOwnership = changed
    ? { ...base, regions: finalRegions }
    : base;
  cache.set(uriKey, result);
  if (changed) schedulePersist(uriKey);
  return result;
}

function sameRegions(
  a: OwnershipRegion[],
  b: OwnershipRegion[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].startLine !== b[i].startLine ||
      a[i].endLine !== b[i].endLine ||
      a[i].origin !== b[i].origin ||
      a[i].explainedAt !== b[i].explainedAt
    ) {
      return false;
    }
  }
  return true;
}

function schedulePersist(uriKey: string): void {
  const prior = pendingSaves.get(uriKey);
  if (prior) clearTimeout(prior);
  const handle = setTimeout(() => {
    pendingSaves.delete(uriKey);
    const data = cache.get(uriKey);
    if (!data || !ctx) return;
    void ctx.globalState.update(KEY_PREFIX + uriKey, data);
  }, PERSIST_DEBOUNCE_MS);
  pendingSaves.set(uriKey, handle);
}

/** Record a new edit. Merges into existing regions when adjacent/overlapping. */
export function recordChange(
  uri: vscode.Uri,
  startLine: number,
  endLine: number,
  origin: "typed" | "auto-inserted" | "pasted"
): void {
  if (endLine < startLine) return;
  // Gate tiny unowned-by-default bursts at the write path — a 1-line paste
  // or a 1-line AI completion should never end up as an "AI block" /
  // "Pasted block" CodeLens. Typed regions stay small by design (single
  // keystrokes) and are not gated.
  if (origin === "auto-inserted" || origin === "pasted") {
    const lines = endLine - startLine + 1;
    if (lines < MIN_AUTO_LINES) return;
  }
  const uriKey = uri.toString();
  const data = load(uriKey);

  const newRegion: OwnershipRegion = {
    startLine,
    endLine,
    origin,
    explainedAt: null,
    createdAt: Date.now(),
  };
  data.regions = insertRegion(data.regions, newRegion);
  data.regions = capRegions(data.regions);

  // Refresh doc-line count opportunistically if the document is open —
  // avoids a stale denominator after big bursts.
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uriKey
  );
  if (doc) {
    data.lastScanAt = Date.now();
    data.totalLinesAtLastScan = doc.lineCount;
  }

  cache.set(uriKey, data);
  schedulePersist(uriKey);
  emitter.fire(uriKey);
}

/** Stamp `explainedAt` on every region intersecting [startLine, endLine]. */
export function markExplained(
  uri: vscode.Uri,
  startLine: number,
  endLine: number
): void {
  if (endLine < startLine) return;
  const uriKey = uri.toString();
  const data = load(uriKey);
  const now = Date.now();
  let touched = false;

  // Split any region that partially overlaps the stamp range so that only
  // the intersecting portion becomes explained.
  const next: OwnershipRegion[] = [];
  for (const r of data.regions) {
    const rs = r.startLine;
    const re = r.endLine;
    const overlapStart = Math.max(rs, startLine);
    const overlapEnd = Math.min(re, endLine);
    if (overlapEnd < overlapStart) {
      next.push(r);
      continue;
    }
    touched = true;
    if (rs < overlapStart) {
      next.push({ ...r, startLine: rs, endLine: overlapStart - 1 });
    }
    next.push({
      ...r,
      startLine: overlapStart,
      endLine: overlapEnd,
      explainedAt: r.explainedAt ?? now,
    });
    if (re > overlapEnd) {
      next.push({ ...r, startLine: overlapEnd + 1, endLine: re });
    }
  }

  if (!touched) {
    // No existing region covered this range — treat the explanation as
    // creating an "owned typed" region. This lets explain-back on
    // unfamiliar code (e.g. code that pre-dated Protege install)
    // actually raise ownership.
    next.push({
      startLine,
      endLine,
      origin: "typed",
      explainedAt: now,
      createdAt: now,
    });
  }

  data.regions = capRegions(sortAndMerge(next));
  cache.set(uriKey, data);
  schedulePersist(uriKey);
  emitter.fire(uriKey);
  log(
    "ownership",
    `markExplained · ${uri.fsPath.split("/").pop()} · lines ${startLine}-${endLine}`
  );
}

/** Compute the summary — what every UI surface asks for. */
export function getOwnership(uri: vscode.Uri): OwnershipSummary {
  const uriKey = uri.toString();
  const data = load(uriKey);

  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uriKey
  );
  const totalLines = doc?.lineCount ?? data.totalLinesAtLastScan;

  if (data.regions.length === 0 || totalLines === 0) {
    return {
      state: "untracked",
      ownedPct: 0,
      knownPct: 0,
      unknownLines: 0,
      totalLines,
      topUnknownRange: null,
    };
  }

  // Collapse regions to per-line owned/known booleans. Small files (< few
  // thousand lines) — O(totalLines) is trivial and simpler than interval
  // merging for the summary path.
  const owned = new Uint8Array(totalLines);
  const known = new Uint8Array(totalLines);
  for (const r of data.regions) {
    const s = Math.max(0, r.startLine);
    const e = Math.min(totalLines - 1, r.endLine);
    for (let i = s; i <= e; i++) {
      known[i] = 1;
      if (r.origin === "typed" || r.explainedAt !== null) owned[i] = 1;
    }
  }

  let ownedCount = 0;
  let knownCount = 0;
  for (let i = 0; i < totalLines; i++) {
    if (owned[i]) ownedCount++;
    if (known[i]) knownCount++;
  }
  const ownedPct = ownedCount / totalLines;
  const knownPct = knownCount / totalLines;
  const unknownLines = totalLines - ownedCount;

  // Largest contiguous span where owned[i] === 0.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= totalLines; i++) {
    const isUnknown = i < totalLines && owned[i] === 0;
    if (isUnknown && runStart === -1) runStart = i;
    if (!isUnknown && runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  const topUnknownRange =
    bestStart >= 0
      ? { startLine: bestStart, endLine: bestStart + bestLen - 1 }
      : null;

  const state: OwnershipState =
    ownedPct >= 0.8 ? "owned" : ownedPct >= 0.3 ? "partial" : "unknown";

  return {
    state,
    ownedPct,
    knownPct,
    unknownLines,
    totalLines,
    topUnknownRange,
  };
}

/** Walk every tracked URI and return `{ uri, summary }` — used by the
 *  inviter to pick which file to nudge about. Filters to currently-open
 *  workspace files only (no stale records for deleted files). */
/** Return the raw region list for a URI. Used by UI surfaces that
 *  need to iterate individual regions (AI-block decorations, block-
 *  level CodeLens) rather than the rolled-up summary. Returns an empty
 *  array when the file has no tracked ownership — caller doesn't need
 *  a separate untracked check. */
export function getRegionsForUri(uri: vscode.Uri): OwnershipRegion[] {
  const data = load(uri.toString());
  // Return a copy so callers can't mutate the cache through the reference.
  return data.regions.map((r) => ({ ...r }));
}

/** Drop every unreviewed auto-inserted OR pasted region for a file. Used
 *  by the "dismiss all AI blocks in this file" escape hatch — when the
 *  user knows the highlighted code is already theirs and wants the noise
 *  gone without walking through each block individually. Typed regions
 *  and already-explained regions are preserved. Returns the number of
 *  regions cleared so the caller can confirm with a log/status. */
export function clearAutoInsertedForUri(uri: vscode.Uri): number {
  const uriKey = uri.toString();
  const data = load(uriKey);
  const before = data.regions.length;
  const kept = data.regions.filter(
    (r) =>
      !(
        (r.origin === "auto-inserted" || r.origin === "pasted") &&
        r.explainedAt === null
      )
  );
  const cleared = before - kept.length;
  if (cleared === 0) return 0;
  data.regions = kept;
  cache.set(uriKey, data);
  schedulePersist(uriKey);
  emitter.fire(uriKey);
  return cleared;
}

export function listTrackedOwnership(): Array<{
  uriKey: string;
  summary: OwnershipSummary;
}> {
  if (!ctx) return [];
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
    (f) => f.uri.toString()
  );
  const out: Array<{ uriKey: string; summary: OwnershipSummary }> = [];
  // Prefer cache for warmth; fall back to globalState keys on cold boot.
  const keys = new Set<string>(cache.keys());
  for (const k of ctx.globalState.keys()) {
    if (k.startsWith(KEY_PREFIX)) keys.add(k.slice(KEY_PREFIX.length));
  }
  for (const uriKey of keys) {
    if (
      workspaceRoots.length > 0 &&
      !workspaceRoots.some((r) => uriKey.startsWith(r))
    )
      continue;
    try {
      const uri = vscode.Uri.parse(uriKey);
      out.push({ uriKey, summary: getOwnership(uri) });
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function isTourOrExplainBackActive(): boolean {
  // Lazy-require the modules to avoid a load-time cycle. Both expose a
  // `getCurrent*` that returns null when idle.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const tour = require("../teaching/architectureTour.js");
    if (typeof tour.getCurrentTour === "function" && tour.getCurrentTour()) return true;
  } catch {
    /* ignore */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const eb = require("../teaching/explainBack.js");
    if (typeof eb.getCurrentExplainBack === "function" && eb.getCurrentExplainBack())
      return true;
  } catch {
    /* ignore */
  }
  return false;
}

// ---- region math ----

/** Insert a region + merge adjacent compatible regions (same origin +
 *  same explained-or-not status). Always returns a sorted list. */
function insertRegion(
  regions: OwnershipRegion[],
  incoming: OwnershipRegion
): OwnershipRegion[] {
  return sortAndMerge([...regions, incoming]);
}

function sortAndMerge(regions: OwnershipRegion[]): OwnershipRegion[] {
  if (regions.length <= 1) return regions.slice();
  const sorted = regions.slice().sort((a, b) => a.startLine - b.startLine);
  const out: OwnershipRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && canMerge(last, r) && r.startLine <= last.endLine + MERGE_LINE_GAP) {
      last.endLine = Math.max(last.endLine, r.endLine);
      last.explainedAt =
        last.explainedAt && r.explainedAt
          ? Math.max(last.explainedAt, r.explainedAt)
          : last.explainedAt ?? r.explainedAt;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

function canMerge(a: OwnershipRegion, b: OwnershipRegion): boolean {
  if (a.origin !== b.origin) return false;
  const aExplained = a.explainedAt !== null;
  const bExplained = b.explainedAt !== null;
  return aExplained === bExplained;
}

/** Coarsen when we exceed MAX_REGIONS_PER_FILE by merging the pair with
 *  the smallest gap between them. Runs once per insert only if needed. */
function capRegions(regions: OwnershipRegion[]): OwnershipRegion[] {
  if (regions.length <= MAX_REGIONS_PER_FILE) return regions;
  const work = regions.slice();
  while (work.length > MAX_REGIONS_PER_FILE) {
    let bestGap = Infinity;
    let bestIdx = -1;
    for (let i = 0; i + 1 < work.length; i++) {
      const gap = work[i + 1].startLine - work[i].endLine;
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const a = work[bestIdx];
    const b = work[bestIdx + 1];
    const aUnowned = a.origin === "auto-inserted" || a.origin === "pasted";
    const bUnowned = b.origin === "auto-inserted" || b.origin === "pasted";
    // When merging across origin boundaries (only triggered when the file
    // exceeds MAX_REGIONS_PER_FILE coarsening cap — pathological), the
    // union becomes the most-needs-explanation origin: any "auto-inserted"
    // wins, then "pasted", then "typed". The paste signal is lost only
    // when collapsed against a typed region — accept that, the
    // over-prompt is safer than the under-prompt.
    let mergedOrigin: "typed" | "auto-inserted" | "pasted";
    if (a.origin === "auto-inserted" || b.origin === "auto-inserted") {
      mergedOrigin = "auto-inserted";
    } else if (aUnowned || bUnowned) {
      mergedOrigin = "pasted";
    } else {
      mergedOrigin = "typed";
    }
    work.splice(bestIdx, 2, {
      startLine: Math.min(a.startLine, b.startLine),
      endLine: Math.max(a.endLine, b.endLine),
      origin: mergedOrigin,
      explainedAt:
        a.explainedAt && b.explainedAt
          ? Math.min(a.explainedAt, b.explainedAt)
          : null,
    });
  }
  return work;
}
