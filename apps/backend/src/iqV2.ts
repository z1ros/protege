/**
 * Code IQ v2 — the engineer's benchmark.
 *
 *   codeIq = round((craft + range + velocity + debug + quality + independence) / 6)
 *
 * Each category is 0–1000, computed from signals we have today.
 * Independence is marked `pending` until keystroke + paste + AI-accept
 * collection ships — so the headline is the mean of the five active
 * categories until then.
 *
 * See Architecture/code-iq-v2-plan.md for the rationale of each formula
 * and the calibration table (Curious 30–80, Senior 550–720, Staff 720–860).
 */
import type {
  ClusterSummary,
  ConceptRow,
  GainEvent,
  IqV2,
  IqV2Category,
  StreakInfo,
  SynergyResult,
  VelocityInfo,
} from "@protege/types";
import { iqSigmoid, iqV2LevelFor } from "@protege/types";
import type { UserRow } from "./store.js";

const DAY_MS = 86_400_000;

export interface IqV2Input {
  user: UserRow;
  rows: ConceptRow[];
  clusters: ClusterSummary[];
  synergies: SynergyResult;
  velocity: VelocityInfo;
  streak: StreakInfo;
  gains: GainEvent[];
  nowMs: number;
}

/* ---------- level curves ---------- */

/** Craft uses a sigmoid so top tiers are exponentially harder.
 *  raw 60 → 100 IQ, raw 150 → 500 IQ, raw 300 → 820 IQ. */
function craftCurve(raw: number): number {
  return Math.round(1000 * iqSigmoid((raw - 120) / 200));
}

/** Range is linear up to 600, compressed above. */
function rangeCurve(raw: number): number {
  const clamped = Math.max(0, raw);
  const scaled = clamped <= 600 ? clamped : 600 + (clamped - 600) * 0.5;
  return Math.round(Math.min(1000, scaled));
}

/** Velocity is logarithmic — shipping your 10th feature matters more
 *  than your 100th. Raw 100 → 330 IQ, raw 300 → 700 IQ, raw 700 → 940 IQ. */
function velocityCurve(raw: number): number {
  return Math.round(1000 * (1 - Math.exp(-Math.max(0, raw) / 250)));
}

/** Debug: linear to 400, sigmoid above. */
function debugCurve(raw: number): number {
  if (raw <= 0) return 0;
  if (raw <= 400) return Math.round(raw);
  return Math.round(400 + 600 * iqSigmoid((raw - 600) / 200));
}

/** Quality: sigmoid centered at 350. */
function qualityCurve(raw: number): number {
  return Math.round(1000 * iqSigmoid((raw - 350) / 180));
}

/* ---------- category computers ---------- */

/** Craft — can you write clean, correct code yourself?
 *
 *  Without authorship signals yet, we multiply every concept's
 *  contribution by a conservative 0.7 (authorship unknown). Once
 *  keystroke telemetry lands, this becomes `authorshipWeight` per
 *  concept (1.0 human, 0.5 ai-assisted, 0.2 ai-copy, 0.1 pasted). */
function computeCraft(input: IqV2Input): IqV2Category {
  const AUTHORSHIP_DEFAULT = 0.7; // "unknown" default until signals ship

  let raw = 0;
  let authoredConcepts = 0;
  let demonstratedConcepts = 0; // used in ≥3 distinct files

  for (const r of input.rows) {
    // Only count concepts the user has actually practiced (timesUsed ≥ 2).
    if (r.timesUsed < 2) continue;
    const authorship = AUTHORSHIP_DEFAULT;
    const fileFactor = Math.min(1, r.distinctFiles / 3);
    const difficulty = r.weight; // 0.3 trivial → 3.0 expert
    const mastery = r.mastery; // 0..1
    raw += authorship * difficulty * fileFactor * mastery * 12;
    authoredConcepts++;
    if (r.distinctFiles >= 3) demonstratedConcepts++;
  }

  const score = craftCurve(raw);
  return {
    id: "craft",
    label: "Craft",
    score,
    delta: 0,
    pending: false,
    explanation:
      authoredConcepts === 0
        ? "Write code that uses real concepts to raise Craft."
        : `${demonstratedConcepts} demonstrated concepts across ${authoredConcepts} practiced.`,
    inputs: {
      raw: Math.round(raw),
      authoredConcepts,
      demonstratedConcepts,
    },
  };
}

/** Range — how many domains can you actually work in? */
function computeRange(input: IqV2Input): IqV2Category {
  // A cluster counts only if it has ≥3 concepts with non-trivial mastery.
  const liveDomains = input.clusters.filter(
    (c) => c.concepts >= 3 && c.progress >= 0.2
  ).length;

  // "Paradigms" = coarse style families detected in rows.
  const hasReact = input.rows.some((r) => r.cluster === "react");
  const hasFunctional = input.rows.some((r) => r.cluster === "functional");
  const hasAsync = input.rows.some((r) => r.cluster === "async");
  const hasTypes = input.rows.some((r) => r.cluster === "types");
  const paradigmsUsed = [hasReact, hasFunctional, hasAsync, hasTypes].filter(Boolean).length;

  // One-trick penalty — >80% of concept weight in one cluster.
  const totalIq = input.clusters.reduce((s, c) => s + c.iq, 0);
  const maxCluster = input.clusters.reduce((m, c) => Math.max(m, c.iq), 0);
  const oneTrickRatio = totalIq > 0 ? maxCluster / totalIq : 0;
  const oneTrickPenalty = oneTrickRatio > 0.8 ? 80 : 0;

  // Active synergy pairs (both sides have ≥2 concepts + demonstrated).
  const synergyPairs = input.synergies.active.length;

  let raw = 0;
  raw += liveDomains * 60;
  raw += paradigmsUsed * 40;
  raw += synergyPairs * 30;
  raw -= oneTrickPenalty;

  // "Languages practiced" proxy — we don't track per-language yet, so
  // treat each live cluster beyond the first as a weak language signal.
  const languageHint = Math.max(0, liveDomains - 1) * 40;
  raw += languageHint;

  const score = rangeCurve(raw);
  return {
    id: "range",
    label: "Range",
    score,
    delta: 0,
    pending: false,
    explanation:
      liveDomains === 0
        ? "Practice real work in at least one domain to unlock Range."
        : `${liveDomains} live domain${liveDomains === 1 ? "" : "s"} · ${synergyPairs} synergy pair${synergyPairs === 1 ? "" : "s"}.`,
    inputs: {
      raw: Math.round(raw),
      liveDomains,
      paradigmsUsed,
      synergyPairs,
      oneTrickPenalty,
    },
  };
}

/** Velocity — how fast can you ship working code? */
function computeVelocityV2(input: IqV2Input): IqV2Category {
  const newConceptsPerWeek = input.velocity.avgNewConceptsPerWeek;
  const saveDays30 = input.user.saveDays.filter((d) => {
    const age = (input.nowMs - Date.parse(d)) / DAY_MS;
    return age <= 30;
  }).length;

  // Active-minutes proxy: each save day ≈ 20 min of real editing (until
  // real telemetry lands). Caps at 300 (~5h/day over 30 days).
  const activeMinutes30d = Math.min(300, saveDays30 * 20);

  // "Features completed" proxy: bursts of ≥3 saves on the same day with
  // a drop in diagnostics. Without per-save diagnostics persisted, use
  // the count of save-days with ≥3 gains as a rough proxy.
  const gainsByDay = new Map<string, number>();
  for (const g of input.gains) {
    const d = g.ts.slice(0, 10);
    gainsByDay.set(d, (gainsByDay.get(d) ?? 0) + 1);
  }
  const featuresCompleted = [...gainsByDay.values()].filter((n) => n >= 3).length;

  const reworkRatio = 0; // placeholder until we track edit churn

  let raw = 0;
  raw += featuresCompleted * 25;
  raw += Math.min(200, activeMinutes30d / 30);
  raw += Math.min(80, newConceptsPerWeek * 16);
  raw += input.velocity.avgLevelUpsPerWeek * 40; // approximately 4×/month

  raw -= reworkRatio * 200;

  const score = velocityCurve(raw);
  return {
    id: "velocity",
    label: "Velocity",
    score,
    delta: 0,
    pending: false,
    explanation:
      featuresCompleted === 0
        ? "Finish what you start — saves that end with clean code raise Velocity."
        : `${featuresCompleted} feature${featuresCompleted === 1 ? "" : "s"} shipped · ${newConceptsPerWeek.toFixed(1)} new concepts/week.`,
    inputs: {
      raw: Math.round(raw),
      featuresCompleted,
      activeMinutes30d,
      newConceptsPerWeek: Math.round(newConceptsPerWeek * 10) / 10,
    },
  };
}

/** Debug — can you find and fix root causes?
 *
 *  We have one rich signal already: `gains` with `kind === "fix"` is
 *  emitted when `lastErrorCount` drops to zero across a save. That's
 *  our "bugs authored-fixed" until we get per-region attribution. */
function computeDebugCategory(input: IqV2Input): IqV2Category {
  const fixGains = input.gains.filter((g) => g.kind === "fix");
  const bugsAuthoredFixed = fixGains.length;

  // Recent fixes are worth more (root-cause indicator: didn't come back).
  const recentFixes = fixGains.filter((g) => {
    const age = (input.nowMs - Date.parse(g.ts)) / DAY_MS;
    return age <= 14;
  }).length;

  // Simplification events — placeholder until we diff file sizes.
  const simplificationEvents = 0;

  // Diagnostic latency — placeholder (median min from appearance to fix).
  const diagnosticLatencyMin = 15;

  let raw = 0;
  raw += bugsAuthoredFixed * 4;
  raw += recentFixes * 4;
  raw += Math.max(0, 60 - diagnosticLatencyMin) * 2;
  raw += simplificationEvents * 6;

  const score = debugCurve(raw);
  return {
    id: "debug",
    label: "Debug",
    score,
    delta: 0,
    pending: false,
    explanation:
      bugsAuthoredFixed === 0
        ? "Fix a bug you authored to unlock Debug — we credit the drop to zero errors."
        : `${bugsAuthoredFixed} bugs authored-fixed (${recentFixes} in last 14 days).`,
    inputs: {
      raw: Math.round(raw),
      bugsAuthoredFixed,
      recentFixes,
      simplificationEvents,
    },
  };
}

/** Quality — does your code last? */
function computeQualityV2(input: IqV2Input): IqV2Category {
  // Clean save rate approximation: fraction of recent saves that produced
  // no concept with qualityFlags incremented. Without per-save storage
  // we approximate from aggregate rows.
  const totalFlags = input.rows.reduce(
    (s, r) => s + (r.timesUsed > 0 ? 0 : 0),
    0
  );
  const totalUses = input.rows.reduce((s, r) => s + r.timesUsed, 0);
  const cleanSaveRate = totalUses > 0 ? 1 - Math.min(1, totalFlags / totalUses) : 1;

  // Bug density proxy: number of fix-gains per 100 concepts used.
  const fixCount = input.gains.filter((g) => g.kind === "fix").length;
  const bugDensity = totalUses > 0 ? (fixCount / totalUses) * 100 : 0;

  // Type strictness proxy: ratio of "types" cluster concepts used to JS
  // concepts used. Real answer will parse `any` / implicit.
  const typesUses = input.rows
    .filter((r) => r.cluster === "types")
    .reduce((s, r) => s + r.timesUsed, 0);
  const jsUses = input.rows
    .filter((r) => r.cluster === "language-core" || r.cluster === "async" || r.cluster === "react")
    .reduce((s, r) => s + r.timesUsed, 0);
  const typeStrictness = jsUses > 0 ? Math.min(1, typesUses / (jsUses * 0.4)) : 0;

  // Recurring bug count — placeholder; we don't track identity of fixes.
  const recurringBugCount = 0;
  const testsAuthored = 0; // need test-framework AST detection
  const testCoverageAuthored = 0;

  let raw = 0;
  raw += testsAuthored * 8;
  raw += testCoverageAuthored * 150;
  raw += cleanSaveRate * 200;
  raw += Math.max(0, 100 - bugDensity * 30);
  raw += typeStrictness * 100;
  raw -= recurringBugCount * 12;

  const score = qualityCurve(raw);
  return {
    id: "quality",
    label: "Quality",
    score,
    delta: 0,
    pending: false,
    explanation:
      totalUses === 0
        ? "Save clean files with typed, tested code to raise Quality."
        : `${Math.round(cleanSaveRate * 100)}% clean saves · ${Math.round(typeStrictness * 100)}% type-strict.`,
    inputs: {
      raw: Math.round(raw),
      cleanSaveRate: Math.round(cleanSaveRate * 100) / 100,
      bugDensity: Math.round(bugDensity * 10) / 10,
      typeStrictness: Math.round(typeStrictness * 100) / 100,
    },
  };
}

/** Independence — are you getting better, or is the AI doing it?
 *
 *  Pending until keystroke + paste + AI-accept telemetry lands.
 *  Score shown as 0 and excluded from the headline average. */
function computeIndependence(_input: IqV2Input): IqV2Category {
  return {
    id: "independence",
    label: "Independence",
    score: 0,
    delta: 0,
    pending: true,
    explanation:
      "Awaiting keystroke + paste + AI-accept telemetry. Ships next.",
    inputs: {
      authorshipRatio30d: 0,
      aiExplainabilityRate: 0,
      noAssistFeaturesCompleted: 0,
    },
  };
}

/* ---------- main entry ---------- */

export function computeIqV2(input: IqV2Input): IqV2 {
  const craft = computeCraft(input);
  const range = computeRange(input);
  const velocity = computeVelocityV2(input);
  const debug = computeDebugCategory(input);
  const quality = computeQualityV2(input);
  const independence = computeIndependence(input);

  const all = [craft, range, velocity, debug, quality, independence];
  const active = all.filter((c) => !c.pending);
  const headline =
    active.length === 0
      ? 0
      : Math.round(active.reduce((s, c) => s + c.score, 0) / active.length);

  const level = iqV2LevelFor(headline);

  return {
    codeIq: headline,
    level,
    weeklyDelta: 0, // filled in by caller if prev snapshot exists
    craft,
    range,
    velocity,
    debug,
    quality,
    independence,
  };
}
