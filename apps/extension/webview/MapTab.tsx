import React, { useEffect, useState } from "react";
import { vscode, onHostMessage } from "./vscode.js";
import type { ProjectMapData, ProjectMapFile } from "@protege/types";

/**
 * Project Map (A1) — the "what matters in this codebase" view.
 *
 * Top: a couple of compact sections — Entry Points, Hot Files (team),
 * Untouched by Me. Each entry is clickable; clicking loads a
 * 2-sentence summary in the right-side panel and reveals an Open-file
 * button. Refresh re-runs git + file-tree collection.
 *
 * No file-tree view yet (would need tree rendering + filtering); the
 * three curated lists cover the "where do I start" question well and
 * keep the sidebar narrow-friendly. Add the full tree later if users
 * ask for it.
 */

const LOAD_TIMEOUT_MS = 15_000;

export function MapTab() {
  const [data, setData] = useState<ProjectMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summaryByPath, setSummaryByPath] = useState<
    Record<string, { summary: string | null; loading: boolean }>
  >({});

  // Initial load + host push subscription.
  useEffect(() => {
    vscode.postMessage({ type: "map/request" });
    // Fail gracefully if the host never responds — earlier bug: the
    // "building project map…" spinner would linger forever on any host
    // error. Now the user sees a retry affordance after 15s.
    const timeout = setTimeout(() => {
      setLoading((curr) => {
        if (curr) setLoadError("Couldn't load the project map — try refresh.");
        return false;
      });
    }, LOAD_TIMEOUT_MS);

    const off = onHostMessage((msg) => {
      if (msg.type === "map/data") {
        clearTimeout(timeout);
        setData(msg.data);
        setLoading(false);
        setLoadError(null);
      } else if (msg.type === "map/fileSummaryResult") {
        setSummaryByPath((prev) => ({
          ...prev,
          [msg.path]: { summary: msg.summary, loading: false },
        }));
      } else if (msg.type === "ownership/changed") {
        // Patch the dot for one file in place. Avoids re-fetching the
        // whole map (git log + file tree) just to re-render a single
        // glyph after a recorded edit or an explain-back round.
        setData((prev) => {
          if (!prev) return prev;
          const apply = (f: ProjectMapFile) =>
            f.path === msg.path ? { ...f, ownership: msg.summary } : f;
          return {
            ...prev,
            files: prev.files.map(apply),
            hotFiles: prev.hotFiles.map(apply),
            entryPoints: prev.entryPoints.map(apply),
            untouchedByMe: prev.untouchedByMe.map(apply),
          };
        });
      }
    });
    return () => {
      clearTimeout(timeout);
      off();
    };
  }, []);

  const refresh = () => {
    // Guard against rapid re-clicks — prevents a pile-up of in-flight
    // map/request messages and keeps the UI consistent with one active
    // load at a time.
    if (loading) return;
    setLoading(true);
    setLoadError(null);
    setData(null);
    vscode.postMessage({ type: "map/request" });
  };

  const startCodebaseTour = () => {
    vscode.postMessage({ type: "tour/start", intent: "codebase" });
  };

  const selectFile = (path: string) => {
    setSelected(path);
    if (!summaryByPath[path]) {
      setSummaryByPath((prev) => ({
        ...prev,
        [path]: { summary: null, loading: true },
      }));
      vscode.postMessage({ type: "map/fileSummary", path });
    }
  };

  const openFile = (path: string) => {
    vscode.postMessage({ type: "map/openFile", path });
  };

  if (loading && !data) {
    return (
      <div className="map-tab">
        <div className="map-loading">
          <span className="typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>
          <span className="map-loading-text">building project map…</span>
        </div>
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="map-tab">
        <div className="map-empty">
          <div className="map-empty-title">Couldn't load the map</div>
          <div className="map-empty-desc">{loadError}</div>
          <div className="map-selection-actions" style={{ justifyContent: "center" }}>
            <button className="map-action-btn primary" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data || data.root === null) {
    return (
      <div className="map-tab">
        <div className="map-empty">
          <div className="map-empty-title">No workspace open</div>
          <div className="map-empty-desc">
            Open a folder in VS Code to see your project map.
          </div>
        </div>
      </div>
    );
  }

  const selectedFile = selected
    ? data.files.find((f) => f.path === selected) ?? null
    : null;
  const selectedSummary = selected ? summaryByPath[selected] : undefined;

  return (
    <div className="map-tab">
      {/* Header */}
      <div className="map-header">
        <div className="map-root microcaps">{shortenRoot(data.root)}</div>
        <div className="map-header-actions">
          <button
            className="map-refresh-btn primary"
            onClick={startCodebaseTour}
            title="Walk me through 5 key files, narrated"
          >
            Tour this codebase
          </button>
          <button
            className="map-refresh-btn"
            onClick={refresh}
            title="Re-scan files + git log"
          >
            refresh
          </button>
        </div>
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="map-warnings">
          {data.warnings.map((w, i) => (
            <div key={i} className="map-warning">
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Selected file panel — at the top so it's always visible after
          click. Avoids requiring the user to scroll back up. */}
      {selectedFile && (
        <div className="map-selection">
          <div className="map-selection-path">{selectedFile.path}</div>
          <div className="map-selection-meta microcaps">
            {selectedFile.editsTotal > 0
              ? `${selectedFile.editsTotal} edits · 7d${
                  selectedFile.editsByMe > 0
                    ? ` · ${selectedFile.editsByMe} by you`
                    : ""
                }`
              : "no recent edits"}
            {selectedFile.isEntryPoint && " · entry point"}
          </div>
          <div className="map-selection-summary">
            {selectedSummary?.loading ? (
              <span className="typing">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
            ) : selectedSummary?.summary ? (
              selectedSummary.summary
            ) : (
              <span className="map-summary-empty">
                Couldn't summarize this file — try Open.
              </span>
            )}
          </div>
          <div className="map-selection-actions">
            <button
              className="map-action-btn primary"
              onClick={() => openFile(selectedFile.path)}
            >
              Open file
            </button>
          </div>
        </div>
      )}

      {/* Entry Points */}
      {data.entryPoints.length > 0 && (
        <MapSection title="Entry Points" count={data.entryPoints.length}>
          {data.entryPoints.map((f) => (
            <MapFileRow
              key={f.path}
              file={f}
              selected={selected === f.path}
              onClick={() => selectFile(f.path)}
            />
          ))}
        </MapSection>
      )}

      {/* Hot Files */}
      {data.hotFiles.length > 0 && (
        <MapSection
          title="Hot Files"
          count={data.hotFiles.length}
          subtitle="last 7 days"
        >
          {data.hotFiles.map((f) => (
            <MapFileRow
              key={f.path}
              file={f}
              selected={selected === f.path}
              onClick={() => selectFile(f.path)}
              showEntryBadge
            />
          ))}
        </MapSection>
      )}

      {/* Untouched by Me */}
      {data.untouchedByMe.length > 0 && (
        <MapSection
          title="Untouched by you"
          count={data.untouchedByMe.length}
          subtitle="others edited · you haven't"
        >
          {data.untouchedByMe.map((f) => (
            <MapFileRow
              key={f.path}
              file={f}
              selected={selected === f.path}
              onClick={() => selectFile(f.path)}
              showEntryBadge
            />
          ))}
        </MapSection>
      )}

      {data.files.length === 0 && (
        <div className="map-empty">
          <div className="map-empty-title">No source files found</div>
          <div className="map-empty-desc">
            Protege looks for common code extensions outside build folders.
          </div>
        </div>
      )}

      {/* Fallback: files exist but no categories populated — probably a
          fresh repo or no git history. Show the most-recent file list
          so the user still has something to click. */}
      {data.files.length > 0 &&
        data.entryPoints.length === 0 &&
        data.hotFiles.length === 0 &&
        data.untouchedByMe.length === 0 && (
          <MapSection
            title="All files"
            count={Math.min(data.files.length, 20)}
            subtitle={data.files.length > 20 ? `first 20 of ${data.files.length}` : undefined}
          >
            {data.files.slice(0, 20).map((f) => (
              <MapFileRow
                key={f.path}
                file={f}
                selected={selected === f.path}
                onClick={() => selectFile(f.path)}
              />
            ))}
          </MapSection>
        )}

      <div className="map-footer microcaps">
        {data.files.length} files tracked · computed {formatAgo(data.computedAt)}
      </div>
    </div>
  );
}

// ---- Section + row sub-components ----

function MapSection({
  title,
  count,
  subtitle,
  children,
}: {
  title: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="map-section">
      <div className="map-section-head">
        <span className="map-section-title microcaps">{title}</span>
        <span className="map-section-count">{count}</span>
        {subtitle && <span className="map-section-subtitle microcaps">{subtitle}</span>}
      </div>
      <div className="map-section-body">{children}</div>
    </div>
  );
}

function MapFileRow({
  file,
  selected,
  onClick,
  showEntryBadge = false,
}: {
  file: ProjectMapFile;
  selected: boolean;
  onClick: () => void;
  /** Whether to show a tiny "entry" chip inline — off inside the Entry
   *  Points section (redundant there), on elsewhere. */
  showEntryBadge?: boolean;
}) {
  const base = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - base.length);
  const ownership = file.ownership;
  // Ownership dot: hollow when fully owned, half when partial, solid when
  // unknown. Tooltip shows the raw percentage so power users can audit.
  const dotGlyph = ownership
    ? ownership.state === "owned"
      ? "\u25CB"     // ○
      : ownership.state === "partial"
      ? "\u25D0"     // ◐
      : "\u25CF"     // ●
    : null;
  const dotTitle = ownership
    ? `${Math.round(ownership.ownedPct * 100)}% owned · ${ownership.unknownLines} unreviewed`
    : undefined;
  return (
    <button
      className={`map-row ${selected ? "active" : ""}`}
      onClick={onClick}
      title={file.path}
    >
      {dotGlyph && (
        <span
          className={`map-row-ownership ownership-${ownership!.state}`}
          title={dotTitle}
          aria-label={dotTitle}
        >
          {dotGlyph}
        </span>
      )}
      {dir && <span className="map-row-dir microcaps">{dir}</span>}
      <span className="map-row-name">{base}</span>
      {showEntryBadge && file.isEntryPoint && (
        <span className="map-row-badge microcaps">entry</span>
      )}
      {file.editsTotal > 0 && (
        <span className="map-row-edits microcaps">
          {file.editsByMe > 0
            ? `${file.editsByMe}/${file.editsTotal}`
            : `${file.editsTotal}`}
        </span>
      )}
    </button>
  );
}

// ---- Utils ----

function shortenRoot(root: string): string {
  const home = "/Users/";
  if (root.startsWith(home)) {
    const rest = root.slice(home.length);
    const parts = rest.split("/");
    if (parts.length > 3) return `~/${parts.slice(1).slice(-2).join("/")}`;
    return `~/${parts.slice(1).join("/")}`;
  }
  const parts = root.split("/");
  return parts.slice(-2).join("/");
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
