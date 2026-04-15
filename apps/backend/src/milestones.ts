import type { Cluster, GainEvent } from "@protege/types";
import { CLUSTER_LABELS, CONCEPT_META } from "@protege/types";

/**
 * Milestones — one-time IQ bonuses for meaningful achievements. Each is
 * checked after every save. Unlocked milestones are stored by id; the check
 * function only fires if the id isn't already unlocked.
 */

export interface Milestone {
  id: string;
  title: string;
  description: string;
  bonusIq: number;
  check: (ctx: MilestoneContext) => boolean;
}

export interface MilestoneContext {
  totalConcepts: number;            // distinct concepts touched
  clustersTouched: Set<Cluster>;    // clusters with ≥1 concept
  clustersComplete: Set<Cluster>;   // clusters where every concept is touched
  expertCount: number;              // concepts at Expert level
  streakDays: number;
  codeIq: number;
}

const perClusterSize: Record<Cluster, number> = CONCEPT_META.reduce(
  (acc, c) => {
    acc[c.cluster] = (acc[c.cluster] ?? 0) + 1;
    return acc;
  },
  {} as Record<Cluster, number>
);

export const MILESTONES: Milestone[] = [
  {
    id: "first-concept",
    title: "First concept",
    description: "You saved a file with a recognized concept.",
    bonusIq: 5,
    check: (ctx) => ctx.totalConcepts >= 1,
  },
  {
    id: "ten-concepts",
    title: "Ten concepts",
    description: "Touched 10 distinct concepts.",
    bonusIq: 15,
    check: (ctx) => ctx.totalConcepts >= 10,
  },
  {
    id: "twenty-concepts",
    title: "Twenty concepts",
    description: "Touched 20 distinct concepts.",
    bonusIq: 30,
    check: (ctx) => ctx.totalConcepts >= 20,
  },
  {
    id: "first-expert",
    title: "First Expert",
    description: "A concept reached Expert level.",
    bonusIq: 25,
    check: (ctx) => ctx.expertCount >= 1,
  },
  {
    id: "three-experts",
    title: "Three Experts",
    description: "Three concepts at Expert level.",
    bonusIq: 40,
    check: (ctx) => ctx.expertCount >= 3,
  },
  {
    id: "streak-3",
    title: "3-day streak",
    description: "Saved code 3 days in a row.",
    bonusIq: 10,
    check: (ctx) => ctx.streakDays >= 3,
  },
  {
    id: "streak-7",
    title: "7-day streak",
    description: "A full week of shipping.",
    bonusIq: 25,
    check: (ctx) => ctx.streakDays >= 7,
  },
  {
    id: "streak-14",
    title: "14-day streak",
    description: "Two weeks straight.",
    bonusIq: 50,
    check: (ctx) => ctx.streakDays >= 14,
  },
  {
    id: "streak-30",
    title: "30-day streak",
    description: "A full month. Relentless.",
    bonusIq: 100,
    check: (ctx) => ctx.streakDays >= 30,
  },
  {
    id: "all-clusters",
    title: "Polyglot",
    description: "Touched every concept cluster at least once.",
    bonusIq: 30,
    check: (ctx) =>
      ctx.clustersTouched.size === Object.keys(CLUSTER_LABELS).length,
  },
];

// Dynamic per-cluster milestones (first + full)
for (const cl of Object.keys(CLUSTER_LABELS) as Cluster[]) {
  MILESTONES.push({
    id: `first-${cl}`,
    title: `First ${CLUSTER_LABELS[cl]}`,
    description: `First concept in the ${CLUSTER_LABELS[cl]} cluster.`,
    bonusIq: 5,
    check: (ctx) => ctx.clustersTouched.has(cl),
  });
  MILESTONES.push({
    id: `complete-${cl}`,
    title: `${CLUSTER_LABELS[cl]} complete`,
    description: `Touched every concept in the ${CLUSTER_LABELS[cl]} cluster.`,
    bonusIq: 50,
    check: (ctx) => ctx.clustersComplete.has(cl),
  });
}

export interface MilestoneUnlock {
  id: string;
  title: string;
  bonusIq: number;
  at: string;
}

/**
 * Check which milestones just unlocked. Returns new unlocks only.
 */
export function checkMilestones(
  alreadyUnlocked: Set<string>,
  ctx: MilestoneContext
): MilestoneUnlock[] {
  const now = new Date().toISOString();
  const unlocks: MilestoneUnlock[] = [];
  for (const m of MILESTONES) {
    if (alreadyUnlocked.has(m.id)) continue;
    if (m.check(ctx)) {
      unlocks.push({ id: m.id, title: m.title, bonusIq: m.bonusIq, at: now });
    }
  }
  return unlocks;
}

export function milestoneBonusIq(unlocked: string[]): number {
  const byId = new Map(MILESTONES.map((m) => [m.id, m]));
  let sum = 0;
  for (const id of unlocked) {
    const m = byId.get(id);
    if (m) sum += m.bonusIq;
  }
  return sum;
}

export function milestoneDefinition(id: string): Milestone | undefined {
  return MILESTONES.find((m) => m.id === id);
}

export { perClusterSize };
