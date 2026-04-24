import React, { useEffect, useMemo, useState } from "react";
import type {
  ConceptKnownStatus,
  RepoConceptTile,
  RepoConceptsPayload,
  RepoScanState,
} from "@protege/types";
import { prefersReducedMotion } from "./colors.js";
import {
  LanguagePicker,
  cycleStatus,
  statusBadgeGlyph,
  statusLabel,
} from "./shared/conceptControls.js";

export interface RepoConceptsProps {
  data: RepoConceptsPayload | null;
  loading: boolean;
  /** Live scan state from the host's `repo_scan_status` broadcast. When
   *  non-null it overrides payload.scanState so the user sees the pulse
   *  the moment the scan starts, not after the next backend round-trip. */
  liveScan: LiveScanState | null;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
  onSetConceptLanguage: (language: string | null) => void;
  onRescanRepo: () => void;
}

export interface LiveScanState {
  state: RepoScanState;
  scannedFiles?: number;
  totalCandidates?: number;
  finishedAt?: string;
}

/**
 * W17 Repo Concepts. Lists every concept the workspace scanner detected
 * in the current workspace, sharing the language picker preference and
 * concept known-status table with W15.
 */
export function RepoConcepts({
  data,
  loading,
  liveScan,
  onSetConceptStatus,
  onSetConceptLanguage,
  onRescanRepo,
}: RepoConceptsProps): JSX.Element {
  const effectiveScanState: RepoScanState = liveScan
    ? liveScan.state
    : data?.scanState ?? "idle";

  return (
    <section className="echo-widget echo-repo-concepts" data-widget="W17">
      <header className="echo-widget-head echo-widget-head-with-actions">
        <div className="echo-widget-head-left">
          <h2>Repo concepts</h2>
          <span className="echo-widget-tag">W17</span>
        </div>
        {data ? (
          <LanguagePicker
            languages={data.languages}
            selected={data.selectedLanguage}
            onSelect={onSetConceptLanguage}
          />
        ) : null}
      </header>
      <div className="echo-widget-body">
        <ScanHeader
          data={data}
          liveScan={liveScan}
          effectiveState={effectiveScanState}
          onRescan={onRescanRepo}
        />
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <RepoBody
            data={data}
            effectiveState={effectiveScanState}
            onSetConceptStatus={onSetConceptStatus}
          />
        ) : null}
      </div>
    </section>
  );
}

function ScanHeader({
  data,
  liveScan,
  effectiveState,
  onRescan,
}: {
  data: RepoConceptsPayload | null;
  liveScan: LiveScanState | null;
  effectiveState: RepoScanState;
  onRescan: () => void;
}): JSX.Element | null {
  if (!data || data.workspaceRoot === null) {
    return (
      <div className="echo-repo-scan-header idle-noworkspace">
        Open Echo in a workspace to see repo concepts.
      </div>
    );
  }

  if (effectiveState === "scanning") {
    const scanned = liveScan?.scannedFiles ?? 0;
    const total = liveScan?.totalCandidates;
    return (
      <div className="echo-repo-scan-header scanning">
        <span className="echo-repo-scan-pulse" aria-hidden />
        <span className="echo-repo-scan-text">
          Scanning workspace... {scanned}
          {typeof total === "number" && total > 0 ? `/${total}` : ""} files
        </span>
      </div>
    );
  }

  const scannedLabel = formatScannedAt(data.lastScannedAt);
  const fileLabel =
    typeof data.scannedFileCount === "number" && data.scannedFileCount > 0
      ? `${data.scannedFileCount} concept file hits`
      : null;

  if (effectiveState === "truncated") {
    return (
      <div className="echo-repo-scan-header truncated">
        <span className="echo-repo-scan-text">
          Partial scan — 2000 of {liveScan?.totalCandidates ?? "many"} files
        </span>
        <button
          type="button"
          className="echo-repo-scan-rescan"
          onClick={onRescan}
        >
          re-scan
        </button>
      </div>
    );
  }

  // idle / done
  return (
    <div className="echo-repo-scan-header done">
      <span className="echo-repo-scan-text">
        {scannedLabel ? `Scanned ${scannedLabel}` : "Not scanned yet"}
        {fileLabel ? ` · ${fileLabel}` : ""}
        {` · ${data.totalConcepts} concept${data.totalConcepts === 1 ? "" : "s"}`}
      </span>
      <button
        type="button"
        className="echo-repo-scan-rescan"
        onClick={onRescan}
      >
        re-scan
      </button>
    </div>
  );
}

const REPO_TILE_CAP = 9;

function RepoBody({
  data,
  effectiveState,
  onSetConceptStatus,
}: {
  data: RepoConceptsPayload;
  effectiveState: RepoScanState;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
}): JSX.Element {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [mounted, setMounted] = useState(reduced);
  const [expanded, setExpanded] = useState<boolean>(false);
  useEffect(() => {
    if (reduced) return;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  if (effectiveState === "scanning" && data.tiles.length === 0) {
    return (
      <div className="echo-widget-empty">
        First scan is in progress — tiles will appear here when it finishes.
      </div>
    );
  }

  if (data.tiles.length === 0) {
    if (data.totalConcepts > 0 && data.selectedLanguage !== null) {
      return (
        <div className="echo-concepts-covered-subempty">
          No concepts in this language — try switching the picker.
        </div>
      );
    }
    if (data.workspaceRoot !== null) {
      return (
        <div className="echo-widget-empty">
          This workspace has no recognized concepts in its source files.
        </div>
      );
    }
    return (
      <div className="echo-widget-empty">
        Open Echo in a workspace to see repo concepts.
      </div>
    );
  }

  const canExpand = data.tiles.length > REPO_TILE_CAP;
  const visibleTiles = expanded ? data.tiles : data.tiles.slice(0, REPO_TILE_CAP);

  return (
    <>
      <div className="echo-ccov-grid">
        {visibleTiles.map((tile, i) => (
          <RepoTile
            key={tile.name}
            tile={tile}
            index={i}
            mounted={mounted}
            reduced={reduced}
            onSetConceptStatus={onSetConceptStatus}
          />
        ))}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="echo-show-all-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? `Show ${REPO_TILE_CAP}` : `Show all (${data.tiles.length})`}
        </button>
      ) : null}
    </>
  );
}

function RepoTile({
  tile,
  index,
  mounted,
  reduced,
  onSetConceptStatus,
}: {
  tile: RepoConceptTile;
  index: number;
  mounted: boolean;
  reduced: boolean;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
}): JSX.Element {
  const style = reduced
    ? undefined
    : {
        transitionDelay: `${Math.min(index, 12) * 40}ms`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? "translateY(0)" : "translateY(4px)",
      };

  const onCycle = (): void => {
    onSetConceptStatus(tile.name, cycleStatus(tile.status));
  };

  return (
    <div
      className={`echo-ccov-tile bucket-repo status-${tile.status}`}
      style={style}
    >
      <div className="echo-ccov-tile-head">
        <span className="echo-ccov-tile-name" title={tile.name}>
          {tile.name}
        </span>
      </div>
      <div className="echo-ccov-tile-meta">
        <span className="echo-ccov-tile-files">
          {tile.fileCount} file{tile.fileCount === 1 ? "" : "s"}
        </span>
        {tile.language ? (
          <>
            <span className="echo-ccov-tile-dot">·</span>
            <span className="echo-ccov-tile-lang">{tile.language}</span>
          </>
        ) : null}
      </div>
      <div className="echo-ccov-tile-actions">
        <button
          type="button"
          className={`echo-ccov-status-btn status-${tile.status}`}
          onClick={onCycle}
          title={`Mark as ${statusLabel(cycleStatus(tile.status))}`}
          aria-label={`Status for ${tile.name}: ${statusLabel(tile.status)}. Click to cycle.`}
        >
          <span className="echo-ccov-status-glyph" aria-hidden>
            {statusBadgeGlyph(tile.status)}
          </span>
          <span className="echo-ccov-status-text">{statusLabel(tile.status)}</span>
        </button>
      </div>
    </div>
  );
}

function formatScannedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
