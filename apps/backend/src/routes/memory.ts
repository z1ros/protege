import { Hono } from "hono";
import {
  addMemory,
  removeMemory,
  getMemorySnapshot,
  writeSessionSummary,
  type MemoryType,
} from "../store.js";

export const memoryRoute = new Hono();

memoryRoute.post("/", async (c) => {
  const body = (await c.req.json()) as {
    userId?: string;
    type: MemoryType;
    content: string;
  };
  const userId = body.userId ?? c.req.header("x-user-id") ?? "local-dev";
  if (!body.type || !body.content) {
    return c.json({ error: "type and content are required" }, 400);
  }
  const row = await addMemory(userId, body.type, body.content);
  return c.json({ ok: true, memory: row });
});

memoryRoute.delete("/:id", async (c) => {
  const userId = c.req.header("x-user-id") ?? "local-dev";
  const id = c.req.param("id");
  const removed = await removeMemory(userId, id);
  return c.json({ ok: removed });
});

memoryRoute.get("/", async (c) => {
  const userId = c.req.query("userId") ?? c.req.header("x-user-id") ?? "local-dev";
  const memories = await getMemorySnapshot(userId, 40);
  return c.json({ memories });
});

memoryRoute.post("/session-summary", async (c) => {
  const body = (await c.req.json()) as { userId?: string; summary: string };
  const userId = body.userId ?? c.req.header("x-user-id") ?? "local-dev";
  await writeSessionSummary(userId, body.summary);
  return c.json({ ok: true });
});
