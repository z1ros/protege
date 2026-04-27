import { Hono } from "hono";
import { githubAuth, resolveUserId } from "../middleware/auth.js";
import {
  removeMemory,
  getMemorySnapshot,
  writeSessionSummary,
  type MemoryType,
} from "../store.js";
import { reconcileAndStore } from "../memoryReconciler.js";

export const memoryRoute = new Hono();

memoryRoute.use("*", githubAuth());

memoryRoute.post("/", async (c) => {
  const body = (await c.req.json()) as {
    userId?: string;
    type: MemoryType;
    content: string;
  };
  const userId = resolveUserId(c, body.userId);
  if (!body.type || !body.content) {
    return c.json({ error: "type and content are required" }, 400);
  }
  const result = await reconcileAndStore(userId, body.type, body.content);
  return c.json({
    ok: true,
    action: result.decision.action,
    memory: result.row,
  });
});

memoryRoute.delete("/:id", async (c) => {
  const userId = resolveUserId(c, undefined);
  const id = c.req.param("id");
  const removed = await removeMemory(userId, id);
  return c.json({ ok: removed });
});

memoryRoute.get("/", async (c) => {
  const userId = resolveUserId(c, undefined);
  const memories = await getMemorySnapshot(userId, 40);
  return c.json({ memories });
});

memoryRoute.post("/session-summary", async (c) => {
  const body = (await c.req.json()) as { userId?: string; summary: string };
  const userId = resolveUserId(c, body.userId);
  await writeSessionSummary(userId, body.summary);
  return c.json({ ok: true });
});
