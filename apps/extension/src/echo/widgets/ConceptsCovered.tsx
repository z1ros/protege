import React, { useEffect, useMemo, useState } from "react";
import type {
  ConceptKnownStatus,
  ConceptsCoveredPayload,
  ConceptsCoveredTile,
} from "@protege/types";
import { prefersReducedMotion } from "./colors.js";
import {
  LanguagePicker,
  cycleStatus,
  statusBadgeGlyph,
  statusLabel,
} from "./shared/conceptControls.js";

export interface ConceptsCoveredProps {
  data: ConceptsCoveredPayload | null;
  loading: boolean;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
  onSetConceptLanguage: (language: string | null) => void;
}

/**
 * W15 Concepts Covered (v5). Two sections (Yours / AI Used) filtered by a
 * single shared language picker at the top-right. The picker selection is
 * persisted as `UserPreference.echoConceptLanguage` and shared with W17,
 * so changing it here also narrows the repo concepts widget.
 */
export function ConceptsCovered({
  data,
  loading,
  onSetConceptStatus,
  onSetConceptLanguage,
}: ConceptsCoveredProps): JSX.Element {
  return (
    <section className="echo-widget echo-concepts-covered" data-widget="W15">
      <header className="echo-widget-head echo-widget-head-with-actions">
        <div className="echo-widget-head-left">
          <h2>Concepts covered</h2>
          <span className="echo-widget-tag">W15</span>
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
        {loading && !data ? (
          <div className="echo-widget-skeleton" />
        ) : data ? (
          <ConceptsCoveredBody data={data} onSetConceptStatus={onSetConceptStatus} />
        ) : (
          <div className="echo-widget-empty">
            Type or accept some code to populate concepts.
          </div>
        )}
      </div>
    </section>
  );
}

function ConceptsCoveredBody({
  data,
  onSetConceptStatus,
}: {
  data: ConceptsCoveredPayload;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
}): JSX.Element {
  const { yoursTiles, aiTiles } = useMemo(() => {
    const yours: ConceptsCoveredTile[] = [];
    const ai: ConceptsCoveredTile[] = [];
    for (const tile of data.tiles) {
      if (tile.bucket === "yours") yours.push(tile);
      else ai.push(tile);
    }
    return { yoursTiles: yours, aiTiles: ai };
  }, [data.tiles]);

  const hasAny = data.counts.yours > 0 || data.counts.ai > 0;

  if (!hasAny) {
    return (
      <div className="echo-widget-empty">
        Type or accept some code to populate concepts.
      </div>
    );
  }

  const filterIsActive = data.selectedLanguage !== null;
  const nothingInFilter = filterIsActive && data.tiles.length === 0;

  return (
    <div className="echo-concepts-covered-body">
      {nothingInFilter ? (
        <div className="echo-concepts-covered-subempty">
          No concepts in this language yet.
        </div>
      ) : null}

      {data.counts.yours > 0 && yoursTiles.length > 0 ? (
        <ConceptSection
          label="Yours"
          tiles={yoursTiles}
          totalCount={data.counts.yours}
          onSetConceptStatus={onSetConceptStatus}
          variant="yours"
        />
      ) : null}

      {data.counts.ai > 0 && aiTiles.length > 0 ? (
        <ConceptSection
          label="AI Used"
          tiles={aiTiles}
          totalCount={data.counts.ai}
          onSetConceptStatus={onSetConceptStatus}
          variant="ai"
        />
      ) : null}
    </div>
  );
}

const TILE_CAP = 9;

function ConceptSection({
  label,
  tiles,
  totalCount,
  onSetConceptStatus,
  variant,
}: {
  label: string;
  tiles: ConceptsCoveredTile[];
  totalCount: number;
  onSetConceptStatus: (concept: string, status: ConceptKnownStatus) => void;
  variant: "yours" | "ai";
}): JSX.Element {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [mounted, setMounted] = useState(reduced);
  const [expanded, setExpanded] = useState<boolean>(false);
  useEffect(() => {
    if (reduced) return;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  const canExpand = tiles.length > TILE_CAP;
  const visibleTiles = expanded ? tiles : tiles.slice(0, TILE_CAP);

  return (
    <div className={`echo-ccov-section section-${variant}`}>
      <div className="echo-ccov-section-head">
        <span className="echo-ccov-section-label">{label}</span>
        <span className="echo-ccov-section-count">({totalCount})</span>
      </div>
      <div className="echo-ccov-grid">
        {visibleTiles.map((tile, i) => (
          <Tile
            key={`${variant}-${tile.name}`}
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
          {expanded ? `Show ${TILE_CAP}` : `Show all (${tiles.length})`}
        </button>
      ) : null}
    </div>
  );
}

function Tile({
  tile,
  index,
  mounted,
  reduced,
  onSetConceptStatus,
}: {
  tile: ConceptsCoveredTile;
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
      className={`echo-ccov-tile bucket-${tile.bucket} status-${tile.status}`}
      style={style}
    >
      <div className="echo-ccov-tile-head">
        <span className="echo-ccov-tile-name" title={tile.name}>
          {tile.name}
        </span>
        {tile.isNew ? <span className="echo-ccov-tile-new">NEW</span> : null}
      </div>
      <div className="echo-ccov-tile-meta">
        <span className="echo-ccov-tile-files">
          {tile.distinctFiles} file{tile.distinctFiles === 1 ? "" : "s"}
        </span>
        <span className="echo-ccov-tile-dot">·</span>
        <span className="echo-ccov-tile-used">used {tile.timesUsed}x</span>
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
