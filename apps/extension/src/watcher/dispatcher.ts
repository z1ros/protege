import type * as vscode from "vscode";
import { WatcherState } from "./state.js";
import { TrustBudget } from "./budget.js";
import { SuppressionRegistry } from "./suppression.js";
import {
  ALL_POLLING_TRIGGERS,
  type TriggerId,
  type TriggerResult,
  type TriggerContext,
  type TriggerSeverity,
} from "./triggers.js";
import { nudgeTemplate } from "./templates.js";

export interface DispatchedNudge {
  id: string;
  triggerId: TriggerId;
  severity: TriggerSeverity;
  text: string;
  canEscalate: boolean;
  context: TriggerContext;
  createdAt: number;
}

export interface Dispatcher {
  onNudge(cb: (n: DispatchedNudge) => void): void;
  pumpPolling(): void;
  pushEvent(
    id: TriggerId,
    severity: TriggerSeverity,
    cooldownMs: number,
    context: TriggerContext
  ): void;
  silenceForToday(): void;
  setVerbosity(v: "silent" | "quiet" | "normal" | "verbose"): void;
  state(): WatcherState;
  budget(): TrustBudget;
  stats(): unknown;
}

const GLOBAL_MIN_SPACING_MS = 20_000;

export function createDispatcher(
  state: WatcherState,
  log: vscode.OutputChannel
): Dispatcher {
  const budget = new TrustBudget();
  const suppression = new SuppressionRegistry();
  const listeners: Array<(n: DispatchedNudge) => void> = [];

  function tryDispatch(result: TriggerResult): DispatchedNudge | null {
    // flow fires just to mark suppression; never a visible nudge
    if (result.id === "flow_detected") {
      suppression.markFlow();
      log.appendLine(`[watcher] flow-state entered (suppressing for 5m)`);
      return null;
    }

    if (result.id === "win_detected") {
      suppression.markWin();
    }

    if (!budget.canFire(result.id, result.severity, GLOBAL_MIN_SPACING_MS)) {
      log.appendLine(
        `[watcher] ${result.id} (${result.severity}) skipped — budget/cooldown`
      );
      return null;
    }

    const suppressed = suppression.shouldSuppress(result, state);
    if (suppressed) {
      log.appendLine(`[watcher] ${result.id} suppressed — ${suppressed}`);
      return null;
    }

    const text = nudgeTemplate(result.id, result.context);
    if (!text) {
      log.appendLine(`[watcher] ${result.id} produced empty template, skipping`);
      return null;
    }

    budget.spend(result.id, result.severity, result.cooldownMs);

    const nudge: DispatchedNudge = {
      id: crypto.randomUUID(),
      triggerId: result.id,
      severity: result.severity,
      text,
      canEscalate: result.canEscalate,
      context: result.context,
      createdAt: Date.now(),
    };

    log.appendLine(`[watcher] → nudge ${result.id}: ${text}`);
    for (const l of listeners) l(nudge);
    return nudge;
  }

  return {
    onNudge(cb) {
      listeners.push(cb);
    },
    pumpPolling() {
      const now = Date.now();
      for (const t of ALL_POLLING_TRIGGERS) {
        try {
          const res = t.check(state, now);
          if (res) tryDispatch(res);
        } catch (err) {
          log.appendLine(`[watcher] trigger ${t.id} error: ${err}`);
        }
      }
    },
    pushEvent(id, severity, cooldownMs, context) {
      tryDispatch({
        id,
        severity,
        cooldownMs,
        canEscalate: severity !== "low",
        context,
      });
    },
    silenceForToday() {
      budget.silenceForToday();
      log.appendLine(`[watcher] silenced for today`);
    },
    setVerbosity(v) {
      suppression.setVerbosity(v);
      log.appendLine(`[watcher] verbosity → ${v}`);
    },
    state() {
      return state;
    },
    budget() {
      return budget;
    },
    stats() {
      return {
        budget: budget.snapshot(),
      };
    },
  };
}
