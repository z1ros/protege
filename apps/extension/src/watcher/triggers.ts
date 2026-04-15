import type { WatcherState, ActiveError } from "./state.js";

/**
 * The 10 trigger types. Each is a pure function of state → nullable result.
 * Thresholds + cooldowns below. Severity drives whether a nudge can speak
 * in voice mode and bypass low-budget states.
 */

export type TriggerId =
  | "error_persists"
  | "struggle_cluster"
  | "stare_pause"
  | "build_fail_loop"
  | "win_detected"
  | "flow_detected"
  | "commit_risk"
  | "late_night_marathon"
  | "risky_edit"
  | "concept_breakthrough";

export type TriggerSeverity = "low" | "medium" | "high";

export interface TriggerContext {
  filePath?: string;
  error?: ActiveError;
  idleMs?: number;
  concept?: string;
  cluster?: string;
  level?: string;
  fileCount?: number;
  note?: string;
}

export interface TriggerResult {
  id: TriggerId;
  severity: TriggerSeverity;
  cooldownMs: number;
  canEscalate: boolean;
  context: TriggerContext;
}

export interface TriggerDefinition {
  id: TriggerId;
  check(state: WatcherState, now: number): TriggerResult | null;
}

/* ========== Individual triggers ========== */

const ERROR_STUCK_MS = 10_000;
const ERROR_RE_NUDGE_MS = 60_000;

const T_error_persists: TriggerDefinition = {
  id: "error_persists",
  check(state, now) {
    const errors = state.getActiveErrors();
    for (const err of errors) {
      const age = now - err.appearedAt;
      if (age < ERROR_STUCK_MS) continue;
      if (err.nudgedAt && now - err.nudgedAt < ERROR_RE_NUDGE_MS) continue;
      state.markErrorNudged(err.path, err.line, err.message);
      return {
        id: "error_persists",
        severity: "high",
        cooldownMs: 60_000,
        canEscalate: true,
        context: { error: err, filePath: err.path },
      };
    }
    return null;
  },
};

const UNDO_WINDOW_MS = 20_000;
const UNDO_CLUSTER_MIN = 5;

const T_struggle_cluster: TriggerDefinition = {
  id: "struggle_cluster",
  check(state) {
    const count = state.undoCountLast(UNDO_WINDOW_MS);
    if (count < UNDO_CLUSTER_MIN) return null;
    return {
      id: "struggle_cluster",
      severity: "medium",
      cooldownMs: 120_000,
      canEscalate: true,
      context: { filePath: state.lastActiveEditor() ?? undefined },
    };
  },
};

const STARE_PAUSE_MS = 90_000;

const T_stare_pause: TriggerDefinition = {
  id: "stare_pause",
  check(state, now) {
    const path = state.lastActiveEditor();
    if (!path) return null;
    const file = state.getFile(path);
    if (!file) return null;
    const lastActivity = Math.max(file.lastEditAt, file.lastSelectionAt);
    if (lastActivity === 0) return null;
    const idle = now - lastActivity;
    if (idle < STARE_PAUSE_MS) return null;
    // Only fire if file has errors OR is substantial
    const hasErrors = state.getActiveErrors(path).length > 0;
    if (!hasErrors && file.lastSaveErrorCount === 0) {
      // No errors — only nudge if user is clearly stuck
      if (idle < STARE_PAUSE_MS * 2) return null;
    }
    return {
      id: "stare_pause",
      severity: "low",
      cooldownMs: 180_000,
      canEscalate: true,
      context: { filePath: path, idleMs: idle },
    };
  },
};

const BUILD_FAIL_MIN = 3;

const T_build_fail_loop: TriggerDefinition = {
  id: "build_fail_loop",
  check(state) {
    for (const [, file] of (state as unknown as { files: Map<string, import("./state.js").FileState> }).files ?? new Map()) {
      if (file.consecutiveErrorSaves >= BUILD_FAIL_MIN) {
        return {
          id: "build_fail_loop",
          severity: "high",
          cooldownMs: 180_000,
          canEscalate: true,
          context: { filePath: file.path },
        };
      }
    }
    return null;
  },
};

const FLOW_SAVE_MIN = 5;
const FLOW_WINDOW_MS = 3 * 60_000;

const T_flow_detected: TriggerDefinition = {
  id: "flow_detected",
  check(state) {
    const clean = state.cleanSavesInWindow(FLOW_WINDOW_MS);
    if (clean < FLOW_SAVE_MIN) return null;
    return {
      id: "flow_detected",
      severity: "low",
      cooldownMs: 5 * 60_000,
      canEscalate: false,
      context: {},
    };
  },
};

const LATE_NIGHT_START_HOUR = 23;
const LATE_NIGHT_MIN_DURATION_MS = 90 * 60_000;
const LATE_NIGHT_MIN_SAVES = 20;

const T_late_night_marathon: TriggerDefinition = {
  id: "late_night_marathon",
  check(state, now) {
    const hour = new Date(now).getHours();
    const isLate = hour >= LATE_NIGHT_START_HOUR || hour < 5;
    if (!isLate) return null;
    const savesAll = state.ring.byType("file_saved");
    if (savesAll.length < LATE_NIGHT_MIN_SAVES) return null;
    const first = savesAll[0];
    if (!first) return null;
    if (now - first.ts < LATE_NIGHT_MIN_DURATION_MS) return null;
    return {
      id: "late_night_marathon",
      severity: "low",
      cooldownMs: 6 * 60 * 60_000, // once per 6h
      canEscalate: true,
      context: {},
    };
  },
};

/**
 * Triggers that only fire in response to discrete events — they're pushed
 * through a separate path (onEvent) rather than the polling loop.
 */
export const EVENT_DRIVEN_TRIGGERS = new Set<TriggerId>([
  "win_detected",
  "concept_breakthrough",
  "risky_edit",
]);

export const ALL_POLLING_TRIGGERS: TriggerDefinition[] = [
  T_error_persists,
  T_struggle_cluster,
  T_stare_pause,
  T_build_fail_loop,
  T_flow_detected,
  T_late_night_marathon,
];
