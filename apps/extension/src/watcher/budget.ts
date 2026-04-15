import type { TriggerId, TriggerSeverity } from "./triggers.js";

/**
 * Trust budget + per-trigger cooldowns. Protege never spams — every
 * unsolicited message costs trust, and trust refunds only on engagement.
 */

const BASE_DAILY_BUDGET = 5;
const MAX_BUDGET_CAP = 8;

interface BudgetState {
  date: string; // yyyy-mm-dd
  remaining: number;
}

interface Cooldown {
  untilTs: number;
}

export class TrustBudget {
  private state: BudgetState;
  private cooldowns = new Map<TriggerId, Cooldown>();
  private lastNudgeTs = 0;

  constructor(private dailyBudget = BASE_DAILY_BUDGET) {
    this.state = { date: todayKey(), remaining: dailyBudget };
  }

  private rollIfNewDay() {
    const today = todayKey();
    if (this.state.date !== today) {
      this.state = { date: today, remaining: this.dailyBudget };
      this.cooldowns.clear();
    }
  }

  canFire(
    id: TriggerId,
    severity: TriggerSeverity,
    globalCooldownMs: number
  ): boolean {
    this.rollIfNewDay();

    // Absolute silence if budget's exhausted — except for "high" which can
    // still fire at 25% cost once we're at 0 (real errors matter)
    if (this.state.remaining <= 0 && severity !== "high") {
      return false;
    }

    // Minimum 20s between ANY two nudges (never stack)
    if (Date.now() - this.lastNudgeTs < globalCooldownMs) return false;

    // Per-trigger cooldown
    const cd = this.cooldowns.get(id);
    if (cd && Date.now() < cd.untilTs) return false;

    return true;
  }

  spend(id: TriggerId, severity: TriggerSeverity, cooldownMs: number) {
    this.rollIfNewDay();
    this.lastNudgeTs = Date.now();
    this.cooldowns.set(id, { untilTs: Date.now() + cooldownMs });
    // High severity errors cost 0.5, others cost 1
    const cost = severity === "high" ? 0.5 : 1;
    this.state.remaining = Math.max(0, this.state.remaining - cost);
  }

  refund(amount = 1, bonus = false) {
    this.rollIfNewDay();
    const target = bonus ? MAX_BUDGET_CAP : this.dailyBudget;
    this.state.remaining = Math.min(target, this.state.remaining + amount);
  }

  snapshot() {
    this.rollIfNewDay();
    return {
      date: this.state.date,
      remaining: this.state.remaining,
      daily: this.dailyBudget,
      cooldowns: Array.from(this.cooldowns.entries()).map(([id, cd]) => ({
        id,
        secsRemaining: Math.max(
          0,
          Math.round((cd.untilTs - Date.now()) / 1000)
        ),
      })),
    };
  }

  silenceForToday() {
    this.rollIfNewDay();
    this.state.remaining = 0;
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
