import { Hono } from "hono";
import type { MeResponse } from "@protege/types";
import { ensureUser, getUserSnapshot, RULE_COUNT, MAX_IQ } from "../store.js";

export const meRoute = new Hono();

meRoute.get("/", async (c) => {
  const userId =
    c.req.query("userId") ?? c.req.header("x-user-id") ?? "local-dev";
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
  };
  return c.json(res);
});
