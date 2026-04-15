import { EventRing, type WatcherEvent } from "./events.js";

/**
 * Rolling watcher state. All data derives from the event ring buffer —
 * this file computes snapshots triggers can query cheaply.
 */

export interface ActiveError {
  path: string;
  line: number;
  message: string;
  source: string;
  appearedAt: number;
  nudgedAt: number | null;
}

export interface FileState {
  path: string;
  lastSavedAt: number;
  lastEditAt: number;
  lastSelectionAt: number;
  consecutiveErrorSaves: number;
  lastSaveErrorCount: number;
}

export class WatcherState {
  readonly ring: EventRing;
  private activeErrors = new Map<string, ActiveError>();
  private files = new Map<string, FileState>();
  /** Local counter for undo events over a sliding window */
  private recentUndos: number[] = [];

  constructor(ring = new EventRing()) {
    this.ring = ring;
  }

  ingest(e: WatcherEvent) {
    this.ring.push(e);

    switch (e.type) {
      case "error_appeared": {
        const key = errorKey(e.path, e.line, e.message);
        if (!this.activeErrors.has(key)) {
          this.activeErrors.set(key, {
            path: e.path,
            line: e.line,
            message: e.message,
            source: e.source,
            appearedAt: e.ts,
            nudgedAt: null,
          });
        }
        break;
      }
      case "error_cleared": {
        const key = errorKey(e.path, e.line, e.message);
        this.activeErrors.delete(key);
        break;
      }
      case "file_saved": {
        const f = this.upsertFile(e.path);
        f.lastSavedAt = e.ts;
        f.lastSaveErrorCount = e.errorCount;
        if (e.errorCount > 0) {
          f.consecutiveErrorSaves += 1;
        } else {
          f.consecutiveErrorSaves = 0;
        }
        break;
      }
      case "text_change": {
        const f = this.upsertFile(e.path);
        f.lastEditAt = e.ts;
        if (e.isUndo) {
          this.recentUndos.push(e.ts);
          // prune to 30s sliding window
          const cutoff = Date.now() - 30_000;
          this.recentUndos = this.recentUndos.filter((t) => t >= cutoff);
        }
        break;
      }
      case "selection_change": {
        const f = this.upsertFile(e.path);
        f.lastSelectionAt = e.ts;
        break;
      }
    }
  }

  private upsertFile(path: string): FileState {
    let f = this.files.get(path);
    if (!f) {
      f = {
        path,
        lastSavedAt: 0,
        lastEditAt: 0,
        lastSelectionAt: 0,
        consecutiveErrorSaves: 0,
        lastSaveErrorCount: 0,
      };
      this.files.set(path, f);
    }
    return f;
  }

  getFile(path: string): FileState | undefined {
    return this.files.get(path);
  }

  getActiveErrors(path?: string): ActiveError[] {
    const all = [...this.activeErrors.values()];
    if (!path) return all;
    return all.filter((e) => e.path === path);
  }

  markErrorNudged(path: string, line: number, message: string) {
    const key = errorKey(path, line, message);
    const err = this.activeErrors.get(key);
    if (err) err.nudgedAt = Date.now();
  }

  undoCountLast(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.recentUndos.filter((t) => t >= cutoff).length;
  }

  cleanSavesInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.ring
      .byType("file_saved")
      .filter((e) => e.ts >= cutoff && e.errorCount === 0).length;
  }

  savesInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.ring.byType("file_saved").filter((e) => e.ts >= cutoff).length;
  }

  lastActiveEditor(): string | null {
    const evts = this.ring.byType("active_editor_change");
    for (let i = evts.length - 1; i >= 0; i--) {
      if (evts[i].path) return evts[i].path;
    }
    return null;
  }
}

function errorKey(path: string, line: number, message: string): string {
  return `${path}::${line}::${message}`;
}
