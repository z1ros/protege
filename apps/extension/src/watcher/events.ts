/**
 * Ambient watcher event types. Normalized shape so triggers don't have to
 * care about the VS Code API surface directly.
 */

export type WatcherEvent =
  | { type: "file_opened"; path: string; ts: number }
  | { type: "file_closed"; path: string; ts: number }
  | { type: "file_saved"; path: string; ts: number; errorCount: number }
  | {
      type: "text_change";
      path: string;
      ts: number;
      changeSize: number;
      isUndo: boolean;
      isRedo: boolean;
    }
  | { type: "selection_change"; path: string; ts: number; line: number }
  | {
      type: "diagnostic_change";
      path: string;
      ts: number;
      errors: number;
      warnings: number;
    }
  | {
      type: "error_appeared";
      path: string;
      ts: number;
      line: number;
      message: string;
      source: string;
    }
  | {
      type: "error_cleared";
      path: string;
      ts: number;
      line: number;
      message: string;
      durationMs: number;
    }
  | {
      type: "concept_gained";
      ts: number;
      concept: string;
      cluster: string;
      deltaIq: number;
      file: string;
    }
  | { type: "active_editor_change"; path: string | null; ts: number };

export type WatcherEventKind = WatcherEvent["type"];

/** Narrow ring buffer — keep last N events OR last T ms, whichever smaller. */
export class EventRing {
  private events: WatcherEvent[] = [];
  constructor(
    private maxEvents = 400,
    private maxAgeMs = 15 * 60 * 1000
  ) {}

  push(e: WatcherEvent) {
    this.events.push(e);
    this.prune();
  }

  private prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  since(ms: number): WatcherEvent[] {
    const cutoff = Date.now() - ms;
    return this.events.filter((e) => e.ts >= cutoff);
  }

  byType<K extends WatcherEventKind>(kind: K): Array<Extract<WatcherEvent, { type: K }>> {
    return this.events.filter((e) => e.type === kind) as Array<
      Extract<WatcherEvent, { type: K }>
    >;
  }

  all(): readonly WatcherEvent[] {
    return this.events;
  }
}
