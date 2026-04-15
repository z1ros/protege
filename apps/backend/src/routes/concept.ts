import { Hono } from "hono";
import { ensureUser, recordConcepts } from "../store.js";

export const conceptRoute = new Hono();

interface Body {
  userId?: string;
  concepts: string[];
  filePath: string;
  fileHash: string;
  hasErrors?: boolean;
  errorCount?: number;
}

conceptRoute.post("/", async (c) => {
  const body = (await c.req.json()) as Body;
  const userId = body.userId ?? c.req.header("x-user-id") ?? "local-dev";
  await ensureUser(userId);

  const result = await recordConcepts(userId, {
    filePath: body.filePath,
    fileHash: body.fileHash,
    concepts: body.concepts ?? [],
    hasErrors: !!body.hasErrors,
    errorCount: body.errorCount ?? 0,
  });

  return c.json({
    ok: true,
    skipped: result.skipped,
    received: body.concepts?.length ?? 0,
    codeIq: result.codeIq,
    totalConcepts: result.totalConcepts,
    gains: result.gains,
  });
});
