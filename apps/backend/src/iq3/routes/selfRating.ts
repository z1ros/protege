import { Hono } from "hono";
import { SelfRatingSchema } from "@protege/types";
import { githubAuth, resolveUserId } from "../../middleware/auth.js";

const app = new Hono();

// Mounted at /iq/self-rating. Auth is enforced for the full router —
// the userId persisted to the DB is the verified GitHub id, NOT
// whatever the client put in body.userId. resolveUserId still rejects
// (403) if body.userId disagrees with the token. (Codex finding F1.)
app.use("*", githubAuth());

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { userId?: unknown; rating?: unknown; ratedAt?: unknown; note?: unknown }
    | null;

  const claimedUserId =
    typeof body?.userId === "string" ? (body.userId as string) : undefined;
  const userId = resolveUserId(c, claimedUserId);

  // Schema-validate the rest of the payload, but always overwrite
  // userId with the verified one before parsing so a missing-but-now-
  // injected userId still passes the SelfRatingSchema check.
  const parsed = SelfRatingSchema.safeParse({
    ...(body ?? {}),
    userId,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid", details: parsed.error.flatten() }, 400);
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await client.from("iq3_self_ratings").insert({
      user_id: parsed.data.userId,
      rating: parsed.data.rating,
      rated_at: parsed.data.ratedAt,
      note: parsed.data.note,
    });
    if (error) return c.json({ error: error.message }, 500);
  } else {
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const path = "./.protege-store-iq3-self-ratings.json";
    const arr = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
    arr.push(parsed.data);
    writeFileSync(path, JSON.stringify(arr, null, 2));
  }
  return c.json({ ok: true });
});

export default app;
