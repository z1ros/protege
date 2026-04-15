import type { TriggerId, TriggerContext } from "./triggers.js";

/**
 * Rule-based nudge wording. Phase 0 uses templates; Phase 1 will polish
 * these via the local LLM before delivery.
 *
 * Tone rules (matches Protege persona):
 *  - Never alarmist, never cheerful, never needy.
 *  - Escape-hatched — always "want me to…?" never "you should…".
 *  - ≤ 100 chars preferred, 160 max.
 */

export function nudgeTemplate(
  id: TriggerId,
  ctx: TriggerContext
): string {
  switch (id) {
    case "error_persists": {
      const err = ctx.error!;
      const secs = Math.round((Date.now() - err.appearedAt) / 1000);
      const msg = truncate(err.message, 70);
      return `That "${msg}" on line ${err.line} has been hanging around for ${secs}s. Want me to look?`;
    }
    case "struggle_cluster": {
      return `Lot of back-and-forth on ${basename(ctx.filePath ?? "this file")}. Want to talk through it?`;
    }
    case "stare_pause": {
      const mins = Math.round((ctx.idleMs ?? 90_000) / 60_000);
      return `Been on ${basename(ctx.filePath ?? "this file")} for ${mins} min. Stuck on something?`;
    }
    case "build_fail_loop": {
      return `Three saves in a row with errors in ${basename(ctx.filePath ?? "this file")}. Want me to trace through what's happening?`;
    }
    case "win_detected": {
      return `Nice — that's ${ctx.concept ?? "it"} working cleanly.`;
    }
    case "flow_detected": {
      return ""; // flow = silence, this trigger never speaks
    }
    case "commit_risk": {
      return `${ctx.fileCount ?? "Several"} files staged with no test touches. Want me to suggest a quick test?`;
    }
    case "late_night_marathon": {
      return `Going deep tonight. Want me to snapshot where you left off before you crash?`;
    }
    case "risky_edit": {
      return `Big change — ${ctx.fileCount ?? "multiple"} files at once. Want a second pair of eyes before it compiles?`;
    }
    case "concept_breakthrough": {
      return `${ctx.concept} just hit ${ctx.level ?? "a new level"}. That's real progress.`;
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
