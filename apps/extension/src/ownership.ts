import * as vscode from "vscode";
import type {
  FileOwnership,
  OwnershipRegion,
  OwnershipSummary,
  OwnershipState,
} from "@protege/types";
import { log } from "./log.js";

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

/** Read-through accessor: cache first, then globalState, then empty. */
function load(uriKey: string): FileOwnership {
  const cached = cache.get(uriKey);
  if (cached) return cached;
  const stored = ctx?.globalState.get<FileOwnership>(KEY_PREFIX + uriKey);
  const result: FileOwnership = stored ?? {
    version: 1,
    regions: [],
    lastScanAt: 0,
    totalLinesAtLastScan: 0,
  };
  cache.set(uriKey, result);
  return result;
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
  origin: "typed" | "auto-inserted"
): void {
  if (endLine < startLine) return;
  const uriKey = uri.toString();
  const data = load(uriKey);

  const newRegion: OwnershipRegion = {
    startLine,
    endLine,
    origin,
    explainedAt: null,
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
    const tour = require("./architectureTour.js");
    if (typeof tour.getCurrentTour === "function" && tour.getCurrentTour()) return true;
  } catch {
    /* ignore */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const eb = require("./explainBack.js");
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
    if (last && canMerge(last, r) && r.startLine <= last.endLine + 1) {
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
    work.splice(bestIdx, 2, {
      startLine: Math.min(a.startLine, b.startLine),
      endLine: Math.max(a.endLine, b.endLine),
      // When merging across origin boundaries, the union becomes "not
      // explained" (the safer default — we'd rather re-prompt than
      // under-prompt).
      origin: a.origin === "auto-inserted" || b.origin === "auto-inserted"
        ? "auto-inserted"
        : "typed",
      explainedAt:
        a.explainedAt && b.explainedAt
          ? Math.min(a.explainedAt, b.explainedAt)
          : null,
    });
  }
  return work;
}
