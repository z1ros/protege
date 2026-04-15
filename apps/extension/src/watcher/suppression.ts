import type { WatcherState } from "./state.js";
import type { TriggerResult } from "./triggers.js";

/**
 * Suppression hierarchy — decides when the watcher should shut up entirely.
 * Called before a nudge is dispatched to the UI.
 */

const FLOW_SUPPRESSION_MS = 5 * 60_000;
const WIN_SUPPRESSION_MS = 60_000;

export class SuppressionRegistry {
  private flowUntil = 0;
  private winUntil = 0;
  private verbosity: "silent" | "quiet" | "normal" | "verbose" = "normal";

  setVerbosity(v: "silent" | "quiet" | "normal" | "verbose") {
    this.verbosity = v;
  }

  markFlow() {
    this.flowUntil = Date.now() + FLOW_SUPPRESSION_MS;
  }

  markWin() {
    this.winUntil = Date.now() + WIN_SUPPRESSION_MS;
  }

  shouldSuppress(result: TriggerResult, _state: WatcherState): string | null {
    if (this.verbosity === "silent") return "verbosity=silent";

    const now = Date.now();
    // Flow suppresses EVERYTHING except truly critical high severity
    if (now < this.flowUntil && result.severity !== "high") {
      return "flow-state active";
    }

    // Win just happened — don't follow it with an unrelated nudge immediately
    if (now < this.winUntil && result.id !== "win_detected") {
      return "post-win cooldown";
    }

    // Late-night mode: only high severity gets through
    if (isLateNight() && result.severity !== "high") {
      return "late-night — critical only";
    }

    // Quiet: drop "low" severity
    if (this.verbosity === "quiet" && result.severity === "low") {
      return "verbosity=quiet";
    }

    return null;
  }
}

function isLateNight(): boolean {
  const h = new Date().getHours();
  return h >= 23 || h < 5;
}
