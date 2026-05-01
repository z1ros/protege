import { Hono } from "hono";
import type { MeResponse } from "@protege/types";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import { ensureUser, getUserSnapshot, RULE_COUNT, MAX_IQ } from "../store.js";
import { getTodayQuota, snapshotFromRow } from "../quotas.js";

export const meRoute = new Hono();

meRoute.use("*", githubAuth());

meRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  await ensureUser(userId);
  const snap = await getUserSnapshot(userId);

  const res: MeResponse = {
    userId: snap.user.userId,
    username: snap.user.username,
    codeIq: snap.codeIq,
    maxIq: MAX_IQ,
    bonusIq: snap.bonusIq,
    totalConcepts: snap.totalConcepts,
    ruleCount: RULE_COUNT,
    topConcepts: snap.rows.slice(0, 20),
    clusters: snap.clusters,
    recentGains: snap.recentGains,
    streak: snap.streak,
    dailyIq: snap.dailyIq,
    milestones: snap.milestones,
    recommendations: snap.recommendations,
    pillars: snap.pillars,
    level: snap.level,
    synergies: snap.synergies,
    velocity: snap.velocity,
    breakdown: snap.breakdown,
    iqV2: snap.iqV2,
  };
  return c.json(res);
});

/**
 * Today's quota usage for the authenticated user. Lets the extension
 * render mini progress bars + a $ pill in the Live tab so users see
 * how close they are to the daily ceiling before they hit a 429.
 *
 * Resets implicitly at 00:00 UTC — see quotas.ts for the table shape.
 * Returns the same shape regardless of whether enforcement is on, so
 * the UI can render the picture even on a not-yet-enforcing deployment.
 */
meRoute.get("/quota", async (c) => {
  const userId = resolveUserId(c, undefined);
  const row = await getTodayQuota(userId);
  return c.json(snapshotFromRow(userId, row));
});
