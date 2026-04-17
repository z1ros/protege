/**
 * Concept metadata shared by backend (for weights, clusters, IQ math)
 * and extension (for display). The regex patterns for detection live only
 * in the extension — the backend never needs to parse source code.
 */

export type Cluster =
  | "react"
  | "async"
  | "functional"
  | "types"
  | "language-core"
  | "error-handling"
  | "python";

export interface ConceptMeta {
  name: string;
  weight: number; // 0.3 trivial · 1.0 core · 2.0 advanced · 3.0 expert
  cluster: Cluster;
}

export const CONCEPT_META: ConceptMeta[] = [
  // React
  { name: "React useState",          weight: 1.2, cluster: "react" },
  { name: "React useEffect",         weight: 1.5, cluster: "react" },
  { name: "React useEffect cleanup", weight: 2.2, cluster: "react" },
  { name: "React useMemo",           weight: 2.0, cluster: "react" },
  { name: "React useCallback",       weight: 2.0, cluster: "react" },
  { name: "React useRef",            weight: 1.5, cluster: "react" },
  { name: "React useReducer",        weight: 2.5, cluster: "react" },
  { name: "React custom hook",       weight: 2.8, cluster: "react" },
  { name: "React component",         weight: 1.0, cluster: "react" },

  // Async
  { name: "async/await",             weight: 1.5, cluster: "async" },
  { name: "Promises",                weight: 1.5, cluster: "async" },
  { name: "Promise.all concurrency", weight: 2.0, cluster: "async" },
  { name: "Async iteration",         weight: 2.2, cluster: "async" },
  { name: "Fetch API",               weight: 0.8, cluster: "async" },

  // Error handling
  { name: "Error handling",          weight: 1.2, cluster: "error-handling" },

  // Functional
  { name: "Array map",               weight: 0.6, cluster: "functional" },
  { name: "Array filter",            weight: 0.6, cluster: "functional" },
  { name: "Array reduce",            weight: 1.8, cluster: "functional" },
  { name: "Reducer pattern",         weight: 2.5, cluster: "functional" },
  { name: "Higher-order function",   weight: 2.3, cluster: "functional" },
  { name: "Destructuring",           weight: 0.5, cluster: "functional" },
  { name: "Spread / rest",           weight: 0.5, cluster: "functional" },
  { name: "Arrow functions",         weight: 0.3, cluster: "functional" },

  // Language core
  { name: "Classes",                 weight: 1.0, cluster: "language-core" },
  { name: "Template literals",       weight: 0.3, cluster: "language-core" },
  { name: "Optional chaining",       weight: 0.4, cluster: "language-core" },
  { name: "Nullish coalescing",      weight: 0.4, cluster: "language-core" },
  { name: "ES modules",              weight: 0.4, cluster: "language-core" },

  // TS types
  { name: "TypeScript interface",    weight: 1.0, cluster: "types" },
  { name: "TypeScript type alias",   weight: 1.0, cluster: "types" },
  { name: "TypeScript generics",     weight: 2.0, cluster: "types" },
  { name: "Generic constraints",     weight: 2.5, cluster: "types" },
  { name: "Conditional types",       weight: 3.0, cluster: "types" },
  { name: "Discriminated unions",    weight: 2.8, cluster: "types" },

  // Python
  { name: "Python list comprehension", weight: 1.2, cluster: "python" },
  { name: "Python decorators",       weight: 2.0, cluster: "python" },
  { name: "Python with-statement",   weight: 1.0, cluster: "python" },
  { name: "Python try/except",       weight: 1.2, cluster: "error-handling" },
  { name: "Python f-string",         weight: 0.4, cluster: "python" },
  { name: "Python async/await",      weight: 1.8, cluster: "async" },
  { name: "Python type hints",       weight: 1.2, cluster: "types" },
];

export const TOTAL_WEIGHT = CONCEPT_META.reduce((s, m) => s + m.weight, 0);

const BY_NAME = new Map(CONCEPT_META.map((m) => [m.name, m]));

export function conceptMeta(name: string): ConceptMeta | undefined {
  return BY_NAME.get(name);
}

export function conceptWeight(name: string): number {
  return BY_NAME.get(name)?.weight ?? 1.0;
}

export function conceptCluster(name: string): Cluster {
  return BY_NAME.get(name)?.cluster ?? "language-core";
}

export const CLUSTER_LABELS: Record<Cluster, string> = {
  react: "React",
  async: "Async & Promises",
  functional: "Functional JS",
  types: "Type Systems",
  "language-core": "Language Core",
  "error-handling": "Error Handling",
  python: "Python Idioms",
};

/**
 * MVP IQ math — shared formula so backend and extension agree.
 *
 * Mastery curve: exponential — first uses feel rewarding, then taper.
 *   m(times) = 1 - exp(-times / 5)  → 63% @ 5, 86% @ 10, 95% @ 15
 *
 * Decay: linear over 60 days since last use, floor 30%.
 *   d(days) = max(0.3, 1 - days / 60)
 *
 * Quality penalty: each save that had errors on this concept costs 10%,
 * floor 40%. So a user who consistently produces buggy code can't coast.
 *   q(flags) = max(0.4, 1 - flags * 0.1)
 *
 * IQ = round( sum( weight[c] * m(t) * d(days) * q(flags) ) * K )
 *      K = 1000 / TOTAL_WEIGHT       (calibrated so max reachable = 1000)
 */

export const IQ_CEILING = 1000;
export const IQ_K = IQ_CEILING / TOTAL_WEIGHT;

export function masteryCurve(timesUsed: number): number {
  if (timesUsed <= 0) return 0;
  return 1 - Math.exp(-timesUsed / 5);
}

export function decayFactor(lastUsedAt: string, nowMs = Date.now()): number {
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return 1;
  const days = Math.max(0, (nowMs - last) / 86_400_000);
  return Math.max(0.3, 1 - days / 60);
}

export function qualityFactor(qualityFlags: number): number {
  return Math.max(0.4, 1 - qualityFlags * 0.1);
}

/* ==========================================================
   Five-Pillar Code IQ System

   Code IQ = Depth + Breadth + Velocity + Consistency + Quality
   Each pillar has an independent max and its own formula.
   The sum is capped at IQ_CEILING (1000).
   ========================================================== */

export interface IqPillar {
  /** Machine-readable id */
  id: "depth" | "breadth" | "velocity" | "consistency" | "quality";
  /** Human label */
  label: string;
  /** Current score */
  score: number;
  /** Maximum possible score for this pillar */
  max: number;
  /** Change since yesterday (or since last snapshot) */
  delta: number;
  /** One-line explanation of what drove the score */
  explanation: string;
}

export interface IqPillars {
  depth: IqPillar;
  breadth: IqPillar;
  velocity: IqPillar;
  consistency: IqPillar;
  quality: IqPillar;
  /** The composite IQ (sum of all pillars, capped at IQ_CEILING) */
  composite: number;
}

export const PILLAR_MAX = {
  depth: 250,
  breadth: 200,
  velocity: 200,
  consistency: 200,
  quality: 150,
} as const;

/* ---------- Depth (0–250) ----------
   How deeply do you know the skills you use?
   Expert skills contribute 3× more than Familiar ones. */

export interface DepthInput {
  mastery: number;       // 0..1 effective mastery
  weight: number;        // concept weight (difficulty-based)
  timesUsed: number;
  distinctFiles: number;
  daysSinceUsed: number;
}

export function computeDepth(skills: DepthInput[]): number {
  if (skills.length === 0) return 0;
  let sum = 0;
  for (const s of skills) {
    // Level multiplier: expert (>0.7) = 3×, competent (>0.4) = 1.8×, functional (>0.2) = 1.2×, familiar = 1×
    const lvlMul = s.mastery >= 0.7 ? 3.0
      : s.mastery >= 0.4 ? 1.8
      : s.mastery >= 0.2 ? 1.2
      : 1.0;
    // File diversity bonus: using a skill across many files = deeper knowledge
    const fileMul = Math.min(1.5, 1 + (s.distinctFiles - 1) * 0.1);
    // Recency bonus: used in last 7 days = 1.2×, last 30 = 1.0×, older = 0.8×
    const recencyMul = s.daysSinceUsed <= 7 ? 1.2 : s.daysSinceUsed <= 30 ? 1.0 : 0.8;
    sum += s.mastery * s.weight * lvlMul * fileMul * recencyMul;
  }
  // Normalize: scale so a user with ~40 solid skills at decent mastery scores ~200
  const raw = sum * (PILLAR_MAX.depth / 80);
  return Math.min(PILLAR_MAX.depth, Math.round(raw));
}

/* ---------- Breadth (0–200) ----------
   How many different domains have you touched?
   Bonus for cross-domain presence, penalty for one-dimensionality. */

export function computeBreadth(
  domainCounts: Map<string, number>,  // domain → detected skill count
  totalDomains: number
): number {
  const touched = [...domainCounts.values()].filter((c) => c >= 3).length;
  if (touched === 0) return 0;

  // Base: fraction of domains with ≥3 skills, scaled to max
  const domainFraction = touched / Math.max(1, totalDomains);
  let score = domainFraction * PILLAR_MAX.breadth * 0.7;

  // Diversity bonus: more domains = multiplicative bonus
  score *= 1 + Math.min(0.5, touched * 0.05);

  // One-dimensional penalty: if >80% of detected skills are in one domain
  const counts = [...domainCounts.values()];
  const total = counts.reduce((s, c) => s + c, 0);
  const maxDomainPct = total > 0 ? Math.max(...counts) / total : 0;
  if (maxDomainPct > 0.8) {
    score *= 0.6; // heavy penalty for being one-dimensional
  } else if (maxDomainPct > 0.6) {
    score *= 0.85; // mild penalty
  }

  return Math.min(PILLAR_MAX.breadth, Math.round(score));
}

/* ---------- Velocity (0–200) ----------
   How fast are you learning new things? */

export interface VelocityInput {
  newConceptsPerWeek: number;   // trailing 4-week average
  levelUpsPerMonth: number;     // skills that advanced a mastery tier this month
  streakDays: number;           // current consecutive coding days
}

export function computeVelocity(v: VelocityInput): number {
  // New concepts rate: 5/week = good, 10/week = excellent
  const conceptScore = Math.min(80, v.newConceptsPerWeek * 16);
  // Level-ups: 3/month = good, 8/month = excellent
  const levelUpScore = Math.min(70, v.levelUpsPerMonth * 8.75);
  // Streak multiplier: 7 days = 1.2×, 14 = 1.35×, 30 = 1.5×
  const streakMul = Math.min(1.5, 1 + v.streakDays / 60);

  const raw = (conceptScore + levelUpScore) * streakMul;
  return Math.min(PILLAR_MAX.velocity, Math.round(raw));
}

/* ---------- Consistency (0–200) ----------
   Do you code regularly? */

export interface ConsistencyInput {
  streakCurrent: number;
  streakLongest: number;
  saveDaysLast30: number;        // how many of the last 30 days had saves
  decayResistantSkills: number;  // skills that WOULD decay but are still active
}

export function computeConsistency(c: ConsistencyInput): number {
  // Current streak: 7 = decent, 14 = good, 30 = excellent
  const streakScore = Math.min(70, c.streakCurrent * 2.33);
  // Save frequency: 20/30 days = good, 28/30 = excellent
  const frequencyScore = Math.min(80, (c.saveDaysLast30 / 30) * 80);
  // Decay resistance: keeping skills alive that would otherwise fade
  const resistScore = Math.min(50, c.decayResistantSkills * 5);

  return Math.min(PILLAR_MAX.consistency, Math.round(streakScore + frequencyScore + resistScore));
}

/* ---------- Quality (0–150) ----------
   Is the code you write actually good? */

export interface QualityInput {
  cleanSaveRate: number;       // 0..1 fraction of saves with 0 findings
  fixRate: number;             // 0..1 fraction of findings that were fixed
  bugDensity: number;          // findings per 100 lines (lower = better)
  recurringBugCount: number;   // same bug type appearing 3+ times
}

export function computeQuality(q: QualityInput): number {
  // Clean saves: 80%+ = great
  const cleanScore = q.cleanSaveRate * 60;
  // Fix rate: fixing what you break = good
  const fixScore = q.fixRate * 50;
  // Bug density: lower is better (0.5/100 lines = excellent)
  const densityScore = Math.max(0, 30 - q.bugDensity * 15);
  // Recurring bug penalty
  const recurringPenalty = q.recurringBugCount * 5;

  const raw = cleanScore + fixScore + densityScore - recurringPenalty;
  return Math.min(PILLAR_MAX.quality, Math.max(0, Math.round(raw)));
}

/* ==========================================================
   Engineering Levels — 8 tiers from Novice to Legend.
   Each level requires a minimum IQ + specific pillar thresholds.
   Users see a checklist of what they need to reach the next tier.
   ========================================================== */

export type EngineeringLevelId =
  | "novice"
  | "beginner"
  | "apprentice"
  | "intermediate"
  | "advanced"
  | "expert"
  | "master"
  | "legend";

export interface LevelRequirement {
  label: string;
  met: boolean;
  current: number;
  target: number;
}

export interface LevelDefinition {
  id: EngineeringLevelId;
  title: string;
  iqMin: number;
  iqMax: number;
  color: string;          // ring gauge color
  glowColor: string;      // badge glow
  requirements: {
    minSkills?: number;
    minDomains?: number;
    minBreadth?: number;
    minQuality?: number;
    minVelocity?: number;
    minExpertSkills?: number;
    minStreak?: number;
    allPillarsMin?: number;
  };
  bonusIq: number;         // one-time IQ bonus on reaching this level
}

export const ENGINEERING_LEVELS: LevelDefinition[] = [
  {
    id: "novice",
    title: "Novice",
    iqMin: 0,
    iqMax: 99,
    color: "#6b7280",      // grey
    glowColor: "rgba(107,114,128,0.3)",
    requirements: {},
    bonusIq: 0,
  },
  {
    id: "beginner",
    title: "Beginner",
    iqMin: 100,
    iqMax: 199,
    color: "#a78bfa",      // soft purple
    glowColor: "rgba(167,139,250,0.3)",
    requirements: { minSkills: 3 },
    bonusIq: 10,
  },
  {
    id: "apprentice",
    title: "Apprentice",
    iqMin: 200,
    iqMax: 349,
    color: "#60a5fa",      // blue
    glowColor: "rgba(96,165,250,0.3)",
    requirements: { minDomains: 2, minQuality: 50 },
    bonusIq: 20,
  },
  {
    id: "intermediate",
    title: "Intermediate",
    iqMin: 350,
    iqMax: 549,
    color: "#34d399",      // emerald
    glowColor: "rgba(52,211,153,0.3)",
    requirements: { minDomains: 3, minBreadth: 80, minStreak: 3 },
    bonusIq: 35,
  },
  {
    id: "advanced",
    title: "Advanced",
    iqMin: 550,
    iqMax: 749,
    color: "#fbbf24",      // amber
    glowColor: "rgba(251,191,36,0.3)",
    requirements: { minDomains: 5, minExpertSkills: 1, minQuality: 90 },
    bonusIq: 50,
  },
  {
    id: "expert",
    title: "Expert",
    iqMin: 750,
    iqMax: 899,
    color: "#f97316",      // orange
    glowColor: "rgba(249,115,22,0.35)",
    requirements: { minDomains: 7, minExpertSkills: 3, minVelocity: 120 },
    bonusIq: 75,
  },
  {
    id: "master",
    title: "Master",
    iqMin: 900,
    iqMax: 969,
    color: "#ef4444",      // red
    glowColor: "rgba(239,68,68,0.35)",
    requirements: { minDomains: 10, minExpertSkills: 5, allPillarsMin: 150 },
    bonusIq: 100,
  },
  {
    id: "legend",
    title: "Legend",
    iqMin: 970,
    iqMax: 1000,
    color: "#e879f9",      // fuchsia
    glowColor: "rgba(232,121,249,0.4)",
    requirements: { minDomains: 12, minExpertSkills: 8, allPillarsMin: 180 },
    bonusIq: 150,
  },
];

export interface LevelInfo {
  current: LevelDefinition;
  next: LevelDefinition | null;
  /** Progress toward next level: 0..1 (IQ-based) */
  progress: number;
  /** Checklist: what's needed for the next level, with met/unmet status */
  nextRequirements: LevelRequirement[];
}

/**
 * Determine the user's engineering level from their composite IQ + pillar scores.
 * A user must meet BOTH the IQ threshold AND all pillar requirements to qualify.
 * If they have the IQ but not the requirements, they stay at the lower level.
 */
export function computeLevel(
  compositeIq: number,
  pillars: IqPillars,
  expertSkillCount: number,
  detectedDomainCount: number,
  streakDays: number,
  totalSkills: number
): LevelInfo {
  let currentIdx = 0;

  for (let i = ENGINEERING_LEVELS.length - 1; i >= 0; i--) {
    const lvl = ENGINEERING_LEVELS[i];
    if (compositeIq < lvl.iqMin) continue;

    const reqs = lvl.requirements;
    const met =
      (!reqs.minSkills || totalSkills >= reqs.minSkills) &&
      (!reqs.minDomains || detectedDomainCount >= reqs.minDomains) &&
      (!reqs.minBreadth || pillars.breadth.score >= reqs.minBreadth) &&
      (!reqs.minQuality || pillars.quality.score >= reqs.minQuality) &&
      (!reqs.minVelocity || pillars.velocity.score >= reqs.minVelocity) &&
      (!reqs.minExpertSkills || expertSkillCount >= reqs.minExpertSkills) &&
      (!reqs.minStreak || streakDays >= reqs.minStreak) &&
      (!reqs.allPillarsMin || (
        pillars.depth.score >= reqs.allPillarsMin &&
        pillars.breadth.score >= reqs.allPillarsMin &&
        pillars.velocity.score >= reqs.allPillarsMin &&
        pillars.consistency.score >= reqs.allPillarsMin &&
        pillars.quality.score >= reqs.allPillarsMin
      ));

    if (met) {
      currentIdx = i;
      break;
    }
  }

  const current = ENGINEERING_LEVELS[currentIdx];
  const next = currentIdx < ENGINEERING_LEVELS.length - 1
    ? ENGINEERING_LEVELS[currentIdx + 1]
    : null;

  // Progress within current level toward next
  const progress = next
    ? Math.min(1, Math.max(0, (compositeIq - current.iqMin) / (next.iqMin - current.iqMin)))
    : 1;

  // Build requirements checklist for next level
  const nextRequirements: LevelRequirement[] = [];
  if (next) {
    const r = next.requirements;
    nextRequirements.push({
      label: `Code IQ ≥ ${next.iqMin}`,
      met: compositeIq >= next.iqMin,
      current: compositeIq,
      target: next.iqMin,
    });
    if (r.minSkills) {
      nextRequirements.push({
        label: `${r.minSkills}+ detected skills`,
        met: totalSkills >= r.minSkills,
        current: totalSkills,
        target: r.minSkills,
      });
    }
    if (r.minDomains) {
      nextRequirements.push({
        label: `${r.minDomains}+ domains touched`,
        met: detectedDomainCount >= r.minDomains,
        current: detectedDomainCount,
        target: r.minDomains,
      });
    }
    if (r.minBreadth) {
      nextRequirements.push({
        label: `Breadth ≥ ${r.minBreadth}`,
        met: pillars.breadth.score >= r.minBreadth,
        current: pillars.breadth.score,
        target: r.minBreadth,
      });
    }
    if (r.minQuality) {
      nextRequirements.push({
        label: `Quality ≥ ${r.minQuality}`,
        met: pillars.quality.score >= r.minQuality,
        current: pillars.quality.score,
        target: r.minQuality,
      });
    }
    if (r.minVelocity) {
      nextRequirements.push({
        label: `Velocity ≥ ${r.minVelocity}`,
        met: pillars.velocity.score >= r.minVelocity,
        current: pillars.velocity.score,
        target: r.minVelocity,
      });
    }
    if (r.minExpertSkills) {
      nextRequirements.push({
        label: `${r.minExpertSkills}+ expert skills`,
        met: expertSkillCount >= r.minExpertSkills,
        current: expertSkillCount,
        target: r.minExpertSkills,
      });
    }
    if (r.minStreak) {
      nextRequirements.push({
        label: `${r.minStreak}+ day streak`,
        met: streakDays >= r.minStreak,
        current: streakDays,
        target: r.minStreak,
      });
    }
    if (r.allPillarsMin) {
      const minPillar = Math.min(
        pillars.depth.score,
        pillars.breadth.score,
        pillars.velocity.score,
        pillars.consistency.score,
        pillars.quality.score
      );
      nextRequirements.push({
        label: `All pillars ≥ ${r.allPillarsMin}`,
        met: minPillar >= r.allPillarsMin,
        current: minPillar,
        target: r.allPillarsMin,
      });
    }
  }

  return { current, next, progress, nextRequirements };
}

/* ==========================================================
   Cross-Domain Synergy System

   When a user demonstrates skills from complementary domains,
   their Breadth pillar gets a multiplicative bonus. This rewards
   full-stack thinking — not just language collecting.

   Anti-synergies flag gaps: "you build but don't test" etc.
   ========================================================== */

export interface SynergyPair {
  /** Concept/cluster name for side A */
  a: string;
  /** Concept/cluster name for side B */
  b: string;
  /** Multiplier applied to Breadth when both are present (e.g. 1.15 = +15%) */
  multiplier: number;
  /** Human-readable label */
  label: string;
}

export interface AntiSynergy {
  /** What the user HAS (cluster or concept name) */
  has: string;
  /** What the user is MISSING (cluster or concept name) */
  missing: string;
  /** Breadth penalty multiplier (e.g. 0.9 = -10%) */
  penalty: number;
  /** Gap message shown to the user */
  gap: string;
}

export interface SynergyResult {
  /** Active synergy pairs with both sides detected */
  active: { pair: SynergyPair; aCount: number; bCount: number }[];
  /** Detected gaps where the user builds in one area but ignores a complement */
  gaps: { anti: AntiSynergy; hasCount: number }[];
  /** Combined multiplier for Breadth pillar (product of all active synergies) */
  multiplier: number;
  /** Combined penalty for Breadth pillar (product of all active anti-synergies) */
  penalty: number;
}

/**
 * Synergy pairs — both sides must have ≥2 detected skills to activate.
 *
 * IMPORTANT: these IDs must match the cluster IDs from CLUSTER_LABELS
 * (react, async, functional, types, language-core, error-handling, python)
 * because domainCounts in computeSnapshot is built from those clusters.
 *
 * When detection expands to taxonomy domains, these can reference the
 * full 28-domain set. For now, only the 7 concept clusters work.
 */
export const SYNERGY_PAIRS: SynergyPair[] = [
  { a: "react",           b: "types",            multiplier: 1.15, label: "React + TypeScript" },
  { a: "async",           b: "error-handling",    multiplier: 1.10, label: "Async + Error Handling" },
  { a: "functional",      b: "types",            multiplier: 1.10, label: "Functional + Types" },
  { a: "react",           b: "functional",       multiplier: 1.10, label: "React + Functional JS" },
  { a: "react",           b: "error-handling",    multiplier: 1.10, label: "React + Error Handling" },
  { a: "react",           b: "async",            multiplier: 1.10, label: "React + Async" },
  { a: "python",          b: "async",            multiplier: 1.15, label: "Python + Async" },
  { a: "python",          b: "error-handling",    multiplier: 1.10, label: "Python + Error Handling" },
  { a: "types",           b: "functional",       multiplier: 1.10, label: "Types + Functional" },
  { a: "async",           b: "functional",       multiplier: 1.10, label: "Async + Functional" },
  { a: "language-core",   b: "types",            multiplier: 1.10, label: "JS Core + TypeScript" },
];

/** Anti-synergies — flag gaps when the user builds in one area but ignores its complement */
export const ANTI_SYNERGIES: AntiSynergy[] = [
  { has: "react",          missing: "error-handling", penalty: 0.92, gap: "React without error handling" },
  { has: "async",          missing: "error-handling", penalty: 0.90, gap: "Async code without error handling" },
  { has: "language-core",  missing: "types",          penalty: 0.92, gap: "JavaScript without TypeScript types" },
  { has: "react",          missing: "types",          penalty: 0.95, gap: "React without TypeScript" },
];

/**
 * Compute synergy bonuses and gap penalties from a user's detected domains.
 *
 * @param domainCounts Map of domain/cluster id → number of detected skills
 * @param minSkillsToActivate Minimum skills in a domain to count (default 2)
 */
export function computeSynergies(
  domainCounts: Map<string, number>,
  minSkillsToActivate = 2
): SynergyResult {
  const active: SynergyResult["active"] = [];
  const gaps: SynergyResult["gaps"] = [];

  for (const pair of SYNERGY_PAIRS) {
    const aCount = domainCounts.get(pair.a) ?? 0;
    const bCount = domainCounts.get(pair.b) ?? 0;
    if (aCount >= minSkillsToActivate && bCount >= minSkillsToActivate) {
      active.push({ pair, aCount, bCount });
    }
  }

  for (const anti of ANTI_SYNERGIES) {
    const hasCount = domainCounts.get(anti.has) ?? 0;
    const missingCount = domainCounts.get(anti.missing) ?? 0;
    // Only flag if user has substantial skills in one area but zero in the other
    if (hasCount >= 3 && missingCount === 0) {
      gaps.push({ anti, hasCount });
    }
  }

  // Combined multiplier = product of all active synergies
  const multiplier = active.reduce((m, s) => m * s.pair.multiplier, 1.0);
  // Combined penalty = product of all gap penalties
  const penalty = gaps.reduce((m, g) => m * g.anti.penalty, 1.0);

  return { active, gaps, multiplier, penalty };
}

/** Compute the composite Code IQ from all five pillars. */
export function compositeIq(pillars: IqPillars): number {
  const sum = pillars.depth.score
    + pillars.breadth.score
    + pillars.velocity.score
    + pillars.consistency.score
    + pillars.quality.score;
  return Math.min(IQ_CEILING, Math.round(sum));
}
